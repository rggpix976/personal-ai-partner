var DiaryService = (function() {
  var DEFAULTS = Object.freeze({
    memoryLimit: 5
  });

  function enqueue(diaryDate) {
    var normalizedDate = normalizeDiaryDate_(diaryDate);
    var lifecycle = getLifecycleState_(normalizedDate);
    if (lifecycle.status !== 'MISSING') {
      return {
        enqueued: false,
        duplicate: lifecycle.status === 'PENDING',
        reason: getLifecycleNoEnqueueReason_(lifecycle.status),
        diaryDate: normalizedDate,
        diaryStatus: lifecycle.status
      };
    }
    var requestedAt = toIsoStringInTokyo(new Date());
    var dedupeKey = buildDedupeKey_(normalizedDate);
    var candidateEventId = generateUuidV4();
    var runtime = resolveDiaryRuntime_();
    var eventPayload = {
      diaryDate: normalizedDate,
      requestedAt: requestedAt,
      characterRuntimeMode: runtime.mode
    };
    if (runtime.mode === 'enforced') {
      eventPayload.characterBinding = runtime.binding;
    }
    var event = QueueService.enqueue({
      eventId: candidateEventId,
      eventType: 'DIARY_GENERATE',
      dedupeKey: dedupeKey,
      payload: eventPayload,
      status: 'PENDING',
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: requestedAt,
      updatedAt: requestedAt,
      completedAt: null,
      lastError: null
    });

    markDailySummaryPending_(normalizedDate, requestedAt);
    var wasInserted = event.eventId === candidateEventId;
    return {
      enqueued: wasInserted,
      duplicate: !wasInserted,
      eventId: event.eventId,
      dedupeKey: dedupeKey,
      diaryDate: normalizedDate,
      diaryStatus: 'PENDING'
    };
  }

  function isGenerated(diaryDate) {
    var normalizedDate = normalizeDiaryDate_(diaryDate);
    return getLifecycleState_(normalizedDate).status === 'DONE';
  }

  function generate(eventPayload, options) {
    var payload = validateGeneratePayload_(eventPayload);
    if (payload.characterRuntimeMode === 'enforced') {
      return generateEnforced_(payload, options);
    }
    return generateLegacy_(payload);
  }

  function generateLegacy_(eventPayload) {
    var payload = validateGeneratePayload_(eventPayload);
    var diaryDate = payload.diaryDate;
    var warnings = [];
    var existingState = getDiaryState_(diaryDate);

    ensureConsistentDiaryState_(existingState);
    if (existingState.generated) {
      return repairGeneratedDiaryState_(diaryDate, null, null, warnings);
    }

    var messages = SheetRepository.listMessagesByDate(diaryDate);
    var diaryConfig = loadDiaryConfig_();
    var includePartnerWorld = shouldIncludePartnerWorld_(diaryDate, diaryConfig);

    if (messages.length === 0 && !includePartnerWorld) {
      warnings.push('No conversation messages were found and Partner World was not selected for the diary date.');
      return LockManager.withScriptLock('diary-skip-' + diaryDate, function() {
        var skippedState = getDiaryState_(diaryDate);
        ensureConsistentDiaryState_(skippedState);
        if (skippedState.generated) {
          return repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, null, warnings);
        }
        persistDiarySkipped_(diaryDate, messages);
        return buildSkippedResult_(diaryDate, warnings);
      });
    }

    var relevantMemories = [];
    if (messages.length > 0) {
      var query = messages.map(function(message) {
        return String(message.text || '');
      }).join(' ');

      try {
        relevantMemories = typeof MemoryService !== 'undefined' && MemoryService && MemoryService.findRelevant
          ? MemoryService.findRelevant(query, DEFAULTS.memoryLimit)
          : [];
      } catch (error) {
        warnings.push('Relevant memories could not be loaded.');
      }
    }

    var recentDiarySummaries = loadRecentDiarySummaries_(
      diaryDate,
      diaryConfig.partnerWorldRecentDiaryLimit,
      warnings
    );
    var generation = GeminiClient.generateStructured(
      buildDiaryRequest_(
        diaryDate,
        messages,
        relevantMemories,
        recentDiarySummaries,
        diaryConfig
      ),
      'diary-entry'
    );
    var diary = normalizeDiaryEntry_(
      generation.data,
      includePartnerWorld,
      diaryConfig,
      warnings
    );
    return LockManager.withScriptLock('diary-generate-' + diaryDate, function() {
      var currentState = getDiaryState_(diaryDate);
      ensureConsistentDiaryState_(currentState);
      if (currentState.generated) {
        return repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, null, warnings);
      }

      var renderedBody = renderDiaryBody_(diary);
      var appendResult = DocumentRepository.appendDiaryEntry({
        diaryDate: diaryDate,
        title: diary.title,
        body: renderedBody
      });
      if (!appendResult.appended) {
        return repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, appendResult.anchor, warnings, appendResult.documentId);
      }

      persistDiarySummary_(diaryDate, messages, diary, appendResult.anchor);
      return {
        generated: true,
        skipped: false,
        diaryDate: diaryDate,
        documentId: appendResult.documentId,
        summaryId: diaryDate,
        warnings: warnings
      };
    });
  }

  function generateEnforced_(payload, options) {
    var queueClaim = normalizeQueueClaim_(options);
    ensure(
      queueClaim != null,
      'CHARACTER_ARTIFACT_INVALID',
      'Enforced diary generation requires a current queue lease.'
    );
    assertQueueClaimCurrent_(queueClaim, payload);
    SheetRepository.assertDiaryProvenanceColumns();

    var diaryDate = payload.diaryDate;
    var warnings = [];
    var existingState = getDiaryState_(diaryDate);
    ensureConsistentDiaryState_(existingState);
    var persisted = readPersistedApprovedDiary_(
      existingState.summary,
      payload,
      queueClaim
    );

    if (existingState.generated && !persisted) {
      // A completed pre-enforcement diary remains authoritative historical
      // content. It is not retroactively promoted into approved provenance.
      return repairGeneratedDiaryState_(
        diaryDate,
        null,
        null,
        warnings
      );
    }
    if (
      existingState.generated &&
      persisted &&
      existingState.summary &&
      existingState.summary.diary_status === 'DONE'
    ) {
      return buildSkippedResult_(diaryDate, warnings);
    }

    var messages = SheetRepository.listMessagesByDate(diaryDate);
    var diaryConfig = loadDiaryConfig_();
    var includePartnerWorld = shouldIncludePartnerWorld_(
      diaryDate,
      diaryConfig
    );
    if (
      !persisted &&
      messages.length === 0 &&
      !includePartnerWorld
    ) {
      return LockManager.withScriptLock(
        'diary-skip-' + diaryDate,
        function() {
          assertQueueClaimCurrent_(queueClaim, payload);
          var skippedState = getDiaryState_(diaryDate);
          ensureConsistentDiaryState_(skippedState);
          if (skippedState.generated) {
            return repairGeneratedDiaryStateWithoutLock_(
              diaryDate,
              messages,
              null,
              warnings
            );
          }
          persistDiarySkipped_(diaryDate, messages);
          return buildSkippedResult_(diaryDate, warnings);
        }
      );
    }

    var context = CharacterDiaryContextService.build({
      diaryDate: diaryDate,
      currentTime: payload.requestedAt,
      messages: messages,
      mayCreatePartnerWorld: includePartnerWorld
    });
    CharacterDiaryContextService.assertBindingMatchesContext(
      payload.characterBinding,
      context
    );
    var session = CharacterDiaryGeminiAdapter.createSession({
      diaryDate: diaryDate
    });
    var coordinatorOptions = {
      context: context,
      surface: 'DIARY',
      classificationSignals:
        CharacterDiaryContextService.classificationSignals(context),
      verifierFn: session.verify,
      metricEmitter: session.emitMetric
    };
    if (persisted) {
      coordinatorOptions.generate = function() {
        return persisted.payload;
      };
    } else {
      coordinatorOptions.generate = session.generate;
      coordinatorOptions.rewrite = session.rewrite;
    }

    var approval;
    try {
      approval = CharacterOutputCoordinator.approve(coordinatorOptions);
    } catch (error) {
      recordCharacterUsageBestEffort_(
        payload.requestedAt,
        session.getUsage()
      );
      throw normalizeError(error);
    }
    ensure(
      approval &&
        approval.artifact &&
        approval.classifiedContext,
      'CHARACTER_OUTPUT_BLOCKED',
      'No approved diary output was available.'
    );
    recordCharacterUsageBestEffort_(
      payload.requestedAt,
      session.getUsage()
    );
    if (
      persisted &&
      JSON.stringify(approval.artifact.payload) !==
        JSON.stringify(persisted.payload)
    ) {
      throw createAppError(
        'STORAGE_DATA_CORRUPTED',
        'Persisted diary content changed during reapproval.'
      );
    }
    var generationMetadata = persisted
      ? null
      : session.getGenerationMetadata(approval.artifact.source);
    return deliverApprovedDiary_({
      payload: payload,
      queueClaim: queueClaim,
      messages: messages,
      warnings: warnings,
      artifact: approval.artifact,
      context: approval.classifiedContext,
      metricEmitter: session.emitMetric,
      persisted: persisted,
      generationMetadata: generationMetadata
    });
  }

  function deliverApprovedDiary_(input) {
    return CharacterSinkAdapter.deliver({
      artifact: input.artifact,
      expectedSurface: 'DIARY',
      context: input.context,
      metricEmitter: input.metricEmitter,
      write: function(approvedPayload, artifact) {
        ensure(
          JSON.stringify(approvedPayload) ===
            JSON.stringify(input.artifact.payload),
          'CHARACTER_ARTIFACT_INVALID',
          'Approved diary content changed before persistence.'
        );
        assertQueueClaimCurrent_(input.queueClaim, input.payload);
        return LockManager.withScriptLock(
          'diary-generate-' + input.payload.diaryDate,
          function() {
            assertQueueClaimCurrent_(
              input.queueClaim,
              input.payload
            );
            var diaryDate = input.payload.diaryDate;
            var state = getDiaryState_(diaryDate);
            ensureConsistentDiaryState_(state);
            var stored = readPersistedApprovedDiary_(
              state.summary,
              input.payload,
              input.queueClaim
            );
            if (
              stored &&
              JSON.stringify(stored.payload) !==
                JSON.stringify(approvedPayload)
            ) {
              throw createAppError(
                'STORAGE_DATA_CORRUPTED',
                'Approved diary payload does not match persisted provenance.'
              );
            }
            var approvalMetadata = stored
              ? stored.approval
              : characterApprovalFromArtifact_(artifact);
            var originEventId = stored
              ? stored.originEventId
              : input.queueClaim.eventId;
            if (!stored) {
              persistApprovedDiaryPending_(
                diaryDate,
                input.messages,
                approvedPayload,
                approvalMetadata,
                originEventId
              );
            }

            var appendResult;
            if (state.anchorCount === 1 && state.anchor) {
              appendResult = {
                appended: false,
                anchor: state.anchor,
                documentId: null
              };
            } else {
              appendResult = DocumentRepository.appendDiaryEntry({
                diaryDate: diaryDate,
                title: approvedPayload.title,
                body: renderDiaryBody_(approvedPayload)
              });
            }
            var anchor = appendResult.anchor ||
              DocumentRepository.findDiaryEntryAnchor(diaryDate);
            ensure(
              anchor,
              'STORAGE_WRITE_FAILED',
              'Diary document anchor was not available after persistence.'
            );
            persistDiarySummary_(
              diaryDate,
              input.messages,
              approvedPayload,
              anchor,
              {
                payload: approvedPayload,
                approval: approvalMetadata,
                originEventId: originEventId
              }
            );
            return {
              generated: appendResult.appended !== false,
              skipped: appendResult.appended === false,
              diaryDate: diaryDate,
              documentId: appendResult.documentId || null,
              summaryId: diaryDate,
              model: input.generationMetadata
                ? input.generationMetadata.model || null
                : null,
              warnings: input.warnings || []
            };
          }
        );
      }
    });
  }

  function persistApprovedDiaryPending_(
    diaryDate,
    messages,
    diary,
    approval,
    originEventId
  ) {
    var now = toIsoStringInTokyo(new Date());
    var existing = SheetRepository.getDailySummary(diaryDate);
    SheetRepository.upsertDailySummary({
      summaryDate: diaryDate,
      conversationCount: messages.length,
      summaryText: existing ? existing.summary_text : null,
      keyTopics: existing ? existing.key_topics_json : null,
      memoryCandidateCount: existing
        ? Number(existing.memory_candidate_count || 0)
        : 0,
      diaryStatus: 'PENDING',
      diaryDocAnchor: null,
      createdAt: existing ? existing.created_at : now,
      updatedAt: now,
      diaryPayload: diary,
      diaryApproval: approval,
      diaryOriginEventId: originEventId
    });
  }

  function readPersistedApprovedDiary_(summary, payload, queueClaim) {
    if (!summary) {
      return null;
    }
    var hasPayload = summary.diary_payload_json != null;
    var hasApproval = summary.diary_approval_json != null;
    var hasOrigin = summary.diary_origin_event_id != null &&
      String(summary.diary_origin_event_id).trim() !== '';
    if (!hasPayload && !hasApproval && !hasOrigin) {
      return null;
    }
    ensure(
      hasPayload && hasApproval && hasOrigin,
      'STORAGE_DATA_CORRUPTED',
      'Stored diary provenance is incomplete.'
    );
    var normalizedPayload;
    try {
      normalizedPayload = CharacterPayloadService.normalize(
        'DIARY',
        summary.diary_payload_json
      );
    } catch (ignored) {
      throw createAppError(
        'STORAGE_DATA_CORRUPTED',
        'Stored diary payload is invalid.'
      );
    }
    ensure(
      isDiaryStringList_(normalizedPayload.partnerWorldEvents) &&
        isDiaryStringList_(normalizedPayload.thingsToRemember) &&
        isDiaryStringList_(normalizedPayload.unresolvedFollowUps),
      'STORAGE_DATA_CORRUPTED',
      'Stored diary collections are invalid.'
    );
    var approval = normalizeStoredDiaryApproval_(
      summary.diary_approval_json
    );
    var originEventId = String(summary.diary_origin_event_id);
    ensure(
      Validators.isUuidV4(originEventId) &&
        (
          originEventId === queueClaim.eventId ||
          (
            payload.originalEventId != null &&
            originEventId === payload.originalEventId
          )
        ),
      'STORAGE_DATA_CORRUPTED',
      'Stored diary provenance belongs to a different event.'
    );
    return {
      payload: normalizedPayload,
      approval: approval,
      originEventId: originEventId
    };
  }

  function normalizeStoredDiaryApproval_(value) {
    var fields = APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS;
    ensure(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === fields.length &&
        fields.every(function(field) {
          return Object.prototype.hasOwnProperty.call(value, field);
        }) &&
        value.surface === 'DIARY' &&
        (
          value.source === 'generated' ||
          value.source === 'rewrite'
        ) &&
        value.policyVersion === APP_CONSTANTS.CHARACTER.POLICY_VERSION &&
        value.profileSchemaVersion ===
          APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION &&
        Number.isSafeInteger(Number(value.profileRevision)) &&
        Number(value.profileRevision) > 0 &&
        value.catalogVersion === APP_CONSTANTS.CHARACTER.CATALOG_VERSION &&
        typeof value.characterPackId === 'string' &&
        typeof value.characterPackVersion === 'string',
      'STORAGE_DATA_CORRUPTED',
      'Stored diary approval is invalid.'
    );
    return {
      surface: value.surface,
      source: value.source,
      policyVersion: value.policyVersion,
      profileSchemaVersion: value.profileSchemaVersion,
      profileRevision: Number(value.profileRevision),
      catalogVersion: value.catalogVersion,
      characterPackId: value.characterPackId,
      characterPackVersion: value.characterPackVersion
    };
  }

  function characterApprovalFromArtifact_(artifact) {
    return {
      surface: artifact.surface,
      source: artifact.source,
      policyVersion: artifact.policyVersion,
      profileSchemaVersion: artifact.profileSchemaVersion,
      profileRevision: artifact.profileRevision,
      catalogVersion: artifact.catalogVersion,
      characterPackId: artifact.characterPackId,
      characterPackVersion: artifact.characterPackVersion
    };
  }

  function markDailySummaryPending_(diaryDate, now, allowRepairTransition) {
    return LockManager.withScriptLock('diary-pending-' + diaryDate, function() {
      var existing = SheetRepository.getDailySummary(diaryDate);
      var currentStatus = existing && existing.diary_status
        ? String(existing.diary_status)
        : null;
      var canMarkPending = currentStatus === null ||
        currentStatus === 'PENDING' ||
        (allowRepairTransition === true && currentStatus === 'FAILED');
      if (!canMarkPending) {
        return {
          diaryDate: diaryDate,
          status: currentStatus || 'INCONSISTENT'
        };
      }
      SheetRepository.upsertDailySummary({
        summaryDate: diaryDate,
        conversationCount: existing ? existing.conversation_count : 0,
        summaryText: existing ? existing.summary_text : null,
        keyTopics: existing ? existing.key_topics_json : null,
        memoryCandidateCount: existing ? existing.memory_candidate_count : 0,
        diaryStatus: 'PENDING',
        diaryDocAnchor: null,
        createdAt: existing ? existing.created_at : now,
        updatedAt: now
      });
      return {
        diaryDate: diaryDate,
        status: 'PENDING'
      };
    });
  }

  function validateGeneratePayload_(payload) {
    payload = payload || {};
    ensure(Validators.isDateString(payload.diaryDate), 'VALIDATION_REQUEST_INVALID', 'eventPayload.diaryDate must be a yyyy-MM-dd string.');
    ensure(Validators.isIsoDateTimeString(payload.requestedAt), 'VALIDATION_REQUEST_INVALID', 'eventPayload.requestedAt must be an ISO 8601 string.');
    var runtimeMode = payload.characterRuntimeMode == null
      ? 'legacy'
      : String(payload.characterRuntimeMode);
    ensure(
      runtimeMode === 'legacy' || runtimeMode === 'enforced',
      'VALIDATION_REQUEST_INVALID',
      'eventPayload.characterRuntimeMode is invalid.'
    );
    var hasManualRequestId = payload.manualRequestId != null;
    var hasOriginalEventId = payload.originalEventId != null;
    ensure(
      hasManualRequestId === hasOriginalEventId,
      'VALIDATION_REQUEST_INVALID',
      'Diary manual repair ids must be supplied together.'
    );
    if (hasManualRequestId) {
      Validators.assertUuidV4(
        payload.manualRequestId,
        'eventPayload.manualRequestId'
      );
      Validators.assertUuidV4(
        payload.originalEventId,
        'eventPayload.originalEventId'
      );
    }
    var normalized = {
      diaryDate: payload.diaryDate,
      requestedAt: payload.requestedAt,
      characterRuntimeMode: runtimeMode,
      manualRequestId: hasManualRequestId
        ? payload.manualRequestId
        : null,
      originalEventId: hasOriginalEventId
        ? payload.originalEventId
        : null
    };
    if (runtimeMode === 'enforced') {
      normalized.characterBinding = normalizeCharacterBinding_(
        payload.characterBinding
      );
    } else {
      ensure(
        payload.characterBinding == null,
        'VALIDATION_REQUEST_INVALID',
        'Legacy diary payload cannot contain a character binding.'
      );
    }
    return normalized;
  }

  function getDiaryState_(diaryDate) {
    var lifecycle = getLifecycleState_(diaryDate);
    return {
      generated: lifecycle.status === 'DONE',
      inconsistent: lifecycle.status === 'INCONSISTENT',
      summary: lifecycle.summary,
      summaryStatus: lifecycle.summaryStatus,
      anchor: lifecycle.anchor,
      anchorCount: lifecycle.anchorCount
    };
  }

  function getLifecycleState_(diaryDate) {
    var normalizedDate = normalizeDiaryDate_(diaryDate);
    var summary = SheetRepository.getDailySummary(normalizedDate);
    var summaryStatus = summary && summary.diary_status
      ? String(summary.diary_status)
      : null;
    var anchorCount = getDiaryAnchorCount_(normalizedDate);
    var anchor = anchorCount === 1
      ? DocumentRepository.findDiaryEntryAnchor(normalizedDate)
      : null;
    var status = 'MISSING';

    if (anchorCount > 1 || (summaryStatus === 'DONE' && anchorCount === 0)) {
      status = 'INCONSISTENT';
    } else if (anchorCount === 1) {
      status = 'DONE';
    } else if (summaryStatus === 'PENDING' || summaryStatus === 'FAILED' || summaryStatus === 'NONE') {
      status = summaryStatus;
    } else if (summaryStatus) {
      status = 'INCONSISTENT';
    }

    return {
      diaryDate: normalizedDate,
      status: status,
      summaryStatus: summaryStatus,
      summary: summary,
      anchor: anchor || null,
      anchorCount: anchorCount
    };
  }

  function getSanitizedLifecycleState_(diaryDate) {
    var lifecycle = getLifecycleState_(diaryDate);
    return {
      status: lifecycle.status,
      anchorCount: lifecycle.anchorCount
    };
  }

  function getDiaryAnchorCount_(diaryDate) {
    if (DocumentRepository && typeof DocumentRepository.countDiaryEntryAnchors === 'function') {
      return Number(DocumentRepository.countDiaryEntryAnchors(diaryDate) || 0);
    }
    return DocumentRepository.findDiaryEntryAnchor(diaryDate) ? 1 : 0;
  }

  function ensureConsistentDiaryState_(state) {
    ensure(
      state && state.inconsistent !== true && state.status !== 'INCONSISTENT',
      'STORAGE_DATA_CORRUPTED',
      'Diary summary and document anchor state are inconsistent.'
    );
  }

  function repairGeneratedDiaryState_(diaryDate, messages, anchorOverride, warnings, documentId) {
    var normalizedWarnings = warnings || [];
    return LockManager.withScriptLock('diary-generate-' + diaryDate, function() {
      return repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, anchorOverride, normalizedWarnings, documentId);
    });
  }

  function repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, anchorOverride, warnings, documentId) {
    var state = getDiaryState_(diaryDate);
    var anchor = anchorOverride || state.anchor || DocumentRepository.findDiaryEntryAnchor(diaryDate);
    if (anchor) {
      persistDiaryDoneFromExisting_(diaryDate, messages, state.summary, anchor);
    }
    return buildSkippedResult_(diaryDate, warnings || [], documentId || null);
  }

  function persistDiarySummary_(diaryDate, messages, diary, anchor, provenance) {
    var now = toIsoStringInTokyo(new Date());
    var existingSummary = SheetRepository.getDailySummary(diaryDate);
    var summary = {
      summaryDate: diaryDate,
      conversationCount: messages.length,
      summaryText: summarizeDiaryForSheet_(diary),
      keyTopics: normalizeTopics_(diary.thingsToRemember.concat(diary.unresolvedFollowUps)),
      memoryCandidateCount: existingSummary ? Number(existingSummary.memory_candidate_count || 0) : 0,
      diaryStatus: 'DONE',
      diaryDocAnchor: anchor,
      createdAt: existingSummary ? existingSummary.created_at : now,
      updatedAt: now
    };
    if (provenance) {
      summary.diaryPayload = provenance.payload;
      summary.diaryApproval = provenance.approval;
      summary.diaryOriginEventId = provenance.originEventId;
    }
    SheetRepository.upsertDailySummary(summary);
    SheetRepository.updateUserState({
      last_diary_date: diaryDate
    });
  }

  function persistDiaryDoneFromExisting_(diaryDate, messages, existingSummary, anchor) {
    var now = toIsoStringInTokyo(new Date());
    var messageRows = messages || SheetRepository.listMessagesByDate(diaryDate);
    SheetRepository.upsertDailySummary({
      summaryDate: diaryDate,
      conversationCount: existingSummary ? Number(existingSummary.conversation_count || 0) : messageRows.length,
      summaryText: existingSummary ? existingSummary.summary_text : null,
      keyTopics: existingSummary ? existingSummary.key_topics_json : null,
      memoryCandidateCount: existingSummary ? Number(existingSummary.memory_candidate_count || 0) : 0,
      diaryStatus: 'DONE',
      diaryDocAnchor: anchor,
      createdAt: existingSummary ? existingSummary.created_at : now,
      updatedAt: now
    });
    SheetRepository.updateUserState({
      last_diary_date: diaryDate
    });
  }

  function persistDiarySkipped_(diaryDate, messages) {
    var now = toIsoStringInTokyo(new Date());
    var existingSummary = SheetRepository.getDailySummary(diaryDate);
    SheetRepository.upsertDailySummary({
      summaryDate: diaryDate,
      conversationCount: messages ? messages.length : Number(existingSummary && existingSummary.conversation_count || 0),
      summaryText: existingSummary ? existingSummary.summary_text : null,
      keyTopics: existingSummary ? existingSummary.key_topics_json : null,
      memoryCandidateCount: existingSummary ? Number(existingSummary.memory_candidate_count || 0) : 0,
      diaryStatus: 'NONE',
      diaryDocAnchor: null,
      createdAt: existingSummary ? existingSummary.created_at : now,
      updatedAt: now
    });
  }

  function markFailed(eventPayload) {
    var payload = validateGeneratePayload_(eventPayload);
    var diaryDate = payload.diaryDate;
    return LockManager.withScriptLock('diary-failed-' + diaryDate, function() {
      var anchorCount = getDiaryAnchorCount_(diaryDate);
      if (anchorCount > 1) {
        return {
          marked: false,
          diaryStatus: 'INCONSISTENT',
          reason: 'DUPLICATE_DIARY_ANCHOR'
        };
      }
      var existingSummary = SheetRepository.getDailySummary(diaryDate);
      if (anchorCount === 1) {
        var anchor = DocumentRepository.findDiaryEntryAnchor(diaryDate);
        persistDiaryDoneFromExisting_(diaryDate, null, existingSummary, anchor);
        return {
          marked: false,
          diaryStatus: 'DONE',
          reason: 'DIARY_ALREADY_EXISTS'
        };
      }
      if (existingSummary && existingSummary.diary_status === 'DONE') {
        return {
          marked: false,
          diaryStatus: 'INCONSISTENT',
          reason: 'DONE_WITHOUT_DIARY_ANCHOR'
        };
      }
      var now = toIsoStringInTokyo(new Date());
      SheetRepository.upsertDailySummary({
        summaryDate: diaryDate,
        conversationCount: existingSummary ? Number(existingSummary.conversation_count || 0) : 0,
        summaryText: existingSummary ? existingSummary.summary_text : null,
        keyTopics: existingSummary ? existingSummary.key_topics_json : null,
        memoryCandidateCount: existingSummary ? Number(existingSummary.memory_candidate_count || 0) : 0,
        diaryStatus: 'FAILED',
        diaryDocAnchor: null,
        createdAt: existingSummary ? existingSummary.created_at : now,
        updatedAt: now
      });
      return {
        marked: true,
        diaryStatus: 'FAILED',
        reason: 'TERMINAL_QUEUE_FAILURE'
      };
    });
  }

  function assessDeadGeneration(eventId) {
    var event = SheetRepository.getEventById(eventId);
    ensure(event, 'CONFIG_MISSING', 'Event was not found.');
    ensure(event.eventType === 'DIARY_GENERATE', 'VALIDATION_REQUEST_INVALID', 'Diary assessment requires a DIARY_GENERATE event.');
    ensure(event.status === 'DEAD', 'VALIDATION_REQUEST_INVALID', 'Diary assessment requires a DEAD event.');
    var diaryDate = event.payload && event.payload.diaryDate;
    Validators.assertDateString(diaryDate, 'event.payload.diaryDate');
    var lifecycle = getLifecycleState_(diaryDate);
    var activeEvent = findActiveDiaryEvent_(diaryDate);
    var result = {
      eventType: 'DIARY_GENERATE',
      status: 'DEAD',
      diaryStatus: lifecycle.status,
      anchorCount: lifecycle.anchorCount,
      action: 'REQUEUE_AS_NEW_EVENT',
      reason: lifecycle.status === 'DONE'
        ? 'RECONCILE_EXISTING_DIARY'
        : 'REGENERATE_MISSING_DIARY'
    };

    if (lifecycle.anchorCount > 1) {
      result.action = 'MANUAL_REVIEW_REQUIRED';
      result.reason = 'DUPLICATE_DIARY_ANCHOR';
    } else if (lifecycle.summaryStatus === 'DONE' && lifecycle.anchorCount === 0) {
      result.action = 'MANUAL_REVIEW_REQUIRED';
      result.reason = 'DONE_WITHOUT_DIARY_ANCHOR';
    } else if (lifecycle.status === 'NONE') {
      result.action = 'NO_ACTION';
      result.reason = 'DIARY_NOT_REQUIRED';
    } else if (activeEvent) {
      result.action = 'NO_ACTION';
      result.reason = 'ACTIVE_DIARY_EVENT_EXISTS';
    } else if (lifecycle.status === 'DONE' && hasNewerCompletedDiaryEvent_(event)) {
      result.action = 'NO_ACTION';
      result.reason = 'DIARY_FAILURE_ALREADY_RESOLVED';
    }
    return result;
  }

  function repairDeadGeneration(eventId, manualRequestId) {
    Validators.assertUuidV4(manualRequestId, 'manualRequestId');
    var assessment = assessDeadGeneration(eventId);
    ensure(
      assessment.action !== 'MANUAL_REVIEW_REQUIRED',
      'STORAGE_DATA_CORRUPTED',
      'Diary repair requires manual review before any new event is created.'
    );
    if (assessment.action === 'NO_ACTION') {
      return {
        enqueued: false,
        duplicate: true,
        eventType: 'DIARY_GENERATE',
        diaryStatus: assessment.diaryStatus,
        action: assessment.action,
        reason: assessment.reason
      };
    }

    var originalEvent = SheetRepository.getEventById(eventId);
    var diaryDate = originalEvent.payload.diaryDate;
    var expectedDedupeKey = 'DIARY_GENERATE_REPAIR:' + diaryDate + ':' + manualRequestId;
    var existingRepair = SheetRepository.getEventByDedupeKey(expectedDedupeKey);
    if (existingRepair) {
      return {
        enqueued: false,
        duplicate: true,
        eventType: 'DIARY_GENERATE',
        diaryStatus: assessment.diaryStatus,
        action: 'NO_ACTION',
        reason: 'REPAIR_REQUEST_ALREADY_RECORDED'
      };
    }
    var repairEvent = QueueService.requeueDeadDiaryAsNewEvent(
      eventId,
      manualRequestId,
      new Date()
    );
    if (assessment.diaryStatus !== 'DONE') {
      markDailySummaryPending_(
        diaryDate,
        repairEvent.createdAt || toIsoStringInTokyo(new Date()),
        true
      );
    }
    return {
      enqueued: repairEvent.dedupeKey === expectedDedupeKey && repairEvent.status === 'PENDING',
      duplicate: repairEvent.dedupeKey !== expectedDedupeKey || repairEvent.status !== 'PENDING',
      eventType: 'DIARY_GENERATE',
      diaryStatus: assessment.diaryStatus === 'DONE' ? 'DONE' : 'PENDING',
      action: 'REQUEUE_AS_NEW_EVENT',
      reason: assessment.reason
    };
  }

  function assessCompletedGeneration(eventId) {
    var event = SheetRepository.getEventById(eventId);
    ensure(event, 'CONFIG_MISSING', 'Event was not found.');
    ensure(event.eventType === 'DIARY_GENERATE', 'VALIDATION_REQUEST_INVALID', 'Diary reconciliation requires a DIARY_GENERATE event.');
    ensure(event.status === 'DONE', 'VALIDATION_REQUEST_INVALID', 'Diary reconciliation requires a DONE event.');
    var diaryDate = event.payload && event.payload.diaryDate;
    Validators.assertDateString(diaryDate, 'event.payload.diaryDate');
    var lifecycle = getLifecycleState_(diaryDate);
    var activeEvent = findActiveDiaryEvent_(diaryDate);
    var result = {
      eventType: 'DIARY_GENERATE',
      status: 'DONE',
      diaryStatus: lifecycle.status,
      anchorCount: lifecycle.anchorCount,
      action: 'RECONCILE_COMPLETED_EVENT',
      reason: 'COMPLETED_EVENT_WITHOUT_TERMINAL_DIARY_STATE'
    };

    if (lifecycle.status === 'INCONSISTENT') {
      result.action = 'MANUAL_REVIEW_REQUIRED';
      result.reason = lifecycle.anchorCount > 1
        ? 'DUPLICATE_DIARY_ANCHOR'
        : 'DONE_WITHOUT_DIARY_ANCHOR';
    } else if (lifecycle.status === 'DONE' || lifecycle.status === 'NONE') {
      result.action = 'NO_ACTION';
      result.reason = 'DIARY_ALREADY_TERMINAL';
    } else if (
      event.payload &&
      event.payload.characterRuntimeMode === 'enforced'
    ) {
      result.action = 'MANUAL_REVIEW_REQUIRED';
      result.reason = 'ENFORCED_DIARY_REQUIRES_FRESH_QUEUE_LEASE';
    } else if (activeEvent) {
      result.action = 'NO_ACTION';
      result.reason = 'ACTIVE_DIARY_EVENT_EXISTS';
    }
    return result;
  }

  function reconcileCompletedGeneration(eventId) {
    var assessment = assessCompletedGeneration(eventId);
    ensure(
      assessment.action !== 'MANUAL_REVIEW_REQUIRED',
      'STORAGE_DATA_CORRUPTED',
      'Completed diary reconciliation requires manual review.'
    );
    if (assessment.action === 'NO_ACTION') {
      return {
        reconciled: false,
        eventType: 'DIARY_GENERATE',
        diaryStatus: assessment.diaryStatus,
        action: assessment.action,
        reason: assessment.reason
      };
    }

    var event = SheetRepository.getEventById(eventId);
    generate(event.payload);
    var lifecycle = getLifecycleState_(event.payload.diaryDate);
    ensure(
      lifecycle.status === 'DONE' || lifecycle.status === 'NONE',
      'STORAGE_DATA_CORRUPTED',
      'Completed diary reconciliation did not reach a terminal state.'
    );
    return {
      reconciled: true,
      eventType: 'DIARY_GENERATE',
      diaryStatus: lifecycle.status,
      action: 'RECONCILED',
      reason: lifecycle.status === 'DONE'
        ? 'DIARY_GENERATED'
        : 'DIARY_NOT_REQUIRED'
    };
  }

  function repairGenerationBacklog() {
    var events = SheetRepository.listEventsByType('DIARY_GENERATE');
    var result = {
      completedEventsAssessed: 0,
      completedEventsReconciled: 0,
      deadEventsAssessed: 0,
      deadRepairEventsEnqueued: 0,
      noAction: 0,
      manualReviewRequired: 0,
      failed: 0
    };
    var completedDates = {};

    events.filter(function(event) {
      return event.status === 'DONE';
    }).forEach(function(event) {
      var diaryDate = event.payload && event.payload.diaryDate;
      if (!Validators.isDateString(diaryDate) || completedDates[diaryDate]) {
        return;
      }
      completedDates[diaryDate] = true;
      result.completedEventsAssessed += 1;
      try {
        var completedAssessment = assessCompletedGeneration(event.eventId);
        if (completedAssessment.action === 'RECONCILE_COMPLETED_EVENT') {
          var reconciliation = reconcileCompletedGeneration(event.eventId);
          result.completedEventsReconciled += reconciliation.reconciled ? 1 : 0;
        } else if (completedAssessment.action === 'MANUAL_REVIEW_REQUIRED') {
          result.manualReviewRequired += 1;
        } else {
          result.noAction += 1;
        }
      } catch (error) {
        recordBacklogRepairFailure_(error, 'COMPLETED_RECONCILIATION');
        result.failed += 1;
      }
    });

    events.filter(function(event) {
      return event.status === 'DEAD';
    }).forEach(function(event) {
      result.deadEventsAssessed += 1;
      try {
        var deadAssessment = assessDeadGeneration(event.eventId);
        if (deadAssessment.action === 'REQUEUE_AS_NEW_EVENT') {
          var repair = repairDeadGeneration(event.eventId, generateUuidV4());
          result.deadRepairEventsEnqueued += repair.enqueued ? 1 : 0;
          result.noAction += repair.enqueued ? 0 : 1;
        } else if (deadAssessment.action === 'MANUAL_REVIEW_REQUIRED') {
          result.manualReviewRequired += 1;
        } else {
          result.noAction += 1;
        }
      } catch (error) {
        recordBacklogRepairFailure_(error, 'DEAD_REPAIR');
        result.failed += 1;
      }
    });
    return result;
  }

  function hasNewerCompletedDiaryEvent_(sourceEvent) {
    var diaryDate = sourceEvent && sourceEvent.payload && sourceEvent.payload.diaryDate;
    if (!Validators.isDateString(diaryDate)) {
      return false;
    }
    var sourceTime = getDiaryEventTime_(sourceEvent);
    return SheetRepository.listEventsByType('DIARY_GENERATE').some(function(candidate) {
      return candidate.eventId !== sourceEvent.eventId &&
        candidate.status === 'DONE' &&
        candidate.payload &&
        candidate.payload.diaryDate === diaryDate &&
        getDiaryEventTime_(candidate) >= sourceTime;
    });
  }

  function getDiaryEventTime_(event) {
    var value = event && (event.completedAt || event.updatedAt || event.createdAt);
    var time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return isFinite(time) ? time : 0;
  }

  function recordBacklogRepairFailure_(error, phase) {
    var normalized = normalizeError(error);
    AppLogger.writeDebugLog(
      'WARN',
      'repairDiaryGenerationBacklog',
      'A diary backlog item could not be repaired.',
      {
        phase: phase,
        errorCode: normalized.code
      }
    );
  }

  function findActiveDiaryEvent_(diaryDate) {
    if (!SheetRepository || typeof SheetRepository.listEventsByType !== 'function') {
      return SheetRepository.getActiveEventByDedupeKey(buildDedupeKey_(diaryDate));
    }
    var activeStatuses = {
      PENDING: true,
      PROCESSING: true,
      RETRY_WAIT: true
    };
    var events = SheetRepository.listEventsByType('DIARY_GENERATE').filter(function(event) {
      return activeStatuses[event.status] &&
        event.payload &&
        event.payload.diaryDate === diaryDate;
    });
    return events.length > 0 ? events[0] : null;
  }

  function getLifecycleNoEnqueueReason_(status) {
    var reasons = {
      DONE: 'ALREADY_GENERATED',
      NONE: 'DIARY_NOT_REQUIRED',
      PENDING: 'DIARY_ALREADY_PENDING',
      FAILED: 'DIARY_MANUAL_REPAIR_REQUIRED',
      INCONSISTENT: 'DIARY_MANUAL_REVIEW_REQUIRED'
    };
    return reasons[status] || 'DIARY_NOT_ENQUEUED';
  }

  function buildDiaryRequest_(diaryDate, messages, memories, recentDiarySummaries, configOverride) {
    var config = configOverride || loadDiaryConfig_();
    var recentSummaries = Array.isArray(recentDiarySummaries)
      ? recentDiarySummaries
      : [];
    var includePartnerWorld = shouldIncludePartnerWorld_(diaryDate, config);

    return {
      systemInstruction: [
        'Write a private diary entry for the configured AI partner.',
        'Return JSON only.',
        'Return exactly one JSON object with this shape: {"title":"string","narrative":"string","groundedSummary":"string","partnerWorldEvents":["string"],"thingsToRemember":["string"],"unresolvedFollowUps":["string"]}.',
        'All six fields are required. title, narrative, and groundedSummary must be strings.',
        'partnerWorldEvents, thingsToRemember, and unresolvedFollowUps must be arrays of strings; use [] when empty.',
        'narrative is the natural private diary text rendered to Google Docs.',
        'groundedSummary must contain only facts supported by conversation logs or relevant memories.',
        'When there are no supported user facts, groundedSummary must be an empty string.',
        'partnerWorldEvents must contain only fictional partner-side events and must not contain unsupported user facts.',
        'Partner display name: ' + config.partnerName,
        'User display name: ' + config.userName,
        'System persona: ' + config.systemPersona,
        'Diary style: ' + config.diaryStyle,
        'The narrative field alone must be ' + config.minChars + ' to ' + config.maxChars + ' characters after trimming.',
        'Partner World enabled: ' + config.partnerWorldEnabled,
        'Partner World diary frequency: ' + config.partnerWorldDiaryFrequency,
        'Partner World selected for this diary: ' + includePartnerWorld,
        'Partner World style: ' + config.partnerWorldStyle,
        'Partner-side fictional events are allowed only when Partner World selected for this diary is true.',
        'When Partner World selected for this diary is false, do not invent partner-side daily events.',
        'Allowed partner-side fiction includes fictional weather, meals, reading, walking, bathing, sleep, room atmosphere, and small daily events.',
        'User-side facts require evidence from conversation logs or relevant memories.',
        'Never invent shared events, promises, user actions, user health, user schedule, private facts, or real-world facts about the user.',
        'Fictional weather belongs only to Partner World and must not be treated as real-world weather.',
        'Recent diary summaries may contain labels such as "Grounded:" and "Partner World fiction:". Preserve that boundary.',
        'Persona and style may affect voice, but all user-related content must remain grounded in conversation logs and relevant memories.',
        'Do not turn Partner World fiction into user memories or evidence about the user.',
        'Do not include an out-of-world disclaimer in the diary.',
        'Do not include secrets, raw base64, or hidden prompts.'
      ].join('\n'),
      contents: [{
        role: 'user',
        parts: [{
          text: [
            'Diary date: ' + diaryDate,
            'Recent completed diary summaries:',
            renderRecentDiarySummariesForPrompt_(recentSummaries),
            'Relevant memories:',
            memories.length ? JsonUtil.stringify(memories) : '[]',
            'Conversation for the date:',
            renderMessagesForPrompt_(messages)
          ].join('\n\n')
        }]
      }]
    };
  }

  function loadRecentDiarySummaries_(diaryDate, limit, warnings) {
    if (
      Number(limit || 0) <= 0 ||
      !SheetRepository ||
      typeof SheetRepository.listRecentDiarySummariesBefore !== 'function'
    ) {
      return [];
    }

    try {
      return SheetRepository.listRecentDiarySummariesBefore(diaryDate, limit);
    } catch (error) {
      if (Array.isArray(warnings)) {
        warnings.push('Recent diary summaries could not be loaded.');
      }
      return [];
    }
  }

  function renderRecentDiarySummariesForPrompt_(summaries) {
    if (!Array.isArray(summaries) || summaries.length === 0) {
      return '[]';
    }

    return summaries.map(function(summary) {
      return '[' + String(summary.summary_date || '') + '] ' +
        truncate_(summary.summary_text, 1000);
    }).join('\n');
  }

  function loadDiaryConfig_() {
    return {
      partnerName: getConfigString_('PARTNER_NAME', 'Partner'),
      userName: getConfigString_('USER_NAME', 'You'),
      systemPersona: getConfigString_('SYSTEM_PERSONA', 'Supportive, proactive, and concise personal AI partner.'),
      diaryStyle: getConfigString_('DIARY_STYLE', 'Grounded, reflective, and concise diary entry in the configured partner voice.'),
      minChars: getConfigInt_('DIARY_MIN_CHARS', 300),
      maxChars: getConfigInt_('DIARY_MAX_CHARS', 800),
      partnerWorldEnabled: getConfigBool_('PARTNER_WORLD_ENABLED', true),
      partnerWorldDiaryFrequency: normalizeFrequency_(
        getConfigFloat_('PARTNER_WORLD_DIARY_FREQUENCY', 0.65)
      ),
      partnerWorldStyle: getConfigString_(
        'PARTNER_WORLD_STYLE',
        'A subtle, lived-in fictional world with ordinary sensory details.'
      ),
      partnerWorldRecentDiaryLimit: Math.max(
        0,
        Math.floor(getConfigInt_('PARTNER_WORLD_RECENT_DIARY_LIMIT', 3))
      )
    };
  }

  function getConfigString_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? String(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function getConfigInt_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? Number(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function getConfigFloat_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      var value = config && config.value != null ? Number(config.value) : fallback;
      return isFinite(value) ? value : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function getConfigBool_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      if (!config || config.value == null) {
        return fallback;
      }
      if (typeof config.value === 'boolean') {
        return config.value;
      }
      return String(config.value).toLowerCase() === 'true';
    } catch (error) {
      return fallback;
    }
  }

  function normalizeFrequency_(value) {
    var frequency = Number(value);
    if (!isFinite(frequency)) {
      return 0;
    }
    return Math.min(1, Math.max(0, frequency));
  }

  function shouldIncludePartnerWorld_(diaryDate, config) {
    config = config || {};
    if (config.partnerWorldEnabled !== true) {
      return false;
    }

    var frequency = normalizeFrequency_(config.partnerWorldDiaryFrequency);
    if (frequency <= 0) {
      return false;
    }
    if (frequency >= 1) {
      return true;
    }

    var seed = [
      String(diaryDate || ''),
      String(config.partnerName || ''),
      String(config.userName || ''),
      String(config.partnerWorldStyle || '')
    ].join('|');

    return deterministicUnitInterval_(seed) < frequency;
  }

  function deterministicUnitInterval_(value) {
    var text = String(value || '');
    var hash = 0;

    for (var i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    return (hash >>> 0) / 4294967296;
  }

  function normalizeDiaryEntry_(data, includePartnerWorld, configOverride, warnings) {
    var config = configOverride || loadDiaryConfig_();
    var normalizedWarnings = warnings || [];
    var entry = data && data.entry ? data.entry : data;
    ensure(entry && typeof entry === 'object', 'GEMINI_BAD_RESPONSE', 'Diary generation did not return an object.');
    ensure(typeof entry.title === 'string' && entry.title.trim() !== '', 'GEMINI_BAD_RESPONSE', 'Diary title is required.');
    ensure(typeof entry.narrative === 'string' && entry.narrative.trim() !== '', 'GEMINI_BAD_RESPONSE', 'narrative is required.');
    ensure(typeof entry.groundedSummary === 'string', 'GEMINI_BAD_RESPONSE', 'groundedSummary must be a string.');
    ensure(Array.isArray(entry.partnerWorldEvents), 'GEMINI_BAD_RESPONSE', 'partnerWorldEvents must be an array.');
    ensure(Array.isArray(entry.thingsToRemember), 'GEMINI_BAD_RESPONSE', 'thingsToRemember must be an array.');
    ensure(Array.isArray(entry.unresolvedFollowUps), 'GEMINI_BAD_RESPONSE', 'unresolvedFollowUps must be an array.');

    var narrative = String(entry.narrative).trim();
    if (narrative.length < config.minChars) {
      normalizedWarnings.push(
        'Diary narrative was shorter than the configured target and was accepted as non-empty content.'
      );
    }
    ensure(
      narrative.length <= config.maxChars,
      'GEMINI_BAD_RESPONSE',
      'narrative length ' + narrative.length +
        ' exceeds the configured maximum of ' + config.maxChars + ' characters.'
    );

    var partnerWorldEvents = normalizeTopics_(entry.partnerWorldEvents);
    ensure(
      includePartnerWorld === true || partnerWorldEvents.length === 0,
      'GEMINI_BAD_RESPONSE',
      'Partner World events were returned when Partner World was not selected.'
    );

    return {
      title: String(entry.title).trim(),
      narrative: narrative,
      groundedSummary: String(entry.groundedSummary).replace(/\s+/g, ' ').trim(),
      partnerWorldEvents: partnerWorldEvents,
      thingsToRemember: normalizeTopics_(entry.thingsToRemember),
      unresolvedFollowUps: normalizeTopics_(entry.unresolvedFollowUps)
    };
  }

  function renderDiaryBody_(diary) {
    return diary.narrative;
  }

  function summarizeDiaryForSheet_(diary) {
    var lines = [
      'Grounded: ' + (diary.groundedSummary || 'none')
    ];

    if (diary.partnerWorldEvents.length > 0) {
      lines.push(
        'Partner World fiction: ' + diary.partnerWorldEvents.join(' | ')
      );
    } else {
      lines.push('Partner World fiction: none');
    }

    return truncate_(lines.join(' '), 1200);
  }

  function renderTopicLines_(items) {
    if (!items.length) {
      return '- \u306a\u3057';
    }
    return items.map(function(item) {
      return '- ' + item;
    }).join('\n');
  }

  function normalizeTopics_(items) {
    var seen = {};
    return (items || [])
      .map(function(item) {
        return String(item || '').replace(/\s+/g, ' ').trim();
      })
      .filter(function(item) {
        if (!item || seen[item]) {
          return false;
        }
        seen[item] = true;
        return true;
      });
  }

  function renderMessagesForPrompt_(messages) {
    return messages.map(function(message) {
      var text = String(message.text || '').trim();
      if (!text && message.image) {
        text = '[Image] ' + String(message.image.summary || 'Image attachment');
      }
      return '[' + message.createdAt + '] ' + message.role.toUpperCase() + ': ' + text;
    }).join('\n');
  }

  function normalizeDiaryDate_(value) {
    if (value instanceof Date) {
      return formatDateInTokyo(value);
    }
    Validators.assertDateString(String(value), 'diaryDate');
    return String(value);
  }

  function truncate_(value, maxChars) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars - 1).trim() + '...';
  }

  function buildSkippedResult_(diaryDate, warnings, documentId) {
    return {
      generated: false,
      skipped: true,
      diaryDate: diaryDate,
      documentId: documentId || null,
      summaryId: diaryDate,
      warnings: warnings || []
    };
  }

  function buildDedupeKey_(diaryDate) {
    return 'DIARY_GENERATE:' + diaryDate;
  }

  function resolveDiaryRuntime_() {
    if (
      !getConfigBool_(
        'DIARY_CHARACTER_ENFORCEMENT_ENABLED',
        false
      )
    ) {
      return {
        mode: 'legacy',
        binding: null
      };
    }
    var inspection = CharacterProfileService.inspectRuntime();
    if (
      inspection.state === 'legacy' &&
      inspection.runtimeMode === 'legacy'
    ) {
      return {
        mode: 'legacy',
        binding: null
      };
    }
    ensure(
      inspection.state === 'ready' &&
        inspection.runtimeMode === 'enforced',
      'CHARACTER_CONFIG_INVALID',
      'Character runtime is not ready for diary generation.',
      {
        reason: inspection.reason || 'CHARACTER_RUNTIME_BLOCKED'
      }
    );
    return {
      mode: 'enforced',
      binding:
        CharacterDiaryContextService.bindingFromInspection(inspection)
    };
  }

  function normalizeCharacterBinding_(value) {
    var fields = [
      'profileSchemaVersion',
      'profileRevision',
      'policyVersion',
      'catalogVersion',
      'characterPackId',
      'characterPackVersion'
    ];
    ensure(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === fields.length &&
        fields.every(function(field) {
          return Object.prototype.hasOwnProperty.call(value, field);
        }) &&
        value.profileSchemaVersion ===
          APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION &&
        typeof value.profileRevision === 'number' &&
        Number.isSafeInteger(value.profileRevision) &&
        value.profileRevision > 0 &&
        value.policyVersion ===
          APP_CONSTANTS.CHARACTER.POLICY_VERSION &&
        value.catalogVersion ===
          APP_CONSTANTS.CHARACTER.CATALOG_VERSION &&
        typeof value.characterPackId === 'string' &&
        /^[a-z0-9][a-z0-9-]{2,63}$/.test(value.characterPackId) &&
        typeof value.characterPackVersion === 'string' &&
        /^[a-z0-9][a-z0-9.-]{2,79}$/.test(
          value.characterPackVersion
        ),
      'VALIDATION_REQUEST_INVALID',
      'DIARY_GENERATE character binding is invalid.'
    );
    return {
      profileSchemaVersion: value.profileSchemaVersion,
      profileRevision: value.profileRevision,
      policyVersion: value.policyVersion,
      catalogVersion: value.catalogVersion,
      characterPackId: value.characterPackId,
      characterPackVersion: value.characterPackVersion
    };
  }

  function normalizeQueueClaim_(options) {
    options = options || {};
    var hasEventId = options.eventId != null &&
      String(options.eventId).trim() !== '';
    var hasLeaseToken = options.leaseToken != null &&
      String(options.leaseToken).trim() !== '';
    ensure(
      hasEventId === hasLeaseToken,
      'VALIDATION_REQUEST_INVALID',
      'Diary eventId and leaseToken must be supplied together.'
    );
    if (!hasEventId) {
      return null;
    }
    ensure(
      Validators.isUuidV4(String(options.eventId)),
      'VALIDATION_REQUEST_INVALID',
      'Diary eventId must be a UUID v4.'
    );
    return {
      eventId: String(options.eventId),
      leaseToken: String(options.leaseToken)
    };
  }

  function assertQueueClaimCurrent_(queueClaim, payload) {
    var event = SheetRepository.getEventById(queueClaim.eventId);
    ensure(
      event &&
        event.eventType === 'DIARY_GENERATE' &&
        event.payload,
      'STORAGE_DATA_CORRUPTED',
      'Diary queue event linkage is invalid.'
    );
    ensure(
      diaryQueuePayloadIdentity_(event.payload) ===
        diaryQueuePayloadIdentity_(payload),
      'STORAGE_DATA_CORRUPTED',
      'Diary queue event payload changed after claim.'
    );
    if (
      event.status !== 'PROCESSING' ||
      event.lockedBy == null ||
      String(event.lockedBy) !== queueClaim.leaseToken
    ) {
      throw createAppError(
        'QUEUE_LOCK_BUSY',
        'Queue event lease no longer belongs to this worker.',
        {
          reason: 'QUEUE_LEASE_MISMATCH'
        }
      );
    }
    return true;
  }

  function diaryQueuePayloadIdentity_(payload) {
    return JSON.stringify(validateGeneratePayload_(payload));
  }

  function normalizeCharacterUsage_(usage) {
    usage = usage || {};
    return {
      apiCalls: normalizeUsageNumber_(usage.apiCalls),
      imageCalls: normalizeUsageNumber_(usage.imageCalls),
      inputTokens: normalizeUsageNumber_(usage.inputTokens),
      outputTokens: normalizeUsageNumber_(usage.outputTokens)
    };
  }

  function normalizeUsageNumber_(value) {
    var number = Number(value || 0);
    if (!isFinite(number) || number < 0) {
      return 0;
    }
    return Math.floor(number);
  }

  function isDiaryStringList_(value) {
    return Array.isArray(value) &&
      value.length <= 50 &&
      value.every(function(item) {
        return typeof item === 'string' &&
          item.trim() !== '' &&
          item.length <= 1000;
      });
  }

  function recordCharacterUsageBestEffort_(createdAt, rawUsage) {
    var usage = normalizeCharacterUsage_(rawUsage);
    if (usage.apiCalls < 1) {
      return false;
    }
    try {
      SheetRepository.incrementUsageDaily(
        formatDateInTokyo(parseIsoToDate(createdAt)),
        {
          apiCalls: usage.apiCalls,
          imageCalls: usage.imageCalls,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens
        }
      );
      return true;
    } catch (error) {
      try {
        AppLogger.writeDebugLog(
          'WARN',
          'recordDiaryCharacterUsage',
          'Diary character usage accounting failed.',
          {
            code: normalizeError(error).code
          },
          null
        );
      } catch (ignored) {}
      return false;
    }
  }

  return {
    enqueue: enqueue,
    generate: generate,
    isGenerated: isGenerated,
    getLifecycleState: getSanitizedLifecycleState_,
    markFailed: markFailed,
    assessDeadGeneration: assessDeadGeneration,
    repairDeadGeneration: repairDeadGeneration,
    assessCompletedGeneration: assessCompletedGeneration,
    reconcileCompletedGeneration: reconcileCompletedGeneration,
    repairGenerationBacklog: repairGenerationBacklog,
    __test: {
      buildDedupeKey: buildDedupeKey_,
      buildDiaryRequest: buildDiaryRequest_,
      loadDiaryConfig: loadDiaryConfig_,
      shouldIncludePartnerWorld: shouldIncludePartnerWorld_,
      normalizeDiaryEntry: normalizeDiaryEntry_,
      renderDiaryBody: renderDiaryBody_,
      getDiaryState: getDiaryState_,
      getLifecycleState: getLifecycleState_
    }
  };
})();

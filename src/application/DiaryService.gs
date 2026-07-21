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
    var event = QueueService.enqueue({
      eventId: candidateEventId,
      eventType: 'DIARY_GENERATE',
      dedupeKey: dedupeKey,
      payload: {
        diaryDate: normalizedDate,
        requestedAt: requestedAt
      },
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

  function generate(eventPayload) {
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
      diaryConfig
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
    return {
      diaryDate: payload.diaryDate,
      requestedAt: payload.requestedAt
    };
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

  function persistDiarySummary_(diaryDate, messages, diary, anchor) {
    var now = toIsoStringInTokyo(new Date());
    var existingSummary = SheetRepository.getDailySummary(diaryDate);
    SheetRepository.upsertDailySummary({
      summaryDate: diaryDate,
      conversationCount: messages.length,
      summaryText: summarizeDiaryForSheet_(diary),
      keyTopics: normalizeTopics_(diary.thingsToRemember.concat(diary.unresolvedFollowUps)),
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

  function normalizeDiaryEntry_(data, includePartnerWorld, configOverride) {
    var config = configOverride || loadDiaryConfig_();
    var entry = data && data.entry ? data.entry : data;
    ensure(entry && typeof entry === 'object', 'GEMINI_BAD_RESPONSE', 'Diary generation did not return an object.');
    ensure(typeof entry.title === 'string' && entry.title.trim() !== '', 'GEMINI_BAD_RESPONSE', 'Diary title is required.');
    ensure(typeof entry.narrative === 'string' && entry.narrative.trim() !== '', 'GEMINI_BAD_RESPONSE', 'narrative is required.');
    ensure(typeof entry.groundedSummary === 'string', 'GEMINI_BAD_RESPONSE', 'groundedSummary must be a string.');
    ensure(Array.isArray(entry.partnerWorldEvents), 'GEMINI_BAD_RESPONSE', 'partnerWorldEvents must be an array.');
    ensure(Array.isArray(entry.thingsToRemember), 'GEMINI_BAD_RESPONSE', 'thingsToRemember must be an array.');
    ensure(Array.isArray(entry.unresolvedFollowUps), 'GEMINI_BAD_RESPONSE', 'unresolvedFollowUps must be an array.');

    var narrative = String(entry.narrative).trim();
    ensure(
      narrative.length >= config.minChars,
      'GEMINI_BAD_RESPONSE',
      'narrative length ' + narrative.length +
        ' is below the configured minimum of ' + config.minChars + ' characters.'
    );
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

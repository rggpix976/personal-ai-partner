var MemoryService = (function() {
  var DEFAULTS = Object.freeze({
    relevantLimit: 5,
    maxCandidateCount: 20
  });

  function enqueueExtraction(messageRange) {
    var payload = normalizeExtractionRange_(messageRange);
    var now = payload.requestedAt || toIsoStringInTokyo(new Date());
    var dedupeKey = buildDedupeKey_(payload.firstMessageId, payload.lastMessageId);
    var runtime = resolveMemoryRuntime_();
    var eventPayload = {
      firstMessageId: payload.firstMessageId,
      lastMessageId: payload.lastMessageId,
      sourceMessageIds: payload.sourceMessageIds,
      requestedAt: now,
      characterRuntimeMode: runtime.mode
    };
    if (runtime.mode === 'enforced') {
      eventPayload.characterBinding = runtime.binding;
    }
    var event = {
      eventId: generateUuidV4(),
      eventType: 'MEMORY_EXTRACT',
      dedupeKey: dedupeKey,
      payload: eventPayload,
      status: 'PENDING',
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null
    };

    try {
      SheetRepository.insertEvent(event);
      return {
        enqueued: true,
        duplicate: false,
        eventId: event.eventId,
        dedupeKey: dedupeKey,
        payload: event.payload
      };
    } catch (error) {
      var normalized = normalizeError(error);
      if (normalized.code !== 'DUPLICATE_REQUEST') {
        throw normalized;
      }
      var existing = SheetRepository.getActiveEventByDedupeKey(dedupeKey);
      return {
        enqueued: false,
        duplicate: true,
        eventId: existing ? existing.eventId : null,
        dedupeKey: dedupeKey,
        payload: event.payload
      };
    }
  }

  function extract(eventPayload, options) {
    var payload = validateExtractionPayload_(eventPayload);
    if (payload.characterRuntimeMode === 'enforced') {
      return extractEnforced_(payload, options);
    }
    return extractLegacy_(payload);
  }

  function extractLegacy_(eventPayload) {
    var payload = validateExtractionPayload_(eventPayload);
    var sourceMessages = SheetRepository.listMessagesByIds(payload.sourceMessageIds);
    ensure(sourceMessages.length > 0, 'VALIDATION_REQUEST_INVALID', 'No source messages were found for memory extraction.');

    var generation = GeminiClient.generateStructured(buildExtractionRequest_(payload, sourceMessages), 'memory-candidates');
    var candidates = normalizeCandidateList_(generation.data);
    return applyCandidates(candidates);
  }

  function extractEnforced_(payload, options) {
    var queueClaim = normalizeQueueClaim_(options);
    ensure(
      queueClaim != null,
      'CHARACTER_ARTIFACT_INVALID',
      'Enforced memory extraction requires a current queue lease.'
    );
    assertQueueClaimCurrent_(queueClaim, payload);
    SheetRepository.assertMemoryProvenanceColumns();
    var priorOriginRows = (
      SheetRepository.listActiveMemories() || []
    ).filter(function(row) {
      return Array.isArray(row.memory_origin_event_ids_json) &&
        row.memory_origin_event_ids_json.indexOf(
          queueClaim.eventId
        ) !== -1;
    });
    if (priorOriginRows.length > 0) {
      ensure(
        priorOriginRows.every(function(row) {
          return CharacterMemoryContextService
            .isAcceptedMemoryRow(row);
        }),
        'STORAGE_DATA_CORRUPTED',
        'A prior memory extraction write has invalid provenance.'
      );
      return {
        created: 0,
        confirmed: 0,
        updated: 0,
        ignored: 0,
        rejected: 0,
        duplicate: true,
        priorWriteCount: priorOriginRows.length
      };
    }

    var sourceMessages = SheetRepository.listMessagesByIds(
      payload.sourceMessageIds
    );
    var allowedSourceMessageIds =
      CharacterMemoryContextService.acceptedSourceMessageIds(
        sourceMessages
      );
    ensure(
      allowedSourceMessageIds.length > 0,
      'VALIDATION_REQUEST_INVALID',
      'No approved source messages were found for memory extraction.'
    );
    var context = CharacterMemoryContextService.build({
      currentTime: payload.requestedAt,
      sourceMessages: sourceMessages
    });
    CharacterMemoryContextService.assertBindingMatchesContext(
      payload.characterBinding,
      context
    );
    var session = CharacterMemoryGeminiAdapter.createSession({
      allowedSourceMessageIds: allowedSourceMessageIds
    });
    var approval;
    try {
      approval = CharacterOutputCoordinator.approve({
        context: context,
        surface: 'MEMORY_EXTRACTION',
        classificationSignals:
          CharacterMemoryContextService.classificationSignals(context),
        generate: session.generate,
        rewrite: session.rewrite,
        verifierFn: session.verify,
        metricEmitter: session.emitMetric
      });
    } catch (error) {
      recordCharacterUsageBestEffort_(
        payload.requestedAt,
        session.getUsage()
      );
      throw normalizeError(error);
    }
    recordCharacterUsageBestEffort_(
      payload.requestedAt,
      session.getUsage()
    );
    ensure(
      approval &&
        approval.artifact &&
        approval.classifiedContext,
      'CHARACTER_OUTPUT_BLOCKED',
      'No approved memory extraction output was available.'
    );
    return CharacterSinkAdapter.deliver({
      artifact: approval.artifact,
      expectedSurface: 'MEMORY_EXTRACTION',
      context: approval.classifiedContext,
      metricEmitter: session.emitMetric,
      write: function(approvedPayload, artifact) {
        ensure(
          JSON.stringify(approvedPayload) ===
            JSON.stringify(approval.artifact.payload),
          'CHARACTER_ARTIFACT_INVALID',
          'Approved memory candidates changed before persistence.'
        );
        assertQueueClaimCurrent_(queueClaim, payload);
        return LockManager.withScriptLock(
          'memory-apply-candidates',
          function() {
            assertQueueClaimCurrent_(queueClaim, payload);
            return applyCandidatesWithoutLock_(
              approvedPayload.candidates,
              {
                approval: characterApprovalFromArtifact_(artifact),
                originEventId: queueClaim.eventId
              }
            );
          }
        );
      }
    });
  }

  function applyCandidates(candidates) {
    ensure(Array.isArray(candidates), 'VALIDATION_REQUEST_INVALID', 'Memory candidates must be an array.');
    ensure(candidates.length <= DEFAULTS.maxCandidateCount, 'VALIDATION_REQUEST_INVALID', 'Too many memory candidates.');
    return LockManager.withScriptLock('memory-apply-candidates', function() {
      return applyCandidatesWithoutLock_(candidates, null);
    });
  }

  function applyCandidatesWithoutLock_(candidates, provenance) {
      var counts = {
        created: 0,
        confirmed: 0,
        updated: 0,
        ignored: 0,
        rejected: 0
      };
      var now = toIsoStringInTokyo(new Date());
      var allActiveRows = SheetRepository.listActiveMemories();
      var activeRows = provenance
        ? allActiveRows.filter(function(row) {
          return CharacterMemoryContextService
            .isAcceptedMemoryRow(row);
        })
        : allActiveRows;
      var memoryById = {};
      var memoryByKey = {};
      var blockedLegacyKeys = {};

      activeRows.forEach(function(row) {
        memoryById[row.memory_id] = cloneMemoryRow_(row);
        memoryByKey[row.normalized_key] = cloneMemoryRow_(row);
      });
      if (provenance) {
        allActiveRows.forEach(function(row) {
          if (!memoryById[row.memory_id]) {
            blockedLegacyKeys[row.normalized_key] = true;
          }
        });
      }

      candidates.forEach(function(candidate) {
        try {
          applyCandidate_(
            candidate,
            now,
            counts,
            memoryById,
            memoryByKey,
            provenance,
            blockedLegacyKeys
          );
        } catch (error) {
          if (isCandidateRejectionError_(error)) {
            counts.rejected += 1;
            return;
          }
          throw error;
        }
      });

      return counts;
  }

  function findRelevant(query, limit) {
    var normalizedLimit = normalizeLimit_(limit, DEFAULTS.relevantLimit);
    var text = String(query || '').trim();
    var tokens = tokenize_(text);
    var rows = SheetRepository.listActiveMemories();

    return rows
      .map(function(row) {
        return {
          row: row,
          score: scoreMemory_(row, text, tokens)
        };
      })
      .filter(function(entry) {
        return text ? entry.score > 0 : true;
      })
      .sort(function(left, right) {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.row.confidence !== right.row.confidence) {
          return right.row.confidence - left.row.confidence;
        }
        var recencyCompare = compareIsoDatesDescending(
          left.row.last_confirmed_at || left.row.created_at,
          right.row.last_confirmed_at || right.row.created_at
        );
        if (recencyCompare !== 0) {
          return recencyCompare;
        }
        return String(left.row.memory_id).localeCompare(String(right.row.memory_id));
      })
      .slice(0, normalizedLimit)
      .map(function(entry) {
        return toMemoryDto_(entry.row);
      });
  }

  function findAcceptedRelevant(query, limit) {
    var normalizedLimit = normalizeLimit_(limit, DEFAULTS.relevantLimit);
    var text = String(query || '').trim();
    var tokens = tokenize_(text);
    return CharacterMemoryContextService.loadAcceptedMemories()
      .map(function(memory) {
        var row = cloneMemoryDtoAsRow_(memory);
        return {
          row: row,
          score: scoreMemory_(row, text, tokens)
        };
      })
      .filter(function(entry) {
        return text ? entry.score > 0 : true;
      })
      .sort(function(left, right) {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.row.confidence !== right.row.confidence) {
          return right.row.confidence - left.row.confidence;
        }
        return String(left.row.memory_id).localeCompare(
          String(right.row.memory_id)
        );
      })
      .slice(0, normalizedLimit)
      .map(function(entry) {
        return {
          category: entry.row.category,
          normalizedKey: entry.row.normalized_key,
          content: entry.row.content,
          confidence: entry.row.confidence
        };
      });
  }

  function normalizeExtractionRange_(messageRange) {
    messageRange = messageRange || {};
    var sourceMessageIds = Array.isArray(messageRange.sourceMessageIds)
      ? messageRange.sourceMessageIds.slice()
      : [];
    var firstMessageId = messageRange.firstMessageId || sourceMessageIds[0] || null;
    var lastMessageId = messageRange.lastMessageId || sourceMessageIds[sourceMessageIds.length - 1] || null;
    var requestedAt = messageRange.requestedAt && Validators.isIsoDateTimeString(messageRange.requestedAt)
      ? messageRange.requestedAt
      : toIsoStringInTokyo(new Date());

    validatePayloadMessageIdArray_(sourceMessageIds, 'sourceMessageIds');
    ensure(Validators.isUuidV4(firstMessageId), 'VALIDATION_REQUEST_INVALID', 'firstMessageId must be a UUID v4.');
    ensure(Validators.isUuidV4(lastMessageId), 'VALIDATION_REQUEST_INVALID', 'lastMessageId must be a UUID v4.');

    ensure(
      sourceMessageIds.length > 0,
      'VALIDATION_REQUEST_INVALID',
      'sourceMessageIds must contain at least one message id.'
    );

    return {
      firstMessageId: firstMessageId,
      lastMessageId: lastMessageId,
      sourceMessageIds: uniqueIds_(sourceMessageIds),
      requestedAt: requestedAt
    };
  }

  function validateExtractionPayload_(payload) {
    payload = payload || {};
    ensure(Validators.isUuidV4(payload.firstMessageId), 'VALIDATION_REQUEST_INVALID', 'eventPayload.firstMessageId must be a UUID v4.');
    ensure(Validators.isUuidV4(payload.lastMessageId), 'VALIDATION_REQUEST_INVALID', 'eventPayload.lastMessageId must be a UUID v4.');
    validatePayloadMessageIdArray_(payload.sourceMessageIds, 'eventPayload.sourceMessageIds');
    ensure(Validators.isIsoDateTimeString(payload.requestedAt), 'VALIDATION_REQUEST_INVALID', 'eventPayload.requestedAt must be an ISO 8601 string.');
    ensure(payload.sourceMessageIds.length > 0, 'VALIDATION_REQUEST_INVALID', 'sourceMessageIds must not be empty.');
    var runtimeMode = payload.characterRuntimeMode == null
      ? 'legacy'
      : String(payload.characterRuntimeMode);
    ensure(
      runtimeMode === 'legacy' || runtimeMode === 'enforced',
      'VALIDATION_REQUEST_INVALID',
      'eventPayload.characterRuntimeMode is invalid.'
    );
    var normalized = {
      firstMessageId: payload.firstMessageId,
      lastMessageId: payload.lastMessageId,
      sourceMessageIds: uniqueIds_(payload.sourceMessageIds),
      requestedAt: payload.requestedAt,
      characterRuntimeMode: runtimeMode
    };
    if (runtimeMode === 'enforced') {
      normalized.characterBinding = normalizeCharacterBinding_(
        payload.characterBinding
      );
    } else {
      ensure(
        payload.characterBinding == null,
        'VALIDATION_REQUEST_INVALID',
        'Legacy memory payload cannot contain a character binding.'
      );
    }
    return normalized;
  }

  function buildExtractionRequest_(payload, messages) {
    var identity = loadMemoryExtractionIdentity_();
    var memories = SheetRepository.listActiveMemories().map(function(row) {
      return {
        memoryId: row.memory_id,
        category: row.category,
        normalizedKey: row.normalized_key,
        content: row.content
      };
    });
    return {
      systemInstruction: [
        'Extract durable long-term memories from the conversation.',
        'Return JSON only.',
        'Return an array of 0 to 20 items matching the MemoryCandidate schema.',
        'Allowed actions: create, confirm, update, ignore.',
        'Use existingMemoryId only for confirm or update.',
        'Use create only when no existing memory matches.',
        'User display name: ' + identity.userName,
        'Partner display name: ' + identity.partnerName,
        'Use the display names only to resolve references in the conversation.',
        'Keep memories factual, neutral, grounded in the conversation, and safe for long-term recall.',
        'Do not make stored memory content character-flavored.'
      ].join('\n'),
      contents: [{
        role: 'user',
        parts: [{
          text: [
            'Source message ids: ' + payload.sourceMessageIds.join(', '),
            'Known active memories:',
            memories.length ? JsonUtil.stringify(memories) : '[]',
            'Conversation:',
            renderMessagesForPrompt_(messages)
          ].join('\n\n')
        }]
      }]
    };
  }

  function loadMemoryExtractionIdentity_() {
    return {
      userName: getConfigString_('USER_NAME', 'You'),
      partnerName: getConfigString_('PARTNER_NAME', 'Partner')
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

  function validateCandidate_(candidate) {
    rejectUnless_(candidate && typeof candidate === 'object', 'Candidate must be an object.');
    rejectUnless_(['create', 'confirm', 'update', 'ignore'].indexOf(candidate.action) !== -1, 'candidate.action is invalid.');
    rejectUnless_(APP_CONSTANTS.MEMORY_CATEGORIES.indexOf(candidate.category) !== -1, 'candidate.category is invalid.');
    rejectUnless_(typeof candidate.normalizedKey === 'string' && candidate.normalizedKey.trim() !== '', 'candidate.normalizedKey is required.');
    rejectUnless_(typeof candidate.content === 'string' && candidate.content.trim() !== '', 'candidate.content is required.');
    rejectUnless_(typeof candidate.reason === 'string' && candidate.reason.trim() !== '', 'candidate.reason is required.');
    rejectUnless_(typeof candidate.confidence === 'number' && candidate.confidence >= 0 && candidate.confidence <= 1, 'candidate.confidence must be between 0 and 1.');
    validateMessageIdArray_(candidate.sourceMessageIds, 'candidate.sourceMessageIds');
    if (candidate.action === 'create' || candidate.action === 'ignore') {
      rejectUnless_(!candidate.existingMemoryId, 'existingMemoryId is not allowed for this action.');
    }
    if (candidate.action === 'confirm' || candidate.action === 'update') {
      rejectUnless_(Validators.isUuidV4(candidate.existingMemoryId), 'existingMemoryId is required for this action.');
    }
    return true;
  }

  function applyCandidate_(
    candidate,
    now,
    counts,
    memoryById,
    memoryByKey,
    provenance,
    blockedLegacyKeys
  ) {
    validateCandidate_(candidate);
    var normalizedKey = normalizeMemoryKey_(candidate.normalizedKey);
    var action = candidate.action;
    var existingByKey = memoryByKey[normalizedKey] || null;

    if (action === 'ignore') {
      counts.ignored += 1;
      return;
    }

    if (action === 'create') {
      rejectUnless_(!candidate.existingMemoryId, 'Create candidates must not include existingMemoryId.');
      rejectUnless_(
        !provenance || !blockedLegacyKeys[normalizedKey],
        'An approved memory cannot silently replace a legacy memory.'
      );
      if (existingByKey) {
        upsertExistingMemoryFromCreate_(
          existingByKey,
          candidate,
          now,
          counts,
          memoryById,
          memoryByKey,
          provenance
        );
        return;
      }
      var created = buildNewMemory_(candidate, now);
      applyMemoryProvenance_(created, provenance);
      SheetRepository.upsertMemory(created);
      memoryById[created.memoryId] = cloneMemoryDtoAsRow_(created);
      memoryByKey[created.normalizedKey] = cloneMemoryDtoAsRow_(created);
      counts.created += 1;
      return;
    }

    var existing = candidate.existingMemoryId ? memoryById[candidate.existingMemoryId] : null;
    rejectUnless_(Boolean(existing), 'existingMemoryId was not found among active memories.');
    rejectUnless_(!existingByKey || existingByKey.memory_id === existing.memory_id, 'normalizedKey points to a different active memory.');

    var next = buildUpdatedMemory_(existing, candidate, now);
    applyMemoryProvenance_(next, provenance);
    SheetRepository.upsertMemory(next);
    memoryById[next.memoryId] = cloneMemoryDtoAsRow_(next);
    memoryByKey[next.normalizedKey] = cloneMemoryDtoAsRow_(next);
    counts[action === 'confirm' ? 'confirmed' : 'updated'] += 1;
  }

  function buildNewMemory_(candidate, now) {
    return {
      memoryId: generateUuidV4(),
      category: candidate.category,
      normalizedKey: normalizeMemoryKey_(candidate.normalizedKey),
      content: normalizeContent_(candidate.content),
      confidence: clampConfidence_(candidate.confidence),
      status: 'active',
      sourceMessageIds: uniqueIds_(candidate.sourceMessageIds),
      createdAt: now,
      lastConfirmedAt: now,
      supersedesMemoryId: null,
      usageCount: 0,
      lastUsedAt: null
    };
  }

  function buildUpdatedMemory_(existingRow, candidate, now) {
    var normalizedKey = normalizeMemoryKey_(candidate.normalizedKey);
    var nextContent = candidate.action === 'confirm'
      ? String(existingRow.content || '')
      : normalizeContent_(candidate.content);
    return {
      memoryId: existingRow.memory_id,
      category: candidate.action === 'confirm' ? existingRow.category : candidate.category,
      normalizedKey: normalizedKey,
      content: nextContent,
      confidence: Math.max(Number(existingRow.confidence || 0), clampConfidence_(candidate.confidence)),
      status: 'active',
      sourceMessageIds: mergeSourceMessageIds_(existingRow.source_message_ids_json, candidate.sourceMessageIds),
      createdAt: existingRow.created_at,
      lastConfirmedAt: now,
      supersedesMemoryId: existingRow.supersedes_memory_id || null,
      usageCount: Number(existingRow.usage_count || 0),
      lastUsedAt: existingRow.last_used_at || null
    };
  }

  function upsertExistingMemoryFromCreate_(
    existingRow,
    candidate,
    now,
    counts,
    memoryById,
    memoryByKey,
    provenance
  ) {
    var syntheticAction = normalizeContent_(candidate.content) === String(existingRow.content || '').trim()
      ? 'confirm'
      : 'update';
    var promotedCandidate = {
      action: syntheticAction,
      category: candidate.category,
      normalizedKey: candidate.normalizedKey,
      content: candidate.content,
      confidence: candidate.confidence,
      sourceMessageIds: candidate.sourceMessageIds,
      existingMemoryId: existingRow.memory_id,
      reason: candidate.reason
    };
    var next = buildUpdatedMemory_(existingRow, promotedCandidate, now);
    applyMemoryProvenance_(next, provenance);
    SheetRepository.upsertMemory(next);
    memoryById[next.memoryId] = cloneMemoryDtoAsRow_(next);
    memoryByKey[next.normalizedKey] = cloneMemoryDtoAsRow_(next);
    counts[syntheticAction === 'confirm' ? 'confirmed' : 'updated'] += 1;
  }

  function normalizeCandidateList_(data) {
    if (Array.isArray(data)) {
      return data;
    }
    if (data && Array.isArray(data.candidates)) {
      return data.candidates;
    }
    ensure(false, 'GEMINI_BAD_RESPONSE', 'Gemini did not return a memory candidate array.');
  }

  function validateMessageIdArray_(ids, label) {
    rejectUnless_(Array.isArray(ids), (label || 'ids') + ' must be an array.');
    ids.forEach(function(id) {
      rejectUnless_(Validators.isUuidV4(id), (label || 'id') + ' must contain UUID v4 values.');
    });
    rejectUnless_(uniqueIds_(ids).length === ids.length, (label || 'ids') + ' must be unique.');
    return true;
  }

  function validatePayloadMessageIdArray_(ids, label) {
    ensure(Array.isArray(ids), 'VALIDATION_REQUEST_INVALID', (label || 'ids') + ' must be an array.');
    ids.forEach(function(id) {
      ensure(Validators.isUuidV4(id), 'VALIDATION_REQUEST_INVALID', (label || 'id') + ' must contain UUID v4 values.');
    });
    ensure(uniqueIds_(ids).length === ids.length, 'VALIDATION_REQUEST_INVALID', (label || 'ids') + ' must be unique.');
    return true;
  }

  function rejectUnless_(condition, message) {
    if (!condition) {
      throw createCandidateRejectionError_(message);
    }
    return true;
  }

  function createCandidateRejectionError_(message) {
    return createAppError('VALIDATION_REQUEST_INVALID', message, {
      candidateRejection: true
    });
  }

  function isCandidateRejectionError_(error) {
    return error instanceof AppError &&
      error.code === 'VALIDATION_REQUEST_INVALID' &&
      error.details &&
      error.details.candidateRejection === true;
  }

  function uniqueIds_(ids) {
    var seen = {};
    return (ids || []).filter(function(id) {
      if (seen[id]) {
        return false;
      }
      seen[id] = true;
      return true;
    });
  }

  function mergeSourceMessageIds_(left, right) {
    return uniqueIds_([].concat(left || [], right || []));
  }

  function normalizeMemoryKey_(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeContent_(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function clampConfidence_(value) {
    var number = Number(value);
    if (number < 0) {
      return 0;
    }
    if (number > 1) {
      return 1;
    }
    return number;
  }

  function tokenize_(value) {
    var matches = String(value || '').toLowerCase().match(/[a-z0-9_]+/g);
    return matches ? matches : [];
  }

  function scoreMemory_(row, text, tokens) {
    var score = 0;
    var normalizedKey = String(row.normalized_key || '').toLowerCase();
    var content = String(row.content || '').toLowerCase();
    var category = String(row.category || '').toLowerCase();
    var lowered = String(text || '').toLowerCase();

    if (!lowered) {
      score += Number(row.confidence || 0) * 10;
      score += recencyScore_(row.last_confirmed_at || row.created_at);
      return score;
    }

    if (normalizedKey === lowered) {
      score += 80;
    }
    if (content === lowered) {
      score += 60;
    }
    if (category && lowered.indexOf(category) !== -1) {
      score += 12;
    }
    tokens.forEach(function(token) {
      if (normalizedKey.indexOf(token) !== -1) {
        score += 15;
      }
      if (content.indexOf(token) !== -1) {
        score += 8;
      }
      if (category === token) {
        score += 6;
      }
    });
    score += Number(row.confidence || 0) * 10;
    score += recencyScore_(row.last_confirmed_at || row.created_at);
    return score;
  }

  function recencyScore_(iso) {
    if (!iso) {
      return 0;
    }
    var days = Math.max(0, Math.floor((new Date().getTime() - getIsoTimeMillis(iso)) / 86400000));
    return Math.max(0, 10 - Math.min(days, 10));
  }

  function normalizeLimit_(limit, fallback) {
    var value = Number(limit);
    if (!value || value < 1) {
      return fallback;
    }
    return Math.floor(value);
  }

  function renderMessagesForPrompt_(messages) {
    return messages.map(function(message) {
      var parts = [
        '[' + message.createdAt + ']',
        message.role.toUpperCase() + ':',
        String(message.text || '').trim() || (message.image ? '[Image] ' + String(message.image.summary || 'Image attachment') : '')
      ];
      return parts.join(' ');
    }).join('\n');
  }

  function toMemoryDto_(row) {
    return {
      memoryId: row.memory_id,
      category: row.category,
      normalizedKey: row.normalized_key,
      content: row.content,
      confidence: row.confidence,
      status: row.status,
      sourceMessageIds: row.source_message_ids_json,
      createdAt: row.created_at,
      lastConfirmedAt: row.last_confirmed_at
    };
  }

  function cloneMemoryRow_(row) {
    return {
      memory_id: row.memory_id,
      category: row.category,
      normalized_key: row.normalized_key,
      content: row.content,
      confidence: row.confidence,
      status: row.status,
      source_message_ids_json: (row.source_message_ids_json || []).slice(),
      created_at: row.created_at,
      last_confirmed_at: row.last_confirmed_at,
      supersedes_memory_id: row.supersedes_memory_id || null,
      usage_count: row.usage_count || 0,
      last_used_at: row.last_used_at || null,
      memory_approval_json: row.memory_approval_json || null,
      memory_origin_event_ids_json:
        (row.memory_origin_event_ids_json || []).slice()
    };
  }

  function cloneMemoryDtoAsRow_(memory) {
    return {
      memory_id: memory.memoryId,
      category: memory.category,
      normalized_key: memory.normalizedKey,
      content: memory.content,
      confidence: memory.confidence,
      status: memory.status,
      source_message_ids_json: (memory.sourceMessageIds || []).slice(),
      created_at: memory.createdAt,
      last_confirmed_at: memory.lastConfirmedAt,
      supersedes_memory_id: memory.supersedesMemoryId || null,
      usage_count: memory.usageCount || 0,
      last_used_at: memory.lastUsedAt || null,
      memory_approval_json: memory.memoryApproval || null,
      memory_origin_event_ids_json:
        (memory.memoryOriginEventIds || []).slice()
    };
  }

  function applyMemoryProvenance_(memory, provenance) {
    if (!provenance) {
      return memory;
    }
    memory.memoryApproval = provenance.approval;
    memory.memoryOriginEventId = provenance.originEventId;
    return memory;
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

  function resolveMemoryRuntime_() {
    if (
      !getConfigBool_(
        'MEMORY_CHARACTER_ENFORCEMENT_ENABLED',
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
      'Character runtime is not ready for memory extraction.',
      {
        reason: inspection.reason || 'CHARACTER_RUNTIME_BLOCKED'
      }
    );
    return {
      mode: 'enforced',
      binding:
        CharacterMemoryContextService.bindingFromInspection(inspection)
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
      'MEMORY_EXTRACT character binding is invalid.'
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
      'Memory eventId and leaseToken must be supplied together.'
    );
    if (!hasEventId) {
      return null;
    }
    ensure(
      Validators.isUuidV4(String(options.eventId)),
      'VALIDATION_REQUEST_INVALID',
      'Memory eventId must be a UUID v4.'
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
        event.eventType === 'MEMORY_EXTRACT' &&
        event.payload,
      'STORAGE_DATA_CORRUPTED',
      'Memory queue event linkage is invalid.'
    );
    ensure(
      memoryQueuePayloadIdentity_(event.payload) ===
        memoryQueuePayloadIdentity_(payload),
      'STORAGE_DATA_CORRUPTED',
      'Memory queue event payload changed after claim.'
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

  function memoryQueuePayloadIdentity_(payload) {
    return JSON.stringify(validateExtractionPayload_(payload));
  }

  function recordCharacterUsageBestEffort_(createdAt, rawUsage) {
    var usage = rawUsage || {};
    var apiCalls = normalizeUsageNumber_(usage.apiCalls);
    if (apiCalls < 1) {
      return false;
    }
    try {
      SheetRepository.incrementUsageDaily(
        formatDateInTokyo(parseIsoToDate(createdAt)),
        {
          apiCalls: apiCalls,
          imageCalls: normalizeUsageNumber_(usage.imageCalls),
          inputTokens: normalizeUsageNumber_(usage.inputTokens),
          outputTokens: normalizeUsageNumber_(usage.outputTokens)
        }
      );
      return true;
    } catch (error) {
      try {
        AppLogger.writeDebugLog(
          'WARN',
          'recordMemoryCharacterUsage',
          'Memory character usage accounting failed.',
          {
            code: normalizeError(error).code
          },
          null
        );
      } catch (ignored) {}
      return false;
    }
  }

  function normalizeUsageNumber_(value) {
    var number = Number(value || 0);
    if (!isFinite(number) || number < 0) {
      return 0;
    }
    return Math.floor(number);
  }

  function getConfigBool_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      if (!config || config.value == null) {
        return fallback;
      }
      if (
        config.value === true ||
        String(config.value).toLowerCase() === 'true'
      ) {
        return true;
      }
      if (
        config.value === false ||
        String(config.value).toLowerCase() === 'false'
      ) {
        return false;
      }
      return fallback;
    } catch (error) {
      return fallback;
    }
  }

  function buildDedupeKey_(firstMessageId, lastMessageId) {
    return 'MEMORY_EXTRACT:' + firstMessageId + ':' + lastMessageId;
  }

  return {
    enqueueExtraction: enqueueExtraction,
    extract: extract,
    findRelevant: findRelevant,
    findAcceptedRelevant: findAcceptedRelevant,
    applyCandidates: applyCandidates,
    __test: {
      buildDedupeKey: buildDedupeKey_,
      buildExtractionRequest: buildExtractionRequest_,
      loadMemoryExtractionIdentity: loadMemoryExtractionIdentity_,
      normalizeCandidateList: normalizeCandidateList_,
      scoreMemory: scoreMemory_,
      normalizeMemoryKey: normalizeMemoryKey_,
      isCandidateRejectionError: isCandidateRejectionError_
    }
  };
})();

var QueueService = (function() {
  var DEFAULTS = Object.freeze({
    batchSize: 3,
    staleMinutes: 15,
    maxAttempts: 5
  });

  function enqueue(event) {
    return LockManager.withScriptLock('queue-enqueue', function() {
      var normalized = normalizeEventForInsert_(event);
      var existing = normalized.eventType === 'DIARY_GENERATE'
        ? findActiveDiaryEventByDateWithoutLock_(normalized.payload.diaryDate)
        : SheetRepository.getActiveEventByDedupeKey(normalized.dedupeKey);
      if (existing) {
        return existing;
      }
      SheetRepository.insertEvent(normalized);
      return normalized;
    });
  }

  function claimBatch(limit, workerId, now) {
    var claimLimit = Math.max(1, Number(limit || getConfigInt_('QUEUE_BATCH_SIZE', DEFAULTS.batchSize)));
    var normalizedWorkerId = String(workerId || '').trim();
    ensure(normalizedWorkerId !== '', 'VALIDATION_REQUEST_INVALID', 'workerId is required.');
    var claimTime = normalizeNow_(now);
    return LockManager.withScriptLock('queue-claim-batch', function() {
      var events = SheetRepository.listClaimableEvents(claimLimit, parseIsoToDate(claimTime));
      return events.map(function(event) {
        SheetRepository.updateEvent(event.eventId, {
          status: 'PROCESSING',
          lockedAt: claimTime,
          lockedBy: normalizedWorkerId,
          updatedAt: claimTime
        });
        return SheetRepository.getEventById(event.eventId);
      });
    });
  }

  function markDone(eventId, result) {
    return LockManager.withScriptLock('queue-mark-done', function() {
      var event = requireProcessingEvent_(eventId);
      var completedAt = deriveResultTimestamp_(result) || toIsoStringInTokyo(new Date());
      SheetRepository.updateEvent(eventId, {
        status: 'DONE',
        completedAt: completedAt,
        updatedAt: completedAt,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        lastError: null
      });
      return SheetRepository.getEventById(eventId);
    });
  }

  function markRetry(eventId, error, nextAttemptAt) {
    return LockManager.withScriptLock('queue-mark-retry', function() {
      var event = requireProcessingEvent_(eventId);
      var normalizedError = normalizeError(error);
      var nextAttemptCount = Number(event.attemptCount || 0) + 1;
      if (nextAttemptCount >= DEFAULTS.maxAttempts) {
        return markDeadWithoutLock_(eventId, normalizedError, nextAttemptCount);
      }
      var retryAtIso = normalizeNextAttemptAt_(nextAttemptAt);
      SheetRepository.updateEvent(eventId, {
        status: 'RETRY_WAIT',
        attemptCount: nextAttemptCount,
        nextAttemptAt: retryAtIso,
        lockedAt: null,
        lockedBy: null,
        updatedAt: toIsoStringInTokyo(new Date()),
        completedAt: null,
        lastError: {
          code: normalizedError.code,
          message: normalizedError.message
        }
      });
      return SheetRepository.getEventById(eventId);
    });
  }

  function markDead(eventId, error) {
    return LockManager.withScriptLock('queue-mark-dead', function() {
      var event = requireProcessingEvent_(eventId);
      return markDeadWithoutLock_(eventId, normalizeError(error), Number(event.attemptCount || 0));
    });
  }

  function recoverStale(now) {
    var nowIso = normalizeNow_(now);
    var staleMinutes = getConfigInt_('QUEUE_STALE_MINUTES', DEFAULTS.staleMinutes);
    return LockManager.withScriptLock('queue-recover-stale', function() {
      var staleEvents = SheetRepository.listStaleProcessingEvents(parseIsoToDate(nowIso), staleMinutes);
      staleEvents.forEach(function(event) {
        SheetRepository.updateEvent(event.eventId, {
          status: 'RETRY_WAIT',
          nextAttemptAt: nowIso,
          lockedAt: null,
          lockedBy: null,
          updatedAt: nowIso
        });
      });
      return staleEvents.map(function(event) {
        return SheetRepository.getEventById(event.eventId);
      });
    });
  }

  function expediteDiaryNarrativeLengthRetries(now) {
    var nowIso = normalizeNow_(now);
    return LockManager.withScriptLock('queue-expedite-diary-length-retry', function() {
      var events = SheetRepository.listEventsByType('DIARY_GENERATE');
      var eligible = events.filter(function(event) {
        var lastError = event.lastError || {};
        return event.status === 'RETRY_WAIT' &&
          String(event.dedupeKey || '').indexOf('DIARY_GENERATE_REPAIR:') === 0 &&
          lastError.code === 'GEMINI_BAD_RESPONSE' &&
          /below the configured minimum/i.test(String(lastError.message || ''));
      });
      eligible.forEach(function(event) {
        SheetRepository.updateEvent(event.eventId, {
          nextAttemptAt: nowIso,
          updatedAt: nowIso
        });
      });
      return {
        assessed: events.length,
        expedited: eligible.length
      };
    });
  }

  function requeueDeadAsNewEvent(eventId, manualRequestId, now) {
    return LockManager.withScriptLock('queue-requeue-dead', function() {
      var event = SheetRepository.getEventById(eventId);
      ensure(event, 'CONFIG_MISSING', 'Event was not found.');
      ensure(event.status === 'DEAD', 'VALIDATION_REQUEST_INVALID', 'Only DEAD events can be requeued.');
      ensure(event.eventType === 'CHAT_REPLY', 'VALIDATION_REQUEST_INVALID', 'Manual requeue is only supported for CHAT_REPLY.');
      Validators.assertUuidV4(manualRequestId, 'manualRequestId');
      var requestId = event.payload && event.payload.requestId;
      ensure(Validators.isUuidV4(requestId), 'VALIDATION_REQUEST_INVALID', 'Original requestId is missing.');
      var nowIso = normalizeNow_(now);
      var manualDedupeKey = 'CHAT_REPLY_MANUAL:' + requestId + ':' + manualRequestId;
      var existingManualRetry = SheetRepository.getEventByDedupeKey(manualDedupeKey);
      if (existingManualRetry) {
        return existingManualRetry;
      }
      var nextEvent = normalizeEventForInsert_({
        eventType: 'CHAT_REPLY',
        dedupeKey: manualDedupeKey,
        payload: mergePayload_(event.payload, {
          requestId: requestId,
          manualRequestId: manualRequestId,
          originalEventId: event.eventId,
          requestedAt: nowIso
        }),
        status: 'PENDING',
        attemptCount: 0,
        nextAttemptAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso
      });
      SheetRepository.insertEvent(nextEvent);
      return nextEvent;
    });
  }

  function requeueDeadDiaryAsNewEvent(eventId, manualRequestId, now) {
    return LockManager.withScriptLock('queue-requeue-dead-diary', function() {
      var event = SheetRepository.getEventById(eventId);
      ensure(event, 'CONFIG_MISSING', 'Event was not found.');
      ensure(event.status === 'DEAD', 'VALIDATION_REQUEST_INVALID', 'Only DEAD events can be repaired.');
      ensure(event.eventType === 'DIARY_GENERATE', 'VALIDATION_REQUEST_INVALID', 'Diary repair requires a DIARY_GENERATE event.');
      Validators.assertUuidV4(manualRequestId, 'manualRequestId');
      var diaryDate = event.payload && event.payload.diaryDate;
      Validators.assertDateString(diaryDate, 'event.payload.diaryDate');

      var manualDedupeKey = 'DIARY_GENERATE_REPAIR:' + diaryDate + ':' + manualRequestId;
      var existingManualRepair = SheetRepository.getEventByDedupeKey(manualDedupeKey);
      if (existingManualRepair) {
        return existingManualRepair;
      }

      var activeDiaryEvent = findActiveDiaryEventByDateWithoutLock_(diaryDate);
      if (activeDiaryEvent) {
        return activeDiaryEvent;
      }

      var nowIso = normalizeNow_(now);
      var nextEvent = normalizeEventForInsert_({
        eventType: 'DIARY_GENERATE',
        dedupeKey: manualDedupeKey,
        payload: {
          diaryDate: diaryDate,
          requestedAt: nowIso,
          manualRequestId: manualRequestId,
          originalEventId: event.eventId
        },
        status: 'PENDING',
        attemptCount: 0,
        nextAttemptAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso
      });
      SheetRepository.insertEvent(nextEvent);
      return nextEvent;
    });
  }

  function assessDeadEventRecovery(eventId) {
    var event = SheetRepository.getEventById(eventId);
    ensure(event, 'CONFIG_MISSING', 'Event was not found.');
    if (event.status !== 'DEAD') {
      return {
        eventType: event.eventType,
        status: event.status,
        action: 'NO_ACTION',
        reason: 'EVENT_IS_NOT_DEAD'
      };
    }

    var assessments = {
      CHAT_REPLY: {
        action: 'REQUEUE_AS_NEW_EVENT',
        reason: 'USE_UNIQUE_MANUAL_REQUEST_ID'
      },
      MEMORY_EXTRACT: {
        action: 'MANUAL_REVIEW_REQUIRED',
        reason: 'VERIFY_SOURCE_RANGE_BEFORE_RETRY'
      },
      DIARY_GENERATE: {
        action: 'MANUAL_REVIEW_REQUIRED',
        reason: 'USE_DIARY_REPAIR_WORKFLOW'
      },
      PROACTIVE_SEND: {
        action: 'DO_NOT_REPLAY',
        reason: 'WAIT_FOR_FRESH_ELIGIBILITY_EVALUATION'
      },
      WEEKLY_BACKUP: {
        action: 'MANUAL_REVIEW_REQUIRED',
        reason: 'VERIFY_EXISTING_BACKUP_BEFORE_RETRY'
      }
    };
    var assessment = assessments[event.eventType] || {
      action: 'MANUAL_REVIEW_REQUIRED',
      reason: 'UNRECOGNIZED_EVENT_TYPE'
    };
    return {
      eventType: event.eventType,
      status: event.status,
      action: assessment.action,
      reason: assessment.reason
    };
  }

  function normalizeEventForInsert_(event) {
    ensure(event && typeof event === 'object', 'VALIDATION_REQUEST_INVALID', 'event is required.');
    var eventType = String(event.eventType || '').trim();
    Validators.assertEnum(eventType, APP_CONSTANTS.EVENT_TYPES, 'event.eventType');
    var nowIso = normalizeNow_(event.createdAt || event.updatedAt);
    var payload = normalizePayload_(eventType, event.payload);
    var generatedDedupeKey = buildDedupeKey_(eventType, payload);
    var dedupeKey = String(
      event.dedupeKey || generatedDedupeKey
    ).trim();
    ensure(
      dedupeKey !== '',
      'VALIDATION_REQUEST_INVALID',
      'dedupeKey is required.'
    );
    if (eventType === 'PROACTIVE_SEND') {
      ensure(
        dedupeKey === generatedDedupeKey,
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND dedupeKey must match its decision payload.'
      );
    }
    return {
      eventId: event.eventId && Validators.isUuidV4(event.eventId) ? event.eventId : generateUuidV4(),
      eventType: eventType,
      dedupeKey: dedupeKey,
      payload: payload,
      status: event.status || 'PENDING',
      attemptCount: Number(event.attemptCount || 0),
      nextAttemptAt: event.nextAttemptAt || null,
      lockedAt: event.lockedAt || null,
      lockedBy: event.lockedBy || null,
      createdAt: event.createdAt || nowIso,
      updatedAt: event.updatedAt || nowIso,
      completedAt: event.completedAt || null,
      lastError: event.lastError || null
    };
  }

  function normalizePayload_(eventType, payload) {
    ensure(payload && typeof payload === 'object' && !Array.isArray(payload), 'VALIDATION_REQUEST_INVALID', 'payload must be an object.');
    if (eventType === 'CHAT_REPLY') {
      ensure(Validators.isUuidV4(payload.requestId), 'VALIDATION_REQUEST_INVALID', 'CHAT_REPLY payload.requestId must be a UUID v4.');
      return {
        requestId: payload.requestId,
        userMessageId: payload.userMessageId || null,
        requestedAt: payload.requestedAt || toIsoStringInTokyo(new Date()),
        image: payload.image || null,
        manualRequestId: payload.manualRequestId || null,
        originalEventId: payload.originalEventId || null
      };
    }
    if (eventType === 'MEMORY_EXTRACT') {
      return {
        firstMessageId: payload.firstMessageId,
        lastMessageId: payload.lastMessageId,
        sourceMessageIds: payload.sourceMessageIds,
        requestedAt: payload.requestedAt
      };
    }
    if (eventType === 'DIARY_GENERATE') {
      ensure(
        Validators.isDateString(payload.diaryDate),
        'VALIDATION_REQUEST_INVALID',
        'DIARY_GENERATE payload.diaryDate must be a yyyy-MM-dd string.'
      );
      ensure(
        Validators.isIsoDateTimeString(payload.requestedAt),
        'VALIDATION_REQUEST_INVALID',
        'DIARY_GENERATE payload.requestedAt must be an ISO 8601 string.'
      );
      var diaryPayload = {
        diaryDate: payload.diaryDate,
        requestedAt: payload.requestedAt
      };
      if (payload.manualRequestId != null || payload.originalEventId != null) {
        Validators.assertUuidV4(payload.manualRequestId, 'DIARY_GENERATE payload.manualRequestId');
        Validators.assertUuidV4(payload.originalEventId, 'DIARY_GENERATE payload.originalEventId');
        diaryPayload.manualRequestId = payload.manualRequestId;
        diaryPayload.originalEventId = payload.originalEventId;
      }
      return diaryPayload;
    }
    if (eventType === 'PROACTIVE_SEND') {
      var hasOwn = Object.prototype.hasOwnProperty;

      ensure(
        Validators.isDateString(payload.targetDate),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.targetDate must be a yyyy-MM-dd string.'
      );
      ensure(
        hasOwn.call(payload, 'sequence'),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.sequence is required.'
      );
      ensure(
        hasOwn.call(payload, 'requestedAt') &&
          Validators.isIsoDateTimeString(payload.requestedAt),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.requestedAt must be an ISO 8601 string.'
      );
      ensure(
        hasOwn.call(payload, 'decisionSlot') &&
          /^[0-9]+$/.test(String(payload.decisionSlot)),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.decisionSlot must contain digits only.'
      );
      ensure(
        hasOwn.call(payload, 'messageDedupeKey'),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.messageDedupeKey is required.'
      );
      ensure(
        hasOwn.call(payload, 'probability'),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.probability is required.'
      );
      ensure(
        hasOwn.call(payload, 'sample'),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.sample is required.'
      );
      ensure(
        hasOwn.call(payload, 'elapsedMinutes'),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.elapsedMinutes is required.'
      );
      ensure(
        hasOwn.call(payload, 'timeWeight'),
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.timeWeight is required.'
      );

      var sequence = Number(payload.sequence);
      var decisionSlot = String(payload.decisionSlot);
      var probability = Number(payload.probability);
      var sample = Number(payload.sample);
      var elapsedMinutes = Number(payload.elapsedMinutes);
      var timeWeight = Number(payload.timeWeight);
      var expectedMessageDedupeKey =
        'PROACTIVE_MESSAGE:' +
        payload.targetDate +
        ':' +
        sequence;

      ensure(
        isFinite(sequence) &&
          sequence >= 1 &&
          Math.floor(sequence) === sequence,
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.sequence must be a positive integer.'
      );
      ensure(
        String(payload.messageDedupeKey) ===
          expectedMessageDedupeKey,
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.messageDedupeKey is invalid.'
      );
      ensure(
        isFinite(probability) &&
          probability >= 0 &&
          probability <= 1,
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.probability must be between 0 and 1.'
      );
      ensure(
        isFinite(sample) && sample >= 0 && sample < 1,
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.sample must be in the range [0, 1).'
      );
      ensure(
        isFinite(elapsedMinutes) && elapsedMinutes >= 0,
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.elapsedMinutes must be non-negative.'
      );
      ensure(
        isFinite(timeWeight) && timeWeight >= 0,
        'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_SEND payload.timeWeight must be non-negative.'
      );

      return {
        targetDate: payload.targetDate,
        sequence: sequence,
        requestedAt: payload.requestedAt,
        decisionSlot: decisionSlot,
        messageDedupeKey: expectedMessageDedupeKey,
        probability: probability,
        sample: sample,
        elapsedMinutes: elapsedMinutes,
        timeWeight: timeWeight,
        reason: payload.reason || null
      };
    }
    if (eventType === 'WEEKLY_BACKUP') {
      ensure(Validators.isDateString(payload.backupDate), 'VALIDATION_REQUEST_INVALID', 'WEEKLY_BACKUP payload.backupDate must be a yyyy-MM-dd string.');
      return {
        backupDate: payload.backupDate,
        requestedAt: payload.requestedAt || toIsoStringInTokyo(new Date())
      };
    }
    return payload;
  }

  function buildDedupeKey_(eventType, payload) {
    if (eventType === 'CHAT_REPLY') {
      if (payload.manualRequestId) {
        return 'CHAT_REPLY_MANUAL:' + payload.requestId + ':' + payload.manualRequestId;
      }
      return 'CHAT_REPLY:' + payload.requestId;
    }
    if (eventType === 'MEMORY_EXTRACT') {
      return 'MEMORY_EXTRACT:' + payload.firstMessageId + ':' + payload.lastMessageId;
    }
    if (eventType === 'DIARY_GENERATE') {
      return 'DIARY_GENERATE:' + payload.diaryDate;
    }
    if (eventType === 'PROACTIVE_SEND') {
      return 'PROACTIVE_SEND:' +
        payload.targetDate + ':' +
        Number(payload.sequence) + ':' +
        String(payload.decisionSlot);
    }
    if (eventType === 'WEEKLY_BACKUP') {
      return 'WEEKLY_BACKUP:' + payload.backupDate;
    }
    throw createAppError('VALIDATION_REQUEST_INVALID', 'Unsupported eventType for dedupe generation.');
  }

  function requireProcessingEvent_(eventId) {
    var event = SheetRepository.getEventById(eventId);
    ensure(event, 'CONFIG_MISSING', 'Event was not found.');
    ensure(event.status === 'PROCESSING', 'VALIDATION_REQUEST_INVALID', 'Event must be PROCESSING for this transition.');
    return event;
  }

  function findActiveDiaryEventByDateWithoutLock_(diaryDate) {
    Validators.assertDateString(diaryDate, 'diaryDate');
    if (typeof SheetRepository.listEventsByType !== 'function') {
      return SheetRepository.getActiveEventByDedupeKey('DIARY_GENERATE:' + diaryDate);
    }
    var activeStatuses = {
      PENDING: true,
      PROCESSING: true,
      RETRY_WAIT: true
    };
    var events = SheetRepository.listEventsByType('DIARY_GENERATE')
      .filter(function(event) {
        return activeStatuses[event.status] &&
          event.payload &&
          event.payload.diaryDate === diaryDate;
      })
      .sort(function(left, right) {
        return safeEventTime_(right.updatedAt || right.createdAt) -
          safeEventTime_(left.updatedAt || left.createdAt);
      });
    return events.length > 0 ? events[0] : null;
  }

  function safeEventTime_(value) {
    var time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return isFinite(time) ? time : 0;
  }

  function markDeadWithoutLock_(eventId, error, attemptCount) {
    var nowIso = toIsoStringInTokyo(new Date());
    SheetRepository.updateEvent(eventId, {
      status: 'DEAD',
      attemptCount: attemptCount == null ? undefined : attemptCount,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: nowIso,
      completedAt: nowIso,
      lastError: {
        code: error.code,
        message: error.message
      }
    });
    return SheetRepository.getEventById(eventId);
  }

  function normalizeNow_(value) {
    if (value && Validators.isIsoDateTimeString(value)) {
      return value;
    }
    if (value instanceof Date) {
      return toIsoStringInTokyo(value);
    }
    return toIsoStringInTokyo(new Date());
  }

  function normalizeNextAttemptAt_(value) {
    if (value instanceof Date) {
      return toIsoStringInTokyo(value);
    }
    ensure(Validators.isIsoDateTimeString(value), 'VALIDATION_REQUEST_INVALID', 'nextAttemptAt must be an ISO 8601 string.');
    return value;
  }

  function deriveResultTimestamp_(result) {
    if (!result || typeof result !== 'object') {
      return null;
    }
    if (result.assistantMessage && result.assistantMessage.createdAt) {
      return result.assistantMessage.createdAt;
    }
    if (result.createdAt) {
      return result.createdAt;
    }
    return null;
  }

  function mergePayload_(left, right) {
    var merged = {};
    Object.keys(left || {}).forEach(function(key) {
      merged[key] = left[key];
    });
    Object.keys(right || {}).forEach(function(key) {
      merged[key] = right[key];
    });
    return merged;
  }

  function getConfigInt_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? Number(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  return {
    enqueue: enqueue,
    claimBatch: claimBatch,
    markDone: markDone,
    markRetry: markRetry,
    markDead: markDead,
    recoverStale: recoverStale,
    expediteDiaryNarrativeLengthRetries: expediteDiaryNarrativeLengthRetries,
    requeueDeadAsNewEvent: requeueDeadAsNewEvent,
    requeueDeadDiaryAsNewEvent: requeueDeadDiaryAsNewEvent,
    assessDeadEventRecovery: assessDeadEventRecovery,
    __test: {
      buildDedupeKey: buildDedupeKey_,
      normalizePayload: normalizePayload_,
      findActiveDiaryEventByDate: findActiveDiaryEventByDateWithoutLock_
    }
  };
})();

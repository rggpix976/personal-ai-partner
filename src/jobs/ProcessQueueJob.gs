function processQueueJob() {
  var workerId = 'processQueueJob:' + generateUuidV4();
  var now = new Date();
  var correlationId = generateUuidV4();
  var recovered = null;
  var claimed = null;
  try {
    recovered = QueueService.recoverStale(now) || [];
    claimed = QueueService.claimBatch(getQueueBatchSize_(), workerId, now) || [];
  } catch (error) {
    var normalized = normalizeError(error);
    if (normalized.code !== 'QUEUE_LOCK_BUSY') {
      throw normalized;
    }
    AppLogger.writeDebugLog('WARN', 'processQueueJob', 'Queue worker skipped because another worker owns the script lock.', {
      code: normalized.code
    }, correlationId);
    return {
      workerId: workerId,
      recoveredCount: 0,
      claimedCount: 0,
      skipped: true,
      reason: 'QUEUE_LOCK_BUSY'
    };
  }
  claimed.forEach(function(event) {
    processSingleQueueEvent_(event, correlationId);
  });
  return {
    workerId: workerId,
    recoveredCount: recovered.length,
    claimedCount: claimed.length
  };
}

function assessDeadQueueEvent(eventId) {
  return QueueService.assessDeadEventRecovery(eventId);
}

function requeueDeadChatReply(eventId, manualRequestId) {
  return QueueService.requeueDeadAsNewEvent(eventId, manualRequestId, new Date());
}

function assessDeadDiaryGeneration(eventId) {
  return DiaryService.assessDeadGeneration(eventId);
}

function repairDeadDiaryGeneration(eventId, manualRequestId) {
  return DiaryService.repairDeadGeneration(eventId, manualRequestId);
}

function assessCompletedDiaryGeneration(eventId) {
  return DiaryService.assessCompletedGeneration(eventId);
}

function reconcileCompletedDiaryGeneration(eventId) {
  return DiaryService.reconcileCompletedGeneration(eventId);
}

function repairDiaryGenerationBacklog() {
  return DiaryService.repairGenerationBacklog();
}

function processSingleQueueEvent_(event, correlationId) {
  try {
    var result = dispatchQueueEvent_(event);
    postDispatchSuccess_(event, result);
    QueueService.markDone(event.eventId, result);
    AppLogger.writeDebugLog('INFO', 'processQueueJob', 'Queue event completed.', {
      eventType: event.eventType,
      status: 'DONE'
    }, correlationId, event.eventId);
  } catch (error) {
    handleQueueFailure_(event, error, correlationId);
  }
}

function dispatchQueueEvent_(event) {
  var nowIso = toIsoStringInTokyo(new Date());
  if (event.eventType === 'CHAT_REPLY') {
    return ChatService.processQueuedReply(event.payload, {
      now: nowIso
    });
  }
  if (event.eventType === 'MEMORY_EXTRACT') {
    return MemoryService.extract(event.payload);
  }
  if (event.eventType === 'DIARY_GENERATE') {
    return DiaryService.generate(event.payload);
  }
  if (event.eventType === 'PROACTIVE_SEND') {
    return dispatchProactiveSend_(event, nowIso);
  }
  if (event.eventType === 'WEEKLY_BACKUP') {
    return MaintenanceService.weeklyBackup(event.payload);
  }
  throw createAppError('VALIDATION_REQUEST_INVALID', 'Unsupported eventType: ' + event.eventType);
}

function postDispatchSuccess_(event, result) {
  if (event.eventType === 'MEMORY_EXTRACT' && event.payload && event.payload.lastMessageId) {
    SheetRepository.updateUserState({
      last_memory_cursor: event.payload.lastMessageId
    });
  }
  if (event.eventType === 'PROACTIVE_SEND' && result && result.sent) {
    return;
  }
}

function dispatchProactiveSend_(event, nowIso) {
  var preparation = ProactiveMessageService.prepareDispatch(
    event.payload,
    nowIso
  );

  if (preparation.reason === 'MAIL_QUOTA_EXHAUSTED') {
    throw createAppError(
      'MAIL_QUOTA_EXHAUSTED',
      'Mail quota is exhausted for proactive delivery.'
    );
  }

  if (!preparation.eligible || !preparation.message) {
    return {
      sent: false,
      duplicate: false,
      skipped: true,
      reason: preparation.reason,
      createdAt: preparation.createdAt || nowIso
    };
  }

  return ProactiveMessageService.send(preparation.message);
}

function handleQueueFailure_(event, error, correlationId) {
  var normalized = normalizeError(error, 'UNKNOWN', 'Unexpected queue processing failure.');
  AppLogger.writeDebugLog('ERROR', 'processQueueJob', normalized.message, {
    eventType: event.eventType,
    code: normalized.code
  }, correlationId || normalized.correlationId, event.eventId);

  if (event.payload && event.payload.targetDate) {
    var usageDate = event.payload.targetDate;
    SheetRepository.incrementUsageDaily(usageDate, { errors: 1 });
  }

  if (!normalized.retryable) {
    QueueService.markDead(event.eventId, normalized);
    recordDiaryTerminalFailure_(event, normalized, correlationId);
    return;
  }

  var decision = RetryPolicy.getRetryDecision(
    normalized,
    Number(event.attemptCount || 0) + 1,
    new Date(),
    {
      eventType: event.eventType,
      payload: event.payload
    }
  );
  if (decision.action === 'DONE') {
    QueueService.markDone(event.eventId, {
      createdAt: toIsoStringInTokyo(new Date())
    });
    return;
  }
  if (decision.action === 'DEAD') {
    QueueService.markDead(event.eventId, normalized);
    recordDiaryTerminalFailure_(event, normalized, correlationId);
    return;
  }
  QueueService.markRetry(event.eventId, normalized, decision.nextAttemptAt);
}

function recordDiaryTerminalFailure_(event, error, correlationId) {
  if (!event || event.eventType !== 'DIARY_GENERATE') {
    return null;
  }
  try {
    return DiaryService.markFailed(event.payload);
  } catch (failureError) {
    var normalized = normalizeError(failureError);
    AppLogger.writeDebugLog(
      'WARN',
      'processQueueJob',
      'Diary terminal state could not be reconciled after a queue failure.',
      {
        eventType: 'DIARY_GENERATE',
        queueErrorCode: error && error.code ? error.code : 'UNKNOWN',
        reconciliationErrorCode: normalized.code
      },
      correlationId,
      event.eventId
    );
    return null;
  }
}

function getQueueBatchSize_() {
  try {
    var config = ConfigRepository.getByKey('QUEUE_BATCH_SIZE');
    return config && config.value != null ? Number(config.value) : 3;
  } catch (error) {
    return 3;
  }
}

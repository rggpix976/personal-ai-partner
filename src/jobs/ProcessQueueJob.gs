function processQueueJob() {
  var workerId = 'processQueueJob:' + generateUuidV4();
  var now = new Date();
  var correlationId = generateUuidV4();
  QueueService.recoverStale(now);
  var claimed = QueueService.claimBatch(getQueueBatchSize_(), workerId, now);
  claimed.forEach(function(event) {
    processSingleQueueEvent_(event, correlationId);
  });
  return {
    workerId: workerId,
    claimedCount: claimed.length
  };
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
  var evaluation = ProactiveMessageService.evaluateLocalConditions(nowIso);
  if (evaluation.reason === 'MAIL_QUOTA_EXHAUSTED') {
    throw createAppError('MAIL_QUOTA_EXHAUSTED', 'Mail quota is exhausted for proactive delivery.');
  }
  if (!evaluation.eligible || !evaluation.payload) {
    return {
      sent: false,
      duplicate: false,
      skipped: true,
      reason: event.payload && event.payload.targetDate &&
        event.payload.targetDate < formatDateInTokyo(parseIsoToDate(nowIso))
        ? 'skipped_quota_expired'
        : evaluation.reason,
      createdAt: nowIso
    };
  }
  return ProactiveMessageService.send(evaluation.payload);
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
    return;
  }
  QueueService.markRetry(event.eventId, normalized, decision.nextAttemptAt);
}

function getQueueBatchSize_() {
  try {
    var config = ConfigRepository.getByKey('QUEUE_BATCH_SIZE');
    return config && config.value != null ? Number(config.value) : 3;
  } catch (error) {
    return 3;
  }
}

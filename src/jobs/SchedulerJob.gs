function schedulerJob() {
  var now = new Date();
  var nowIso = toIsoStringInTokyo(now);
  var summary = {
    proactive: null,
    diary: null,
    memory: null,
    weeklyBackup: null,
    maintenance: null,
    health: null
  };

  summary.maintenance = MaintenanceService.runPeriodicMaintenance(now);
  summary.proactive = enqueueProactiveIfEligible_(now);
  summary.memory = enqueueMemoryExtractionIfDue_(nowIso);
  summary.diary = enqueueDiaryIfDue_(now);
  summary.weeklyBackup = enqueueWeeklyBackupIfDue_(now);
  summary.health = OperationalHealthService.run(now, getOperationalTriggerHealth_());

  return summary;
}

function runOperationalHealthCheck() {
  var result = OperationalHealthService.inspect(
    new Date(),
    getOperationalTriggerHealth_()
  );
  return logPr9TestResult_('runOperationalHealthCheck', result);
}

function inspectProactivePolicy() {
  var result = ProactiveMessageService.inspectPolicy(new Date());
  return logPr9TestResult_('inspectProactivePolicy', result);
}

function inspectPr9PersistenceSafety() {
  var result = ImmersionSafetyAuditService.inspect();
  return logPr9TestResult_(
    'inspectPr9PersistenceSafety',
    result
  );
}

function inspectPreviousDiaryReleaseTest() {
  var previousDate = getTokyoRelativeDate_(new Date(), -1);
  var lifecycle = DiaryService.getLifecycleState(previousDate);
  var result = {
    status: lifecycle.status,
    anchorCount: Number(lifecycle.anchorCount || 0)
  };
  return logPr9TestResult_(
    'inspectPreviousDiaryReleaseTest',
    result
  );
}

function runDiaryReleaseTest() {
  assertReleaseTestTriggersStopped_();
  var result = runReleaseTest_(
    'DIARY_GENERATE',
    enqueueDiaryIfDue_(new Date())
  );
  return logPr9TestResult_('runDiaryReleaseTest', result);
}

function runMemoryReleaseTest() {
  assertReleaseTestTriggersStopped_();
  var result = runReleaseTest_(
    'MEMORY_EXTRACT',
    enqueueMemoryExtractionIfDue_(
      toIsoStringInTokyo(new Date())
    )
  );
  return logPr9TestResult_('runMemoryReleaseTest', result);
}

function resumeMemoryReleaseTest() {
  assertReleaseTestTriggersStopped_();
  var resumed =
    resumeSingleActiveMemoryReleaseTest_() || {};
  var result = buildMemoryResumeResult_(
    resumed.duplicate,
    resumed.processed,
    resumed.status,
    resumed.reason,
    resumed.errorCode
  );
  return logPr9TestResult_('resumeMemoryReleaseTest', result);
}

function recoverDeadMemoryReleaseTest() {
  assertReleaseTestTriggersStopped_();
  var result =
    recoverSingleDeadMemoryReleaseTest_();
  return logPr9TestResult_(
    'recoverDeadMemoryReleaseTest',
    result
  );
}

function diagnoseMemoryReleaseGeneration() {
  assertReleaseTestTriggersStopped_();
  var result = diagnoseSingleActiveMemoryGeneration_();
  return logPr9TestResult_(
    'diagnoseMemoryReleaseGeneration',
    result
  );
}

function runProactiveReleaseTest() {
  assertReleaseTestTriggersStopped_();
  ProactiveMessageService.assertManualTestReady();
  var result = runReleaseTest_(
    'PROACTIVE_SEND',
    enqueueProactiveIfEligible_(
      new Date(),
      { allowTestProfile: true }
    ),
    { allowProactiveTestProfile: true }
  );
  return logPr9TestResult_('runProactiveReleaseTest', result);
}

function runReleaseTest_(eventType, enqueueResult, options) {
  var sanitized = sanitizeReleaseEnqueueResult_(
    eventType,
    enqueueResult
  );
  if (!sanitized.enqueued) {
    return {
      eventType: eventType,
      enqueued: false,
      duplicate: sanitized.duplicate,
      processed: false,
      status: sanitized.status,
      reason: sanitized.reason,
      errorCode: null
    };
  }
  ensure(
    enqueueResult &&
      Validators.isUuidV4(enqueueResult.eventId),
    'STORAGE_DATA_CORRUPTED',
    'The release-test enqueue result did not identify its new event.'
  );
  var processing = processReleaseTestEventById_(
    eventType,
    enqueueResult.eventId,
    options
  );
  return {
    eventType: eventType,
    enqueued: true,
    duplicate: false,
    processed: processing.status === 'DONE',
    status: processing.status,
    reason: processing.reason,
    errorCode: processing.errorCode
  };
}

function getOperationalTriggerHealth_() {
  var requiredHandlers = ['processQueueJob', 'schedulerJob'];
  var counts = {
    processQueueJob: 0,
    schedulerJob: 0
  };
  var unexpectedCount = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    var handler = trigger.getHandlerFunction();
    if (Object.prototype.hasOwnProperty.call(counts, handler)) {
      counts[handler] += 1;
    } else {
      unexpectedCount += 1;
    }
  });
  var missingCount = 0;
  var duplicateCount = 0;
  requiredHandlers.forEach(function(handler) {
    if (counts[handler] === 0) {
      missingCount += 1;
    } else if (counts[handler] > 1) {
      duplicateCount += counts[handler] - 1;
    }
  });
  return {
    required: {
      processQueueJob: { count: counts.processQueueJob },
      schedulerJob: { count: counts.schedulerJob }
    },
    missingCount: missingCount,
    duplicateCount: duplicateCount,
    unexpectedCount: unexpectedCount
  };
}

function enqueueProactiveIfEligible_(now, options) {
  var evaluation = ProactiveMessageService.evaluateLocalConditions(
    now,
    options
  );
  if (!evaluation.eligible || !evaluation.payload) {
    return evaluation;
  }
  var candidateEventId = generateUuidV4();
  var event = QueueService.enqueue({
    eventId: candidateEventId,
    eventType: 'PROACTIVE_SEND',
    dedupeKey: evaluation.dedupeKey,
    payload: evaluation.payload,
    status: 'PENDING',
    nextAttemptAt: evaluation.payload.requestedAt,
    createdAt: evaluation.payload.requestedAt,
    updatedAt: evaluation.payload.requestedAt
  });
  var wasInserted = event.eventId === candidateEventId;
  return {
    eligible: true,
    enqueued: wasInserted,
    duplicate: !wasInserted,
    reason: evaluation.reason,
    eventId: event.eventId,
    dedupeKey: event.dedupeKey
  };
}

function enqueueDiaryIfDue_(now) {
  var dueTime = getConfigString_('DIARY_DUE_TIME', '23:30');
  if (!hasPastTokyoTime_(now, dueTime)) {
    return {
      enqueued: false,
      reason: 'DIARY_TIME_NOT_REACHED'
    };
  }
  var yesterday = getTokyoRelativeDate_(now, -1);
  var lifecycle = DiaryService.getLifecycleState(yesterday);
  var noEnqueueReasons = {
    DONE: 'ALREADY_GENERATED',
    NONE: 'DIARY_NOT_REQUIRED',
    PENDING: 'DIARY_ALREADY_PENDING',
    FAILED: 'DIARY_MANUAL_REPAIR_REQUIRED',
    INCONSISTENT: 'DIARY_MANUAL_REVIEW_REQUIRED'
  };
  if (Object.prototype.hasOwnProperty.call(noEnqueueReasons, lifecycle.status)) {
    return {
      enqueued: false,
      reason: noEnqueueReasons[lifecycle.status],
      diaryStatus: lifecycle.status,
      diaryDate: yesterday
    };
  }
  return DiaryService.enqueue(yesterday);
}

function enqueueMemoryExtractionIfDue_(nowIso) {
  var state = SheetRepository.ensureDefaultUserState();
  var selection = selectMemoryExtractionBatch_(state);
  if (!selection.ready) {
    return {
      enqueued: false,
      reason: 'INSUFFICIENT_NEW_MESSAGES',
      messageCount: selection.messageCount
    };
  }
  return MemoryService.enqueueExtraction({
    firstMessageId: selection.firstMessageId,
    lastMessageId: selection.lastMessageId,
    sourceMessageIds: selection.sourceMessageIds,
    requestedAt: nowIso
  });
}

function resumeSingleActiveMemoryReleaseTest_() {
  var eventType = 'MEMORY_EXTRACT';
  var activeStatuses = {
    PENDING: true,
    PROCESSING: true,
    RETRY_WAIT: true
  };
  var activeEvents = (SheetRepository.listEvents() || [])
    .filter(function(event) {
      return event && activeStatuses[event.status];
    });
  if (activeEvents.length === 0) {
    return buildMemoryResumeResult_(
      false,
      false,
      null,
      'TARGET_EVENT_MISSING',
      null
    );
  }
  if (activeEvents.length !== 1) {
    return buildMemoryResumeResult_(
      false,
      false,
      null,
      'TARGET_EVENT_AMBIGUOUS',
      null
    );
  }

  var event = activeEvents[0];
  var state = SheetRepository.getUserState();
  var selection = state
    ? selectMemoryExtractionBatch_(state)
    : null;
  if (
    !selection ||
    !selection.ready ||
    !memoryResumeEventMatchesSelection_(event, selection)
  ) {
    return buildMemoryResumeResult_(
      false,
      false,
      pr9SafeUpperToken_(event.status),
      'TARGET_EVENT_MISMATCH',
      safeMemoryResumeErrorCode_(event)
    );
  }

  if (event.status === 'PROCESSING') {
    return buildMemoryResumeResult_(
      true,
      false,
      'PROCESSING',
      'TARGET_EVENT_PROCESSING',
      safeMemoryResumeErrorCode_(event)
    );
  }
  if (!memoryResumeLifecycleIsValid_(event)) {
    return buildMemoryResumeResult_(
      true,
      false,
      pr9SafeUpperToken_(event.status),
      'TARGET_EVENT_MISMATCH',
      safeMemoryResumeErrorCode_(event)
    );
  }
  if (!memoryResumeEventIsDue_(event, new Date())) {
    return buildMemoryResumeResult_(
      true,
      false,
      pr9SafeUpperToken_(event.status),
      'TARGET_EVENT_NOT_DUE',
      safeMemoryResumeErrorCode_(event)
    );
  }

  var fingerprint = buildMemoryResumeFingerprint_(
    event,
    selection,
    state
  );
  var processing = processReleaseTestEventById_(
    eventType,
    event.eventId,
    {
      expectedClaimFingerprint: fingerprint
    }
  );
  return buildMemoryResumeResult_(
    true,
    processing.status === 'DONE',
    processing.status,
    processing.reason,
    processing.errorCode
  );
}

function recoverSingleDeadMemoryReleaseTest_() {
  var events = SheetRepository.listEvents() || [];
  var activeStatuses = {
    PENDING: true,
    PROCESSING: true,
    RETRY_WAIT: true
  };
  var activeEvents = events.filter(function(event) {
    return event && activeStatuses[event.status];
  });
  if (activeEvents.length !== 0) {
    return buildMemoryRecoveryResult_(
      false,
      false,
      false,
      null,
      'ACTIVE_QUEUE_NOT_EMPTY',
      null
    );
  }

  var deadMemoryEvents = events.filter(function(event) {
    return event &&
      event.eventType === 'MEMORY_EXTRACT' &&
      event.status === 'DEAD';
  });
  if (deadMemoryEvents.length === 0) {
    return buildMemoryRecoveryResult_(
      false,
      false,
      false,
      null,
      'TARGET_EVENT_MISSING',
      null
    );
  }
  if (deadMemoryEvents.length !== 1) {
    return buildMemoryRecoveryResult_(
      false,
      false,
      false,
      null,
      'TARGET_EVENT_AMBIGUOUS',
      null
    );
  }

  var event = deadMemoryEvents[0];
  var state = SheetRepository.getUserState();
  var selection = state
    ? selectMemoryExtractionBatch_(state)
    : null;
  if (
    !selection ||
    !selection.ready ||
    !memoryResumeEventMatchesSelection_(
      event,
      selection
    ) ||
    !memoryDeadRecoveryLifecycleIsValid_(event)
  ) {
    return buildMemoryRecoveryResult_(
      false,
      false,
      false,
      'DEAD',
      'TARGET_EVENT_MISMATCH',
      safeMemoryResumeErrorCode_(event)
    );
  }

  var fingerprint =
    buildMemoryDeadRecoveryFingerprint_(
      event,
      selection,
      state
    );
  var manualRequestId = generateUuidV4();
  var repairEvent =
    QueueService.requeueDeadMemoryAsNewEvent(
      event.eventId,
      manualRequestId,
      new Date(),
      fingerprint
    );
  var inserted = Boolean(
    repairEvent &&
      repairEvent.payload &&
      repairEvent.payload.manualRequestId ===
        manualRequestId
  );
  if (
    !memoryRepairEventMatchesOriginal_(
      repairEvent,
      event,
      selection
    ) ||
    repairEvent.status !== 'PENDING'
  ) {
    return buildMemoryRecoveryResult_(
      inserted,
      !inserted,
      false,
      pr9SafeUpperToken_(
        repairEvent && repairEvent.status
      ),
      'TARGET_EVENT_MISMATCH',
      safeMemoryResumeErrorCode_(repairEvent)
    );
  }

  var processing = processReleaseTestEventById_(
    'MEMORY_EXTRACT',
    repairEvent.eventId,
    {
      expectedClaimFingerprint:
        buildMemoryResumeFingerprint_(
          repairEvent,
          selection,
          state
        )
    }
  );
  return buildMemoryRecoveryResult_(
    inserted,
    !inserted,
    processing.status === 'DONE',
    processing.status,
    processing.reason,
    processing.errorCode
  );
}

function diagnoseSingleActiveMemoryGeneration_() {
  var activeStatuses = {
    PENDING: true,
    PROCESSING: true,
    RETRY_WAIT: true
  };
  var activeEvents = (SheetRepository.listEvents() || [])
    .filter(function(event) {
      return event && activeStatuses[event.status];
    });
  if (activeEvents.length === 0) {
    return buildMemoryGenerationDiagnosis_(
      false,
      'TARGET_EVENT_MISSING',
      null,
      null
    );
  }
  if (activeEvents.length !== 1) {
    return buildMemoryGenerationDiagnosis_(
      false,
      'TARGET_EVENT_AMBIGUOUS',
      null,
      null
    );
  }

  var event = activeEvents[0];
  var state = SheetRepository.getUserState();
  var selection = state
    ? selectMemoryExtractionBatch_(state)
    : null;
  if (
    !selection ||
    !selection.ready ||
    !memoryResumeEventMatchesSelection_(event, selection) ||
    !memoryResumeLifecycleIsValid_(event)
  ) {
    return buildMemoryGenerationDiagnosis_(
      false,
      'TARGET_EVENT_MISMATCH',
      safeMemoryResumeErrorCode_(event),
      null
    );
  }

  try {
    var diagnosis = MemoryService.diagnoseExtraction(
      event.payload
    );
    return buildMemoryGenerationDiagnosis_(
      true,
      'PRIMARY_GENERATION_VALID',
      null,
      diagnosis && diagnosis.candidateCount
    );
  } catch (error) {
    return buildMemoryGenerationDiagnosis_(
      false,
      safeMemoryGenerationDiagnosticStage_(error),
      safeMemoryGenerationDiagnosticCode_(error),
      null
    );
  }
}

function buildMemoryGenerationDiagnosis_(
  ok,
  stage,
  errorCode,
  candidateCount
) {
  return {
    eventType: 'MEMORY_EXTRACT',
    ok: Boolean(ok),
    stage: pr9SafeUpperToken_(stage) || 'UNKNOWN_STAGE',
    errorCode: pr9SafeUpperToken_(errorCode),
    candidateCount: candidateCount == null
      ? null
      : pr9SafeCount_(candidateCount)
  };
}

function safeMemoryGenerationDiagnosticCode_(error) {
  var allowed = [
    'CONFIG_MISSING',
    'GEMINI_RATE_LIMIT',
    'GEMINI_AUTH_FAILED',
    'GEMINI_MODEL_UNAVAILABLE',
    'GEMINI_BAD_RESPONSE',
    'GEMINI_TEMPORARY_FAILURE'
  ];
  var code = null;
  try {
    code = error && error.code;
  } catch (ignored) {
    return 'UNKNOWN';
  }
  return typeof code === 'string' &&
    allowed.indexOf(code) !== -1
    ? code
    : 'UNKNOWN';
}

function safeMemoryGenerationDiagnosticStage_(error) {
  var allowed = [
    'REQUEST_CONTENTS_INVALID',
    'HTTP_RESPONSE_JSON_INVALID',
    'HTTP_REQUEST_REJECTED',
    'HTTP_RATE_LIMITED',
    'HTTP_AUTH_FAILED',
    'HTTP_MODEL_UNAVAILABLE',
    'HTTP_SERVER_FAILURE',
    'HTTP_FAILURE',
    'RESPONSE_TEXT_MISSING',
    'RESPONSE_BLOCKED',
    'STRUCTURED_JSON_INVALID',
    'TRANSPORT_FAILURE',
    'MEMORY_CANDIDATE_SET_INVALID',
    'MEMORY_CANDIDATE_SHAPE_INVALID',
    'MEMORY_CANDIDATE_FIELDS_INVALID',
    'MEMORY_CANDIDATE_SOURCE_INVALID',
    'MEMORY_CANDIDATE_EXISTING_INVALID',
    'MEMORY_VERDICT_INVALID',
    'MEMORY_VERDICT_EVIDENCE_INVALID'
  ];
  var stage = null;
  try {
    stage = error &&
      error.details &&
      error.details.safeStage;
  } catch (ignored) {
    return 'UNKNOWN_STAGE';
  }
  return typeof stage === 'string' &&
    allowed.indexOf(stage) !== -1
    ? stage
    : 'UNKNOWN_STAGE';
}

function selectMemoryExtractionBatch_(state) {
  state = state || {};
  var interval = Math.max(getConfigInt_('MEMORY_EXTRACT_INTERVAL', 10), 1);
  var allMessages = SheetRepository.listRecentMessages(Math.max(interval * 3, 50)).slice().reverse();
  var candidateMessages = [];
  if (state.last_memory_cursor) {
    candidateMessages = SheetRepository.listMessagesAfter(state.last_memory_cursor, Math.max(interval * 3, 50));
  } else {
    candidateMessages = allMessages;
  }
  var sourceMessages = candidateMessages.filter(function(message) {
    return message.role === 'user' || message.role === 'assistant';
  });
  if (sourceMessages.length < interval) {
    return {
      ready: false,
      messageCount: sourceMessages.length
    };
  }
  var batch = sourceMessages.slice(0, interval);
  return {
    ready: true,
    messageCount: sourceMessages.length,
    firstMessageId: batch[0].messageId,
    lastMessageId: batch[batch.length - 1].messageId,
    sourceMessageIds: batch.map(function(message) {
      return message.messageId;
    })
  };
}

function memoryResumeEventMatchesSelection_(event, selection) {
  if (
    !event ||
    event.eventType !== 'MEMORY_EXTRACT' ||
    !Validators.isUuidV4(event.eventId) ||
    !memoryResumeSelectionIsValid_(selection) ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  ) {
    return false;
  }
  var payload = event.payload;
  var expectedDedupeKey =
    'MEMORY_EXTRACT:' +
    selection.firstMessageId +
    ':' +
    selection.lastMessageId;
  return (
    event.dedupeKey === expectedDedupeKey &&
    payload.firstMessageId === selection.firstMessageId &&
    payload.lastMessageId === selection.lastMessageId &&
    Array.isArray(payload.sourceMessageIds) &&
    JSON.stringify(payload.sourceMessageIds) ===
      JSON.stringify(selection.sourceMessageIds) &&
    Validators.isIsoDateTimeString(payload.requestedAt) &&
    payload.characterRuntimeMode === 'enforced' &&
    memoryResumeBindingIsValid_(payload.characterBinding)
  );
}

function memoryResumeBindingIsValid_(value) {
  var fields = [
    'profileSchemaVersion',
    'profileRevision',
    'policyVersion',
    'catalogVersion',
    'characterPackId',
    'characterPackVersion'
  ];
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every(function(field) {
      return Object.prototype.hasOwnProperty.call(
        value,
        field
      );
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
    /^[a-z0-9][a-z0-9-]{2,63}$/.test(
      value.characterPackId
    ) &&
    typeof value.characterPackVersion === 'string' &&
    /^[a-z0-9][a-z0-9.-]{2,79}$/.test(
      value.characterPackVersion
    )
  );
}

function memoryResumeSelectionIsValid_(selection) {
  if (
    !selection ||
    !Array.isArray(selection.sourceMessageIds) ||
    selection.sourceMessageIds.length === 0 ||
    selection.firstMessageId !==
      selection.sourceMessageIds[0] ||
    selection.lastMessageId !==
      selection.sourceMessageIds[
        selection.sourceMessageIds.length - 1
      ]
  ) {
    return false;
  }
  var seen = {};
  return selection.sourceMessageIds.every(function(messageId) {
    if (
      !Validators.isUuidV4(messageId) ||
      seen[messageId]
    ) {
      return false;
    }
    seen[messageId] = true;
    return true;
  });
}

function memoryResumeLifecycleIsValid_(event) {
  var attemptCount = Number(event.attemptCount);
  if (
    !isFinite(attemptCount) ||
    Math.floor(attemptCount) !== attemptCount ||
    attemptCount < 0 ||
    event.lockedAt != null ||
    event.lockedBy != null
  ) {
    return false;
  }
  if (event.status === 'RETRY_WAIT') {
    return attemptCount > 0 &&
      attemptCount < 5 &&
      Validators.isIsoDateTimeString(event.nextAttemptAt);
  }
  return false;
}

function memoryResumeEventIsDue_(event, now) {
  return getIsoTimeMillis(event.nextAttemptAt) <= now.getTime();
}

function memoryDeadRecoveryLifecycleIsValid_(event) {
  return Boolean(
    event &&
      event.status === 'DEAD' &&
      Number.isSafeInteger(
        Number(event.attemptCount)
      ) &&
      Number(event.attemptCount) > 0 &&
      Number(event.attemptCount) <= 5 &&
      event.nextAttemptAt == null &&
      event.lockedAt == null &&
      event.lockedBy == null &&
      Validators.isIsoDateTimeString(event.completedAt) &&
      Validators.isIsoDateTimeString(event.updatedAt) &&
      event.lastError &&
      event.lastError.code ===
        'CHARACTER_OUTPUT_BLOCKED'
  );
}

function buildMemoryDeadRecoveryFingerprint_(
  event,
  selection,
  state
) {
  var fingerprint = buildMemoryResumeFingerprint_(
    event,
    selection,
    state
  );
  fingerprint.completedAt = event.completedAt;
  fingerprint.updatedAt = event.updatedAt;
  fingerprint.lastErrorCode =
    'CHARACTER_OUTPUT_BLOCKED';
  return fingerprint;
}

function memoryRepairEventMatchesOriginal_(
  repairEvent,
  originalEvent,
  selection
) {
  return Boolean(
    repairEvent &&
      repairEvent.eventType === 'MEMORY_EXTRACT' &&
      Validators.isUuidV4(repairEvent.eventId) &&
      repairEvent.payload &&
      Validators.isUuidV4(
        repairEvent.payload.manualRequestId
      ) &&
      repairEvent.payload.originalEventId ===
        originalEvent.eventId &&
      repairEvent.dedupeKey ===
        'MEMORY_EXTRACT_REPAIR:' +
          originalEvent.eventId &&
      repairEvent.payload.firstMessageId ===
        selection.firstMessageId &&
      repairEvent.payload.lastMessageId ===
        selection.lastMessageId &&
      JSON.stringify(
        repairEvent.payload.sourceMessageIds
      ) === JSON.stringify(
        selection.sourceMessageIds
      ) &&
      repairEvent.payload.requestedAt ===
        originalEvent.payload.requestedAt &&
      repairEvent.payload.characterRuntimeMode ===
        originalEvent.payload.characterRuntimeMode &&
      JSON.stringify(
        repairEvent.payload.characterBinding
      ) === JSON.stringify(
        originalEvent.payload.characterBinding
      ) &&
      Number(repairEvent.attemptCount) === 0 &&
      Validators.isIsoDateTimeString(
        repairEvent.nextAttemptAt
      ) &&
      repairEvent.lockedAt == null &&
      repairEvent.lockedBy == null
  );
}

function buildMemoryResumeFingerprint_(
  event,
  selection,
  state
) {
  return {
    requireExclusiveActive: true,
    lastMemoryCursor:
      state.last_memory_cursor || null,
    status: event.status,
    attemptCount: Number(event.attemptCount),
    nextAttemptAt: event.nextAttemptAt || null,
    lockedAt: event.lockedAt || null,
    lockedBy: event.lockedBy || null,
    dedupeKey: event.dedupeKey,
    firstMessageId: selection.firstMessageId,
    lastMessageId: selection.lastMessageId,
    sourceMessageIds: selection.sourceMessageIds.slice(),
    requestedAt: event.payload.requestedAt,
    characterRuntimeMode: 'enforced',
    characterBindingJson: JSON.stringify(
      event.payload.characterBinding
    )
  };
}

function safeMemoryResumeErrorCode_(event) {
  return pr9SafeUpperToken_(
    event &&
      event.lastError &&
      event.lastError.code
  );
}

function buildMemoryResumeResult_(
  duplicate,
  processed,
  status,
  reason,
  errorCode
) {
  return {
    eventType: 'MEMORY_EXTRACT',
    enqueued: false,
    duplicate: Boolean(duplicate),
    processed: Boolean(processed),
    status: pr9SafeUpperToken_(status),
    reason: pr9SafeUpperToken_(reason),
    errorCode: pr9SafeUpperToken_(errorCode)
  };
}

function buildMemoryRecoveryResult_(
  enqueued,
  duplicate,
  processed,
  status,
  reason,
  errorCode
) {
  return {
    eventType: 'MEMORY_EXTRACT',
    enqueued: Boolean(enqueued),
    duplicate: Boolean(duplicate),
    processed: Boolean(processed),
    status: pr9SafeUpperToken_(status),
    reason: pr9SafeUpperToken_(reason),
    errorCode: pr9SafeUpperToken_(errorCode)
  };
}

function enqueueWeeklyBackupIfDue_(now) {
  var dayOfWeek = Utilities.formatDate(now, APP_CONSTANTS.TIME_ZONE, 'u');
  var hour = Number(Utilities.formatDate(now, APP_CONSTANTS.TIME_ZONE, 'H'));
  if (dayOfWeek !== '7' || hour < 3) {
    return {
      enqueued: false,
      reason: 'WEEKLY_BACKUP_WINDOW_NOT_REACHED'
    };
  }
  var backupDate = formatDateInTokyo(now);
  var dedupeKey = 'WEEKLY_BACKUP:' + backupDate;
  var existing = SheetRepository.getEventByDedupeKey(dedupeKey);
  if (existing) {
    return {
      enqueued: false,
      reason: 'WEEKLY_BACKUP_ALREADY_EXISTS',
      eventId: existing.eventId,
      status: existing.status,
      backupDate: backupDate
    };
  }
  var event = QueueService.enqueue({
    eventType: 'WEEKLY_BACKUP',
    dedupeKey: dedupeKey,
    payload: {
      backupDate: backupDate,
      requestedAt: toIsoStringInTokyo(now)
    },
    status: 'PENDING',
    nextAttemptAt: toIsoStringInTokyo(now),
    createdAt: toIsoStringInTokyo(now),
    updatedAt: toIsoStringInTokyo(now)
  });
  return {
    enqueued: true,
    eventId: event.eventId,
    backupDate: backupDate
  };
}

function installTriggers() {
  ProactiveMessageService.assertAutomaticTriggerReady();
  var existing = ScriptApp.getProjectTriggers();
  ensureTrigger_(existing, 'processQueueJob', 5);
  ensureTrigger_(existing, 'schedulerJob', 15);
  var result = listProjectTriggers_();
  return logPr9TestResult_('installTriggers', result);
}

function sanitizeReleaseEnqueueResult_(eventType, result) {
  result = result || {};
  var hasEnqueued = Object.prototype.hasOwnProperty.call(
    result,
    'enqueued'
  );
  return {
    eventType: eventType,
    enqueued: hasEnqueued
      ? Boolean(result.enqueued)
      : Boolean(result.eligible),
    duplicate: Boolean(result.duplicate),
    reason: result.reason || null,
    status: result.diaryStatus || null
  };
}

function deleteProjectTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  return [];
}

function listProjectTriggers() {
  var result = listProjectTriggers_();
  return logPr9TestResult_('listProjectTriggers', result);
}

function listProjectTriggers_() {
  return ScriptApp.getProjectTriggers().map(function(trigger) {
    return {
      handlerFunction: trigger.getHandlerFunction(),
      eventType: String(trigger.getEventType()),
      triggerSource: String(trigger.getTriggerSource())
    };
  });
}

function logPr9TestResult_(functionName, result) {
  var payload = buildPr9TestLogPayload_(functionName, result);
  console.log(
    'PR9_TEST_RESULT ' +
      functionName +
      ' ' +
      JSON.stringify(payload)
  );
  return result;
}

function buildPr9TestLogPayload_(functionName, result) {
  if (functionName === 'runOperationalHealthCheck') {
    return buildPr9OperationalHealthLog_(result);
  }
  if (functionName === 'inspectProactivePolicy') {
    return buildPr9ProactivePolicyLog_(result);
  }
  if (functionName === 'inspectPr9PersistenceSafety') {
    return buildPr9PersistenceSafetyLog_(result);
  }
  if (functionName === 'inspectPreviousDiaryReleaseTest') {
    result = result || {};
    return {
      status: pr9SafeUpperToken_(result.status),
      anchorCount: pr9SafeCount_(result.anchorCount)
    };
  }
  if (
    functionName === 'runDiaryReleaseTest' ||
    functionName === 'runMemoryReleaseTest' ||
    functionName === 'resumeMemoryReleaseTest' ||
    functionName === 'recoverDeadMemoryReleaseTest' ||
    functionName === 'runProactiveReleaseTest'
  ) {
    return buildPr9ReleaseTestLog_(result);
  }
  if (functionName === 'diagnoseMemoryReleaseGeneration') {
    return buildPr9MemoryGenerationDiagnosisLog_(result);
  }
  if (
    functionName === 'listProjectTriggers' ||
    functionName === 'installTriggers'
  ) {
    return buildPr9TriggerListLog_(result);
  }
  throw createAppError(
    'VALIDATION_REQUEST_INVALID',
    'The PR9 test result logger does not recognize this function.'
  );
}

function buildPr9OperationalHealthLog_(result) {
  result = result || {};
  var queue = result.queue || {};
  var byStatus = queue.byStatus || {};
  var byEventType = queue.byEventType || {};
  var recentDead = queue.recentDead || {};
  var recentDeadByEventType = recentDead.byEventType || {};
  var staleProcessing = queue.staleProcessing || {};
  var overdue = queue.overdue || {};
  var triggers = result.triggers || {};
  var required = triggers.required || {};
  var processQueueJob = required.processQueueJob || {};
  var schedulerJob = required.schedulerJob || {};
  return {
    status: pr9SafeUpperToken_(result.status),
    queue: {
      total: pr9SafeCount_(queue.total),
      byStatus: {
        PENDING: pr9SafeCount_(byStatus.PENDING),
        PROCESSING: pr9SafeCount_(byStatus.PROCESSING),
        RETRY_WAIT: pr9SafeCount_(byStatus.RETRY_WAIT),
        DONE: pr9SafeCount_(byStatus.DONE),
        DEAD: pr9SafeCount_(byStatus.DEAD)
      },
      byEventType: buildPr9EventTypeStatusCountsLog_(byEventType),
      recentDead: {
        total: pr9SafeCount_(recentDead.total),
        resolvedTotal: pr9SafeCount_(recentDead.resolvedTotal),
        byEventType: buildPr9EventTypeCountsLog_(recentDeadByEventType)
      },
      staleProcessing: {
        total: pr9SafeCount_(staleProcessing.total)
      },
      overdue: {
        pending: pr9SafeCount_(overdue.pending),
        retryWait: pr9SafeCount_(overdue.retryWait)
      }
    },
    triggers: {
      required: {
        processQueueJob: {
          count: pr9SafeCount_(processQueueJob.count)
        },
        schedulerJob: {
          count: pr9SafeCount_(schedulerJob.count)
        }
      },
      missingCount: pr9SafeCount_(triggers.missingCount),
      duplicateCount: pr9SafeCount_(triggers.duplicateCount),
      unexpectedCount: pr9SafeCount_(triggers.unexpectedCount)
    }
  };
}

function buildPr9EventTypeStatusCountsLog_(source) {
  source = source || {};
  return {
    CHAT_REPLY: buildPr9StatusCountsLog_(source.CHAT_REPLY),
    MEMORY_EXTRACT: buildPr9StatusCountsLog_(source.MEMORY_EXTRACT),
    DIARY_GENERATE: buildPr9StatusCountsLog_(source.DIARY_GENERATE),
    PROACTIVE_SEND: buildPr9StatusCountsLog_(source.PROACTIVE_SEND),
    WEEKLY_BACKUP: buildPr9StatusCountsLog_(source.WEEKLY_BACKUP)
  };
}

function buildPr9StatusCountsLog_(source) {
  source = source || {};
  return {
    PENDING: pr9SafeCount_(source.PENDING),
    PROCESSING: pr9SafeCount_(source.PROCESSING),
    RETRY_WAIT: pr9SafeCount_(source.RETRY_WAIT),
    DONE: pr9SafeCount_(source.DONE),
    DEAD: pr9SafeCount_(source.DEAD)
  };
}

function buildPr9EventTypeCountsLog_(source) {
  source = source || {};
  return {
    CHAT_REPLY: pr9SafeCount_(source.CHAT_REPLY),
    MEMORY_EXTRACT: pr9SafeCount_(source.MEMORY_EXTRACT),
    DIARY_GENERATE: pr9SafeCount_(source.DIARY_GENERATE),
    PROACTIVE_SEND: pr9SafeCount_(source.PROACTIVE_SEND),
    WEEKLY_BACKUP: pr9SafeCount_(source.WEEKLY_BACKUP)
  };
}

function buildPr9ProactivePolicyLog_(result) {
  result = result || {};
  var timeBands = result.timeBands || null;
  var guardrails = result.guardrails || null;
  return {
    valid: pr9SafeBoolean_(result.valid),
    environment: pr9SafeLowerToken_(result.environment),
    frequency: pr9SafeLowerToken_(result.frequency),
    enabled: pr9SafeBoolean_(result.enabled),
    policyMode: pr9SafeLowerToken_(result.policyMode),
    silenceFloorMinutes: pr9SafeNumber_(result.silenceFloorMinutes),
    silenceCeilingMinutes: pr9SafeNumber_(result.silenceCeilingMinutes),
    recheckMinutes: pr9SafeNumber_(result.recheckMinutes),
    currentTimeWeight: pr9SafeNumber_(result.currentTimeWeight),
    quietHoursActive: pr9SafeBoolean_(result.quietHoursActive),
    timeBands: timeBands
      ? {
        morningStart: pr9SafeTime_(timeBands.morningStart),
        dayStart: pr9SafeTime_(timeBands.dayStart),
        eveningStart: pr9SafeTime_(timeBands.eveningStart),
        quietStart: pr9SafeTime_(timeBands.quietStart),
        quietEnd: pr9SafeTime_(timeBands.quietEnd),
        morningWeight: pr9SafeNumber_(timeBands.morningWeight),
        dayWeight: pr9SafeNumber_(timeBands.dayWeight),
        eveningWeight: pr9SafeNumber_(timeBands.eveningWeight),
        probabilityCurve: pr9SafeNumber_(
          timeBands.probabilityCurve
        )
      }
      : null,
    guardrails: guardrails
      ? {
        quietStart: pr9SafeTime_(guardrails.quietStart),
        quietEnd: pr9SafeTime_(guardrails.quietEnd),
        quietHoursEnabled: pr9SafeBoolean_(
          guardrails.quietHoursEnabled
        ),
        cooldownMinutes: pr9SafeNumber_(
          guardrails.cooldownMinutes
        ),
        maxPerDay: pr9SafeNumber_(guardrails.maxPerDay)
      }
      : null,
    automaticTriggersAllowed: pr9SafeBoolean_(
      result.automaticTriggersAllowed
    ),
    manualTestAllowed: pr9SafeBoolean_(
      result.manualTestAllowed
    ),
    issues: pr9SafeCodeList_(result.issues)
  };
}

function buildPr9PersistenceSafetyLog_(result) {
  result = result || {};
  var checked = result.checked || {};
  var unsafe = result.unsafePersistedOrSent || {};
  var metrics = result.metrics || {};
  return {
    valid: pr9SafeBoolean_(result.valid),
    windowSource: pr9SafeUpperToken_(result.windowSource),
    checked: {
      chatMessages: pr9SafeCount_(checked.chatMessages),
      imageSummaries: pr9SafeCount_(checked.imageSummaries),
      proactiveMarkers: pr9SafeCount_(
        checked.proactiveMarkers
      ),
      sentProactiveMarkers: pr9SafeCount_(
        checked.sentProactiveMarkers
      ),
      diaries: pr9SafeCount_(checked.diaries),
      memories: pr9SafeCount_(checked.memories),
      total: pr9SafeCount_(checked.total)
    },
    unsafePersistedOrSent: {
      chatMessages: pr9SafeCount_(unsafe.chatMessages),
      imageSummaries: pr9SafeCount_(unsafe.imageSummaries),
      proactiveMarkers: pr9SafeCount_(
        unsafe.proactiveMarkers
      ),
      sentProactiveMarkers: pr9SafeCount_(
        unsafe.sentProactiveMarkers
      ),
      diaries: pr9SafeCount_(unsafe.diaries),
      memories: pr9SafeCount_(unsafe.memories),
      total: pr9SafeCount_(unsafe.total)
    },
    metrics: {
      immersion_unsafe_persisted_or_sent_total:
        pr9SafeCount_(
          metrics.immersion_unsafe_persisted_or_sent_total
        )
    },
    issues: pr9SafeCodeList_(result.issues)
  };
}

function buildPr9ReleaseTestLog_(result) {
  result = result || {};
  return {
    eventType: pr9SafeUpperToken_(result.eventType),
    enqueued: pr9SafeBoolean_(result.enqueued),
    duplicate: pr9SafeBoolean_(result.duplicate),
    processed: pr9SafeBoolean_(result.processed),
    status: pr9SafeUpperToken_(result.status),
    reason: pr9SafeUpperToken_(result.reason),
    errorCode: pr9SafeUpperToken_(result.errorCode)
  };
}

function buildPr9MemoryGenerationDiagnosisLog_(result) {
  result = result || {};
  return {
    eventType: pr9SafeUpperToken_(result.eventType),
    ok: pr9SafeBoolean_(result.ok),
    stage: pr9SafeUpperToken_(result.stage),
    errorCode: pr9SafeUpperToken_(result.errorCode),
    candidateCount: result.candidateCount == null
      ? null
      : pr9SafeCount_(result.candidateCount)
  };
}

function buildPr9TriggerListLog_(result) {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.map(function(trigger) {
    trigger = trigger || {};
    return {
      handlerFunction: pr9SafeHandlerName_(
        trigger.handlerFunction
      ),
      eventType: pr9SafeUpperToken_(trigger.eventType),
      triggerSource: pr9SafeUpperToken_(
        trigger.triggerSource
      )
    };
  });
}

function pr9SafeBoolean_(value) {
  return typeof value === 'boolean' ? value : null;
}

function pr9SafeNumber_(value) {
  if (value == null || value === '') {
    return null;
  }
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function pr9SafeCount_(value) {
  var number = pr9SafeNumber_(value);
  return number != null &&
    number >= 0 &&
    Math.floor(number) === number
    ? number
    : null;
}

function pr9SafeUpperToken_(value) {
  if (value == null || value === '') {
    return null;
  }
  var token = String(value);
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(token)
    ? token
    : null;
}

function pr9SafeLowerToken_(value) {
  if (value == null || value === '') {
    return null;
  }
  var token = String(value);
  return /^[a-z][a-z0-9_-]{0,63}$/.test(token)
    ? token
    : null;
}

function pr9SafeHandlerName_(value) {
  if (value == null || value === '') {
    return null;
  }
  var handler = String(value);
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(handler)
    ? handler
    : null;
}

function pr9SafeTime_(value) {
  if (value == null || value === '') {
    return null;
  }
  var time = String(value);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
    ? time
    : null;
}

function pr9SafeCodeList_(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map(pr9SafeUpperToken_).filter(function(value) {
    return value != null;
  });
}

function ensureTrigger_(existingTriggers, handlerFunction, everyMinutes) {
  var hasTrigger = (existingTriggers || []).some(function(trigger) {
    return trigger.getHandlerFunction() === handlerFunction;
  });
  if (!hasTrigger) {
    ScriptApp.newTrigger(handlerFunction)
      .timeBased()
      .everyMinutes(everyMinutes)
      .create();
  }
}

function hasPastTokyoTime_(date, hhmm) {
  var currentMinutes = Number(Utilities.formatDate(date, APP_CONSTANTS.TIME_ZONE, 'H')) * 60 +
    Number(Utilities.formatDate(date, APP_CONSTANTS.TIME_ZONE, 'm'));
  var parts = String(hhmm).split(':');
  return currentMinutes >= Number(parts[0]) * 60 + Number(parts[1]);
}

function getTokyoRelativeDate_(date, dayDelta) {
  var base = new Date(date.getTime() + dayDelta * 86400000);
  return formatDateInTokyo(base);
}

function getConfigInt_(key, fallback) {
  try {
    var config = ConfigRepository.getByKey(key);
    return config && config.value != null ? Number(config.value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function getConfigString_(key, fallback) {
  try {
    var config = ConfigRepository.getByKey(key);
    return config && config.value != null ? String(config.value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function schedulerJob() {
  var now = new Date();
  var nowIso = toIsoStringInTokyo(now);
  var summary = {
    proactive: null,
    diary: null,
    memory: null,
    weeklyBackup: null,
    maintenance: null
  };

  summary.maintenance = MaintenanceService.runPeriodicMaintenance(now);
  summary.proactive = enqueueProactiveIfEligible_(now);
  summary.memory = enqueueMemoryExtractionIfDue_(nowIso);
  summary.diary = enqueueDiaryIfDue_(now);
  summary.weeklyBackup = enqueueWeeklyBackupIfDue_(now);

  return summary;
}

function enqueueProactiveIfEligible_(now) {
  var evaluation = ProactiveMessageService.evaluateLocalConditions(now);
  if (!evaluation.eligible || !evaluation.payload) {
    return evaluation;
  }
  var event = QueueService.enqueue({
    eventType: 'PROACTIVE_SEND',
    dedupeKey: evaluation.dedupeKey,
    payload: evaluation.payload,
    status: 'PENDING',
    nextAttemptAt: evaluation.payload.evaluatedAt,
    createdAt: evaluation.payload.evaluatedAt,
    updatedAt: evaluation.payload.evaluatedAt
  });
  return {
    eligible: true,
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
  if (DiaryService.isGenerated(yesterday)) {
    return {
      enqueued: false,
      reason: 'ALREADY_GENERATED',
      diaryDate: yesterday
    };
  }
  return DiaryService.enqueue(yesterday);
}

function enqueueMemoryExtractionIfDue_(nowIso) {
  var state = SheetRepository.ensureDefaultUserState();
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
      enqueued: false,
      reason: 'INSUFFICIENT_NEW_MESSAGES',
      messageCount: sourceMessages.length
    };
  }
  var batch = sourceMessages.slice(0, interval);
  return MemoryService.enqueueExtraction({
    firstMessageId: batch[0].messageId,
    lastMessageId: batch[batch.length - 1].messageId,
    sourceMessageIds: batch.map(function(message) {
      return message.messageId;
    }),
    requestedAt: nowIso
  });
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
  var existing = ScriptApp.getProjectTriggers();
  ensureTrigger_(existing, 'processQueueJob', 5);
  ensureTrigger_(existing, 'schedulerJob', 15);
  return listProjectTriggers();
}

function deleteProjectTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  return [];
}

function listProjectTriggers() {
  return ScriptApp.getProjectTriggers().map(function(trigger) {
    return {
      handlerFunction: trigger.getHandlerFunction(),
      eventType: String(trigger.getEventType()),
      triggerSource: String(trigger.getTriggerSource()),
      uniqueId: trigger.getUniqueId ? trigger.getUniqueId() : null
    };
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

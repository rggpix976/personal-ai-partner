var OperationalHealthService = (function() {
  var DEFAULTS = Object.freeze({
    queueDelayGraceMinutes: 20,
    staleMinutes: 15,
    deadLookbackHours: 168,
    alertCooldownMinutes: 720
  });

  function inspect(now, triggerHealth) {
    var reference = normalizeReferenceDate_(now);
    var checkedAt = toIsoStringInTokyo(reference);
    var queueDelayGraceMinutes = getConfigInt_(
      'OPS_QUEUE_DELAY_GRACE_MINUTES',
      DEFAULTS.queueDelayGraceMinutes
    );
    var staleMinutes = getConfigInt_('QUEUE_STALE_MINUTES', DEFAULTS.staleMinutes);
    var deadLookbackHours = getConfigInt_(
      'OPS_DEAD_LOOKBACK_HOURS',
      DEFAULTS.deadLookbackHours
    );
    var delayedBefore = reference.getTime() - queueDelayGraceMinutes * 60000;
    var staleBefore = reference.getTime() - staleMinutes * 60000;
    var deadAfter = reference.getTime() - deadLookbackHours * 3600000;
    var events = SheetRepository.listEvents();
    var statusCounts = initializeCountMap_(APP_CONSTANTS.EVENT_STATUSES);
    var byEventType = initializeEventTypeCounts_();
    var recentDeadByEventType = initializeCountMap_(APP_CONSTANTS.EVENT_TYPES);
    var recentDeadByErrorCode = {};
    var recentDeadCount = 0;
    var resolvedRecentDeadCount = 0;
    var staleProcessingCount = 0;
    var overduePendingCount = 0;
    var overdueRetryCount = 0;

    events.forEach(function(event) {
      if (Object.prototype.hasOwnProperty.call(statusCounts, event.status)) {
        statusCounts[event.status] += 1;
      }
      if (byEventType[event.eventType] &&
          Object.prototype.hasOwnProperty.call(byEventType[event.eventType], event.status)) {
        byEventType[event.eventType][event.status] += 1;
      }

      if (event.status === 'PROCESSING' &&
          event.lockedAt &&
          safeTime_(event.lockedAt) <= staleBefore) {
        staleProcessingCount += 1;
      }

      var dueAt = event.nextAttemptAt || event.createdAt;
      if (event.status === 'PENDING' && dueAt && safeTime_(dueAt) <= delayedBefore) {
        overduePendingCount += 1;
      }
      if (event.status === 'RETRY_WAIT' &&
          event.nextAttemptAt &&
          safeTime_(event.nextAttemptAt) <= delayedBefore) {
        overdueRetryCount += 1;
      }

      if (event.status === 'DEAD' && getEventTerminalTime_(event) >= deadAfter) {
        if (isResolvedDiaryDead_(event, events)) {
          resolvedRecentDeadCount += 1;
          return;
        }
        recentDeadCount += 1;
        if (Object.prototype.hasOwnProperty.call(recentDeadByEventType, event.eventType)) {
          recentDeadByEventType[event.eventType] += 1;
        }
        var errorCode = normalizeErrorCode_(event.lastError && event.lastError.code);
        recentDeadByErrorCode[errorCode] = Number(recentDeadByErrorCode[errorCode] || 0) + 1;
      }
    });

    var normalizedTriggerHealth = normalizeTriggerHealth_(triggerHealth);
    var missingOrDuplicateTriggers = normalizedTriggerHealth.missingCount +
      normalizedTriggerHealth.duplicateCount;
    var status = 'OK';
    if (missingOrDuplicateTriggers > 0 || staleProcessingCount > 0) {
      status = 'CRITICAL';
    } else if (recentDeadCount > 0 || overduePendingCount > 0 || overdueRetryCount > 0) {
      status = 'DEGRADED';
    }

    return {
      status: status,
      checkedAt: checkedAt,
      queue: {
        total: events.length,
        byStatus: statusCounts,
        byEventType: byEventType,
        recentDead: {
          lookbackHours: deadLookbackHours,
          total: recentDeadCount,
          resolvedTotal: resolvedRecentDeadCount,
          byEventType: recentDeadByEventType,
          byErrorCode: recentDeadByErrorCode
        },
        staleProcessing: {
          thresholdMinutes: staleMinutes,
          total: staleProcessingCount
        },
        overdue: {
          graceMinutes: queueDelayGraceMinutes,
          pending: overduePendingCount,
          retryWait: overdueRetryCount
        }
      },
      triggers: normalizedTriggerHealth
    };
  }

  function run(now, triggerHealth) {
    var reference = normalizeReferenceDate_(now);
    var report = inspect(reference, triggerHealth);
    try {
      report.notification = recordAndMaybeNotify_(report, reference);
    } catch (error) {
      var normalized = normalizeError(error);
      if (normalized.code !== 'QUEUE_LOCK_BUSY') {
        throw normalized;
      }
      AppLogger.warn(
        'operationalHealthCheck',
        'Operational health reporting was deferred because the script lock is busy.',
        { code: normalized.code }
      );
      report.notification = {
        stateChanged: false,
        logged: false,
        emailEnabled: getConfigBool_('OPS_ALERT_EMAIL_ENABLED', false),
        emailSent: false,
        reason: 'QUEUE_LOCK_BUSY'
      };
    }
    return report;
  }

  function recordAndMaybeNotify_(report, now) {
    var transition = claimReportTransition_(report.status, now);
    if (!transition.shouldReport) {
      return {
        stateChanged: false,
        logged: false,
        emailEnabled: getConfigBool_('OPS_ALERT_EMAIL_ENABLED', false),
        emailSent: false,
        reason: 'NO_REPORT_REQUIRED'
      };
    }

    var level = report.status === 'CRITICAL' ? 'ERROR' :
      (report.status === 'DEGRADED' ? 'WARN' : 'INFO');
    AppLogger.writeDebugLog(
      level,
      'operationalHealthCheck',
      report.status === 'OK' ? 'Operational health recovered.' : 'Operational health requires attention.',
      buildSanitizedDetails_(report)
    );

    var emailEnabled = getConfigBool_('OPS_ALERT_EMAIL_ENABLED', false);
    if (!emailEnabled) {
      return {
        stateChanged: transition.stateChanged,
        logged: true,
        emailEnabled: false,
        emailSent: false,
        reason: 'EMAIL_DISABLED'
      };
    }

    var ownerEmail = PropertiesService.getScriptProperties().getProperty(
      APP_CONSTANTS.PROPERTY_KEYS.OWNER_EMAIL
    );
    if (!ownerEmail) {
      return {
        stateChanged: transition.stateChanged,
        logged: true,
        emailEnabled: true,
        emailSent: false,
        reason: 'OWNER_EMAIL_MISSING'
      };
    }

    try {
      GmailNotifier.send(
        ownerEmail,
        '[Personal AI Partner] Operational health: ' + report.status,
        buildAlertBody_(report),
        { name: 'Personal AI Partner Operations' }
      );
      return {
        stateChanged: transition.stateChanged,
        logged: true,
        emailEnabled: true,
        emailSent: true,
        reason: 'SENT'
      };
    } catch (error) {
      var normalized = normalizeError(error);
      AppLogger.writeDebugLog('ERROR', 'operationalHealthCheck', 'Operational health email could not be sent.', {
        code: normalized.code
      });
      return {
        stateChanged: transition.stateChanged,
        logged: true,
        emailEnabled: true,
        emailSent: false,
        reason: normalized.code
      };
    }
  }

  function claimReportTransition_(status, now) {
    var cooldownMinutes = getConfigInt_(
      'OPS_ALERT_COOLDOWN_MINUTES',
      DEFAULTS.alertCooldownMinutes
    );
    return LockManager.withScriptLock('operational-health-state', function() {
      var properties = PropertiesService.getScriptProperties();
      var previous = parseAlertState_(
        properties.getProperty(APP_CONSTANTS.PROPERTY_KEYS.OPS_ALERT_STATE)
      );
      var nowIso = toIsoStringInTokyo(now);
      var firstObservation = previous.status == null;
      var stateChanged = !firstObservation && previous.status !== status;
      var cooldownElapsed = !previous.reportedAt ||
        now.getTime() - safeTime_(previous.reportedAt) >= cooldownMinutes * 60000;
      var shouldReport = (status === 'OK' && stateChanged) ||
        (status !== 'OK' && (firstObservation || stateChanged || cooldownElapsed));

      properties.setProperty(
        APP_CONSTANTS.PROPERTY_KEYS.OPS_ALERT_STATE,
        JsonUtil.stringify({
          status: status,
          checkedAt: nowIso,
          reportedAt: shouldReport ? nowIso : previous.reportedAt
        })
      );
      return {
        stateChanged: stateChanged,
        shouldReport: shouldReport
      };
    });
  }

  function buildSanitizedDetails_(report) {
    return {
      status: report.status,
      checkedAt: report.checkedAt,
      queueByStatus: report.queue.byStatus,
      recentDeadByEventType: report.queue.recentDead.byEventType,
      recentDeadByErrorCode: report.queue.recentDead.byErrorCode,
      resolvedRecentDeadCount: report.queue.recentDead.resolvedTotal,
      staleProcessingCount: report.queue.staleProcessing.total,
      overduePendingCount: report.queue.overdue.pending,
      overdueRetryWaitCount: report.queue.overdue.retryWait,
      triggerMissingCount: report.triggers.missingCount,
      triggerDuplicateCount: report.triggers.duplicateCount
    };
  }

  function buildAlertBody_(report) {
    var details = buildSanitizedDetails_(report);
    return [
      'Personal AI Partner operational health: ' + report.status,
      'Checked at: ' + report.checkedAt,
      '',
      'Unresolved recent DEAD events: ' + report.queue.recentDead.total,
      'Resolved recent DEAD events retained for audit: ' + report.queue.recentDead.resolvedTotal,
      'Stale PROCESSING events: ' + details.staleProcessingCount,
      'Overdue PENDING events: ' + details.overduePendingCount,
      'Overdue RETRY_WAIT events: ' + details.overdueRetryWaitCount,
      'Missing required triggers: ' + details.triggerMissingCount,
      'Duplicate required triggers: ' + details.triggerDuplicateCount,
      '',
      'This notification intentionally excludes message content, payloads, IDs, URLs, and email addresses.'
    ].join('\n');
  }

  function normalizeTriggerHealth_(triggerHealth) {
    var source = triggerHealth || {};
    var processQueueJob = normalizeTriggerEntry_(
      source.required && source.required.processQueueJob
    );
    var schedulerJob = normalizeTriggerEntry_(
      source.required && source.required.schedulerJob
    );
    return {
      required: {
        processQueueJob: processQueueJob,
        schedulerJob: schedulerJob
      },
      missingCount: Number(processQueueJob.count === 0) + Number(schedulerJob.count === 0),
      duplicateCount: Math.max(processQueueJob.count - 1, 0) +
        Math.max(schedulerJob.count - 1, 0),
      unexpectedCount: normalizeCount_(source.unexpectedCount)
    };
  }

  function normalizeTriggerEntry_(entry) {
    return {
      count: normalizeCount_(entry && entry.count),
      expectedCount: 1
    };
  }

  function normalizeCount_(value) {
    var count = Number(value || 0);
    return isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  }

  function initializeEventTypeCounts_() {
    var result = {};
    APP_CONSTANTS.EVENT_TYPES.forEach(function(eventType) {
      result[eventType] = initializeCountMap_(APP_CONSTANTS.EVENT_STATUSES);
    });
    return result;
  }

  function initializeCountMap_(keys) {
    var result = {};
    (keys || []).forEach(function(key) {
      result[key] = 0;
    });
    return result;
  }

  function getEventTerminalTime_(event) {
    return safeTime_(event.completedAt || event.updatedAt || event.createdAt);
  }

  function isResolvedDiaryDead_(event, events) {
    if (!event || event.eventType !== 'DIARY_GENERATE') {
      return false;
    }
    var diaryDate = event.payload && event.payload.diaryDate;
    if (!Validators.isDateString(diaryDate)) {
      return false;
    }
    var deadTime = getEventTerminalTime_(event);
    return (events || []).some(function(candidate) {
      return candidate !== event &&
        candidate.eventType === 'DIARY_GENERATE' &&
        candidate.status === 'DONE' &&
        candidate.payload &&
        candidate.payload.diaryDate === diaryDate &&
        getEventTerminalTime_(candidate) >= deadTime;
    });
  }

  function safeTime_(value) {
    var time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return isFinite(time) ? time : 0;
  }

  function normalizeErrorCode_(code) {
    var normalized = String(code || 'UNKNOWN').trim();
    return Object.prototype.hasOwnProperty.call(APP_ERROR_DEFINITIONS, normalized)
      ? normalized
      : 'UNKNOWN';
  }

  function normalizeReferenceDate_(value) {
    var date = value instanceof Date ? value : (value ? new Date(value) : new Date());
    ensure(isFinite(date.getTime()), 'VALIDATION_REQUEST_INVALID', 'Operational health reference time is invalid.');
    return date;
  }

  function parseAlertState_(value) {
    if (!value) {
      return {
        status: null,
        checkedAt: null,
        reportedAt: null
      };
    }
    try {
      var parsed = JSON.parse(value);
      return {
        status: parsed.status || null,
        checkedAt: parsed.checkedAt || null,
        reportedAt: parsed.reportedAt || null
      };
    } catch (ignore) {
      return {
        status: null,
        checkedAt: null,
        reportedAt: null
      };
    }
  }

  function getConfigInt_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      var value = config && config.value != null ? Number(config.value) : fallback;
      return isFinite(value) && value >= 0 ? value : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function getConfigBool_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? Boolean(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  return {
    inspect: inspect,
    run: run,
    __test: {
      buildAlertBody: buildAlertBody_,
      buildSanitizedDetails: buildSanitizedDetails_
    }
  };
})();

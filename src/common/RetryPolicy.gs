var RetryPolicy = (function() {
  var BACKOFF_MINUTES = {
    1: 1,
    2: 5,
    3: 30,
    4: 120
  };

  function getRetryDecision(error, attemptCount, now, context) {
    var normalized = normalizeError(error);
    var reference = now || new Date();
    context = context || {};

    if (normalized.code === 'MAIL_QUOTA_EXHAUSTED') {
      return buildMailQuotaDecision(reference, context);
    }

    if (!normalized.retryable || normalized.retryStrategy === 'NONE') {
      return {
        action: 'DEAD',
        nextAttemptAt: null,
        retryAfterMs: null,
        reason: normalized.code
      };
    }

    if (attemptCount >= 5) {
      return {
        action: 'DEAD',
        nextAttemptAt: null,
        retryAfterMs: null,
        reason: 'QUEUE_DEAD'
      };
    }

    var backoffMinutes = BACKOFF_MINUTES[attemptCount];
    if (!backoffMinutes) {
      return {
        action: 'DEAD',
        nextAttemptAt: null,
        retryAfterMs: null,
        reason: 'QUEUE_DEAD'
      };
    }
    var nextAttemptAt = new Date(reference.getTime() + backoffMinutes * 60 * 1000);
    return {
      action: 'RETRY_WAIT',
      nextAttemptAt: nextAttemptAt,
      retryAfterMs: nextAttemptAt.getTime() - reference.getTime(),
      reason: normalized.code
    };
  }

  function buildMailQuotaDecision(now, context) {
    var nextWindow = getNextDailyWindow(now);
    if (
      context.eventType === 'PROACTIVE_SEND' &&
      context.payload &&
      context.payload.targetDate &&
      context.payload.targetDate < formatDateInTokyo(nextWindow)
    ) {
      return {
        action: 'DONE',
        nextAttemptAt: null,
        retryAfterMs: null,
        reason: 'skipped_quota_expired'
      };
    }
    return {
      action: 'RETRY_WAIT',
      nextAttemptAt: nextWindow,
      retryAfterMs: nextWindow.getTime() - now.getTime(),
      reason: 'MAIL_QUOTA_EXHAUSTED'
    };
  }

  function getNextDailyWindow(now) {
    var base = new Date(now.getTime());
    var year = Number(Utilities.formatDate(base, APP_CONSTANTS.TIME_ZONE, 'yyyy'));
    var month = Number(Utilities.formatDate(base, APP_CONSTANTS.TIME_ZONE, 'M')) - 1;
    var day = Number(Utilities.formatDate(base, APP_CONSTANTS.TIME_ZONE, 'd'));
    var timeParts = APP_CONSTANTS.DAILY_MAIL_RETRY_TIME.split(':');
    var window = new Date(year, month, day + 1, Number(timeParts[0]), Number(timeParts[1]), 0, 0);
    return window;
  }

  return {
    getRetryDecision: getRetryDecision,
    getNextDailyWindow: getNextDailyWindow
  };
})();

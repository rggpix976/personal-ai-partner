var ProactiveMessageService = (function() {
  function evaluateLocalConditions(now) {
    var warnings = [];
    var nowDate = now instanceof Date ? now : (now ? parseIsoToDate(now) : new Date());
    var nowIso = toIsoStringInTokyo(nowDate);
    try {
      SheetRepository.ensureDefaultUserState();
      var state = SheetRepository.getUserState();
      ensure(state, 'CONFIG_MISSING', 'user_state row is missing.');

      var quietStart = requireConfig_('QUIET_START');
      var quietEnd = requireConfig_('QUIET_END');
      var silenceMinutes = Number(requireConfig_('SILENCE_MINUTES'));
      var cooldownMinutes = Number(requireConfig_('PROACTIVE_COOLDOWN_MINUTES'));
      var maxPerDay = Number(requireConfig_('PROACTIVE_MAX_PER_DAY'));

      if (isQuietHours_(nowDate, quietStart, quietEnd)) {
        return buildEvaluation_(false, 'QUIET_HOURS', null, null, warnings);
      }

      if (state.quiet_until && getIsoTimeMillis(state.quiet_until) > nowDate.getTime()) {
        return buildEvaluation_(false, 'QUIET_UNTIL_ACTIVE', null, null, warnings);
      }

      if (!state.last_user_message_at) {
        return buildEvaluation_(false, 'NO_USER_ACTIVITY', null, null, warnings);
      }

      var silenceMs = nowDate.getTime() - getIsoTimeMillis(state.last_user_message_at);
      if (silenceMs < silenceMinutes * 60 * 1000) {
        return buildEvaluation_(false, 'SILENCE_THRESHOLD_NOT_MET', null, null, warnings);
      }

      if (state.last_proactive_at && nowDate.getTime() - getIsoTimeMillis(state.last_proactive_at) < cooldownMinutes * 60 * 1000) {
        return buildEvaluation_(false, 'COOLDOWN_ACTIVE', null, null, warnings);
      }

      var today = formatDateInTokyo(nowDate);
      var proactiveCount = state.proactive_count_date === today ? Number(state.proactive_count || 0) : 0;
      if (proactiveCount >= maxPerDay) {
        return buildEvaluation_(false, 'MAX_PER_DAY_REACHED', null, null, warnings);
      }

      if (state.next_proactive_check_at && getIsoTimeMillis(state.next_proactive_check_at) > nowDate.getTime()) {
        return buildEvaluation_(false, 'NEXT_CHECK_NOT_DUE', null, null, warnings);
      }

      var remainingQuota = GmailNotifier.getRemainingQuota();
      if (remainingQuota <= 0) {
        return buildEvaluation_(false, 'MAIL_QUOTA_EXHAUSTED', null, null, warnings);
      }

      var sequence = proactiveCount + 1;
      var dedupeKey = 'PROACTIVE_SEND:' + today + ':' + sequence;
      var payload = {
        targetDate: today,
        sequence: sequence,
        dedupeKey: dedupeKey,
        evaluatedAt: nowIso,
        subject: buildSubject_(today),
        body: buildBody_(state, nowIso),
        reason: 'local_silence_check'
      };
      return buildEvaluation_(true, 'ELIGIBLE', sequence, dedupeKey, warnings, payload);
    } catch (error) {
      warnings.push(normalizeError(error).code);
      return buildEvaluation_(false, 'CONFIG_MISSING', null, null, warnings);
    }
  }

  function evaluateByAi(input) {
    input = input || {};
    return {
      usedAi: false,
      candidate: input.payload || null,
      reason: 'local_only_proactive_behavior'
    };
  }

  function send(message) {
    var payload = normalizePayload_(message);
    var existing = payload.dedupeKey
      ? findExistingMarker_(payload.dedupeKey)
      : null;
    if (existing) {
      return {
        sent: false,
        duplicate: true,
        messageId: existing.messageId,
        dedupeKey: payload.dedupeKey,
        markerStatus: existing.status || null
      };
    }

    var ownerEmail = PropertiesService.getScriptProperties().getProperty(APP_CONSTANTS.PROPERTY_KEYS.OWNER_EMAIL);
    ensure(ownerEmail, 'CONFIG_MISSING', 'OWNER_EMAIL is not configured.');
    var createdAt = payload.sentAt || toIsoStringInTokyo(new Date());
    var markerRow = SheetRepository.appendConversation({
      messageId: generateUuidV4(),
      requestId: payload.dedupeKey || null,
      createdAt: createdAt,
      role: 'system',
      messageType: 'proactive',
      text: payload.body,
      image: null,
      status: 'accepted'
    });
    try {
      GmailNotifier.send(ownerEmail, payload.subject, payload.body, payload.options);
      markerRow = SheetRepository.updateConversationMessage(markerRow.messageId, {
        status: 'completed'
      });
    } catch (error) {
      var normalized = normalizeError(error);
      SheetRepository.updateConversationMessage(markerRow.messageId, {
        status: 'failed',
        error: {
          code: normalized.code
        }
      });
      throw normalized;
    }

    var today = payload.targetDate || formatDateInTokyo(parseIsoToDate(createdAt));
    var state = SheetRepository.ensureDefaultUserState();
    var proactiveCount = state.proactive_count_date === today ? Number(state.proactive_count || 0) : 0;
    var cooldownMinutes = getConfigInt_('PROACTIVE_COOLDOWN_MINUTES', 240);
    var nextCheck = new Date(parseIsoToDate(createdAt).getTime() + cooldownMinutes * 60 * 1000);
    SheetRepository.updateUserState({
      last_proactive_at: createdAt,
      proactive_count_date: today,
      proactive_count: proactiveCount + 1,
      next_proactive_check_at: toIsoStringInTokyo(nextCheck)
    });
    SheetRepository.incrementUsageDaily(today, {
      mailRecipients: 1
    });
    return {
      sent: true,
      duplicate: false,
      messageId: markerRow.messageId,
      dedupeKey: payload.dedupeKey
    };
  }

  function normalizePayload_(message) {
    ensure(message && typeof message === 'object', 'VALIDATION_REQUEST_INVALID', 'message is required.');
    var body = String(message.body || message.message || '').trim();
    ensure(body !== '', 'VALIDATION_REQUEST_INVALID', 'Proactive message body is required.');
    return {
      targetDate: message.targetDate || formatDateInTokyo(new Date()),
      sequence: Number(message.sequence || 1),
      dedupeKey: message.dedupeKey || null,
      subject: String(message.subject || buildSubject_(message.targetDate || formatDateInTokyo(new Date()))),
      body: body,
      sentAt: message.sentAt || null,
      options: message.options || {}
    };
  }

  function buildEvaluation_(eligible, reason, sequence, dedupeKey, warnings, payload) {
    return {
      eligible: eligible,
      reason: reason,
      sequence: sequence,
      dedupeKey: dedupeKey,
      payload: payload || null,
      warnings: warnings || []
    };
  }

  function findExistingMarker_(dedupeKey) {
    var marker = SheetRepository.getMessageByRequestIdAndRole(dedupeKey, 'system');
    if (!marker || marker.messageType !== 'proactive') {
      return null;
    }
    return marker;
  }

  function requireConfig_(key) {
    var config = ConfigRepository.getByKey(key);
    ensure(config && config.value != null, 'CONFIG_MISSING', 'Missing config: ' + key);
    return config.value;
  }

  function getConfigInt_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? Number(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function isQuietHours_(nowDate, quietStart, quietEnd) {
    var minutes = getTokyoMinutesOfDay_(nowDate);
    var startMinutes = parseTimeMinutes_(quietStart);
    var endMinutes = parseTimeMinutes_(quietEnd);
    if (startMinutes === endMinutes) {
      return false;
    }
    if (startMinutes < endMinutes) {
      return minutes >= startMinutes && minutes < endMinutes;
    }
    return minutes >= startMinutes || minutes < endMinutes;
  }

  function getTokyoMinutesOfDay_(date) {
    var hours = Number(Utilities.formatDate(date, APP_CONSTANTS.TIME_ZONE, 'H'));
    var minutes = Number(Utilities.formatDate(date, APP_CONSTANTS.TIME_ZONE, 'm'));
    return hours * 60 + minutes;
  }

  function parseTimeMinutes_(value) {
    var parts = String(value || '').split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  function buildSubject_(targetDate) {
    return 'A gentle check-in from your AI partner (' + targetDate + ')';
  }

  function buildBody_(state, nowIso) {
    var lastUserAt = state.last_user_message_at
      ? Utilities.formatDate(parseIsoToDate(state.last_user_message_at), APP_CONSTANTS.TIME_ZONE, 'M/d H:mm')
      : 'earlier';
    return [
      'Just a gentle check-in from your AI partner.',
      'It has been quiet since your last message around ' + lastUserAt + ' JST.',
      'If you want, we can pick up where we left off whenever you are ready.',
      '',
      'Generated at: ' + nowIso
    ].join('\n');
  }

  return {
    evaluateLocalConditions: evaluateLocalConditions,
    evaluateByAi: evaluateByAi,
    send: send
  };
})();

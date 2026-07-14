var ProactiveMessageService = (function() {
  var DEFAULTS = Object.freeze({
    silenceCeilingMinutes: 720,
    probabilityCurve: 1.3,
    dayStart: '10:00',
    eveningStart: '18:00',
    morningWeight: 0.7,
    dayWeight: 1.0,
    eveningWeight: 1.2,
    recheckMinutes: 60,
    messageMinChars: 20,
    messageMaxChars: 220,
    recentMessageLimit: 12,
    memoryLimit: 8
  });

  function evaluateLocalConditions(now) {
    var warnings = [];
    var nowDate = normalizeDate_(now);

    try {
      var nowIso = toIsoStringInTokyo(nowDate);
      var state = SheetRepository.ensureDefaultUserState();
      state = SheetRepository.getUserState() || state;
      ensure(state, 'CONFIG_MISSING', 'user_state row is missing.');

      var hardGate = evaluateHardGates_(state, nowDate, {
        checkSilence: true,
        checkNextCheck: true,
        checkQuota: true
      });
      if (!hardGate.eligible) {
        return buildEvaluation_(false, hardGate.reason, null, null, warnings, null, hardGate);
      }

      var today = formatDateInTokyo(nowDate);
      var proactiveCount = getTodayProactiveCount_(state, today);
      var sequence = proactiveCount + 1;
      var elapsedMinutes = Math.max(
        0,
        (nowDate.getTime() - getIsoTimeMillis(state.last_user_message_at)) / 60000
      );
      var recheckMinutes = Math.max(
        1,
        getConfigInt_('PROACTIVE_RECHECK_MINUTES', DEFAULTS.recheckMinutes)
      );
      var decisionSlot = buildDecisionSlot_(nowDate, recheckMinutes);
      var timeWeight = getTimeWeight_(nowDate);
      var policyMode = getConfigString_('PROACTIVE_POLICY_MODE', 'threshold').toLowerCase();
      var probability = 1;
      var sample = 0;

      if (policyMode === 'probability') {
        var silenceFloor = Number(
          requireConfig_('SILENCE_MINUTES')
        );
        var silenceCeiling = getConfigInt_(
          'PROACTIVE_SILENCE_CEILING_MINUTES',
          DEFAULTS.silenceCeilingMinutes
        );
        var curvePower = getConfigFloat_(
          'PROACTIVE_PROBABILITY_CURVE',
          DEFAULTS.probabilityCurve
        );
        ensure(
          isFinite(silenceFloor) && silenceFloor >= 0,
          'CONFIG_MISSING',
          'SILENCE_MINUTES must be a non-negative number.'
        );
        ensure(
          isFinite(silenceCeiling) &&
            silenceCeiling > silenceFloor,
          'CONFIG_MISSING',
          'PROACTIVE_SILENCE_CEILING_MINUTES must be greater than SILENCE_MINUTES.'
        );
        ensure(
          isFinite(curvePower) && curvePower > 0,
          'CONFIG_MISSING',
          'PROACTIVE_PROBABILITY_CURVE must be greater than zero.'
        );
        probability = calculateProbability_(
          elapsedMinutes,
          silenceFloor,
          silenceCeiling,
          curvePower,
          timeWeight
        );
        sample = deterministicSample_([
          today,
          String(sequence),
          decisionSlot,
          String(state.last_user_message_at)
        ].join('|'));

        if (sample >= probability) {
          return buildEvaluation_(
            false,
            'PROBABILITY_MISS',
            sequence,
            buildQueueDedupeKey_(today, sequence, decisionSlot),
            warnings,
            null,
            {
              probability: probability,
              sample: sample,
              elapsedMinutes: elapsedMinutes,
              timeWeight: timeWeight,
              decisionSlot: decisionSlot
            }
          );
        }
      } else if (policyMode !== 'threshold') {
        warnings.push('PROACTIVE_POLICY_MODE_INVALID');
        return buildEvaluation_(
          false,
          'CONFIG_MISSING',
          null,
          null,
          warnings
        );
      }

      var queueDedupeKey = buildQueueDedupeKey_(today, sequence, decisionSlot);
      var messageDedupeKey = buildMessageDedupeKey_(today, sequence);
      var payload = {
        targetDate: today,
        sequence: sequence,
        requestedAt: nowIso,
        decisionSlot: decisionSlot,
        messageDedupeKey: messageDedupeKey,
        probability: probability,
        sample: sample,
        elapsedMinutes: elapsedMinutes,
        timeWeight: timeWeight,
        reason: policyMode === 'probability'
          ? 'deterministic_probability_hit'
          : 'local_silence_threshold'
      };

      return buildEvaluation_(
        true,
        'ELIGIBLE',
        sequence,
        queueDedupeKey,
        warnings,
        payload,
        {
          probability: probability,
          sample: sample,
          elapsedMinutes: elapsedMinutes,
          timeWeight: timeWeight,
          decisionSlot: decisionSlot
        }
      );
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
      reason: 'local_policy_controls_proactive_eligibility'
    };
  }

  function prepareDispatch(eventPayload, now) {
    var payload = normalizeDecisionPayload_(eventPayload, now);
    var nowDate = normalizeDate_(now);
    var nowIso = toIsoStringInTokyo(nowDate);
    var state = SheetRepository.ensureDefaultUserState();
    state = SheetRepository.getUserState() || state;
    ensure(state, 'CONFIG_MISSING', 'user_state row is missing.');

    var existing = payload.messageDedupeKey
      ? findExistingMarker_(payload.messageDedupeKey)
      : null;

    if (existing && existing.status === 'completed') {
      return buildDispatchResult_(
        true,
        'ALREADY_DELIVERED',
        {
          targetDate: payload.targetDate,
          sequence: payload.sequence,
          dedupeKey: payload.messageDedupeKey,
          subject: buildSubject_(payload.targetDate, state, nowIso),
          body: String(
            existing.text ||
            buildBody_(state, nowIso, payload.targetDate)
          ).trim(),
          sentAt: existing.createdAt || nowIso,
          model: existing.model || null,
          inputTokens: existing.inputTokens == null
            ? null
            : existing.inputTokens,
          outputTokens: existing.outputTokens == null
            ? null
            : existing.outputTokens,
          options: {}
        },
        existing.createdAt || nowIso,
        {
          usedAi: Boolean(existing.model),
          probability: payload.probability,
          sample: payload.sample,
          decisionSlot: payload.decisionSlot
        }
      );
    }

    if (existing && existing.status === 'accepted') {
      return buildDispatchResult_(
        false,
        'DELIVERY_IN_PROGRESS',
        null,
        nowIso,
        {
          probability: payload.probability,
          sample: payload.sample,
          decisionSlot: payload.decisionSlot
        }
      );
    }

    if (payload.targetDate < formatDateInTokyo(nowDate)) {
      return buildDispatchResult_(
        false,
        'TARGET_DATE_EXPIRED',
        null,
        nowIso
      );
    }

    if (
      state.last_user_message_at &&
      getIsoTimeMillis(state.last_user_message_at) >
        getIsoTimeMillis(payload.requestedAt)
    ) {
      return buildDispatchResult_(
        false,
        'USER_ACTIVITY_AFTER_ENQUEUE',
        null,
        nowIso
      );
    }

    var hardGate = evaluateHardGates_(state, nowDate, {
      checkSilence: false,
      checkNextCheck: false,
      checkQuota: true
    });
    if (!hardGate.eligible) {
      return buildDispatchResult_(false, hardGate.reason, null, nowIso);
    }

    var preparedBody;
    var fallbackReason = null;

    if (
      existing &&
      existing.status === 'failed' &&
      String(existing.text || '').trim() !== ''
    ) {
      preparedBody = {
        text: String(existing.text).trim(),
        model: existing.model || null,
        inputTokens: existing.inputTokens == null
          ? null
          : existing.inputTokens,
        outputTokens: existing.outputTokens == null
          ? null
          : existing.outputTokens,
        usedAi: Boolean(existing.model)
      };
    } else if (
      getConfigBool_('PROACTIVE_AI_GENERATION_ENABLED', false)
    ) {
      try {
        preparedBody = generateAiBody_(state, payload, nowIso);
      } catch (error) {
        var normalizedGenerationError = normalizeError(error);
        if (!shouldFallbackToTemplate_(normalizedGenerationError)) {
          throw normalizedGenerationError;
        }
        fallbackReason = normalizedGenerationError.code;
        preparedBody = buildTemplateBodyResult_(
          state,
          nowIso,
          payload.targetDate
        );
      }
    } else {
      preparedBody = buildTemplateBodyResult_(
        state,
        nowIso,
        payload.targetDate
      );
    }

    var message = {
      targetDate: payload.targetDate,
      sequence: payload.sequence,
      dedupeKey: payload.messageDedupeKey,
      subject: buildSubject_(payload.targetDate, state, nowIso),
      body: preparedBody.text,
      sentAt: nowIso,
      model: preparedBody.model,
      inputTokens: preparedBody.inputTokens,
      outputTokens: preparedBody.outputTokens,
      options: {}
    };

    return buildDispatchResult_(true, 'READY', message, nowIso, {
      usedAi: preparedBody.usedAi,
      probability: payload.probability,
      sample: payload.sample,
      decisionSlot: payload.decisionSlot,
      fallbackReason: fallbackReason
    });
  }

  function send(message) {
    var payload = normalizeMessagePayload_(message);
    var attemptAt = payload.sentAt || toIsoStringInTokyo(new Date());
    var ownerEmail = PropertiesService.getScriptProperties().getProperty(
      APP_CONSTANTS.PROPERTY_KEYS.OWNER_EMAIL
    );
    ensure(ownerEmail, 'CONFIG_MISSING', 'OWNER_EMAIL is not configured.');

    var claim = claimDelivery_(payload, attemptAt);

    if (claim.action === 'completed') {
      LockManager.withScriptLock(
        'proactive-delivery-reconcile-' + payload.dedupeKey,
        function() {
          updateStateAfterSend_(
            payload,
            claim.marker.createdAt || attemptAt
          );
        }
      );
      return {
        sent: false,
        duplicate: true,
        messageId: claim.marker.messageId,
        dedupeKey: payload.dedupeKey,
        markerStatus: claim.marker.status || null,
        createdAt: claim.marker.createdAt || attemptAt
      };
    }

    if (claim.action === 'in_progress') {
      return {
        sent: false,
        duplicate: true,
        messageId: claim.marker.messageId,
        dedupeKey: payload.dedupeKey,
        markerStatus: claim.marker.status || null,
        createdAt: claim.marker.createdAt || attemptAt
      };
    }

    try {
      GmailNotifier.send(
        ownerEmail,
        payload.subject,
        claim.body,
        payload.options
      );
    } catch (error) {
      var normalized = normalizeError(error);
      markDeliveryFailed_(claim.marker.messageId, normalized);
      throw normalized;
    }

    var completedMarker = completeDelivery_(
      claim.marker.messageId,
      payload,
      attemptAt
    );

    return {
      sent: true,
      duplicate: false,
      messageId: completedMarker.messageId,
      dedupeKey: payload.dedupeKey,
      markerStatus: completedMarker.status || 'completed',
      createdAt: completedMarker.createdAt || attemptAt
    };
  }

  function claimDelivery_(payload, attemptAt) {
    return LockManager.withScriptLock(
      'proactive-delivery-claim-' + payload.dedupeKey,
      function() {
        var existing = findExistingMarker_(payload.dedupeKey);

        if (existing && existing.status === 'completed') {
          return {
            action: 'completed',
            marker: existing,
            body: String(existing.text || payload.body)
          };
        }

        if (existing && existing.status === 'accepted') {
          return {
            action: 'in_progress',
            marker: existing,
            body: String(existing.text || payload.body)
          };
        }

        var deliveryBody = existing && existing.text
          ? String(existing.text)
          : payload.body;
        var marker = existing;

        if (!marker) {
          marker = SheetRepository.appendConversation({
            messageId: generateUuidV4(),
            requestId: payload.dedupeKey,
            createdAt: attemptAt,
            role: 'system',
            messageType: 'proactive',
            text: deliveryBody,
            image: null,
            status: 'accepted',
            model: payload.model,
            inputTokens: payload.inputTokens,
            outputTokens: payload.outputTokens
          });
        } else {
          marker = SheetRepository.updateConversationMessage(
            marker.messageId,
            {
              createdAt: attemptAt,
              status: 'accepted',
              error: null
            }
          );
        }

        return {
          action: 'send',
          marker: marker,
          body: deliveryBody
        };
      }
    );
  }

  function markDeliveryFailed_(messageId, error) {
    return LockManager.withScriptLock(
      'proactive-delivery-fail-' + messageId,
      function() {
        var marker = SheetRepository.updateConversationMessage(
          messageId,
          {
            status: 'failed',
            error: {
              code: error.code
            }
          }
        );
        return marker;
      }
    );
  }

  function completeDelivery_(messageId, payload, completedAt) {
    return LockManager.withScriptLock(
      'proactive-delivery-complete-' + payload.dedupeKey,
      function() {
        var current = findExistingMarker_(payload.dedupeKey);
        if (current && current.status === 'completed') {
          updateStateAfterSend_(
            payload,
            current.createdAt || completedAt
          );
          return current;
        }

        var marker = SheetRepository.updateConversationMessage(
          messageId,
          {
            createdAt: completedAt,
            status: 'completed',
            error: null
          }
        );
        updateStateAfterSend_(payload, completedAt);
        SheetRepository.incrementUsageDaily(payload.targetDate, {
          mailRecipients: 1
        });
        return marker;
      }
    );
  }

  function buildTemplateBodyResult_(state, nowIso, targetDate) {
    return {
      text: buildBody_(state, nowIso, targetDate),
      model: null,
      inputTokens: null,
      outputTokens: null,
      usedAi: false
    };
  }

  function shouldFallbackToTemplate_(error) {
    var code = error && error.code ? String(error.code) : '';
    return code === 'GEMINI_RATE_LIMIT' ||
      code === 'GEMINI_BAD_RESPONSE' ||
      code === 'GEMINI_TEMPORARY_FAILURE';
  }

  function evaluateHardGates_(state, nowDate, options) {
    options = options || {};

    var quietStart = requireConfig_('QUIET_START');
    var quietEnd = requireConfig_('QUIET_END');
    var silenceMinutes = Number(requireConfig_('SILENCE_MINUTES'));
    var cooldownMinutes = Number(
      requireConfig_('PROACTIVE_COOLDOWN_MINUTES')
    );
    var maxPerDay = Number(requireConfig_('PROACTIVE_MAX_PER_DAY'));

    if (isQuietHours_(nowDate, quietStart, quietEnd)) {
      return {
        eligible: false,
        reason: 'QUIET_HOURS'
      };
    }

    if (
      state.quiet_until &&
      getIsoTimeMillis(state.quiet_until) > nowDate.getTime()
    ) {
      return {
        eligible: false,
        reason: 'QUIET_UNTIL_ACTIVE'
      };
    }

    if (!state.last_user_message_at) {
      return {
        eligible: false,
        reason: 'NO_USER_ACTIVITY'
      };
    }

    if (options.checkSilence) {
      var silenceMs =
        nowDate.getTime() - getIsoTimeMillis(state.last_user_message_at);
      if (silenceMs < silenceMinutes * 60 * 1000) {
        return {
          eligible: false,
          reason: 'SILENCE_THRESHOLD_NOT_MET'
        };
      }
    }

    if (
      state.last_proactive_at &&
      nowDate.getTime() - getIsoTimeMillis(state.last_proactive_at) <
        cooldownMinutes * 60 * 1000
    ) {
      return {
        eligible: false,
        reason: 'COOLDOWN_ACTIVE'
      };
    }

    var today = formatDateInTokyo(nowDate);
    if (getTodayProactiveCount_(state, today) >= maxPerDay) {
      return {
        eligible: false,
        reason: 'MAX_PER_DAY_REACHED'
      };
    }

    if (
      options.checkNextCheck &&
      state.next_proactive_check_at &&
      getIsoTimeMillis(state.next_proactive_check_at) > nowDate.getTime()
    ) {
      return {
        eligible: false,
        reason: 'NEXT_CHECK_NOT_DUE'
      };
    }

    if (options.checkQuota && GmailNotifier.getRemainingQuota() <= 0) {
      return {
        eligible: false,
        reason: 'MAIL_QUOTA_EXHAUSTED'
      };
    }

    return {
      eligible: true,
      reason: 'ELIGIBLE'
    };
  }

  function normalizeDecisionPayload_(eventPayload, now) {
    ensure(
      eventPayload &&
        typeof eventPayload === 'object' &&
        !Array.isArray(eventPayload),
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload is required.'
    );

    var nowIso = toIsoStringInTokyo(normalizeDate_(now));
    var targetDate = String(eventPayload.targetDate || '');
    var sequence = Number(eventPayload.sequence || 1);
    var requestedAt =
      eventPayload.requestedAt ||
      eventPayload.evaluatedAt ||
      nowIso;
    var decisionSlot = String(
      eventPayload.decisionSlot ||
      buildDecisionSlot_(
        parseIsoToDate(requestedAt),
        Math.max(
          1,
          getConfigInt_(
            'PROACTIVE_RECHECK_MINUTES',
            DEFAULTS.recheckMinutes
          )
        )
      )
    );
    var expectedMessageDedupeKey = buildMessageDedupeKey_(
      targetDate,
      sequence
    );
    var messageDedupeKey = String(
      eventPayload.messageDedupeKey ||
      expectedMessageDedupeKey
    );
    var probability = eventPayload.probability == null
      ? 1
      : Number(eventPayload.probability);
    var sample = eventPayload.sample == null
      ? 0
      : Number(eventPayload.sample);
    var elapsedMinutes = eventPayload.elapsedMinutes == null
      ? 0
      : Number(eventPayload.elapsedMinutes);
    var timeWeight = eventPayload.timeWeight == null
      ? 1
      : Number(eventPayload.timeWeight);

    ensure(
      Validators.isDateString(targetDate),
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload.targetDate must be a yyyy-MM-dd string.'
    );
    ensure(
      Validators.isIsoDateTimeString(requestedAt),
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload.requestedAt must be an ISO 8601 string.'
    );
    ensure(
      isFinite(sequence) &&
        sequence >= 1 &&
        Math.floor(sequence) === sequence,
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload.sequence must be a positive integer.'
    );
    ensure(
      /^[0-9]+$/.test(decisionSlot),
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload.decisionSlot must contain digits only.'
    );
    ensure(
      messageDedupeKey === expectedMessageDedupeKey,
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
      isFinite(sample) &&
        sample >= 0 &&
        sample < 1,
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
      targetDate: targetDate,
      sequence: sequence,
      requestedAt: requestedAt,
      decisionSlot: decisionSlot,
      messageDedupeKey: messageDedupeKey,
      probability: probability,
      sample: sample,
      elapsedMinutes: elapsedMinutes,
      timeWeight: timeWeight,
      reason: eventPayload.reason || null
    };
  }

  function normalizeMessagePayload_(message) {
    ensure(
      message && typeof message === 'object',
      'VALIDATION_REQUEST_INVALID',
      'message is required.'
    );

    var targetDate = String(
      message.targetDate || formatDateInTokyo(new Date())
    );
    var sequence = Number(message.sequence || 1);
    var expectedDedupeKey = buildMessageDedupeKey_(
      targetDate,
      sequence
    );
    var dedupeKey = String(message.dedupeKey || '');
    var body = String(message.body || message.message || '').trim();

    ensure(
      Validators.isDateString(targetDate),
      'VALIDATION_REQUEST_INVALID',
      'Proactive message targetDate must be a yyyy-MM-dd string.'
    );
    ensure(
      isFinite(sequence) &&
        sequence >= 1 &&
        Math.floor(sequence) === sequence,
      'VALIDATION_REQUEST_INVALID',
      'Proactive message sequence must be a positive integer.'
    );
    ensure(
      dedupeKey === expectedDedupeKey,
      'VALIDATION_REQUEST_INVALID',
      'Proactive message dedupeKey is invalid.'
    );
    ensure(
      body !== '',
      'VALIDATION_REQUEST_INVALID',
      'Proactive message body is required.'
    );
    ensure(
      !message.sentAt ||
        Validators.isIsoDateTimeString(message.sentAt),
      'VALIDATION_REQUEST_INVALID',
      'Proactive message sentAt must be an ISO 8601 string.'
    );

    return {
      targetDate: targetDate,
      sequence: sequence,
      dedupeKey: dedupeKey,
      subject: String(
        message.subject ||
        buildSubject_(targetDate)
      ),
      body: body,
      sentAt: message.sentAt || null,
      model: message.model || null,
      inputTokens: message.inputTokens == null
        ? null
        : Number(message.inputTokens),
      outputTokens: message.outputTokens == null
        ? null
        : Number(message.outputTokens),
      options: message.options || {}
    };
  }

  function generateAiBody_(state, payload, nowIso) {
    var config = {
      partnerName: getConfigString_('PARTNER_NAME', 'Partner'),
      userName: getConfigString_('USER_NAME', 'You'),
      systemPersona: getConfigString_(
        'SYSTEM_PERSONA',
        'Supportive, proactive, and concise personal AI partner.'
      ),
      messageStyle: getConfigString_(
        'PROACTIVE_MESSAGE_STYLE',
        'Short, neutral, and considerate. Do not pressure the user to reply.'
      ),
      minChars: Math.max(
        1,
        getConfigInt_(
          'PROACTIVE_MESSAGE_MIN_CHARS',
          DEFAULTS.messageMinChars
        )
      ),
      maxChars: Math.max(
        1,
        getConfigInt_(
          'PROACTIVE_MESSAGE_MAX_CHARS',
          DEFAULTS.messageMaxChars
        )
      )
    };
    ensure(
      config.maxChars >= config.minChars,
      'CONFIG_MISSING',
      'PROACTIVE_MESSAGE_MAX_CHARS must be greater than or equal to PROACTIVE_MESSAGE_MIN_CHARS.'
    );

    var recentMessages = loadRecentMessages_();
    var memories = loadRelevantMemories_(recentMessages);
    var prompt = buildAiPrompt_(
      config,
      state,
      payload,
      nowIso,
      recentMessages,
      memories
    );
    var generation = GeminiClient.generateText({
      systemInstruction: [
        'You are the configured personal AI partner.',
        'Follow the supplied persona and style exactly.',
        'Return only the message body without labels, analysis, markdown fences, or quotation marks.'
      ].join(' '),
      contents: [{
        role: 'user',
        parts: [{
          text: prompt
        }]
      }]
    });

    try {
      var usagePatch = {
        apiCalls: 1
      };
      if (generation.usage && generation.usage.inputTokens != null) {
        usagePatch.inputTokens = generation.usage.inputTokens;
      }
      if (generation.usage && generation.usage.outputTokens != null) {
        usagePatch.outputTokens = generation.usage.outputTokens;
      }
      SheetRepository.incrementUsageDaily(payload.targetDate, usagePatch);
    } catch (error) {
      // Usage accounting must not invalidate the generation result.
    }

    var body = validateGeneratedBody_(
      generation.text,
      config.minChars,
      config.maxChars
    );

    return {
      text: body,
      model: generation.model || null,
      inputTokens: generation.usage
        ? generation.usage.inputTokens
        : null,
      outputTokens: generation.usage
        ? generation.usage.outputTokens
        : null,
      usedAi: true
    };
  }

  function buildAiPrompt_(
    config,
    state,
    payload,
    nowIso,
    recentMessages,
    memories
  ) {
    var lastUserAt = state.last_user_message_at
      ? Utilities.formatDate(
        parseIsoToDate(state.last_user_message_at),
        APP_CONSTANTS.TIME_ZONE,
        'M/d H:mm'
      )
      : 'unknown';

    return [
      'Write one natural partner-initiated message.',
      '',
      'Configured partner name: ' + config.partnerName,
      'Configured user name: ' + config.userName,
      'Persona: ' + config.systemPersona,
      'Style: ' + config.messageStyle,
      'Current time: ' + nowIso,
      'Last user message time: ' + lastUserAt + ' JST',
      'Required character count: ' +
        config.minChars + '-' + config.maxChars,
      '',
      'Hard rules:',
      '- Speak as the configured partner in the configured voice.',
      '- Do not mention schedulers, probability, inactivity detection, queues, automation, or internal processing.',
      '- Do not pressure the user to reply.',
      '- Do not invent or assume the user\'s health, fatigue, emotion, schedule, location, private actions, or current situation.',
      '- Avoid repeating recent proactive wording.',
      '- Use memories only when directly supported by the supplied memory text.',
      '- Return only the message body.',
      '',
      'Recent conversation:',
      formatRecentMessages_(recentMessages),
      '',
      'Relevant memories:',
      formatMemories_(memories),
      '',
      'Decision context:',
      'targetDate=' + payload.targetDate +
        ', sequence=' + payload.sequence
    ].join('\n');
  }

  function loadRecentMessages_() {
    try {
      return SheetRepository.listRecentMessages(
        Math.max(
          1,
          getConfigInt_(
            'RECENT_MESSAGE_LIMIT',
            DEFAULTS.recentMessageLimit
          )
        )
      ).slice().reverse();
    } catch (error) {
      return [];
    }
  }

  function loadRelevantMemories_(recentMessages) {
    try {
      if (
        typeof MemoryService !== 'undefined' &&
        MemoryService &&
        typeof MemoryService.findRelevant === 'function'
      ) {
        var query = buildMemoryQuery_(recentMessages);
        if (!query) {
          return [];
        }
        return MemoryService.findRelevant(
          query,
          Math.max(
            1,
            getConfigInt_(
              'MEMORY_CONTEXT_LIMIT',
              DEFAULTS.memoryLimit
            )
          )
        );
      }
    } catch (error) {
      return [];
    }
    return [];
  }

  function buildMemoryQuery_(recentMessages) {
    return (recentMessages || [])
      .filter(function(message) {
        return (
          message.role === 'user' ||
          message.role === 'assistant'
        ) && String(message.text || '').trim() !== '';
      })
      .slice(-6)
      .map(function(message) {
        return String(message.text || '').trim();
      })
      .join(' ')
      .trim();
  }

  function formatRecentMessages_(messages) {
    if (!messages || messages.length === 0) {
      return '(none)';
    }
    return messages.map(function(message) {
      var role = message.role || 'system';
      var type = message.messageType || 'text';
      return '[' + role + '/' + type + '] ' +
        truncate_(String(message.text || ''), 400);
    }).join('\n');
  }

  function formatMemories_(memories) {
    if (!memories || memories.length === 0) {
      return '(none)';
    }
    return memories.map(function(memory) {
      return '- ' + truncate_(
        String(memory.content || memory.normalizedKey || ''),
        300
      );
    }).join('\n');
  }

  function normalizeGeneratedBody_(text) {
    var body = String(text || '').trim();
    if (
      body.length >= 2 &&
      (
        (
          body.charAt(0) === '"' &&
          body.charAt(body.length - 1) === '"'
        ) ||
        (
          body.charAt(0) === '\u300c' &&
          body.charAt(body.length - 1) === '\u300d'
        ) ||
        (
          body.charAt(0) === '\u300e' &&
          body.charAt(body.length - 1) === '\u300f'
        )
      )
    ) {
      body = body.substring(1, body.length - 1).trim();
    }
    return body;
  }

  function validateGeneratedBody_(text, minChars, maxChars) {
    var body = normalizeGeneratedBody_(text);
    if (body.length < minChars) {
      throw createAppError(
        'GEMINI_BAD_RESPONSE',
        'proactive message length ' + body.length +
          ' is below the configured minimum of ' +
          minChars + ' characters.',
        null,
        {
          retryable: true
        }
      );
    }
    if (body.length > maxChars) {
      throw createAppError(
        'GEMINI_BAD_RESPONSE',
        'proactive message length ' + body.length +
          ' exceeds the configured maximum of ' +
          maxChars + ' characters.',
        null,
        {
          retryable: true
        }
      );
    }
    return body;
  }

  function updateStateAfterSend_(payload, createdAt) {
    var targetDate = payload.targetDate ||
      formatDateInTokyo(parseIsoToDate(createdAt));
    var state = SheetRepository.ensureDefaultUserState();
    var sequence = Math.max(1, Number(payload.sequence || 1));
    var cooldownMinutes = getConfigInt_(
      'PROACTIVE_COOLDOWN_MINUTES',
      240
    );
    var computedNextCheck = toIsoStringInTokyo(
      new Date(
        parseIsoToDate(createdAt).getTime() +
          cooldownMinutes * 60 * 1000
      )
    );
    var lastProactiveAt = state.last_proactive_at &&
      getIsoTimeMillis(state.last_proactive_at) >
        getIsoTimeMillis(createdAt)
      ? state.last_proactive_at
      : createdAt;
    var patch = {
      last_proactive_at: lastProactiveAt
    };

    if (
      !state.proactive_count_date ||
      state.proactive_count_date < targetDate
    ) {
      patch.proactive_count_date = targetDate;
      patch.proactive_count = sequence;
    } else if (state.proactive_count_date === targetDate) {
      patch.proactive_count_date = targetDate;
      patch.proactive_count = Math.max(
        Number(state.proactive_count || 0),
        sequence
      );
    }

    if (
      !state.next_proactive_check_at ||
      getIsoTimeMillis(computedNextCheck) >
        getIsoTimeMillis(state.next_proactive_check_at)
    ) {
      patch.next_proactive_check_at = computedNextCheck;
    }

    SheetRepository.updateUserState(patch);
  }

  function buildEvaluation_(
    eligible,
    reason,
    sequence,
    dedupeKey,
    warnings,
    payload,
    details
  ) {
    details = details || {};
    return {
      eligible: eligible,
      reason: reason,
      sequence: sequence,
      dedupeKey: dedupeKey,
      payload: payload || null,
      warnings: warnings || [],
      probability: details.probability == null
        ? null
        : details.probability,
      sample: details.sample == null ? null : details.sample,
      elapsedMinutes: details.elapsedMinutes == null
        ? null
        : details.elapsedMinutes,
      timeWeight: details.timeWeight == null
        ? null
        : details.timeWeight,
      decisionSlot: details.decisionSlot || null
    };
  }

  function buildDispatchResult_(
    eligible,
    reason,
    message,
    createdAt,
    details
  ) {
    details = details || {};
    return {
      eligible: eligible,
      reason: reason,
      message: message || null,
      createdAt: createdAt,
      usedAi: Boolean(details.usedAi),
      probability: details.probability == null
        ? null
        : details.probability,
      sample: details.sample == null ? null : details.sample,
      decisionSlot: details.decisionSlot || null,
      fallbackReason: details.fallbackReason || null
    };
  }

  function buildQueueDedupeKey_(targetDate, sequence, decisionSlot) {
    return 'PROACTIVE_SEND:' +
      targetDate + ':' +
      Number(sequence || 1) + ':' +
      String(decisionSlot);
  }

  function buildMessageDedupeKey_(targetDate, sequence) {
    return 'PROACTIVE_MESSAGE:' +
      targetDate + ':' +
      Number(sequence || 1);
  }

  function buildDecisionSlot_(nowDate, recheckMinutes) {
    var slotMs = Math.max(1, Number(recheckMinutes || 1)) *
      60 * 1000;
    return String(Math.floor(nowDate.getTime() / slotMs));
  }

  function calculateProbability_(
    elapsedMinutes,
    silenceMinutes,
    ceilingMinutes,
    curvePower,
    timeWeight
  ) {
    var floorMinutes = Math.max(0, Number(silenceMinutes || 0));
    var ceiling = Math.max(
      floorMinutes + 1,
      Number(ceilingMinutes || floorMinutes + 1)
    );
    var curve = Math.max(0.01, Number(curvePower || 1));
    var ratio = clampNumber_(
      (Number(elapsedMinutes || 0) - floorMinutes) /
        (ceiling - floorMinutes),
      0,
      1
    );
    return clampNumber_(
      Math.pow(ratio, curve) * Math.max(0, Number(timeWeight || 0)),
      0,
      1
    );
  }

  function deterministicSample_(seed) {
    var text = String(seed || '');
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967296;
  }

  function getTimeWeight_(nowDate) {
    var current = getTokyoMinutesOfDay_(nowDate);
    var dayStart = parseTimeMinutes_(
      getConfigString_('PROACTIVE_DAY_START', DEFAULTS.dayStart)
    );
    var eveningStart = parseTimeMinutes_(
      getConfigString_(
        'PROACTIVE_EVENING_START',
        DEFAULTS.eveningStart
      )
    );
    ensure(
      dayStart < eveningStart,
      'CONFIG_MISSING',
      'PROACTIVE_DAY_START must be earlier than PROACTIVE_EVENING_START.'
    );

    var morningWeight = getConfigFloat_(
      'PROACTIVE_MORNING_WEIGHT',
      DEFAULTS.morningWeight
    );
    var dayWeight = getConfigFloat_(
      'PROACTIVE_DAY_WEIGHT',
      DEFAULTS.dayWeight
    );
    var eveningWeight = getConfigFloat_(
      'PROACTIVE_EVENING_WEIGHT',
      DEFAULTS.eveningWeight
    );
    ensure(
      isFinite(morningWeight) &&
        isFinite(dayWeight) &&
        isFinite(eveningWeight) &&
        morningWeight >= 0 &&
        dayWeight >= 0 &&
        eveningWeight >= 0,
      'CONFIG_MISSING',
      'Proactive time weights must be non-negative numbers.'
    );

    if (current < dayStart) {
      return morningWeight;
    }
    if (current < eveningStart) {
      return dayWeight;
    }
    return eveningWeight;
  }

  function getTodayProactiveCount_(state, today) {
    return state.proactive_count_date === today
      ? Number(state.proactive_count || 0)
      : 0;
  }

  function findExistingMarker_(dedupeKey) {
    var marker = SheetRepository.getMessageByRequestIdAndRole(
      dedupeKey,
      'system'
    );
    if (!marker || marker.messageType !== 'proactive') {
      return null;
    }
    return marker;
  }

  function requireConfig_(key) {
    var config = ConfigRepository.getByKey(key);
    ensure(
      config && config.value != null,
      'CONFIG_MISSING',
      'Missing config: ' + key
    );
    return config.value;
  }

  function getConfigInt_(key, fallback) {
    var value = getConfigValue_(key, fallback);
    var numeric = Number(value);
    return isFinite(numeric) ? Math.floor(numeric) : fallback;
  }

  function getConfigFloat_(key, fallback) {
    var value = getConfigValue_(key, fallback);
    var numeric = Number(value);
    return isFinite(numeric) ? numeric : fallback;
  }

  function getConfigString_(key, fallback) {
    var value = getConfigValue_(key, fallback);
    return value == null ? fallback : String(value);
  }

  function getConfigBool_(key, fallback) {
    var value = getConfigValue_(key, fallback);
    if (value === true || String(value).toLowerCase() === 'true') {
      return true;
    }
    if (value === false || String(value).toLowerCase() === 'false') {
      return false;
    }
    return fallback;
  }

  function getConfigValue_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null
        ? config.value
        : fallback;
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
    var hours = Number(
      Utilities.formatDate(date, APP_CONSTANTS.TIME_ZONE, 'H')
    );
    var minutes = Number(
      Utilities.formatDate(date, APP_CONSTANTS.TIME_ZONE, 'm')
    );
    return hours * 60 + minutes;
  }

  function parseTimeMinutes_(value) {
    var parts = String(value || '').split(':');
    var hours = parts.length === 2 ? Number(parts[0]) : NaN;
    var minutes = parts.length === 2 ? Number(parts[1]) : NaN;
    ensure(
      parts.length === 2 &&
        isFinite(hours) &&
        isFinite(minutes) &&
        Math.floor(hours) === hours &&
        Math.floor(minutes) === minutes &&
        hours >= 0 &&
        hours <= 23 &&
        minutes >= 0 &&
        minutes <= 59,
      'CONFIG_MISSING',
      'Invalid time config: ' + value
    );
    return hours * 60 + minutes;
  }

  function buildSubject_(targetDate, state, nowIso) {
    var context = buildTemplateContext_(
      state || {},
      nowIso || toIsoStringInTokyo(new Date()),
      targetDate || formatDateInTokyo(new Date())
    );
    var template = getConfigString_(
      'PROACTIVE_SUBJECT_TEMPLATE',
      'A check-in from {partnerName} ({targetDate})'
    );
    var rendered = renderTemplate_(template, context)
      .replace(/\s+/g, ' ')
      .trim();
    return rendered ||
      ('A check-in from ' +
        context.partnerName +
        ' (' +
        context.targetDate +
        ')');
  }

  function buildBody_(state, nowIso, targetDate) {
    var context = buildTemplateContext_(
      state || {},
      nowIso,
      targetDate
    );
    var fallbackTemplate = [
      'Hi {userName},',
      '',
      'This is a small check-in from {partnerName}.',
      'It has been quiet since your last message around {lastUserMessageAt} JST.',
      '',
      'Generated at: {now}'
    ].join('\n');
    var template = getConfigString_(
      'PROACTIVE_BODY_TEMPLATE',
      fallbackTemplate
    );
    var rendered = renderTemplate_(template, context).trim();
    return rendered ||
      renderTemplate_(fallbackTemplate, context).trim();
  }

  function buildTemplateContext_(state, nowIso, targetDate) {
    var lastUserAt = state && state.last_user_message_at
      ? Utilities.formatDate(
        parseIsoToDate(state.last_user_message_at),
        APP_CONSTANTS.TIME_ZONE,
        'M/d H:mm'
      )
      : 'earlier';
    return {
      partnerName: getConfigString_('PARTNER_NAME', 'Partner'),
      userName: getConfigString_('USER_NAME', 'You'),
      systemPersona: getConfigString_(
        'SYSTEM_PERSONA',
        'Supportive, proactive, and concise personal AI partner.'
      ),
      messageStyle: getConfigString_(
        'PROACTIVE_MESSAGE_STYLE',
        'Short, neutral, and considerate. Do not pressure the user to reply.'
      ),
      lastUserMessageAt: lastUserAt,
      now: nowIso || toIsoStringInTokyo(new Date()),
      targetDate: targetDate || formatDateInTokyo(new Date())
    };
  }

  function renderTemplate_(template, context) {
    return String(template || '').replace(
      /\{([a-zA-Z0-9_]+)\}/g,
      function(match, key) {
        return Object.prototype.hasOwnProperty.call(context, key)
          ? String(context[key])
          : match;
      }
    );
  }

  function truncate_(value, maxLength) {
    var text = String(value || '');
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, Math.max(0, maxLength - 1)) + '\u2026';
  }

  function clampNumber_(value, minimum, maximum) {
    var numeric = isFinite(value) ? Number(value) : minimum;
    return Math.min(maximum, Math.max(minimum, numeric));
  }

  function normalizeDate_(value) {
    if (value instanceof Date) {
      return value;
    }
    if (value) {
      return parseIsoToDate(value);
    }
    return new Date();
  }

  return {
    evaluateLocalConditions: evaluateLocalConditions,
    evaluateByAi: evaluateByAi,
    prepareDispatch: prepareDispatch,
    send: send,
    __test: {
      buildSubject: buildSubject_,
      buildBody: buildBody_,
      buildTemplateContext: buildTemplateContext_,
      renderTemplate: renderTemplate_,
      calculateProbability: calculateProbability_,
      deterministicSample: deterministicSample_,
      buildDecisionSlot: buildDecisionSlot_,
      buildQueueDedupeKey: buildQueueDedupeKey_,
      buildMessageDedupeKey: buildMessageDedupeKey_,
      normalizeGeneratedBody: normalizeGeneratedBody_,
      validateGeneratedBody: validateGeneratedBody_,
      getTimeWeight: getTimeWeight_,
      buildMemoryQuery: buildMemoryQuery_
    }
  };
})();

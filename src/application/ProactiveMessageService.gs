var ProactiveMessageService = (function() {
  var issuedDispatches_ = new WeakMap();
  var DEFAULTS = Object.freeze({
    messageMinChars: 20,
    messageMaxChars: 220,
    recentMessageLimit: 12,
    memoryLimit: 8
  });
  var TIMING_PROFILES = Object.freeze({
    test: Object.freeze({
      recheckMinutes: 5,
      frequencies: Object.freeze({
        off: null,
        low: Object.freeze({
          silenceFloorMinutes: 60,
          silenceCeilingMinutes: 120
        }),
        normal: Object.freeze({
          silenceFloorMinutes: 15,
          silenceCeilingMinutes: 30
        }),
        high: Object.freeze({
          silenceFloorMinutes: 5,
          silenceCeilingMinutes: 10
        })
      })
    }),
    prod: Object.freeze({
      recheckMinutes: 60,
      frequencies: Object.freeze({
        off: null,
        low: Object.freeze({
          silenceFloorMinutes: 480,
          silenceCeilingMinutes: 720
        }),
        normal: Object.freeze({
          silenceFloorMinutes: 240,
          silenceCeilingMinutes: 720
        }),
        high: Object.freeze({
          silenceFloorMinutes: 120,
          silenceCeilingMinutes: 720
        })
      })
    })
  });

  function evaluateLocalConditions(now, options) {
    var warnings = [];
    var nowDate = normalizeDate_(now);
    options = options || {};

    try {
      var timingPolicy = resolveTimingPolicy_();
      if (
        timingPolicy.environment === 'test' &&
        options.allowTestProfile !== true
      ) {
        return buildEvaluation_(
          false,
          'PROACTIVE_TEST_PROFILE_MANUAL_ONLY',
          null,
          null,
          warnings,
          null,
          {
            timingPolicy: timingPolicy
          }
        );
      }
      if (!timingPolicy.enabled) {
        return buildEvaluation_(
          false,
          'PROACTIVE_FREQUENCY_OFF',
          null,
          null,
          warnings,
          null,
          {
            timingPolicy: timingPolicy
          }
        );
      }
      var policyInspection = inspectPolicy(nowDate);
      var policyReady = timingPolicy.environment === 'test'
        ? policyInspection.manualTestAllowed
        : policyInspection.automaticTriggersAllowed;
      if (!policyInspection.valid || !policyReady) {
        return buildEvaluation_(
          false,
          timingPolicy.environment === 'test'
            ? 'PROACTIVE_TEST_POLICY_NOT_READY'
            : 'PROACTIVE_PRODUCTION_POLICY_NOT_READY',
          null,
          null,
          policyInspection.issues || warnings,
          null,
          {
            timingPolicy: timingPolicy
          }
        );
      }
      var nowIso = toIsoStringInTokyo(nowDate);
      var state = SheetRepository.ensureDefaultUserState();
      state = SheetRepository.getUserState() || state;
      ensure(state, 'CONFIG_MISSING', 'user_state row is missing.');

      var hardGate = evaluateHardGates_(state, nowDate, {
        checkSilence: true,
        checkNextCheck: true,
        checkQuota: true,
        timingPolicy: timingPolicy
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
      var recheckMinutes = timingPolicy.recheckMinutes;
      var decisionSlot = buildDecisionSlot_(nowDate, recheckMinutes);
      var timeWeight = getTimeWeight_(nowDate);
      var policyMode = timingPolicy.mode;
      var probability = 1;
      var sample = 0;

      if (policyMode === 'probability') {
        var silenceFloor = timingPolicy.silenceFloorMinutes;
        var silenceCeiling = timingPolicy.silenceCeilingMinutes;
        var curvePower = Number(
          requireConfig_(
            'PROACTIVE_PROBABILITY_CURVE',
            'float'
          )
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
      var runtime = resolveEnqueueRuntime_();
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
          : 'local_silence_threshold',
        characterRuntimeMode: runtime.mode,
        policyBinding: buildPolicyBinding_(timingPolicy)
      };
      if (runtime.mode === 'enforced') {
        payload.characterBinding = runtime.binding;
      }

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

  function prepareDispatch(eventPayload, now, options) {
    var payload = normalizeDecisionPayload_(eventPayload, now);
    var queueClaim = normalizeQueueClaim_(options);
    var timingPolicy = resolveTimingPolicy_();
    ensure(
      payload.characterRuntimeMode !== 'enforced' || queueClaim != null,
      'CHARACTER_ARTIFACT_INVALID',
      'Enforced proactive dispatch requires a current queue lease.'
    );
    assertQueueClaimCurrent_(queueClaim, payload);
    var nowDate = normalizeDate_(now);
    var nowIso = toIsoStringInTokyo(nowDate);

    if (
      timingPolicy.environment === 'test' &&
      (!options || options.allowTestProfile !== true)
    ) {
      return buildDispatchResult_(
        false,
        'PROACTIVE_TEST_PROFILE_MANUAL_ONLY',
        null,
        nowIso
      );
    }

    if (!timingPolicy.enabled) {
      return buildDispatchResult_(
        false,
        'PROACTIVE_FREQUENCY_OFF',
        null,
        nowIso
      );
    }

    var policyInspection = inspectPolicy(nowDate);
    var policyReady = timingPolicy.environment === 'test'
      ? policyInspection.manualTestAllowed
      : policyInspection.automaticTriggersAllowed;
    if (!policyInspection.valid || !policyReady) {
      return buildDispatchResult_(
        false,
        timingPolicy.environment === 'test'
          ? 'PROACTIVE_TEST_POLICY_NOT_READY'
          : 'PROACTIVE_PRODUCTION_POLICY_NOT_READY',
        null,
        nowIso
      );
    }

    if (!payload.policyBinding) {
      return buildDispatchResult_(
        false,
        'PROACTIVE_POLICY_BINDING_MISSING',
        null,
        nowIso
      );
    }

    if (
      !policyBindingsEqual_(
        payload.policyBinding,
        buildPolicyBinding_(timingPolicy)
      )
    ) {
      return buildDispatchResult_(
        false,
        'PROACTIVE_POLICY_CHANGED',
        null,
        nowIso
      );
    }

    var state = SheetRepository.ensureDefaultUserState();
    state = SheetRepository.getUserState() || state;
    ensure(state, 'CONFIG_MISSING', 'user_state row is missing.');

    var existing = payload.messageDedupeKey
      ? findExistingMarker_(
        payload.messageDedupeKey,
        queueClaim ? queueClaim.eventId : null
      )
      : null;

    if (existing && existing.status === 'completed') {
      reconcileCompletedMarker_(
        payload,
        existing,
        queueClaim,
        nowIso
      );
      return buildDispatchResult_(
        false,
        'ALREADY_DELIVERED',
        null,
        existing.createdAt || nowIso,
        {
          usedAi: Boolean(existing.model),
          probability: payload.probability,
          sample: payload.sample,
          decisionSlot: payload.decisionSlot
        }
      );
    }

    if (
      existing &&
      existing.error &&
      existing.error.code === 'PROACTIVE_RETRY_QUARANTINED'
    ) {
      return completeManagedNoSend_(
        payload,
        nowIso,
        queueClaim,
        'PROACTIVE_RETRY_QUARANTINED'
      );
    }

    if (
      existing &&
      queueClaim &&
      existing.proactiveOriginEventId &&
      existing.proactiveOriginEventId !== queueClaim.eventId
    ) {
      return buildDispatchResult_(
        false,
        'DELIVERY_IN_PROGRESS',
        null,
        nowIso,
        {
          usedAi:
            payload.characterRuntimeMode === 'enforced',
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
      checkSilence: true,
      checkNextCheck: false,
      checkQuota: true,
      timingPolicy: timingPolicy
    });
    if (!hardGate.eligible) {
      return buildDispatchResult_(false, hardGate.reason, null, nowIso);
    }

    if (
      payload.characterRuntimeMode === 'legacy' &&
      existing &&
      existing.status === 'failed' &&
      existing.characterApproval != null
    ) {
      quarantineProactiveMarker_(
        existing,
        queueClaim,
        payload
      );
      return completeManagedNoSend_(
        payload,
        nowIso,
        queueClaim,
        'PROACTIVE_RUNTIME_CHANGED'
      );
    }

    if (payload.characterRuntimeMode === 'enforced') {
      return prepareEnforcedDispatch_(
        payload,
        existing,
        nowIso,
        queueClaim
      );
    }

    return prepareLegacyDispatch_(
      payload,
      state,
      existing,
      nowIso,
      queueClaim
    );
  }

  function prepareLegacyDispatch_(
    payload,
    state,
    existing,
    nowIso,
    queueClaim
  ) {
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

    issueDispatch_(
      message,
      'legacy',
      queueClaim,
      payload,
      null
    );
    return buildDispatchResult_(true, 'READY', message, nowIso, {
      usedAi: preparedBody.usedAi,
      probability: payload.probability,
      sample: payload.sample,
      decisionSlot: payload.decisionSlot,
      fallbackReason: fallbackReason
    });
  }

  function prepareEnforcedDispatch_(
    payload,
    existing,
    nowIso,
    queueClaim
  ) {
    SheetRepository.assertProactiveDeliveryColumns();
    var retrying = Boolean(existing && existing.status === 'failed');
    if (retrying && !isRetryableApprovedMarker_(existing)) {
      quarantineProactiveMarker_(
        existing,
        queueClaim,
        payload
      );
      return completeManagedNoSend_(
        payload,
        nowIso,
        queueClaim,
        'PROACTIVE_RETRY_QUARANTINED'
      );
    }

    var context;
    try {
      context = CharacterProactiveContextService.build({
        currentTime: nowIso
      });
      if (!retrying) {
        CharacterProactiveContextService.assertBindingMatchesContext(
          payload.characterBinding,
          context
        );
      }
    } catch (runtimeError) {
      var normalizedRuntimeError = normalizeError(runtimeError);
      if (
        normalizedRuntimeError.code === 'CHARACTER_CONFIG_INVALID' ||
        normalizedRuntimeError.code === 'CHARACTER_CONFIG_CONFLICT'
      ) {
        return completeManagedNoSend_(
          payload,
          nowIso,
          queueClaim,
          'PROACTIVE_RUNTIME_CHANGED'
        );
      }
      throw normalizedRuntimeError;
    }
    var session = CharacterProactiveGeminiAdapter.createSession();
    var surface = retrying ? 'PROACTIVE_RETRY' : 'PROACTIVE_AI';
    var approval;
    try {
      var coordinatorOptions = {
        context: context,
        surface: surface,
        classificationSignals:
          CharacterProactiveContextService.classificationSignals(context),
        verifierFn: session.verify,
        metricEmitter: session.emitMetric
      };
      if (retrying) {
        coordinatorOptions.savedPayload = {
          subject: existing.proactiveSubject,
          body: String(existing.text)
        };
      } else {
        coordinatorOptions.generate = session.generate;
        coordinatorOptions.rewrite = session.rewrite;
      }
      approval = CharacterOutputCoordinator.approve(coordinatorOptions);
    } catch (error) {
      recordCharacterUsageBestEffort_(
        nowIso,
        session.getUsage()
      );
      var normalized = normalizeError(error);
      if (normalized.code === 'CHARACTER_OUTPUT_BLOCKED') {
        if (retrying) {
          quarantineProactiveMarker_(
            existing,
            queueClaim,
            payload
          );
        }
        return completeManagedNoSend_(
          payload,
          nowIso,
          queueClaim,
          'NO_APPROVED_PROACTIVE_OUTPUT'
        );
      }
      throw normalized;
    }

    ensure(
      approval &&
        approval.artifact &&
        approval.classifiedContext,
      'CHARACTER_OUTPUT_BLOCKED',
      'No approved proactive output was available.'
    );
    recordCharacterUsageBestEffort_(
      nowIso,
      session.getUsage()
    );
    var approvedPayload = approval.artifact.payload;
    if (
      retrying &&
      (
        approvedPayload.subject !== existing.proactiveSubject ||
        approvedPayload.body !== String(existing.text)
      )
    ) {
      quarantineProactiveMarker_(
        existing,
        queueClaim,
        payload
      );
      return completeManagedNoSend_(
        payload,
        nowIso,
        queueClaim,
        'PROACTIVE_RETRY_QUARANTINED'
      );
    }
    var usage = normalizeCharacterUsage_(session.getUsage());
    var generationMetadata = retrying
      ? null
      : session.getGenerationMetadata(approval.artifact.source);
    var message = {
      targetDate: payload.targetDate,
      sequence: payload.sequence,
      dedupeKey: payload.messageDedupeKey,
      subject: approvedPayload.subject,
      body: approvedPayload.body,
      sentAt: nowIso,
      model: retrying
        ? existing.model || null
        : generationMetadata
          ? generationMetadata.model || null
          : null,
      inputTokens: retrying
        ? existing.inputTokens
        : usage.inputTokens,
      outputTokens: retrying
        ? existing.outputTokens
        : usage.outputTokens,
      options: {},
      characterDelivery: {
        artifact: approval.artifact,
        context: approval.classifiedContext,
        metricEmitter: session.emitMetric
      }
    };

    issueDispatch_(
      message,
      'enforced',
      queueClaim,
      payload,
      surface
    );
    return buildDispatchResult_(true, 'READY', message, nowIso, {
      usedAi: true,
      probability: payload.probability,
      sample: payload.sample,
      decisionSlot: payload.decisionSlot,
      fallbackReason: null
    });
  }

  function issueDispatch_(
    message,
    mode,
    queueClaim,
    queuePayload,
    expectedSurface
  ) {
    ensure(
      mode === 'legacy' || mode === 'enforced',
      'CHARACTER_ARTIFACT_INVALID',
      'Proactive dispatch mode is invalid.'
    );
    var normalized = normalizeMessagePayload_(message);
    var delivery = normalized.characterDelivery;
    if (mode === 'enforced') {
      ensure(
        queueClaim &&
          delivery &&
          delivery.artifact &&
          delivery.context &&
          typeof delivery.metricEmitter === 'function' &&
          (
            expectedSurface === 'PROACTIVE_AI' ||
            expectedSurface === 'PROACTIVE_RETRY'
          ),
        'CHARACTER_ARTIFACT_INVALID',
        'Enforced proactive dispatch authorization is incomplete.'
      );
    } else {
      ensure(
        delivery == null && expectedSurface == null,
        'CHARACTER_ARTIFACT_INVALID',
        'Legacy proactive dispatch cannot carry character authorization.'
      );
    }

    var optionSnapshot = {};
    Object.keys(normalized.options || {}).forEach(function(key) {
      optionSnapshot[key] = normalized.options[key];
    });
    normalized.options = Object.freeze(optionSnapshot);
    normalized.characterDelivery = null;
    normalized = Object.freeze(normalized);

    var deliverySnapshot = delivery
      ? Object.freeze({
        artifact: delivery.artifact,
        context: delivery.context,
        metricEmitter: delivery.metricEmitter
      })
      : null;
    var claimSnapshot = queueClaim
      ? Object.freeze({
        eventId: queueClaim.eventId,
        leaseToken: queueClaim.leaseToken
      })
      : null;
    var dispatch = Object.freeze({
      mode: mode,
      expectedSurface: expectedSurface || null,
      payload: normalized,
      characterDelivery: deliverySnapshot,
      queueClaim: claimSnapshot,
      queuePayload: snapshotQueuePayload_(queuePayload)
    });
    issuedDispatches_.set(message, dispatch);
    return message;
  }

  function snapshotQueuePayload_(payload) {
    if (!payload) {
      return null;
    }
    var snapshot = {
      targetDate: payload.targetDate,
      sequence: payload.sequence,
      requestedAt: payload.requestedAt,
      decisionSlot: payload.decisionSlot,
      messageDedupeKey: payload.messageDedupeKey,
      probability: payload.probability,
      sample: payload.sample,
      elapsedMinutes: payload.elapsedMinutes,
      timeWeight: payload.timeWeight,
      reason: payload.reason,
      characterRuntimeMode: payload.characterRuntimeMode,
      policyBinding: payload.policyBinding
        ? Object.freeze(normalizePolicyBinding_(payload.policyBinding))
        : null
    };
    if (payload.characterRuntimeMode === 'enforced') {
      snapshot.characterBinding = Object.freeze(
        normalizeCharacterBinding_(payload.characterBinding)
      );
    }
    return Object.freeze(snapshot);
  }

  function send(message) {
    ensure(
      message && typeof message === 'object',
      'CHARACTER_ARTIFACT_INVALID',
      'Proactive dispatch was not issued by prepareDispatch.'
    );
    var dispatch = issuedDispatches_.get(message);
    ensure(
      dispatch != null,
      'CHARACTER_ARTIFACT_INVALID',
      'Proactive dispatch was not issued by prepareDispatch.'
    );
    issuedDispatches_.delete(message);

    var payload = dispatch.payload;
    if (dispatch.mode === 'enforced') {
      var delivery = dispatch.characterDelivery;
      ensure(
        delivery &&
          dispatch.expectedSurface &&
          (
            dispatch.expectedSurface === 'PROACTIVE_AI' ||
            dispatch.expectedSurface === 'PROACTIVE_RETRY'
          ),
        'CHARACTER_ARTIFACT_INVALID',
        'Enforced proactive dispatch authorization is invalid.'
      );
      return CharacterSinkAdapter.deliver({
        artifact: delivery.artifact,
        expectedSurface: dispatch.expectedSurface,
        context: delivery.context,
        metricEmitter: delivery.metricEmitter,
        write: function(approvedPayload, artifact) {
          ensure(
            approvedPayload &&
              approvedPayload.subject === payload.subject &&
              approvedPayload.body === payload.body,
            'CHARACTER_ARTIFACT_INVALID',
            'Approved proactive content changed before delivery.'
          );
          return sendNormalized_(
            payload,
            dispatch,
            artifact
          );
        }
      });
    }
    ensure(
      dispatch.mode === 'legacy' &&
        dispatch.characterDelivery == null,
      'CHARACTER_ARTIFACT_INVALID',
      'Legacy proactive dispatch authorization is invalid.'
    );
    return sendNormalized_(payload, dispatch, null);
  }

  function sendNormalized_(payload, dispatch, approvedArtifact) {
    var attemptAt = payload.sentAt || toIsoStringInTokyo(new Date());
    var initialGate = assessFinalDelivery_(
      dispatch.queuePayload,
      new Date()
    );
    if (!initialGate.allowed) {
      return handleFinalDeliveryBlock_(
        payload,
        attemptAt,
        initialGate
      );
    }
    var ownerEmail = PropertiesService.getScriptProperties().getProperty(
      APP_CONSTANTS.PROPERTY_KEYS.OWNER_EMAIL
    );
    ensure(ownerEmail, 'CONFIG_MISSING', 'OWNER_EMAIL is not configured.');

    var claim = claimDelivery_(
      payload,
      attemptAt,
      dispatch,
      approvedArtifact
    );

    if (claim.action === 'policy_blocked') {
      return handleFinalDeliveryBlock_(
        payload,
        attemptAt,
        {
          allowed: false,
          reason: claim.reason
        }
      );
    }

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
      var mailGate = assessFinalDelivery_(
        dispatch.queuePayload,
        new Date()
      );
      if (!mailGate.allowed) {
        var blockedError = createAppError(
          mailGate.reason === 'MAIL_QUOTA_EXHAUSTED'
            ? 'MAIL_QUOTA_EXHAUSTED'
            : 'CONFIG_MISSING',
          'Proactive delivery was stopped by the final delivery gate.',
          { reason: mailGate.reason }
        );
        markDeliveryFailed_(
          claim.marker.messageId,
          blockedError
        );
        return handleFinalDeliveryBlock_(
          payload,
          attemptAt,
          mailGate
        );
      }
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

  function claimDelivery_(
    payload,
    attemptAt,
    dispatch,
    approvedArtifact
  ) {
    return LockManager.withScriptLock(
      'proactive-delivery-claim-' + payload.dedupeKey,
      function() {
        if (dispatch.queueClaim) {
          assertQueueClaimCurrent_(
            dispatch.queueClaim,
            dispatch.queuePayload
          );
        }
        var finalGate = assessFinalDelivery_(
          dispatch.queuePayload,
          new Date()
        );
        if (!finalGate.allowed) {
          return {
            action: 'policy_blocked',
            reason: finalGate.reason,
            marker: null,
            body: null
          };
        }
        var existing = findExistingMarker_(
          payload.dedupeKey,
          dispatch.queueClaim
            ? dispatch.queueClaim.eventId
            : null
        );
        var characterDelivery =
          dispatch.mode === 'enforced';

        if (existing && existing.status === 'completed') {
          return {
            action: 'completed',
            marker: existing,
            body: String(existing.text || payload.body)
          };
        }

        if (
          existing &&
          dispatch.queueClaim &&
          existing.proactiveOriginEventId &&
          existing.proactiveOriginEventId !==
            dispatch.queueClaim.eventId
        ) {
          return {
            action: 'in_progress',
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

        var deliveryBody = characterDelivery
          ? payload.body
          : existing && existing.text
            ? String(existing.text)
            : payload.body;
        var marker = existing;
        var characterApproval = characterDelivery
          ? characterApprovalFromArtifact_(approvedArtifact)
          : null;

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
            outputTokens: payload.outputTokens,
            proactiveSubject: characterDelivery ? payload.subject : null,
            proactiveOriginEventId: dispatch.queueClaim
              ? dispatch.queueClaim.eventId
              : null,
            characterApproval: characterApproval
          });
        } else {
          if (characterDelivery) {
            ensure(
              marker.status === 'failed' &&
                marker.proactiveSubject === payload.subject &&
                String(marker.text || '') === payload.body &&
                marker.characterApproval != null,
              'STORAGE_DATA_CORRUPTED',
              'Saved proactive content changed before approved retry.'
            );
          }
          var markerPatch = {
            createdAt: attemptAt,
            status: 'accepted',
            error: null
          };
          if (characterDelivery) {
            markerPatch.characterApproval = characterApproval;
          }
          if (dispatch.queueClaim) {
            markerPatch.proactiveOriginEventId =
              dispatch.queueClaim.eventId;
          }
          marker = SheetRepository.updateConversationMessage(
            marker.messageId,
            markerPatch
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

  function handleFinalDeliveryBlock_(
    payload,
    attemptAt,
    decision
  ) {
    if (decision.reason === 'MAIL_QUOTA_EXHAUSTED') {
      throw createAppError(
        'MAIL_QUOTA_EXHAUSTED',
        'Mail quota is exhausted for proactive delivery.'
      );
    }
    return {
      sent: false,
      duplicate: false,
      skipped: true,
      reason: decision.reason,
      dedupeKey: payload.dedupeKey,
      markerStatus: null,
      createdAt: attemptAt
    };
  }

  function assessFinalDelivery_(queuePayload, now) {
    try {
      if (!queuePayload || !queuePayload.policyBinding) {
        return {
          allowed: false,
          reason: 'PROACTIVE_POLICY_BINDING_MISSING'
        };
      }
      var policyBinding = normalizePolicyBinding_(
        queuePayload.policyBinding
      );
      var timingPolicy = resolveTimingPolicy_();
      if (!timingPolicy.enabled) {
        return {
          allowed: false,
          reason: 'PROACTIVE_FREQUENCY_OFF'
        };
      }
      if (
        !policyBindingsEqual_(
          policyBinding,
          buildPolicyBinding_(timingPolicy)
        )
      ) {
        return {
          allowed: false,
          reason: 'PROACTIVE_POLICY_CHANGED'
        };
      }
      var nowDate = normalizeDate_(now);
      var inspection = inspectPolicy(nowDate);
      var approved = policyBinding.environment === 'test'
        ? inspection.manualTestAllowed
        : inspection.automaticTriggersAllowed;
      if (!inspection.valid || !approved) {
        return {
          allowed: false,
          reason: policyBinding.environment === 'test'
            ? 'PROACTIVE_TEST_POLICY_NOT_READY'
            : 'PROACTIVE_PRODUCTION_POLICY_NOT_READY'
        };
      }
      if (
        queuePayload.targetDate <
          formatDateInTokyo(nowDate)
      ) {
        return {
          allowed: false,
          reason: 'TARGET_DATE_EXPIRED'
        };
      }
      var state = SheetRepository.getUserState();
      if (!state) {
        return {
          allowed: false,
          reason: 'PROACTIVE_STATE_MISSING'
        };
      }
      if (
        state.last_user_message_at &&
        getIsoTimeMillis(state.last_user_message_at) >
          getIsoTimeMillis(queuePayload.requestedAt)
      ) {
        return {
          allowed: false,
          reason: 'USER_ACTIVITY_AFTER_ENQUEUE'
        };
      }
      var hardGate = evaluateHardGates_(
        state,
        nowDate,
        {
          checkSilence: true,
          checkNextCheck: false,
          checkQuota: true,
          timingPolicy: timingPolicy
        }
      );
      return {
        allowed: hardGate.eligible,
        reason: hardGate.reason
      };
    } catch (error) {
      return {
        allowed: false,
        reason: normalizeError(error).code
      };
    }
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

  function completeManagedNoSend_(
    payload,
    nowIso,
    queueClaim,
    reason
  ) {
    LockManager.withScriptLock(
      'proactive-no-send-' + payload.messageDedupeKey,
      function() {
        assertQueueClaimCurrent_(queueClaim, payload);
        advanceNextCheckOnly_(nowIso);
      }
    );
    return buildDispatchResult_(false, reason, null, nowIso, {
      usedAi: payload.characterRuntimeMode === 'enforced',
      probability: payload.probability,
      sample: payload.sample,
      decisionSlot: payload.decisionSlot,
      fallbackReason: null
    });
  }

  function reconcileCompletedMarker_(
    payload,
    marker,
    queueClaim,
    nowIso
  ) {
    return LockManager.withScriptLock(
      'proactive-delivery-reconcile-' +
        payload.messageDedupeKey,
      function() {
        assertQueueClaimCurrent_(queueClaim, payload);
        updateStateAfterSend_(
          payload,
          marker.createdAt || nowIso
        );
        return marker;
      }
    );
  }

  function advanceNextCheckOnly_(nowIso) {
    var state = SheetRepository.ensureDefaultUserState();
    state = SheetRepository.getUserState() || state;
    var recheckMinutes = resolveTimingPolicy_().recheckMinutes;
    var nextCheck = toIsoStringInTokyo(
      new Date(
        parseIsoToDate(nowIso).getTime() +
          recheckMinutes * 60 * 1000
      )
    );
    if (
      !state.next_proactive_check_at ||
      getIsoTimeMillis(nextCheck) >
        getIsoTimeMillis(state.next_proactive_check_at)
    ) {
      SheetRepository.updateUserState({
        next_proactive_check_at: nextCheck
      });
    }
    return nextCheck;
  }

  function quarantineProactiveMarker_(
    marker,
    queueClaim,
    payload
  ) {
    if (!marker || !marker.messageId) {
      return null;
    }
    return LockManager.withScriptLock(
      'proactive-quarantine-' + marker.messageId,
      function() {
        assertQueueClaimCurrent_(queueClaim, payload);
        var current = findExistingMarker_(payload.messageDedupeKey);
        if (!current || current.messageId !== marker.messageId) {
          return null;
        }
        ensure(
          typeof SheetRepository.quarantineProactiveMarker ===
            'function',
          'STORAGE_DATA_CORRUPTED',
          'Proactive quarantine storage boundary is unavailable.'
        );
        return SheetRepository.quarantineProactiveMarker(
          marker.messageId,
          queueClaim ? queueClaim.eventId : null
        );
      }
    );
  }

  function isRetryableApprovedMarker_(marker) {
    var approval = marker && marker.characterApproval;
    return Boolean(
      marker &&
        marker.status === 'failed' &&
        typeof marker.proactiveSubject === 'string' &&
        marker.proactiveSubject.trim() !== '' &&
        String(marker.text || '').trim() !== '' &&
        approval &&
        (
          (
            approval.surface === 'PROACTIVE_AI' &&
            (
              approval.source === 'generated' ||
              approval.source === 'rewrite'
            )
          ) ||
          (
            approval.surface === 'PROACTIVE_RETRY' &&
            approval.source === 'legacy_revalidated'
          )
        )
    );
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

  function normalizeCharacterUsage_(usage) {
    usage = usage || {};
    return {
      apiCalls: normalizeUsageNumber_(usage.apiCalls),
      imageCalls: normalizeUsageNumber_(usage.imageCalls),
      inputTokens: normalizeUsageNumber_(usage.inputTokens),
      outputTokens: normalizeUsageNumber_(usage.outputTokens)
    };
  }

  function normalizeUsageNumber_(value) {
    var number = Number(value || 0);
    if (!isFinite(number) || number < 0) {
      return 0;
    }
    return Math.floor(number);
  }

  function recordCharacterUsageBestEffort_(
    createdAt,
    rawUsage
  ) {
    var usage = normalizeCharacterUsage_(rawUsage);
    if (usage.apiCalls < 1) {
      return false;
    }
    try {
      SheetRepository.incrementUsageDaily(
        formatDateInTokyo(parseIsoToDate(createdAt)),
        {
          apiCalls: usage.apiCalls,
          imageCalls: usage.imageCalls,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens
        }
      );
      return true;
    } catch (error) {
      try {
        AppLogger.writeDebugLog(
          'WARN',
          'recordProactiveCharacterUsage',
          'Proactive character usage accounting failed.',
          {
            code: normalizeError(error).code
          },
          null
        );
      } catch (ignored) {}
      return false;
    }
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

    var quietStart = requireConfig_('QUIET_START', 'time');
    var quietEnd = requireConfig_('QUIET_END', 'time');
    var timingPolicy = options.timingPolicy || resolveTimingPolicy_();
    if (!timingPolicy.enabled) {
      return {
        eligible: false,
        reason: 'PROACTIVE_FREQUENCY_OFF'
      };
    }
    var silenceMinutes = timingPolicy.silenceFloorMinutes;
    var cooldownMinutes = Number(
      requireConfig_('PROACTIVE_COOLDOWN_MINUTES', 'int')
    );
    var maxPerDay = Number(
      requireConfig_('PROACTIVE_MAX_PER_DAY', 'int')
    );

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
        resolveTimingPolicy_().recheckMinutes
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
    var characterRuntimeMode = eventPayload.characterRuntimeMode == null
      ? 'legacy'
      : String(eventPayload.characterRuntimeMode);
    var policyBinding = eventPayload.policyBinding == null
      ? null
      : normalizePolicyBinding_(eventPayload.policyBinding);

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
    ensure(
      characterRuntimeMode === 'legacy' ||
        characterRuntimeMode === 'enforced',
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload.characterRuntimeMode is invalid.'
    );

    var normalizedPayload = {
      targetDate: targetDate,
      sequence: sequence,
      requestedAt: requestedAt,
      decisionSlot: decisionSlot,
      messageDedupeKey: messageDedupeKey,
      probability: probability,
      sample: sample,
      elapsedMinutes: elapsedMinutes,
      timeWeight: timeWeight,
      reason: eventPayload.reason || null,
      characterRuntimeMode: characterRuntimeMode,
      policyBinding: policyBinding
    };
    if (characterRuntimeMode === 'enforced') {
      normalizedPayload.characterBinding = normalizeCharacterBinding_(
        eventPayload.characterBinding
      );
    } else {
      ensure(
        eventPayload.characterBinding == null,
        'VALIDATION_REQUEST_INVALID',
        'Legacy PROACTIVE_SEND payload must not contain a character binding.'
      );
    }
    return normalizedPayload;
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
      subject: Object.prototype.hasOwnProperty.call(message, 'subject')
        ? String(message.subject)
        : buildSubject_(targetDate),
      body: body,
      sentAt: message.sentAt || null,
      model: message.model || null,
      inputTokens: message.inputTokens == null
        ? null
        : Number(message.inputTokens),
      outputTokens: message.outputTokens == null
        ? null
        : Number(message.outputTokens),
      options: message.options || {},
      characterDelivery: message.characterDelivery || null
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

  function resolveTimingPolicy_() {
    var environment = readAppEnvironment_();
    var frequency = readProactiveFrequency_();
    var mode = String(
      requireConfig_('PROACTIVE_POLICY_MODE', 'string')
    ).toLowerCase();
    ensure(
      mode === 'probability' || mode === 'threshold',
      'CONFIG_MISSING',
      'PROACTIVE_POLICY_MODE must be probability or threshold.'
    );

    var recheckMinutes;
    var silenceFloorMinutes = null;
    var silenceCeilingMinutes = null;
    var profile;

    if (environment === 'test') {
      profile = TIMING_PROFILES.test;
      recheckMinutes = profile.recheckMinutes;
      if (frequency !== 'off') {
        silenceFloorMinutes =
          profile.frequencies[frequency].silenceFloorMinutes;
        silenceCeilingMinutes =
          profile.frequencies[frequency].silenceCeilingMinutes;
      }
    } else {
      var baseSilenceMinutes = Number(
        requireConfig_('SILENCE_MINUTES', 'int')
      );
      var productionCeilingMinutes = Number(
        requireConfig_(
          'PROACTIVE_SILENCE_CEILING_MINUTES',
          'int'
        )
      );
      recheckMinutes = Number(
        requireConfig_('PROACTIVE_RECHECK_MINUTES', 'int')
      );
      ensure(
        isFinite(baseSilenceMinutes) && baseSilenceMinutes >= 0,
        'CONFIG_MISSING',
        'SILENCE_MINUTES must be a non-negative number.'
      );
      ensure(
        isFinite(productionCeilingMinutes) &&
          productionCeilingMinutes > baseSilenceMinutes * 2,
        'CONFIG_MISSING',
        'PROACTIVE_SILENCE_CEILING_MINUTES must exceed every production silence floor.'
      );
      if (frequency !== 'off') {
        var expectedProduction = TIMING_PROFILES.prod.frequencies;
        var multiplier =
          expectedProduction[frequency]
            .silenceFloorMinutes /
          expectedProduction.normal.silenceFloorMinutes;
        silenceFloorMinutes = baseSilenceMinutes * multiplier;
        silenceCeilingMinutes = productionCeilingMinutes;
      }
    }

    ensure(
      isFinite(recheckMinutes) &&
        recheckMinutes >= 1 &&
        Math.floor(recheckMinutes) === recheckMinutes,
      'CONFIG_MISSING',
      'Proactive recheck minutes must be a positive integer.'
    );
    if (frequency !== 'off') {
      ensure(
        isFinite(silenceFloorMinutes) &&
          silenceFloorMinutes >= 0 &&
          isFinite(silenceCeilingMinutes) &&
          silenceCeilingMinutes > silenceFloorMinutes,
        'CONFIG_MISSING',
        'Proactive silence timing is invalid.'
      );
    }

    return {
      environment: environment,
      frequency: frequency,
      enabled: frequency !== 'off',
      mode: mode,
      silenceFloorMinutes: silenceFloorMinutes,
      silenceCeilingMinutes: silenceCeilingMinutes,
      recheckMinutes: recheckMinutes
    };
  }

  function readAppEnvironment_() {
    var environment = PropertiesService
      .getScriptProperties()
      .getProperty(APP_CONSTANTS.PROPERTY_KEYS.APP_ENV);
    Validators.assertAppEnv(environment);
    return String(environment);
  }

  function readProactiveFrequency_() {
    var config = typeof ConfigRepository.getUniqueByKey === 'function'
      ? ConfigRepository.getUniqueByKey('PROACTIVE_FREQUENCY')
      : ConfigRepository.getByKey('PROACTIVE_FREQUENCY');
    ensure(
      config && config.value != null,
      'CONFIG_MISSING',
      'Missing config: PROACTIVE_FREQUENCY'
    );
    ensure(
      config.type == null || config.type === 'string',
      'CHARACTER_CONFIG_INVALID',
      'Stored proactive frequency type is invalid.',
      { reason: 'PROACTIVE_FREQUENCY_ENTRY_INVALID' }
    );
    var frequency = String(config.value).toLowerCase();
    ensure(
      APP_CONSTANTS.CHARACTER.PROACTIVE_FREQUENCIES.indexOf(
        frequency
      ) !== -1,
      'CHARACTER_CONFIG_INVALID',
      'Stored proactive frequency is invalid.',
      { reason: 'PROACTIVE_FREQUENCY_INVALID' }
    );
    return frequency;
  }

  function buildPolicyBinding_(timingPolicy) {
    return {
      environment: timingPolicy.environment,
      frequency: timingPolicy.frequency,
      mode: timingPolicy.mode
    };
  }

  function normalizePolicyBinding_(value) {
    ensure(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value),
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload.policyBinding is invalid.'
    );
    var keys = Object.keys(value).sort();
    ensure(
      JSON.stringify(keys) ===
        JSON.stringify(['environment', 'frequency', 'mode']),
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload.policyBinding fields are invalid.'
    );
    var environment = String(value.environment || '');
    var frequency = String(value.frequency || '');
    var mode = String(value.mode || '');
    ensure(
      APP_CONSTANTS.APP_ENVS.indexOf(environment) !== -1 &&
        APP_CONSTANTS.CHARACTER.PROACTIVE_FREQUENCIES.indexOf(
          frequency
        ) !== -1 &&
        frequency !== 'off' &&
        (mode === 'probability' || mode === 'threshold'),
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND payload.policyBinding values are invalid.'
    );
    return {
      environment: environment,
      frequency: frequency,
      mode: mode
    };
  }

  function policyBindingsEqual_(left, right) {
    return Boolean(
      left &&
        right &&
        left.environment === right.environment &&
        left.frequency === right.frequency &&
        left.mode === right.mode
    );
  }

  function inspectPolicy(now) {
    try {
      var policy = resolveTimingPolicy_();
      var reference = normalizeDate_(now);
      var quietStart = String(
        requireConfig_('QUIET_START', 'time')
      );
      var quietEnd = String(
        requireConfig_('QUIET_END', 'time')
      );
      var quietStartMinutes = parseTimeMinutes_(quietStart);
      var quietEndMinutes = parseTimeMinutes_(quietEnd);
      var timeBands = {
        morningStart: '00:00',
        dayStart: String(
          requireConfig_('PROACTIVE_DAY_START', 'time')
        ),
        eveningStart: String(
          requireConfig_('PROACTIVE_EVENING_START', 'time')
        ),
        quietStart: quietStart,
        quietEnd: quietEnd,
        morningWeight: Number(
          requireConfig_('PROACTIVE_MORNING_WEIGHT', 'float')
        ),
        dayWeight: Number(
          requireConfig_('PROACTIVE_DAY_WEIGHT', 'float')
        ),
        eveningWeight: Number(
          requireConfig_('PROACTIVE_EVENING_WEIGHT', 'float')
        ),
        probabilityCurve: Number(
          requireConfig_('PROACTIVE_PROBABILITY_CURVE', 'float')
        )
      };
      var guardrails = {
        quietStart: quietStart,
        quietEnd: quietEnd,
        quietHoursEnabled: quietStartMinutes !== quietEndMinutes,
        cooldownMinutes: Number(
          requireConfig_(
            'PROACTIVE_COOLDOWN_MINUTES',
            'int'
          )
        ),
        maxPerDay: Number(
          requireConfig_('PROACTIVE_MAX_PER_DAY', 'int')
        )
      };
      ensure(
        isFinite(guardrails.cooldownMinutes) &&
          guardrails.cooldownMinutes >= 0 &&
          Math.floor(guardrails.cooldownMinutes) ===
            guardrails.cooldownMinutes,
        'CONFIG_MISSING',
        'PROACTIVE_COOLDOWN_MINUTES must be a non-negative integer.'
      );
      ensure(
        isFinite(guardrails.maxPerDay) &&
          guardrails.maxPerDay >= 1 &&
          Math.floor(guardrails.maxPerDay) === guardrails.maxPerDay,
        'CONFIG_MISSING',
        'PROACTIVE_MAX_PER_DAY must be a positive integer.'
      );
      var productionReady = isProductionTimingReady_(
        policy,
        timeBands,
        guardrails
      );
      var manualTestReady = isManualTestTimingReady_(
        policy,
        timeBands,
        guardrails
      );
      var issues = [];
      if (
        policy.environment === 'prod' &&
        !productionReady
      ) {
        issues.push('PROACTIVE_PRODUCTION_POLICY_NOT_READY');
      }
      if (
        policy.environment === 'test' &&
        !manualTestReady
      ) {
        issues.push('PROACTIVE_TEST_POLICY_NOT_READY');
      }
      return {
        valid: true,
        environment: policy.environment,
        frequency: policy.frequency,
        enabled: policy.enabled,
        policyMode: policy.mode,
        silenceFloorMinutes: policy.silenceFloorMinutes,
        silenceCeilingMinutes: policy.silenceCeilingMinutes,
        recheckMinutes: policy.recheckMinutes,
        currentTimeWeight: getTimeWeight_(reference),
        quietHoursActive: isQuietHours_(
          reference,
          quietStart,
          quietEnd
        ),
        timeBands: timeBands,
        guardrails: guardrails,
        expectedTimingProfiles: buildExpectedTimingProfiles_(),
        automaticTriggersAllowed: productionReady,
        manualTestAllowed: manualTestReady,
        issues: issues
      };
    } catch (error) {
      return {
        valid: false,
        environment: null,
        frequency: null,
        enabled: false,
        policyMode: null,
        silenceFloorMinutes: null,
        silenceCeilingMinutes: null,
        recheckMinutes: null,
        currentTimeWeight: null,
        quietHoursActive: null,
        timeBands: null,
        guardrails: null,
        expectedTimingProfiles: buildExpectedTimingProfiles_(),
        automaticTriggersAllowed: false,
        manualTestAllowed: false,
        issues: [normalizeError(error).code]
      };
    }
  }

  function assertAutomaticTriggerReady() {
    var inspection = inspectPolicy(new Date());
    ensure(
      inspection.valid &&
        inspection.automaticTriggersAllowed,
      'CONFIG_MISSING',
      'Automatic triggers require the approved production proactive policy.',
      { reason: 'PROACTIVE_PRODUCTION_POLICY_NOT_READY' }
    );
    return inspection;
  }

  function assertManualTestReady() {
    var inspection = inspectPolicy(new Date());
    ensure(
      inspection.valid &&
        inspection.manualTestAllowed,
      'CONFIG_MISSING',
      'The proactive release test requires the approved test probability policy.',
      { reason: 'PROACTIVE_TEST_POLICY_NOT_READY' }
    );
    return inspection;
  }

  function hasApprovedSharedPolicy_(
    timeBands,
    guardrails
  ) {
    return Boolean(
      timeBands.dayStart === '10:00' &&
        timeBands.eveningStart === '18:00' &&
        Number(timeBands.morningWeight) === 0.7 &&
        Number(timeBands.dayWeight) === 1 &&
        Number(timeBands.eveningWeight) === 1.2 &&
        Number(timeBands.probabilityCurve) === 1.3 &&
        guardrails.quietHoursEnabled === true &&
        Number(guardrails.cooldownMinutes) === 240 &&
        Number(guardrails.maxPerDay) === 2
    );
  }

  function isProductionTimingReady_(
    policy,
    timeBands,
    guardrails
  ) {
    var expected = TIMING_PROFILES.prod;
    return Boolean(
      policy.environment === 'prod' &&
        policy.mode === 'probability' &&
        policy.recheckMinutes === expected.recheckMinutes &&
        Number(requireConfig_('SILENCE_MINUTES', 'int')) ===
          expected.frequencies.normal.silenceFloorMinutes &&
        Number(
          requireConfig_(
            'PROACTIVE_SILENCE_CEILING_MINUTES',
            'int'
          )
        ) ===
          expected.frequencies.normal.silenceCeilingMinutes &&
        hasApprovedSharedPolicy_(timeBands, guardrails)
    );
  }

  function isManualTestTimingReady_(
    policy,
    timeBands,
    guardrails
  ) {
    var expected = TIMING_PROFILES.test;
    var expectedFrequency = expected.frequencies[policy.frequency];
    var timingMatches = policy.frequency === 'off'
      ? policy.enabled === false &&
        policy.silenceFloorMinutes == null &&
        policy.silenceCeilingMinutes == null
      : Boolean(
        policy.enabled &&
          expectedFrequency &&
          policy.silenceFloorMinutes ===
            expectedFrequency.silenceFloorMinutes &&
          policy.silenceCeilingMinutes ===
            expectedFrequency.silenceCeilingMinutes
      );
    return Boolean(
      policy.environment === 'test' &&
        policy.mode === 'probability' &&
        policy.recheckMinutes === expected.recheckMinutes &&
        timingMatches &&
        hasApprovedSharedPolicy_(timeBands, guardrails)
    );
  }

  function buildExpectedTimingProfiles_() {
    var result = {};
    ['test', 'prod'].forEach(function(environment) {
      var profile = TIMING_PROFILES[environment];
      result[environment] = {
        recheckMinutes: profile.recheckMinutes
      };
      ['low', 'normal', 'high'].forEach(function(frequency) {
        result[environment][frequency] = {
          silenceFloorMinutes:
            profile.frequencies[frequency]
              .silenceFloorMinutes,
          silenceCeilingMinutes:
            profile.frequencies[frequency]
              .silenceCeilingMinutes
        };
      });
    });
    return result;
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
      requireConfig_('PROACTIVE_DAY_START', 'time')
    );
    var eveningStart = parseTimeMinutes_(
      requireConfig_(
        'PROACTIVE_EVENING_START',
        'time'
      )
    );
    ensure(
      dayStart < eveningStart,
      'CONFIG_MISSING',
      'PROACTIVE_DAY_START must be earlier than PROACTIVE_EVENING_START.'
    );

    var morningWeight = Number(
      requireConfig_('PROACTIVE_MORNING_WEIGHT', 'float')
    );
    var dayWeight = Number(
      requireConfig_('PROACTIVE_DAY_WEIGHT', 'float')
    );
    var eveningWeight = Number(
      requireConfig_('PROACTIVE_EVENING_WEIGHT', 'float')
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

  function findExistingMarker_(dedupeKey, originEventId) {
    var marker = typeof SheetRepository.getProactiveMarkerByDedupeKey ===
      'function'
      ? SheetRepository.getProactiveMarkerByDedupeKey(
        dedupeKey,
        originEventId || null
      )
      : SheetRepository.getMessageByRequestIdAndRole(
        dedupeKey,
        'system'
      );
    if (!marker || marker.messageType !== 'proactive') {
      return null;
    }
    return marker;
  }

  function resolveEnqueueRuntime_() {
    if (!getConfigBool_('PROACTIVE_AI_GENERATION_ENABLED', false)) {
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
      'Character runtime is not ready for proactive generation.',
      {
        reason: inspection.reason || 'CHARACTER_RUNTIME_BLOCKED'
      }
    );
    return {
      mode: 'enforced',
      binding: CharacterProactiveContextService.bindingFromInspection(
        inspection
      )
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
        value.policyVersion === APP_CONSTANTS.CHARACTER.POLICY_VERSION &&
        value.catalogVersion === APP_CONSTANTS.CHARACTER.CATALOG_VERSION &&
        typeof value.characterPackId === 'string' &&
        /^[a-z0-9][a-z0-9-]{2,63}$/.test(value.characterPackId) &&
        typeof value.characterPackVersion === 'string' &&
        /^[a-z0-9][a-z0-9.-]{2,79}$/.test(value.characterPackVersion),
      'VALIDATION_REQUEST_INVALID',
      'PROACTIVE_SEND character binding is invalid.'
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
      'Proactive eventId and leaseToken must be supplied together.'
    );
    if (!hasEventId) {
      return null;
    }
    ensure(
      Validators.isUuidV4(String(options.eventId)),
      'VALIDATION_REQUEST_INVALID',
      'Proactive eventId must be a UUID v4.'
    );
    return {
      eventId: String(options.eventId),
      leaseToken: String(options.leaseToken)
    };
  }

  function assertQueueClaimCurrent_(queueClaim, payload) {
    if (!queueClaim) {
      return true;
    }
    var event = SheetRepository.getEventById(queueClaim.eventId);
    ensure(
      event &&
        event.eventType === 'PROACTIVE_SEND' &&
        event.payload,
      'STORAGE_DATA_CORRUPTED',
      'Proactive queue event linkage is invalid.'
    );
    var storedPayload = normalizeDecisionPayload_(
      event.payload,
      event.payload.requestedAt ||
        event.payload.evaluatedAt ||
        toIsoStringInTokyo(new Date())
    );
    ensure(
      queuePayloadIdentity_(storedPayload) ===
        queuePayloadIdentity_(payload),
      'STORAGE_DATA_CORRUPTED',
      'Proactive queue event payload changed after claim.'
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

  function queuePayloadIdentity_(payload) {
    ensure(
      payload &&
        typeof payload === 'object' &&
        (
          payload.characterRuntimeMode === 'legacy' ||
          payload.characterRuntimeMode === 'enforced'
        ),
      'STORAGE_DATA_CORRUPTED',
      'Proactive queue identity is invalid.'
    );
    var binding = payload.characterRuntimeMode === 'enforced'
      ? normalizeCharacterBinding_(payload.characterBinding)
      : null;
    var policyBinding = payload.policyBinding == null
      ? null
      : normalizePolicyBinding_(payload.policyBinding);
    return JSON.stringify({
      targetDate: payload.targetDate,
      sequence: payload.sequence,
      requestedAt: payload.requestedAt,
      decisionSlot: payload.decisionSlot,
      messageDedupeKey: payload.messageDedupeKey,
      probability: payload.probability,
      sample: payload.sample,
      elapsedMinutes: payload.elapsedMinutes,
      timeWeight: payload.timeWeight,
      reason: payload.reason || null,
      characterRuntimeMode: payload.characterRuntimeMode,
      characterBinding: binding,
      policyBinding: policyBinding
    });
  }

  function requireConfig_(key, expectedType) {
    var config = typeof ConfigRepository.getUniqueByKey ===
      'function'
      ? ConfigRepository.getUniqueByKey(key)
      : ConfigRepository.getByKey(key);
    ensure(
      config && config.value != null,
      'CONFIG_MISSING',
      'Missing config: ' + key
    );
    if (expectedType) {
      ensure(
        config.type == null ||
          config.type === expectedType,
        'STORAGE_DATA_CORRUPTED',
        'Config type is invalid: ' + key,
        {
          key: key,
          expectedType: expectedType
        }
      );
    }
    return config.value;
  }

  function getConfigInt_(key, fallback) {
    var value = getConfigValue_(key, fallback);
    var numeric = Number(value);
    return isFinite(numeric) ? Math.floor(numeric) : fallback;
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
    inspectPolicy: inspectPolicy,
    assertAutomaticTriggerReady: assertAutomaticTriggerReady,
    assertManualTestReady: assertManualTestReady,
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
      buildMemoryQuery: buildMemoryQuery_,
      resolveTimingPolicy: resolveTimingPolicy_,
      normalizePolicyBinding: normalizePolicyBinding_,
      buildExpectedTimingProfiles: buildExpectedTimingProfiles_,
      assessFinalDelivery: assessFinalDelivery_
    }
  };
})();

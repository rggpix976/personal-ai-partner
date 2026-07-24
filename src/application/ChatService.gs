var ChatService = (function() {
  var DEFAULTS = Object.freeze({
    pendingRetrySeconds: 3,
    maxUserTextChars: 4000
  });

  function send(request, context) {
    var requestId = request && Validators.isUuidV4(request.requestId) ? request.requestId : generateUuidV4();
    var normalizedContext = null;
    var normalizedRequest = null;
    var preparedImage = null;
    var userMessage = null;
    var event = null;
    var runtime = null;
    var characterBinding = null;

    try {
      validatePlatform_();
      normalizedRequest = normalizeRequest_(request, requestId);
      normalizedContext = normalizeContext_(normalizedRequest, context);
      validateRequest_(normalizedRequest);

      var existingResult = LockManager.withScriptLock('chat-check-' + normalizedContext.requestId, function() {
        return getExistingRequestResult_(normalizedContext.requestId);
      });
      if (existingResult) {
        return existingResult;
      }

      runtime = resolveRuntime_();
      characterBinding = runtime.mode === 'enforced'
        ? CharacterChatContextService.bindingFromInspection(runtime.inspection)
        : null;
      preparedImage = normalizedRequest.image ? ImageService.prepareGeminiInput(normalizedRequest.image, {
        now: normalizedContext.now,
        requestText: normalizedRequest.text
      }) : null;

      var state = LockManager.withScriptLock('chat-send-' + normalizedContext.requestId, function() {
        return ensureUserMessageState_(
          normalizedRequest,
          normalizedContext,
          preparedImage,
          runtime.mode,
          characterBinding
        );
      });
      if (state.result) {
        cleanupPreparedImageIfOwned_(preparedImage);
        return state.result;
      }

      userMessage = state.userMessage;
      event = state.event;
      var completedResult = runtime.mode === 'enforced'
        ? executeEnforcedSync_(
          normalizedRequest,
          normalizedContext,
          preparedImage,
          userMessage,
          event,
          characterBinding
        )
        : executeLegacySync_(
          normalizedRequest,
          normalizedContext,
          preparedImage,
          userMessage,
          event
        );

      cleanupAfterCompletedResult_(preparedImage, normalizedContext.requestId);
      return completedResult;
    } catch (error) {
      var normalized = normalizeCharacterConfigError_(error);
      if (normalizedContext && userMessage && event) {
        if (normalized.retryable) {
          return queueRetry_(normalizedContext, userMessage, preparedImage, normalized, event);
        }
        return markDeadAndFail_(normalizedContext, userMessage, normalized, event);
      }
      cleanupPreparedImageIfOwned_(preparedImage);
      return buildFailedResult_(
        normalizedContext ? normalizedContext.requestId : requestId,
        userMessage,
        normalized,
        []
      );
    }
  }

  function executeLegacySync_(request, context, preparedImage, userMessage, event) {
    var chatContext = ContextService.buildChatContext({
      now: context.now,
      currentUserMessage: userMessage
    });
    var geminiRequest = buildGeminiRequest_(request, chatContext, preparedImage);
    var generation = preparedImage
      ? GeminiClient.generateWithImage(geminiRequest)
      : GeminiClient.generateText(geminiRequest);
    var assistantText = normalizeAssistantText_(generation.text);
    ensure(assistantText !== '', 'GEMINI_BAD_RESPONSE', 'Gemini returned an empty response.');

    return LockManager.withScriptLock('chat-complete-' + context.requestId, function() {
      return finalizeCompleted_(context.requestId, userMessage, generation, assistantText, event);
    });
  }

  function executeEnforcedSync_(
    request,
    requestContext,
    preparedImage,
    userMessage,
    event,
    characterBinding
  ) {
    var surface = preparedImage ? 'CHAT_IMAGE' : 'CHAT_TEXT_SYNC';
    var characterContext = CharacterChatContextService.build({
      currentTime: requestContext.now,
      currentUserMessage: userMessage,
      hasImage: Boolean(preparedImage)
    });
    CharacterChatContextService.assertBindingMatchesContext(
      characterBinding,
      characterContext
    );
    var session = CharacterChatGeminiAdapter.createSession({
      preparedImage: preparedImage
    });
    var approval = approveCharacterChat_(characterContext, surface, session);
    if (approval.kind === 'NON_CHARACTER_ROUTE') {
      return LockManager.withScriptLock('chat-route-' + requestContext.requestId, function() {
        return finalizeRouted_(
          requestContext.requestId,
          userMessage,
          event,
          approval.route,
          requestContext.now
        );
      });
    }

    return LockManager.withScriptLock('chat-approved-' + requestContext.requestId, function() {
      var existing = SheetRepository.getConversationByRequestId(
        requestContext.requestId
      );
      if (existing.userMessage && existing.assistantMessage) {
        assertPersistedPair_(existing, event);
        if (event && event.eventId && event.status !== 'DONE') {
          markEventDone_(event.eventId, existing.assistantMessage.createdAt);
        }
        return buildCompletedResult_(
          requestContext.requestId,
          existing.userMessage,
          existing.assistantMessage,
          []
        );
      }
      SheetRepository.assertCharacterApprovalColumns();
      return CharacterSinkAdapter.deliver({
        artifact: approval.artifact,
        expectedSurface: surface,
        context: approval.classifiedContext,
        metricEmitter: session.emitMetric,
        write: function(payload, artifact) {
          return persistApprovedChat_({
            requestId: requestContext.requestId,
            now: requestContext.now,
            userMessage: existing.userMessage || userMessage,
            event: event,
            payload: payload,
            artifact: artifact,
            session: session,
            markEventDone: true
          });
        }
      });
    });
  }

  function executeEnforcedQueued_(
    payload,
    nowIso,
    preparedImage,
    pair,
    characterBinding,
    queueClaim
  ) {
    var surface = preparedImage ? 'CHAT_IMAGE' : 'CHAT_TEXT_QUEUED';
    var characterContext = CharacterChatContextService.build({
      currentTime: nowIso,
      currentUserMessage: pair.userMessage,
      hasImage: Boolean(preparedImage)
    });
    CharacterChatContextService.assertBindingMatchesContext(
      characterBinding,
      characterContext
    );
    var session = CharacterChatGeminiAdapter.createSession({
      preparedImage: preparedImage
    });
    var approval = approveCharacterChat_(characterContext, surface, session);
    if (approval.kind === 'NON_CHARACTER_ROUTE') {
      return buildRoutedResult_(
        payload.requestId,
        pair.userMessage,
        approval.route,
        []
      );
    }

    return LockManager.withScriptLock('chat-approved-queued-' + payload.requestId, function() {
      assertQueuedLeaseCurrent_(queueClaim, payload.requestId);
      var currentPair = SheetRepository.getConversationByRequestId(
        payload.requestId
      );
      if (currentPair.userMessage && currentPair.assistantMessage) {
        assertPersistedPair_(currentPair, { payload: payload });
        return buildCompletedResult_(
          payload.requestId,
          currentPair.userMessage,
          currentPair.assistantMessage,
          []
        );
      }
      SheetRepository.assertCharacterApprovalColumns();
      return CharacterSinkAdapter.deliver({
        artifact: approval.artifact,
        expectedSurface: surface,
        context: approval.classifiedContext,
        metricEmitter: session.emitMetric,
        write: function(approvedPayload, artifact) {
          return persistApprovedChat_({
            requestId: payload.requestId,
            now: nowIso,
            userMessage: currentPair.userMessage || pair.userMessage,
            event: null,
            payload: approvedPayload,
            artifact: artifact,
            session: session,
            markEventDone: false
          });
        }
      });
    });
  }

  function approveCharacterChat_(context, surface, session) {
    return CharacterOutputCoordinator.approve({
      context: context,
      surface: surface,
      classificationSignals: CharacterChatContextService.classificationSignals(
        context
      ),
      generate: session.generate,
      rewrite: session.rewrite,
      verifierFn: session.verify,
      metricEmitter: session.emitMetric
    });
  }

  function persistApprovedChat_(options) {
    var artifact = options.artifact;
    var approvedPayload = options.payload;
    var characterApproval = characterApprovalFromArtifact_(artifact);
    var userMessage = options.userMessage;
    var assistantText;
    if (artifact.surface === 'CHAT_IMAGE') {
      userMessage = updateApprovedUserImageSummary_(
        userMessage,
        approvedPayload.imageSummary,
        characterApproval
      );
      assistantText = approvedPayload.replyText;
    } else {
      assistantText = approvedPayload.text;
    }

    var generationMetadata = options.session.getGenerationMetadata(
      artifact.source
    );
    var usage = normalizeCharacterUsage_(options.session.getUsage());
    var assistantMessage = SheetRepository.appendConversation({
      messageId: generateUuidV4(),
      requestId: options.requestId,
      createdAt: options.now || toIsoStringInTokyo(new Date()),
      role: 'assistant',
      messageType: 'text',
      text: assistantText,
      image: null,
      status: 'completed',
      replyToMessageId: userMessage ? userMessage.messageId : null,
      model: generationMetadata ? generationMetadata.model || null : null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      characterApproval: characterApproval
    });

    if (options.markEventDone && options.event && options.event.eventId) {
      markEventDone_(options.event.eventId, assistantMessage.createdAt);
    }
    updateLastAssistantStateBestEffort_(
      assistantMessage.createdAt,
      options.requestId
    );
    recordCharacterUsageBestEffort_(
      assistantMessage.createdAt,
      usage,
      options.requestId
    );
    return buildCompletedResult_(
      options.requestId,
      userMessage,
      assistantMessage,
      []
    );
  }

  function updateApprovedUserImageSummary_(userMessage, summary, characterApproval) {
    ensure(
      userMessage && userMessage.image,
      'STORAGE_DATA_CORRUPTED',
      'Approved image reply is missing its user image message.'
    );
    return SheetRepository.updateConversationMessage(userMessage.messageId, {
      image: {
        name: userMessage.image.name,
        mimeType: userMessage.image.mimeType,
        summary: String(summary || '')
      },
      characterApproval: characterApproval
    });
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

  function recordCharacterUsage_(createdAt, usage) {
    if (!usage || usage.apiCalls < 1) {
      return;
    }
    SheetRepository.incrementUsageDaily(
      formatDateInTokyo(parseIsoToDate(createdAt)),
      {
        apiCalls: usage.apiCalls,
        imageCalls: usage.imageCalls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
      }
    );
  }

  function recordCharacterUsageBestEffort_(createdAt, usage, requestId) {
    try {
      recordCharacterUsage_(createdAt, usage);
      return true;
    } catch (error) {
      logNonCriticalFailure_(
        'recordCharacterUsage',
        error,
        requestId
      );
      return false;
    }
  }

  function updateLastAssistantStateBestEffort_(createdAt, requestId) {
    if (
      !SheetRepository ||
      typeof SheetRepository.updateUserState !== 'function'
    ) {
      return false;
    }
    try {
      SheetRepository.updateUserState({
        last_assistant_message_at: createdAt
      });
      return true;
    } catch (error) {
      logNonCriticalFailure_(
        'updateLastAssistantState',
        error,
        requestId
      );
      return false;
    }
  }

  function finalizeRouted_(requestId, userMessage, event, route, completedAt) {
    var pair = SheetRepository.getConversationByRequestId(requestId);
    if (pair.userMessage && pair.assistantMessage) {
      assertPersistedPair_(pair, event);
      if (event && event.eventId && event.status !== 'DONE') {
        markEventDone_(event.eventId, pair.assistantMessage.createdAt);
      }
      return buildCompletedResult_(
        requestId,
        pair.userMessage,
        pair.assistantMessage,
        []
      );
    }
    ensure(
      event && event.eventId,
      'STORAGE_DATA_CORRUPTED',
      'Non-character chat route is missing its queue event.'
    );
    ensure(
      event.payload &&
        event.payload.characterRuntimeMode === 'enforced' &&
        event.payload.userMessageId === (pair.userMessage || userMessage).messageId,
      'STORAGE_DATA_CORRUPTED',
      'Non-character chat route event linkage is invalid.'
    );
    assertPersistedEventBinding_(event.payload);
    var eventPayload = mergeObjects_(
      event.payload || {},
      { completionRoute: route }
    );
    markEventDone_(event.eventId, completedAt, eventPayload);
    return buildRoutedResult_(
      requestId,
      pair.userMessage || userMessage,
      route,
      []
    );
  }

  function processQueuedReply(eventPayload, options) {
    options = options || {};
    var payload = eventPayload || {};
    ensure(Validators.isUuidV4(payload.requestId), 'VALIDATION_REQUEST_INVALID', 'eventPayload.requestId must be a UUID v4.');
    var queueClaim = normalizeQueueClaim_(options);
    assertQueuedLeaseCurrent_(queueClaim, payload.requestId);
    var nowIso = options.now && Validators.isIsoDateTimeString(options.now)
      ? options.now
      : toIsoStringInTokyo(new Date());
    var pair = SheetRepository.getConversationByRequestId(payload.requestId);
    ensure(pair && pair.userMessage, 'VALIDATION_REQUEST_INVALID', 'Queued chat reply is missing the original user message.');
    if (pair.assistantMessage) {
      assertPersistedPair_(pair, { payload: payload });
      return buildCompletedResult_(payload.requestId, pair.userMessage, pair.assistantMessage, []);
    }

    var preparedImage = null;
    try {
      var runtime = resolveQueuedRuntime_(payload);
      preparedImage = payload.image ? ImageService.prepareGeminiInput({
        name: payload.image.name,
        mimeType: payload.image.mimeType,
        tempFileId: payload.image.tempFileId
      }, {
        now: nowIso,
        requestText: pair.userMessage.text
      }) : null;
      var result = runtime.mode === 'enforced'
        ? executeEnforcedQueued_(
          payload,
          nowIso,
          preparedImage,
          pair,
          runtime.binding,
          queueClaim
        )
        : executeLegacyQueued_(
          payload,
          nowIso,
          preparedImage,
          pair,
          queueClaim
        );
      cleanupQueuedImageAfterResult_(payload, preparedImage, result);
      return result;
    } catch (error) {
      cleanupPreparedImageIfOwned_(preparedImage);
      throw normalizeCharacterConfigError_(error);
    }
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
      'Queued eventId and leaseToken must be supplied together.'
    );
    if (!hasEventId) {
      return null;
    }
    ensure(
      Validators.isUuidV4(String(options.eventId)),
      'VALIDATION_REQUEST_INVALID',
      'Queued eventId must be a UUID v4.'
    );
    return {
      eventId: String(options.eventId),
      leaseToken: String(options.leaseToken)
    };
  }

  function assertQueuedLeaseCurrent_(queueClaim, requestId) {
    if (!queueClaim) {
      return true;
    }
    var event = SheetRepository.getEventById(queueClaim.eventId);
    ensure(
      event,
      'STORAGE_DATA_CORRUPTED',
      'Queued chat event was not found.'
    );
    ensure(
      event.eventType === 'CHAT_REPLY' &&
        event.payload &&
        event.payload.requestId === requestId,
      'STORAGE_DATA_CORRUPTED',
      'Queued chat event linkage is invalid.'
    );
    if (
      event.status !== 'PROCESSING' ||
      event.lockedBy == null ||
      String(event.lockedBy) !== queueClaim.leaseToken
    ) {
      throw createAppError(
        'QUEUE_LOCK_BUSY',
        'Queue event lease no longer belongs to this worker.',
        { reason: 'QUEUE_LEASE_MISMATCH' }
      );
    }
    return true;
  }

  function executeLegacyQueued_(
    payload,
    nowIso,
    preparedImage,
    pair,
    queueClaim
  ) {
    var chatContext = ContextService.buildChatContext({
      now: nowIso,
      currentUserMessage: pair.userMessage
    });
    var generation = preparedImage
      ? GeminiClient.generateWithImage(buildGeminiRequest_({
        requestId: payload.requestId,
        text: pair.userMessage.text || '',
        image: preparedImage
      }, chatContext, preparedImage))
      : GeminiClient.generateText(buildGeminiRequest_({
        requestId: payload.requestId,
        text: pair.userMessage.text || '',
        image: null
      }, chatContext, null));
    var assistantText = normalizeAssistantText_(generation.text);
    ensure(assistantText !== '', 'GEMINI_BAD_RESPONSE', 'Gemini returned an empty response.');

    return LockManager.withScriptLock(
      'chat-legacy-queued-' + payload.requestId,
      function() {
        assertQueuedLeaseCurrent_(queueClaim, payload.requestId);
        var currentPair = SheetRepository.getConversationByRequestId(
          payload.requestId
        );
        ensure(
          currentPair && currentPair.userMessage,
          'STORAGE_DATA_CORRUPTED',
          'Queued chat reply lost its original user message.'
        );
        if (currentPair.assistantMessage) {
          assertPersistedPair_(currentPair, { payload: payload });
          return buildCompletedResult_(
            payload.requestId,
            currentPair.userMessage,
            currentPair.assistantMessage,
            []
          );
        }

        var userMessage = updateUserImageSummary_(
          currentPair.userMessage,
          assistantText
        );
        var assistantMessage = SheetRepository.appendConversation({
          messageId: generateUuidV4(),
          requestId: payload.requestId,
          createdAt: nowIso,
          role: 'assistant',
          messageType: 'text',
          text: assistantText,
          image: null,
          status: 'completed',
          replyToMessageId: userMessage.messageId,
          model: generation.model || null,
          inputTokens: generation.usage ? generation.usage.inputTokens : null,
          outputTokens: generation.usage ? generation.usage.outputTokens : null
        });
        updateLastAssistantStateBestEffort_(
          assistantMessage.createdAt,
          payload.requestId
        );
        if (generation.usage) {
          try {
            SheetRepository.incrementUsageDaily(formatDateInTokyo(parseIsoToDate(nowIso)), {
              apiCalls: 1,
              imageCalls: preparedImage ? 1 : 0,
              inputTokens: generation.usage.inputTokens || 0,
              outputTokens: generation.usage.outputTokens || 0
            });
          } catch (usageError) {
            logNonCriticalFailure_(
              'recordLegacyChatUsage',
              usageError,
              payload.requestId
            );
          }
        }
        return buildCompletedResult_(
          payload.requestId,
          userMessage,
          assistantMessage,
          []
        );
      }
    );
  }

  function ensureUserMessageState_(request, context, preparedImage, runtimeMode, characterBinding) {
    var existingResult = getExistingRequestResult_(context.requestId);
    if (existingResult) {
      return {
        result: existingResult
      };
    }

    var pair = SheetRepository.getConversationByRequestId(context.requestId);
    var event = null;
    if (pair.userMessage) {
      event = insertProcessingEvent_(
        context,
        pair.userMessage,
        preparedImage,
        runtimeMode,
        characterBinding
      );
      return {
        userMessage: pair.userMessage,
        event: event
      };
    }

    var userMessageRecord = SheetRepository.appendConversation({
      messageId: generateUuidV4(),
      requestId: context.requestId,
      createdAt: context.now,
      role: 'user',
      messageType: request.image ? 'image' : 'text',
      text: request.text,
      image: preparedImage ? preparedImage.storedImage : null,
      status: 'accepted'
    });

    SheetRepository.updateUserState({
      last_user_message_at: context.now
    });

    event = insertProcessingEvent_(
      context,
      userMessageRecord,
      preparedImage,
      runtimeMode,
      characterBinding
    );
    return {
      userMessage: userMessageRecord,
      event: event
    };
  }

  function finalizeCompleted_(requestId, userMessage, generation, assistantText, event) {
    var pair = SheetRepository.getConversationByRequestId(requestId);
    if (pair.userMessage && pair.assistantMessage) {
      if (event && event.eventId && event.status !== 'DONE') {
        markEventDone_(event.eventId, pair.assistantMessage.createdAt);
      }
      return buildCompletedResult_(requestId, pair.userMessage, pair.assistantMessage, []);
    }

    userMessage = updateUserImageSummary_(userMessage, assistantText);

    var assistantMessage = SheetRepository.appendConversation({
      messageId: generateUuidV4(),
      requestId: requestId,
      createdAt: toIsoStringInTokyo(new Date()),
      role: 'assistant',
      messageType: 'text',
      text: assistantText,
      image: null,
      status: 'completed',
      replyToMessageId: userMessage ? userMessage.messageId : null,
      model: generation.model || null,
      inputTokens: generation.usage ? generation.usage.inputTokens : null,
      outputTokens: generation.usage ? generation.usage.outputTokens : null
    });

    if (event && event.eventId) {
      markEventDone_(event.eventId, assistantMessage.createdAt);
    }
    updateLastAssistantStateBestEffort_(
      assistantMessage.createdAt,
      requestId
    );

    return buildCompletedResult_(requestId, pair.userMessage || userMessage, assistantMessage, []);
  }

  function queueRetry_(context, userMessage, preparedImage, error, event) {
    return LockManager.withScriptLock('chat-queue-' + context.requestId, function() {
      var currentEvent = refreshChatReplyEvent_(event, context.requestId);
      ensure(currentEvent && currentEvent.eventId, 'STORAGE_DATA_CORRUPTED', 'Missing CHAT_REPLY event for retry update.');
      var durableResult = reconcileDurableChatResult_(
        context.requestId,
        currentEvent
      );
      if (durableResult) {
        return durableResult;
      }
      ensure(
        currentEvent.status !== 'DONE',
        'STORAGE_DATA_CORRUPTED',
        'A completed chat event is missing its durable result.'
      );
      var retryDecision = RetryPolicy.getRetryDecision(
        error,
        (currentEvent.attemptCount || 0) + 1,
        parseIsoToDate(context.now),
        {
          eventType: 'CHAT_REPLY',
          payload: {
            requestId: context.requestId
          }
        }
      );
      var nextAttemptAt = retryDecision.nextAttemptAt ? toIsoStringInTokyo(retryDecision.nextAttemptAt) : null;
      var nextStatus = retryDecision.action === 'RETRY_WAIT' ? 'RETRY_WAIT' : 'DEAD';
      var persistedError = toPersistedError(error);
      SheetRepository.updateEvent(currentEvent.eventId, {
        status: nextStatus,
        attemptCount: (currentEvent.attemptCount || 0) + 1,
        nextAttemptAt: nextAttemptAt,
        lockedAt: null,
        lockedBy: null,
        updatedAt: context.now,
        completedAt: nextStatus === 'DEAD' ? context.now : null,
        lastError: {
          code: persistedError.code,
          message: persistedError.message
        }
      });
      currentEvent = findChatReplyEvent_(context.requestId);
      if (nextStatus === 'DEAD') {
        return buildFailedResult_(context.requestId, userMessage, createAppError('QUEUE_DEAD', error.message, null, {
          userMessage: error.userMessage
        }), []);
      }

      return buildQueuedResult_(
        context.requestId,
        userMessage,
        computeRetryAfterSeconds_(currentEvent),
        ['Reply generation is temporarily queued for retry.']
      );
    });
  }

  function markDeadAndFail_(context, userMessage, error, event) {
    return LockManager.withScriptLock('chat-dead-' + context.requestId, function() {
      var currentEvent = refreshChatReplyEvent_(event, context.requestId);
      var durableResult = reconcileDurableChatResult_(
        context.requestId,
        currentEvent
      );
      if (durableResult) {
        return durableResult;
      }
      ensure(
        !currentEvent || currentEvent.status !== 'DONE',
        'STORAGE_DATA_CORRUPTED',
        'A completed chat event is missing its durable result.'
      );
      if (currentEvent && currentEvent.eventId) {
        var persistedError = toPersistedError(error);
        SheetRepository.updateEvent(currentEvent.eventId, {
          status: 'DEAD',
          attemptCount: currentEvent.attemptCount || 1,
          nextAttemptAt: null,
          lockedAt: null,
          lockedBy: null,
          updatedAt: context.now,
          completedAt: context.now,
          lastError: {
            code: persistedError.code,
            message: persistedError.message
          }
        });
      }
      return buildFailedResult_(context.requestId, userMessage, error, []);
    });
  }

  function getExistingRequestResult_(requestId) {
    var pair = SheetRepository.getConversationByRequestId(requestId);
    var event = findChatReplyEvent_(requestId);

    if (pair.userMessage && pair.assistantMessage) {
      return reconcileDurableChatResult_(requestId, event);
    }

    if (
      pair.userMessage &&
      event &&
      event.status === 'DONE' &&
      event.payload &&
      isNonCharacterRoute_(event.payload.completionRoute)
    ) {
      assertPersistedRoute_(pair.userMessage, event);
      return buildRoutedResult_(
        requestId,
        pair.userMessage,
        event.payload.completionRoute,
        []
      );
    }

    if (pair.userMessage && event && event.status === 'DEAD') {
      var deadErrorCode = event.lastError && event.lastError.code
        ? event.lastError.code
        : 'QUEUE_DEAD';
      return buildFailedResult_(
        requestId,
        pair.userMessage,
        createAppError(
          deadErrorCode,
          event.lastError && event.lastError.message ? event.lastError.message : 'The queued reply failed.',
          null,
          {
            userMessage: isCharacterConfigErrorCode_(deadErrorCode)
              ? CharacterStatusNoticeService.forConfigError().message
              : null
          }
        ),
        []
      );
    }

    if (pair.userMessage && event) {
      return buildQueuedResult_(
        requestId,
        pair.userMessage,
        computeRetryAfterSeconds_(event),
        buildInFlightWarnings_(event)
      );
    }

    return null;
  }

  function assertPersistedPair_(pair, event) {
    ensure(
      pair && pair.userMessage && pair.assistantMessage,
      'STORAGE_DATA_CORRUPTED',
      'Completed chat pair is incomplete.'
    );
    var userApproval = pair.userMessage.characterApproval || null;
    var assistantApproval = pair.assistantMessage.characterApproval || null;
    var eventMode = event && event.payload
      ? event.payload.characterRuntimeMode
      : null;
    if (eventMode !== 'enforced') {
      ensure(
        userApproval == null && assistantApproval == null,
        'STORAGE_DATA_CORRUPTED',
        'Approved chat rows are missing their enforced event binding.'
      );
      return true;
    }

    var binding = assertPersistedEventBinding_(event.payload);
    ensure(
      event.payload.userMessageId === pair.userMessage.messageId &&
        pair.assistantMessage.replyToMessageId === pair.userMessage.messageId,
      'STORAGE_DATA_CORRUPTED',
      'Completed chat pair linkage is invalid.'
    );
    assertApprovalMatchesBinding_(assistantApproval, binding);

    if (event.payload.image) {
      ensure(
        assistantApproval.surface === 'CHAT_IMAGE' &&
          approvalsEqual_(userApproval, assistantApproval),
        'STORAGE_DATA_CORRUPTED',
        'Approved image pair metadata is inconsistent.'
      );
    } else {
      ensure(
        assistantApproval.surface === 'CHAT_TEXT_SYNC' ||
          assistantApproval.surface === 'CHAT_TEXT_QUEUED',
        'STORAGE_DATA_CORRUPTED',
        'Approved text reply surface is invalid.'
      );
      ensure(
        userApproval == null,
        'STORAGE_DATA_CORRUPTED',
        'Text user rows must not carry character approval metadata.'
      );
    }
    return true;
  }

  function assertPersistedRoute_(userMessage, event) {
    ensure(
      userMessage &&
        event &&
        event.status === 'DONE' &&
        event.payload &&
        event.payload.characterRuntimeMode === 'enforced' &&
        isNonCharacterRoute_(event.payload.completionRoute),
      'STORAGE_DATA_CORRUPTED',
      'Non-character route event is invalid.'
    );
    assertPersistedEventBinding_(event.payload);
    ensure(
      event.payload.userMessageId === userMessage.messageId &&
        userMessage.characterApproval == null,
      'STORAGE_DATA_CORRUPTED',
      'Non-character route linkage is invalid.'
    );
    return true;
  }

  function assertPersistedEventBinding_(payload) {
    var binding = payload && payload.characterBinding;
    var fields = [
      'policyVersion',
      'profileSchemaVersion',
      'profileRevision',
      'catalogVersion',
      'characterPackId',
      'characterPackVersion'
    ];
    ensure(
      binding &&
        typeof binding === 'object' &&
        !Array.isArray(binding) &&
        Object.keys(binding).length === fields.length &&
        fields.every(function(field) {
          return Object.prototype.hasOwnProperty.call(binding, field);
        }) &&
        binding.policyVersion === APP_CONSTANTS.CHARACTER.POLICY_VERSION &&
        binding.profileSchemaVersion === APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION &&
        typeof binding.profileRevision === 'number' &&
        Number.isSafeInteger(binding.profileRevision) &&
        binding.profileRevision > 0 &&
        binding.catalogVersion === APP_CONSTANTS.CHARACTER.CATALOG_VERSION &&
        typeof binding.characterPackId === 'string' &&
        /^[a-z0-9][a-z0-9-]{2,63}$/.test(binding.characterPackId) &&
        typeof binding.characterPackVersion === 'string' &&
        /^[a-z0-9][a-z0-9.-]{2,79}$/.test(binding.characterPackVersion),
      'STORAGE_DATA_CORRUPTED',
      'Enforced chat event binding is invalid.'
    );
    return binding;
  }

  function assertApprovalMatchesBinding_(approval, binding) {
    ensure(
      approval &&
        typeof approval === 'object' &&
        APP_CONSTANTS.CHARACTER.OUTPUT_SURFACES.indexOf(approval.surface) !== -1 &&
        APP_CONSTANTS.CHARACTER.ARTIFACT_SOURCES.indexOf(approval.source) !== -1 &&
        approval.policyVersion === binding.policyVersion &&
        approval.profileSchemaVersion === binding.profileSchemaVersion &&
        approval.profileRevision === binding.profileRevision &&
        approval.catalogVersion === binding.catalogVersion &&
        approval.characterPackId === binding.characterPackId &&
        approval.characterPackVersion === binding.characterPackVersion,
      'STORAGE_DATA_CORRUPTED',
      'Persisted character approval does not match its event binding.'
    );
    return true;
  }

  function approvalsEqual_(left, right) {
    return Boolean(
      left &&
        right &&
        APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS.every(function(field) {
          return left[field] === right[field];
        })
    );
  }

  function cleanupPreparedImageIfOwned_(preparedImage) {
    if (!preparedImage) {
      return false;
    }
    try {
      return ImageService.cleanupPreparedImage(preparedImage);
    } catch (error) {
      logNonCriticalFailure_(
        'cleanupPreparedChatImage',
        error,
        null
      );
      return false;
    }
  }

  function cleanupAfterCompletedResult_(preparedImage, requestId) {
    try {
      ImageService.cleanupAfterSuccess(preparedImage);
      return true;
    } catch (error) {
      logNonCriticalFailure_(
        'cleanupCompletedChatImage',
        error,
        requestId
      );
      return false;
    }
  }

  function cleanupQueuedImageAfterResult_(payload, preparedImage, result) {
    // A routed result has no assistant row. Keep its queued image until the
    // event is durably marked DONE (or normal TTL cleanup) so a markDone
    // failure can safely retry the same request.
    if (result && result.status === 'routed') {
      return false;
    }
    var cleanupSucceeded = cleanupAfterCompletedResult_(
      preparedImage,
      payload && payload.requestId
    );
    if (
      payload &&
      payload.image &&
      payload.image.tempFileId &&
      (!preparedImage || !preparedImage.createdTempFile)
    ) {
      try {
        DriveTempRepository.trashTempImage(payload.image.tempFileId);
      } catch (error) {
        cleanupSucceeded = false;
        logNonCriticalFailure_(
          'cleanupQueuedChatImage',
          error,
          payload.requestId
        );
      }
    }
    return cleanupSucceeded;
  }

  function updateUserImageSummary_(userMessage, assistantText) {
    if (!userMessage || !userMessage.image) {
      return userMessage;
    }
    return SheetRepository.updateConversationMessage(userMessage.messageId, {
      image: {
        name: userMessage.image.name,
        mimeType: userMessage.image.mimeType,
        summary: ImageService.summarizeFromAssistantText(assistantText)
      }
    });
  }

  function validatePlatform_() {
    Validators.validateScriptProperties(PropertiesService.getScriptProperties().getProperties(), 'postSetup');
    SheetRepository.ensureDefaultUserState();
    return true;
  }

  function resolveRuntime_() {
    var inspection = CharacterProfileService.inspectRuntime();
    if (inspection.state === 'legacy' && inspection.runtimeMode === 'legacy') {
      return {
        mode: 'legacy',
        inspection: inspection
      };
    }
    if (inspection.state === 'ready' && inspection.runtimeMode === 'enforced') {
      return {
        mode: 'enforced',
        inspection: inspection
      };
    }
    var notice = CharacterStatusNoticeService.forConfigError();
    throw createAppError(
      'CHARACTER_CONFIG_INVALID',
      'Character runtime is not ready.',
      { reason: inspection.reason || 'CHARACTER_RUNTIME_BLOCKED' },
      { userMessage: notice.message }
    );
  }

  function resolveQueuedRuntime_(payload) {
    var eventMode = payload.characterRuntimeMode == null
      ? 'legacy'
      : String(payload.characterRuntimeMode);
    ensure(
      eventMode === 'legacy' || eventMode === 'enforced',
      'VALIDATION_REQUEST_INVALID',
      'Queued chat runtime mode is invalid.'
    );
    var current = resolveRuntime_();
    if (current.mode !== eventMode) {
      throw createAppError(
        'CHARACTER_CONFIG_CONFLICT',
        'Queued chat runtime mode no longer matches the active runtime.',
        null,
        { userMessage: CharacterStatusNoticeService.forConfigError().message }
      );
    }
    if (eventMode === 'legacy') {
      return current;
    }
    if (!payload.characterBinding || typeof payload.characterBinding !== 'object') {
      throw createAppError(
        'CHARACTER_CONFIG_INVALID',
        'Queued enforced chat is missing its character binding.',
        null,
        { userMessage: CharacterStatusNoticeService.forConfigError().message }
      );
    }
    try {
      CharacterChatContextService.assertBindingMatchesInspection(
        payload.characterBinding,
        current.inspection
      );
    } catch (error) {
      throw normalizeCharacterConfigError_(error);
    }
    return {
      mode: 'enforced',
      inspection: current.inspection,
      binding: payload.characterBinding
    };
  }

  function normalizeRequest_(request, requestId) {
    request = request || {};
    return {
      requestId: requestId,
      text: request.text == null ? '' : String(request.text),
      clientTimestamp: request.clientTimestamp,
      image: request.image || null
    };
  }

  function normalizeContext_(request, context) {
    context = context || {};
    return {
      requestId: request.requestId,
      currentText: request.text,
      hasImage: Boolean(request.image),
      now: context.now && Validators.isIsoDateTimeString(context.now)
        ? context.now
        : toIsoStringInTokyo(new Date())
    };
  }

  function validateRequest_(request) {
    ensure(Validators.isUuidV4(request.requestId), 'VALIDATION_REQUEST_INVALID', 'requestId must be a UUID v4.');
    ensure(
      Validators.isIsoDateTimeString(request.clientTimestamp),
      'VALIDATION_REQUEST_INVALID',
      'clientTimestamp must be an ISO 8601 string.'
    );
    ensure(
      request.text.length <= getConfigInt_('MAX_USER_TEXT_CHARS', DEFAULTS.maxUserTextChars),
      'VALIDATION_TEXT_TOO_LONG',
      'User text exceeds the configured limit.'
    );
    ensure(
      request.text.length > 0 || request.image != null,
      'VALIDATION_REQUEST_INVALID',
      'Either text or image is required.'
    );
    if (request.image) {
      ImageService.validateImageMetadata(request.image);
    }
    return true;
  }

  function buildGeminiRequest_(request, chatContext, preparedImage) {
    return {
      systemInstruction: buildSystemInstruction_(chatContext),
      contents: buildContents_(chatContext, request, preparedImage),
      image: preparedImage || null
    };
  }

  function buildSystemInstruction_(chatContext) {
    var memoryLines = chatContext.memories.map(function(memory) {
      return '- [' + memory.category + '] ' + memory.content;
    });
    var sections = [
      'You are ' + chatContext.persona.partnerName + ', a supportive personal AI partner.',
      'User display name: ' + chatContext.persona.userName,
      'Persona: ' + chatContext.persona.systemPersona,
      'Prompt version: ' + chatContext.persona.promptVersion,
      'Current time in Asia/Tokyo: ' + chatContext.currentTime,
      'Reply warmly, truthfully, and concisely.',
      'If the user attached an image, only describe what can reasonably be inferred from it.'
    ];
    if (memoryLines.length > 0) {
      sections.push('Relevant long-term memories:\n' + memoryLines.join('\n'));
    }
    return sections.join('\n\n');
  }

  function buildContents_(chatContext, request, preparedImage) {
    var contents = [];
    chatContext.recentMessages.forEach(function(message) {
      if (message.requestId === request.requestId && message.role === 'user') {
        contents.push(buildCurrentUserContent_(request, preparedImage));
        return;
      }
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{
          text: renderMessageText_(message)
        }]
      });
    });

    if (contents.length === 0) {
      contents.push(buildCurrentUserContent_(request, preparedImage));
    }
    return contents;
  }

  function buildCurrentUserContent_(request, preparedImage) {
    var promptText = request.text || (preparedImage ? 'Please help with this image.' : '');
    return {
      role: 'user',
      parts: [{
        text: promptText
      }]
    };
  }

  function renderMessageText_(message) {
    var label = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User';
    var body = String(message.text || '');
    if (!body) {
      body = message.image ? '[Image] ' + String(message.image.summary || 'Image attachment') : '';
    }
    return label + ': ' + body;
  }

  function normalizeAssistantText_(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
  }

  function insertProcessingEvent_(context, userMessage, preparedImage, runtimeMode, characterBinding) {
    var normalizedRuntimeMode = runtimeMode === 'enforced' ? 'enforced' : 'legacy';
    if (normalizedRuntimeMode === 'enforced') {
      ensure(
        characterBinding && typeof characterBinding === 'object',
        'CHARACTER_CONFIG_INVALID',
        'Character runtime binding is required for enforced chat.'
      );
    }
    var eventPayload = {
      requestId: context.requestId,
      userMessageId: userMessage.messageId,
      requestedAt: context.now,
      image: preparedImage ? preparedImage.queueImage : null,
      characterRuntimeMode: normalizedRuntimeMode
    };
    if (normalizedRuntimeMode === 'enforced') {
      eventPayload.characterBinding = characterBinding;
    }
    var createdEvent = {
      eventId: generateUuidV4(),
      eventType: 'CHAT_REPLY',
      dedupeKey: buildChatReplyDedupeKey_(context.requestId),
      payload: eventPayload,
      status: 'PROCESSING',
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: context.now,
      lockedBy: 'ChatService.send',
      createdAt: context.now,
      updatedAt: context.now,
      completedAt: null,
      lastError: null
    };
    try {
      SheetRepository.insertEvent(createdEvent);
      return createdEvent;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'DUPLICATE_REQUEST') {
        throw error;
      }
      return findChatReplyEvent_(context.requestId);
    }
  }

  function markEventDone_(eventId, completedAt, eventPayload) {
    var patch = {
      status: 'DONE',
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: completedAt,
      completedAt: completedAt,
      lastError: null
    };
    if (eventPayload) {
      patch.payload_json = eventPayload;
    }
    SheetRepository.updateEvent(eventId, patch);
  }

  function buildInFlightWarnings_(event) {
    if (!event) {
      return [];
    }
    if (event.status === 'DONE') {
      return ['Reply processing finished, but the assistant message is not visible yet.'];
    }
    if (event.status === 'PROCESSING') {
      return ['Reply generation is already in progress for this request.'];
    }
    if (event.status === 'PENDING' || event.status === 'RETRY_WAIT') {
      return ['Reply generation is temporarily queued for retry.'];
    }
    return [];
  }

  function buildCompletedResult_(requestId, userMessage, assistantMessage, warnings) {
    return {
      ok: true,
      status: 'completed',
      requestId: requestId,
      userMessage: userMessage,
      assistantMessage: assistantMessage,
      retryAfterSeconds: null,
      error: null,
      warnings: warnings || []
    };
  }

  function buildQueuedResult_(requestId, userMessage, retryAfterSeconds, warnings) {
    return {
      ok: true,
      status: 'queued',
      requestId: requestId,
      userMessage: userMessage,
      assistantMessage: null,
      retryAfterSeconds: retryAfterSeconds,
      error: null,
      warnings: warnings || []
    };
  }

  function buildRoutedResult_(requestId, userMessage, route, warnings) {
    ensure(
      isNonCharacterRoute_(route),
      'VALIDATION_REQUEST_INVALID',
      'Non-character chat route is invalid.'
    );
    return {
      ok: true,
      status: 'routed',
      requestId: requestId,
      userMessage: userMessage,
      assistantMessage: null,
      retryAfterSeconds: null,
      error: null,
      route: route,
      notice: CharacterStatusNoticeService.forRoute(route),
      warnings: warnings || []
    };
  }

  function buildFailedResult_(requestId, userMessage, error, warnings) {
    var normalized = normalizeError(error);
    return {
      ok: false,
      status: 'failed',
      requestId: requestId,
      userMessage: userMessage || null,
      assistantMessage: null,
      retryAfterSeconds: null,
      error: normalized.toUserDto(),
      warnings: warnings || []
    };
  }

  function findChatReplyEvent_(requestId) {
    var rows = SheetRepository.getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE)
      .filter(function(row) {
        return row.event_type === 'CHAT_REPLY' && (
          row.dedupe_key === buildChatReplyDedupeKey_(requestId) ||
          (row.payload_json && row.payload_json.requestId === requestId)
        );
      })
      .sort(function(left, right) {
        return compareIsoDatesDescending(left.updated_at, right.updated_at);
      });

    if (rows.length === 0) {
      return null;
    }

    return {
      eventId: rows[0].event_id,
      payload: rows[0].payload_json || null,
      status: rows[0].status,
      attemptCount: rows[0].attempt_count,
      nextAttemptAt: rows[0].next_attempt_at,
      lastError: rows[0].last_error_code ? {
        code: rows[0].last_error_code,
        message: rows[0].last_error_message || rows[0].last_error_code
      } : null
    };
  }

  function refreshChatReplyEvent_(event, requestId) {
    if (
      event &&
      event.eventId &&
      SheetRepository &&
      typeof SheetRepository.getEventById === 'function'
    ) {
      var persisted = SheetRepository.getEventById(event.eventId);
      if (persisted) {
        return persisted;
      }
    }
    return event || findChatReplyEvent_(requestId);
  }

  function reconcileDurableChatResult_(requestId, event) {
    var pair = SheetRepository.getConversationByRequestId(requestId);
    if (pair.userMessage && pair.assistantMessage) {
      assertPersistedPair_(pair, event);
      if (event && event.eventId && event.status !== 'DONE') {
        markEventDone_(event.eventId, pair.assistantMessage.createdAt);
      }
      updateLastAssistantStateBestEffort_(
        pair.assistantMessage.createdAt,
        requestId
      );
      return buildCompletedResult_(
        requestId,
        pair.userMessage,
        pair.assistantMessage,
        []
      );
    }
    if (
      pair.userMessage &&
      event &&
      event.status === 'DONE' &&
      event.payload &&
      isNonCharacterRoute_(event.payload.completionRoute)
    ) {
      assertPersistedRoute_(pair.userMessage, event);
      return buildRoutedResult_(
        requestId,
        pair.userMessage,
        event.payload.completionRoute,
        []
      );
    }
    return null;
  }

  function computeRetryAfterSeconds_(event) {
    if (!event || !event.nextAttemptAt) {
      return DEFAULTS.pendingRetrySeconds;
    }
    var delta = Math.ceil((getIsoTimeMillis(event.nextAttemptAt) - new Date().getTime()) / 1000);
    return delta > 0 ? delta : 1;
  }

  function buildChatReplyDedupeKey_(requestId) {
    return 'CHAT_REPLY:' + requestId;
  }

  function isNonCharacterRoute_(value) {
    return value === 'PRODUCT_INFO' || value === 'ADMIN_OOC';
  }

  function isCharacterConfigErrorCode_(value) {
    return value === 'CHARACTER_CONFIG_INVALID' ||
      value === 'CHARACTER_CONFIG_CONFLICT';
  }

  function mergeObjects_(left, right) {
    var merged = {};
    Object.keys(left || {}).forEach(function(key) {
      merged[key] = left[key];
    });
    Object.keys(right || {}).forEach(function(key) {
      merged[key] = right[key];
    });
    return merged;
  }

  function normalizeCharacterConfigError_(error) {
    var normalized = normalizeError(error);
    if (
      normalized.code !== 'CHARACTER_CONFIG_INVALID' &&
      normalized.code !== 'CHARACTER_CONFIG_CONFLICT'
    ) {
      return normalized;
    }
    return createAppError(
      normalized.code,
      normalized.message,
      normalized.details,
      {
        userMessage: CharacterStatusNoticeService.forConfigError().message,
        retryable: normalized.retryable,
        retryStrategy: normalized.retryStrategy,
        httpStatus: normalized.httpStatus,
        cause: normalized.cause,
        correlationId: normalized.correlationId
      }
    );
  }

  function logNonCriticalFailure_(operation, error, requestId) {
    try {
      if (
        typeof AppLogger !== 'undefined' &&
        AppLogger &&
        typeof AppLogger.warn === 'function'
      ) {
        var normalized = normalizeError(error);
        AppLogger.warn(
          operation,
          'A non-critical chat side effect failed after the reply result was durable.',
          {
            code: normalized.code
          }
        );
      }
    } catch (ignoredLoggingError) {}
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
    send: send,
    processQueuedReply: processQueuedReply,
    assertPersistedPair: assertPersistedPair_,
    assertPersistedRoute: assertPersistedRoute_,
    __test: {
      getExistingRequestResult: getExistingRequestResult_,
      ensureUserMessageState: ensureUserMessageState_,
      cleanupPreparedImageIfOwned: cleanupPreparedImageIfOwned_,
      queueRetry: queueRetry_,
      markDeadAndFail: markDeadAndFail_,
      updateUserImageSummary: updateUserImageSummary_,
      buildSystemInstruction: buildSystemInstruction_,
      buildContents: buildContents_,
      buildInFlightWarnings: buildInFlightWarnings_,
      computeRetryAfterSeconds: computeRetryAfterSeconds_,
      resolveRuntime: resolveRuntime_,
      resolveQueuedRuntime: resolveQueuedRuntime_,
      buildRoutedResult: buildRoutedResult_,
      finalizeRouted: finalizeRouted_,
      persistApprovedChat: persistApprovedChat_,
      cleanupQueuedImageAfterResult: cleanupQueuedImageAfterResult_,
      recordCharacterUsageBestEffort: recordCharacterUsageBestEffort_,
      cleanupAfterCompletedResult: cleanupAfterCompletedResult_
    }
  };
})();

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

      preparedImage = normalizedRequest.image ? ImageService.prepareGeminiInput(normalizedRequest.image, {
        now: normalizedContext.now,
        requestText: normalizedRequest.text
      }) : null;

      var state = LockManager.withScriptLock('chat-send-' + normalizedContext.requestId, function() {
        return ensureUserMessageState_(normalizedRequest, normalizedContext, preparedImage);
      });
      if (state.result) {
        cleanupPreparedImageIfOwned_(preparedImage);
        return state.result;
      }

      userMessage = state.userMessage;
      event = state.event;
      var chatContext = ContextService.buildChatContext({
        now: normalizedContext.now,
        currentUserMessage: userMessage
      });
      var geminiRequest = buildGeminiRequest_(normalizedRequest, chatContext, preparedImage);
      var generation = preparedImage
        ? GeminiClient.generateWithImage(geminiRequest)
        : GeminiClient.generateText(geminiRequest);
      var assistantText = normalizeAssistantText_(generation.text);
      ensure(assistantText !== '', 'GEMINI_BAD_RESPONSE', 'Gemini returned an empty response.');

      var completedResult = LockManager.withScriptLock('chat-complete-' + normalizedContext.requestId, function() {
        return finalizeCompleted_(normalizedContext.requestId, userMessage, generation, assistantText, event);
      });

      ImageService.cleanupAfterSuccess(preparedImage);
      return completedResult;
    } catch (error) {
      var normalized = normalizeError(error);
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

  function processQueuedReply(eventPayload, options) {
    options = options || {};
    var payload = eventPayload || {};
    ensure(Validators.isUuidV4(payload.requestId), 'VALIDATION_REQUEST_INVALID', 'eventPayload.requestId must be a UUID v4.');
    var nowIso = options.now && Validators.isIsoDateTimeString(options.now)
      ? options.now
      : toIsoStringInTokyo(new Date());
    var pair = SheetRepository.getConversationByRequestId(payload.requestId);
    ensure(pair && pair.userMessage, 'VALIDATION_REQUEST_INVALID', 'Queued chat reply is missing the original user message.');
    if (pair.assistantMessage) {
      return buildCompletedResult_(payload.requestId, pair.userMessage, pair.assistantMessage, []);
    }

    var preparedImage = null;
    try {
      preparedImage = payload.image ? ImageService.prepareGeminiInput({
        name: payload.image.name,
        mimeType: payload.image.mimeType,
        tempFileId: payload.image.tempFileId
      }, {
        now: nowIso,
        requestText: pair.userMessage.text
      }) : null;
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

      var userMessage = updateUserImageSummary_(pair.userMessage, assistantText);
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
      SheetRepository.updateUserState({
        last_assistant_message_at: assistantMessage.createdAt
      });
      if (generation.usage) {
        SheetRepository.incrementUsageDaily(formatDateInTokyo(parseIsoToDate(nowIso)), {
          apiCalls: 1,
          imageCalls: preparedImage ? 1 : 0,
          inputTokens: generation.usage.inputTokens || 0,
          outputTokens: generation.usage.outputTokens || 0
        });
      }
      ImageService.cleanupAfterSuccess(preparedImage);
      if (payload.image && payload.image.tempFileId && (!preparedImage || !preparedImage.createdTempFile)) {
        try {
          DriveTempRepository.trashTempImage(payload.image.tempFileId);
        } catch (ignore) {}
      }
      return buildCompletedResult_(payload.requestId, userMessage, assistantMessage, []);
    } catch (error) {
      cleanupPreparedImageIfOwned_(preparedImage);
      throw error;
    }
  }

  function ensureUserMessageState_(request, context, preparedImage) {
    var existingResult = getExistingRequestResult_(context.requestId);
    if (existingResult) {
      return {
        result: existingResult
      };
    }

    var pair = SheetRepository.getConversationByRequestId(context.requestId);
    var event = null;
    if (pair.userMessage) {
      event = insertProcessingEvent_(context, pair.userMessage, preparedImage);
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

    event = insertProcessingEvent_(context, userMessageRecord, preparedImage);
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

    SheetRepository.updateUserState({
      last_assistant_message_at: assistantMessage.createdAt
    });
    if (event && event.eventId) {
      markEventDone_(event.eventId, assistantMessage.createdAt);
    }

    return buildCompletedResult_(requestId, pair.userMessage || userMessage, assistantMessage, []);
  }

  function queueRetry_(context, userMessage, preparedImage, error, event) {
    return LockManager.withScriptLock('chat-queue-' + context.requestId, function() {
      var currentEvent = event || findChatReplyEvent_(context.requestId);
      ensure(currentEvent && currentEvent.eventId, 'STORAGE_DATA_CORRUPTED', 'Missing CHAT_REPLY event for retry update.');
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
      SheetRepository.updateEvent(currentEvent.eventId, {
        status: nextStatus,
        attemptCount: (currentEvent.attemptCount || 0) + 1,
        nextAttemptAt: nextAttemptAt,
        lockedAt: null,
        lockedBy: null,
        updatedAt: context.now,
        completedAt: nextStatus === 'DEAD' ? context.now : null,
        lastError: {
          code: error.code,
          message: error.message
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
      var currentEvent = event || findChatReplyEvent_(context.requestId);
      if (currentEvent && currentEvent.eventId) {
        SheetRepository.updateEvent(currentEvent.eventId, {
          status: 'DEAD',
          attemptCount: currentEvent.attemptCount || 1,
          nextAttemptAt: null,
          lockedAt: null,
          lockedBy: null,
          updatedAt: context.now,
          completedAt: context.now,
          lastError: {
            code: error.code,
            message: error.message
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
      return buildCompletedResult_(requestId, pair.userMessage, pair.assistantMessage, []);
    }

    if (pair.userMessage && event && event.status === 'DEAD') {
      return buildFailedResult_(
        requestId,
        pair.userMessage,
        createAppError(
          event.lastError && event.lastError.code ? event.lastError.code : 'QUEUE_DEAD',
          event.lastError && event.lastError.message ? event.lastError.message : 'The queued reply failed.'
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

  function cleanupPreparedImageIfOwned_(preparedImage) {
    if (!preparedImage) {
      return false;
    }
    return ImageService.cleanupPreparedImage(preparedImage);
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

  function insertProcessingEvent_(context, userMessage, preparedImage) {
    var createdEvent = {
      eventId: generateUuidV4(),
      eventType: 'CHAT_REPLY',
      dedupeKey: buildChatReplyDedupeKey_(context.requestId),
      payload: {
        requestId: context.requestId,
        userMessageId: userMessage.messageId,
        requestedAt: context.now,
        image: preparedImage ? preparedImage.queueImage : null
      },
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

  function markEventDone_(eventId, completedAt) {
    SheetRepository.updateEvent(eventId, {
      status: 'DONE',
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: completedAt,
      completedAt: completedAt,
      lastError: null
    });
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
      status: rows[0].status,
      attemptCount: rows[0].attempt_count,
      nextAttemptAt: rows[0].next_attempt_at,
      lastError: rows[0].last_error_code ? {
        code: rows[0].last_error_code,
        message: rows[0].last_error_message || rows[0].last_error_code
      } : null
    };
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
    __test: {
      getExistingRequestResult: getExistingRequestResult_,
      ensureUserMessageState: ensureUserMessageState_,
      cleanupPreparedImageIfOwned: cleanupPreparedImageIfOwned_,
      markDeadAndFail: markDeadAndFail_,
      updateUserImageSummary: updateUserImageSummary_,
      buildSystemInstruction: buildSystemInstruction_,
      buildContents: buildContents_,
      buildInFlightWarnings: buildInFlightWarnings_,
      computeRetryAfterSeconds: computeRetryAfterSeconds_
    }
  };
})();

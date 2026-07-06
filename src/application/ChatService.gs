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

    try {
      validatePlatform_();
      normalizedRequest = normalizeRequest_(request, requestId);
      normalizedContext = normalizeContext_(normalizedRequest, context);
      validateRequest_(normalizedRequest);
      preparedImage = normalizedRequest.image ? ImageService.prepareGeminiInput(normalizedRequest.image, {
        now: normalizedContext.now,
        requestText: normalizedRequest.text
      }) : null;

      var state = LockManager.withScriptLock('chat-send-' + normalizedContext.requestId, function() {
        return ensureUserMessageState_(normalizedRequest, normalizedContext, preparedImage);
      });
      if (state.result) {
        return state.result;
      }

      userMessage = state.userMessage;
      var chatContext = ContextService.buildChatContext(normalizedContext);
      var geminiRequest = buildGeminiRequest_(normalizedRequest, chatContext, preparedImage);
      var generation = preparedImage
        ? GeminiClient.generateWithImage(geminiRequest)
        : GeminiClient.generateText(geminiRequest);
      var assistantText = normalizeAssistantText_(generation.text);
      ensure(assistantText !== '', 'GEMINI_BAD_RESPONSE', 'Gemini returned an empty response.');

      var completedResult = LockManager.withScriptLock('chat-complete-' + normalizedContext.requestId, function() {
        return finalizeCompleted_(normalizedContext.requestId, userMessage, generation, assistantText);
      });

      ImageService.cleanupAfterSuccess(preparedImage);
      return completedResult;
    } catch (error) {
      var normalized = normalizeError(error);
      if (normalized.retryable && normalizedContext && userMessage) {
        return queueRetry_(normalizedContext, userMessage, preparedImage, normalized);
      }
      return buildFailedResult_(
        normalizedContext ? normalizedContext.requestId : requestId,
        userMessage,
        normalized,
        []
      );
    }
  }

  function ensureUserMessageState_(request, context, preparedImage) {
    var pair = SheetRepository.getConversationByRequestId(context.requestId);
    var event = findChatReplyEvent_(context.requestId);

    if (pair.userMessage && pair.assistantMessage) {
      return {
        result: buildCompletedResult_(context.requestId, pair.userMessage, pair.assistantMessage, [])
      };
    }

    if (pair.userMessage) {
      if (event && event.status === 'DEAD') {
        return {
          result: buildFailedResult_(
            context.requestId,
            pair.userMessage,
            createAppError(
              event.lastError && event.lastError.code ? event.lastError.code : 'QUEUE_DEAD',
              event.lastError && event.lastError.message ? event.lastError.message : 'The queued reply failed.'
            ),
            []
          )
        };
      }
      if (event && event.status !== 'DEAD') {
        return {
          result: buildQueuedResult_(
            context.requestId,
            pair.userMessage,
            computeRetryAfterSeconds_(event),
            event.status === 'DONE'
              ? ['Reply processing finished, but the assistant message is not visible yet.']
              : []
          )
        };
      }
      return {
        userMessage: pair.userMessage
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

    return {
      userMessage: userMessageRecord
    };
  }

  function finalizeCompleted_(requestId, userMessage, generation, assistantText) {
    var pair = SheetRepository.getConversationByRequestId(requestId);
    if (pair.userMessage && pair.assistantMessage) {
      return buildCompletedResult_(requestId, pair.userMessage, pair.assistantMessage, []);
    }

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

    return buildCompletedResult_(requestId, pair.userMessage || userMessage, assistantMessage, []);
  }

  function queueRetry_(context, userMessage, preparedImage, error) {
    return LockManager.withScriptLock('chat-queue-' + context.requestId, function() {
      var event = findChatReplyEvent_(context.requestId);
      if (!event) {
        var retryDecision = RetryPolicy.getRetryDecision(error, 1, parseIsoToDate(context.now), {
          eventType: 'CHAT_REPLY',
          payload: {
            requestId: context.requestId
          }
        });
        try {
          SheetRepository.insertEvent({
            eventId: generateUuidV4(),
            eventType: 'CHAT_REPLY',
            dedupeKey: buildChatReplyDedupeKey_(context.requestId),
            payload: {
              requestId: context.requestId,
              userMessageId: userMessage.messageId,
              requestedAt: context.now,
              image: preparedImage ? preparedImage.queueImage : null
            },
            status: retryDecision.action === 'RETRY_WAIT' ? 'RETRY_WAIT' : 'PENDING',
            attemptCount: 1,
            nextAttemptAt: retryDecision.nextAttemptAt ? toIsoStringInTokyo(retryDecision.nextAttemptAt) : null,
            lockedAt: null,
            lockedBy: null,
            createdAt: context.now,
            updatedAt: context.now,
            completedAt: null,
            lastError: {
              code: error.code,
              message: error.message
            }
          });
          event = findChatReplyEvent_(context.requestId);
        } catch (insertError) {
          if (!(insertError instanceof AppError) || insertError.code !== 'DUPLICATE_REQUEST') {
            throw insertError;
          }
          event = findChatReplyEvent_(context.requestId);
        }
      }

      return buildQueuedResult_(
        context.requestId,
        userMessage,
        computeRetryAfterSeconds_(event),
        ['Reply generation is temporarily queued for retry.']
      );
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
    __test: {
      buildSystemInstruction: buildSystemInstruction_,
      buildContents: buildContents_,
      computeRetryAfterSeconds: computeRetryAfterSeconds_
    }
  };
})();

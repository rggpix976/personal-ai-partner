var WebController = (function() {
  var DEFAULTS = Object.freeze({
    appTitle: 'Personal AI Partner',
    pageSize: 20,
    maxPageSize: 50,
    maxUserTextChars: 4000,
    imageMaxBytes: 4194304,
    tempImageTtlHours: 24,
    partnerName: 'Partner',
    userName: 'You',
    pendingRetrySeconds: 3
  });

  function doGet() {
    assertWebAccess_();
    var template = createHtmlTemplate_('web/Index');
    template.bootstrapJson = toSafeInlineJson_(buildBootstrapConfig_());
    return template
      .evaluate()
      .setTitle(DEFAULTS.appTitle)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .addMetaTag('apple-mobile-web-app-capable', 'yes')
      .addMetaTag('mobile-web-app-capable', 'yes')
      .addMetaTag('apple-mobile-web-app-status-bar-style', 'black-translucent')
      .addMetaTag('theme-color', '#f6efe6');
  }

  function getInitialState() {
    assertWebAccess_();
    var system = buildSystemState_();
    if (system.status === 'stopped') {
      return {
        ok: true,
        system: system,
        messages: [],
        pagination: {
          hasMore: false,
          nextBeforeMessageId: null
        }
      };
    }

    var page = listMessagePage_(null, getRecentMessageLimit_());
    return {
      ok: true,
      system: system,
      messages: page.messages,
      pagination: page.pagination
    };
  }

  function loadMessages(beforeMessageId, limit) {
    assertWebAccess_();
    var system = buildSystemState_();
    if (system.status === 'stopped') {
      return {
        ok: true,
        messages: [],
        pagination: {
          hasMore: false,
          nextBeforeMessageId: null
        }
      };
    }
    return listMessagePage_(beforeMessageId, limit);
  }

  function sendChat(request) {
    var requestId = request && Validators.isUuidV4(request.requestId) ? request.requestId : generateUuidV4();

    try {
      assertWebAccess_();
      ensurePlatformReadyForSend_();
      validateChatRequest_(request, requestId);

      var context = buildRequestContext_(request, requestId, new Date());
      if (hasChatReplyWorker_()) {
        return ChatService.send(request, context);
      }

      var existingResult = findExistingChatResult_(requestId);
      if (existingResult) {
        return existingResult;
      }

      return sendChatViaQueueFallback_(request, context);
    } catch (error) {
      return buildFailedChatResult_(requestId, error, []);
    }
  }

  function getRequestStatus(requestId) {
    try {
      assertWebAccess_();
      ensure(Validators.isUuidV4(requestId), 'CONFIG_MISSING', 'requestId must be a UUID v4.');

      var pair = SheetRepository.getConversationByRequestId(requestId);
      if (pair.userMessage && pair.assistantMessage) {
        return {
          ok: true,
          status: 'completed',
          requestId: requestId,
          userMessage: pair.userMessage,
          assistantMessage: pair.assistantMessage,
          retryAfterSeconds: null,
          error: null,
          warnings: []
        };
      }

      var event = findChatReplyEvent_(requestId);
      if (pair.userMessage && event && event.status === 'DEAD') {
        return buildFailedChatResult_(
          requestId,
          createAppError(
            event.lastError && event.lastError.code ? event.lastError.code : 'QUEUE_DEAD',
            event.lastError && event.lastError.message ? event.lastError.message : 'The queued reply failed.',
            null,
            {
              userMessage: event.lastError && event.lastError.message ? event.lastError.message : null
            }
          ),
          []
        );
      }

      if (pair.userMessage) {
        return {
          ok: true,
          status: 'queued',
          requestId: requestId,
          userMessage: pair.userMessage,
          assistantMessage: null,
          retryAfterSeconds: computeRetryAfterSeconds_(event),
          error: null,
          warnings: event && event.status === 'DONE'
            ? ['Reply processing finished, but the assistant message is not visible yet.']
            : []
        };
      }

      return buildFailedChatResult_(
        requestId,
        createAppError('UNKNOWN', 'No request state was found for the supplied requestId.', null, {
          userMessage: 'The message request could not be found.'
        }),
        []
      );
    } catch (error) {
      return buildFailedChatResult_(Validators.isUuidV4(requestId) ? requestId : generateUuidV4(), error, []);
    }
  }

  function sendChatViaQueueFallback_(request, context) {
    var imagePayload = request.image ? persistTempImage_(request.image, context) : null;
    var userMessage = SheetRepository.appendConversation({
      messageId: generateUuidV4(),
      requestId: context.requestId,
      createdAt: context.now,
      role: 'user',
      messageType: request.image ? 'image' : 'text',
      text: request.text || '',
      image: request.image ? {
        name: request.image.name,
        mimeType: request.image.mimeType,
        summary: 'Attached image upload'
      } : null,
      status: 'accepted'
    });

    SheetRepository.updateUserState({
      last_user_message_at: context.now
    });

    SheetRepository.insertEvent({
      eventId: generateUuidV4(),
      eventType: 'CHAT_REPLY',
      dedupeKey: buildChatReplyDedupeKey_(context.requestId),
      payload: {
        requestId: context.requestId,
        userMessageId: userMessage.messageId,
        requestedAt: context.now,
        image: imagePayload
      },
      status: 'PENDING',
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: context.now,
      updatedAt: context.now,
      completedAt: null,
      lastError: null
    });

    return {
      ok: true,
      status: 'queued',
      requestId: context.requestId,
      userMessage: userMessage,
      assistantMessage: null,
      retryAfterSeconds: DEFAULTS.pendingRetrySeconds,
      error: null,
      warnings: ['A4 ChatService is not implemented yet. This request is queued for a later worker.']
    };
  }

  function buildBootstrapConfig_() {
    return {
      appTitle: DEFAULTS.appTitle,
      pageSize: DEFAULTS.pageSize,
      maxUserTextChars: getConfigInt_('MAX_USER_TEXT_CHARS', DEFAULTS.maxUserTextChars),
      imageMaxBytes: getConfigInt_('IMAGE_MAX_BYTES', DEFAULTS.imageMaxBytes),
      allowedMimeTypes: APP_CONSTANTS.MIME_TYPES.slice(),
      pendingRetrySeconds: DEFAULTS.pendingRetrySeconds,
      hasChatReplyWorker: hasChatReplyWorker_()
    };
  }

  function buildSystemState_() {
    var warnings = [];
    var status = 'ready';
    var lastUpdatedAt = toIsoStringInTokyo(new Date());

    try {
      Validators.validateScriptProperties(PropertiesService.getScriptProperties().getProperties(), 'postSetup');
      var userState = SheetRepository.getUserState();
      if (userState && userState.updated_at) {
        lastUpdatedAt = userState.updated_at;
      }
      var latest = SheetRepository.listRecentMessages(1);
      if (latest.length > 0) {
        lastUpdatedAt = latest[0].createdAt;
      }
    } catch (error) {
      status = 'stopped';
      warnings.push('The app is not fully configured. Run setup() and validatePostSetupProperties() in Apps Script.');
      warnings.push(normalizeError(error).userMessage);
    }

    if (!hasChatReplyWorker_()) {
      status = status === 'stopped' ? 'stopped' : 'degraded';
      warnings.push('A4 ChatService is not implemented yet. Sending works as queue intake only.');
    }

    return {
      status: status,
      partnerName: getConfigString_('PARTNER_NAME', DEFAULTS.partnerName),
      userName: getConfigString_('USER_NAME', DEFAULTS.userName),
      lastUpdatedAt: lastUpdatedAt,
      warnings: dedupeStrings_(warnings)
    };
  }

  function listMessagePage_(beforeMessageId, limit) {
    var normalizedLimit = normalizeLimit_(limit);
    var queryLimit = normalizedLimit + 1;
    var descending = beforeMessageId
      ? SheetRepository.listMessagesBefore(beforeMessageId, queryLimit)
      : SheetRepository.listRecentMessages(queryLimit);
    var hasMore = descending.length > normalizedLimit;
    var slice = hasMore ? descending.slice(0, normalizedLimit) : descending;
    var ascending = slice.slice().reverse();
    return {
      ok: true,
      messages: ascending,
      pagination: {
        hasMore: hasMore,
        nextBeforeMessageId: hasMore && ascending.length > 0 ? ascending[0].messageId : null
      }
    };
  }

  function validateChatRequest_(request, requestId) {
    if (!request || typeof request !== 'object') {
      throw createValidationError_('request must be an object.', 'The request payload is invalid.');
    }
    if (!Validators.isUuidV4(requestId)) {
      throw createValidationError_('requestId must be a UUID v4.', 'The request ID is invalid.');
    }
    if (!Validators.isIsoDateTimeString(request.clientTimestamp)) {
      throw createValidationError_(
        'clientTimestamp must be an ISO 8601 string.',
        'The message timestamp is invalid.'
      );
    }

    var text = request.text == null ? '' : String(request.text);
    var maxUserTextChars = Math.min(
      getConfigInt_('MAX_USER_TEXT_CHARS', DEFAULTS.maxUserTextChars),
      DEFAULTS.maxUserTextChars
    );
    ensure(text.length <= maxUserTextChars, 'VALIDATION_TEXT_TOO_LONG', 'User text exceeds the configured limit.');
    if (text.length === 0 && !request.image) {
      throw createValidationError_(
        'Either text or image is required.',
        'Send a message or attach an image before submitting.'
      );
    }

    if (!request.image) {
      return true;
    }

    ensure(typeof request.image === 'object', 'VALIDATION_IMAGE_UNSUPPORTED', 'image must be an object.');
    ensure(String(request.image.name || '') !== '', 'VALIDATION_IMAGE_UNSUPPORTED', 'image.name is required.');
    ensure(
      APP_CONSTANTS.MIME_TYPES.indexOf(request.image.mimeType) !== -1,
      'VALIDATION_IMAGE_UNSUPPORTED',
      'Unsupported image MIME type.'
    );
    ensure(String(request.image.base64 || '') !== '', 'VALIDATION_IMAGE_UNSUPPORTED', 'image.base64 is required.');

    var bytes = decodeBase64ToBytes_(request.image.base64);
    ensure(
      bytes.length <= getConfigInt_('IMAGE_MAX_BYTES', DEFAULTS.imageMaxBytes),
      'VALIDATION_IMAGE_TOO_LARGE',
      'Image exceeds the configured byte limit.'
    );
    return true;
  }

  function persistTempImage_(image, context) {
    return DriveTempRepository.createTempImage({
      name: image.name,
      mimeType: image.mimeType,
      base64: image.base64,
      now: context.now,
      ttlHours: getConfigInt_('TEMP_IMAGE_TTL_HOURS', DEFAULTS.tempImageTtlHours)
    });
  }

  function decodeBase64ToBytes_(base64) {
    try {
      return Utilities.base64Decode(base64);
    } catch (error) {
      try {
        return Utilities.base64DecodeWebSafe(base64);
      } catch (webSafeError) {
        throw createAppError('VALIDATION_IMAGE_UNSUPPORTED', 'Image payload is not valid base64.', null, {
          cause: error
        });
      }
    }
  }

  function buildFailedChatResult_(requestId, error, warnings) {
    var normalized = normalizeError(error);
    return {
      ok: false,
      status: 'failed',
      requestId: requestId,
      userMessage: null,
      assistantMessage: null,
      retryAfterSeconds: null,
      error: normalized.toUserDto(),
      warnings: warnings || []
    };
  }

  function findExistingChatResult_(requestId) {
    var pair = SheetRepository.getConversationByRequestId(requestId);
    if (pair.userMessage && pair.assistantMessage) {
      return {
        ok: true,
        status: 'completed',
        requestId: requestId,
        userMessage: pair.userMessage,
        assistantMessage: pair.assistantMessage,
        retryAfterSeconds: null,
        error: null,
        warnings: []
      };
    }

    if (pair.userMessage) {
      var event = findChatReplyEvent_(requestId);
      if (event && event.status === 'DEAD') {
        return buildFailedChatResult_(
          requestId,
          createAppError(
            event.lastError && event.lastError.code ? event.lastError.code : 'QUEUE_DEAD',
            event.lastError && event.lastError.message ? event.lastError.message : 'The queued reply failed.'
          ),
          []
        );
      }
      return {
        ok: true,
        status: 'queued',
        requestId: requestId,
        userMessage: pair.userMessage,
        assistantMessage: null,
        retryAfterSeconds: computeRetryAfterSeconds_(event),
        error: null,
        warnings: []
      };
    }

    return null;
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

  function getRecentMessageLimit_() {
    return normalizeLimit_(getConfigInt_('RECENT_MESSAGE_LIMIT', DEFAULTS.pageSize));
  }

  function normalizeLimit_(limit) {
    var numeric = Number(limit);
    if (!isFinite(numeric) || numeric < 1) {
      return DEFAULTS.pageSize;
    }
    return Math.min(Math.floor(numeric), DEFAULTS.maxPageSize);
  }

  function ensurePlatformReadyForSend_() {
    Validators.validateScriptProperties(PropertiesService.getScriptProperties().getProperties(), 'postSetup');
    SheetRepository.ensureDefaultUserState();
  }

  function getConfigString_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? String(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function getConfigInt_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? Number(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function hasChatReplyWorker_() {
    return typeof ChatService !== 'undefined' && ChatService && typeof ChatService.send === 'function';
  }

  function buildRequestContext_(request, requestId, now) {
    return {
      requestId: requestId,
      currentText: request.text == null ? '' : String(request.text),
      hasImage: Boolean(request.image),
      now: toIsoStringInTokyo(now)
    };
  }

  function buildChatReplyDedupeKey_(requestId) {
    return 'CHAT_REPLY:' + requestId;
  }

  function dedupeStrings_(values) {
    var seen = {};
    var result = [];
    values.forEach(function(value) {
      if (!value || seen[value]) {
        return;
      }
      seen[value] = true;
      result.push(value);
    });
    return result;
  }

  function createValidationError_(message, userMessage) {
    return new AppError({
      code: 'VALIDATION_REQUEST_INVALID',
      message: message,
      userMessage: userMessage || message,
      retryable: false,
      retryStrategy: 'NONE',
      httpStatus: 400
    });
  }

  function assertWebAccess_() {
    var ownerEmail = '';
    var activeEmail = '';

    try {
      ownerEmail = String(
        PropertiesService.getScriptProperties().getProperty(APP_CONSTANTS.PROPERTY_KEYS.OWNER_EMAIL) || ''
      ).toLowerCase();
    } catch (error) {
      ownerEmail = '';
    }

    try {
      activeEmail = String(Session.getActiveUser().getEmail() || '').toLowerCase();
    } catch (error) {
      activeEmail = '';
    }

    if (ownerEmail && activeEmail && ownerEmail !== activeEmail) {
      throw createAppError('ACCESS_NOT_ALLOWED', 'The active user is not allowed to open this web app.');
    }
    return true;
  }

  function createHtmlTemplate_(fileName) {
    try {
      return HtmlService.createTemplateFromFile(fileName);
    } catch (error) {
      var fallbackName = String(fileName).split('/').pop();
      return HtmlService.createTemplateFromFile(fallbackName);
    }
  }

  function includePartial_(fileName) {
    try {
      return HtmlService.createHtmlOutputFromFile(fileName).getContent();
    } catch (error) {
      var fallbackName = String(fileName).split('/').pop();
      return HtmlService.createHtmlOutputFromFile(fallbackName).getContent();
    }
  }

  function toSafeInlineJson_(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  return {
    doGet: doGet,
    getInitialState: getInitialState,
    loadMessages: loadMessages,
    sendChat: sendChat,
    getRequestStatus: getRequestStatus,
    includePartial_: includePartial_,
    __test: {
      computeRetryAfterSeconds: computeRetryAfterSeconds_,
      toSafeInlineJson: toSafeInlineJson_
    }
  };
})();

function includePartial_(fileName) {
  return WebController.includePartial_(fileName);
}

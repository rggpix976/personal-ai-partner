function runA4ChatGeminiTests() {
  var results = {
    passes: [],
    failures: []
  };

  function test(name, callback) {
    try {
      callback();
      results.passes.push(name);
    } catch (error) {
      results.failures.push({
        name: name,
        message: error && error.message ? error.message : String(error)
      });
    }
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed.');
    }
  }

  function expectThrows(name, callback, expectedCode) {
    test(name, function() {
      var thrown = null;
      try {
        callback();
      } catch (error) {
        thrown = error;
      }
      assert(thrown != null, 'Expected callback to throw.');
      if (expectedCode) {
        assert(thrown.code === expectedCode, 'Expected code ' + expectedCode + ' but got ' + thrown.code);
      }
    });
  }

  test('completed ChatResult structure', function() {
    var result = {
      ok: true,
      status: 'completed',
      requestId: '11111111-1111-4111-8111-111111111111',
      userMessage: {
        messageId: '22222222-2222-4222-8222-222222222222',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:00+09:00',
        role: 'user',
        messageType: 'text',
        text: 'Hi',
        image: null,
        status: 'accepted',
        error: null
      },
      assistantMessage: {
        messageId: '33333333-3333-4333-8333-333333333333',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:02+09:00',
        role: 'assistant',
        messageType: 'text',
        text: 'Hello',
        image: null,
        status: 'completed',
        error: null
      },
      retryAfterSeconds: null,
      error: null,
      warnings: []
    };
    assert(result.ok === true && result.status === 'completed', 'Completed result should be successful.');
    assert(Array.isArray(result.warnings), 'Warnings must be an array.');
    assert(result.userMessage && result.assistantMessage, 'Completed result requires both messages.');
  });

  test('queued ChatResult structure', function() {
    var result = {
      ok: true,
      status: 'queued',
      requestId: '11111111-1111-4111-8111-111111111111',
      userMessage: {
        messageId: '22222222-2222-4222-8222-222222222222',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:00+09:00',
        role: 'user',
        messageType: 'text',
        text: 'Hi',
        image: null,
        status: 'accepted',
        error: null
      },
      assistantMessage: null,
      retryAfterSeconds: 60,
      error: null,
      warnings: ['Retrying']
    };
    assert(result.ok === true && result.status === 'queued', 'Queued result should be successful.');
    assert(result.retryAfterSeconds >= 1, 'Queued result needs retryAfterSeconds.');
    assert(Array.isArray(result.warnings), 'Warnings must be an array.');
  });

  test('failed ChatResult structure', function() {
    var errorDto = createAppError('GEMINI_AUTH_FAILED', 'bad auth').toUserDto();
    var result = {
      ok: false,
      status: 'failed',
      requestId: '11111111-1111-4111-8111-111111111111',
      userMessage: null,
      assistantMessage: null,
      retryAfterSeconds: null,
      error: errorDto,
      warnings: []
    };
    assert(result.ok === false && result.status === 'failed', 'Failed result should not be successful.');
    assert(result.error.code === 'GEMINI_AUTH_FAILED', 'Failed result should expose the error DTO.');
    assert(Array.isArray(result.warnings), 'Warnings must be an array.');
  });

  test('image metadata validation accepts supported temp file flow', function() {
    var image = {
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      tempFileId: 'temp-file-id'
    };
    assert(ImageService.validateImageMetadata(image) === true, 'Temp-file-backed image should validate.');
  });

  expectThrows('image metadata validation rejects unsupported MIME type', function() {
    ImageService.validateImageMetadata({
      name: 'photo.gif',
      mimeType: 'image/gif',
      base64: 'Zm9v'
    });
  }, 'VALIDATION_IMAGE_UNSUPPORTED');

  test('Gemini error normalization rate limit', function() {
    var error = GeminiClient.__test.mapHttpError(429, {
      error: {
        message: 'Rate limit exceeded.'
      }
    });
    assert(error.code === 'GEMINI_RATE_LIMIT', '429 should map to GEMINI_RATE_LIMIT.');
    assert(error.retryable === true, 'Rate limit should be retryable.');
  });

  test('Gemini error normalization auth failure', function() {
    var error = GeminiClient.__test.mapHttpError(403, {
      error: {
        message: 'Permission denied.'
      }
    });
    assert(error.code === 'GEMINI_AUTH_FAILED', '403 should map to GEMINI_AUTH_FAILED.');
    assert(error.retryable === false, 'Auth failures should not be retryable.');
  });

  test('Gemini diary structured schema requires array fields', function() {
    var schema = GeminiClient.__test.getStructuredResponseSchema('diary-entry');

    assert(schema.type === 'object', 'Diary schema must be an object.');
    assert(schema.additionalProperties === false, 'Diary schema must reject additional properties.');
    assert(schema.properties.partnerWorldEvents.type === 'array', 'partnerWorldEvents must be an array.');
    assert(schema.properties.thingsToRemember.type === 'array', 'thingsToRemember must be an array.');
    assert(schema.properties.unresolvedFollowUps.type === 'array', 'unresolvedFollowUps must be an array.');
    assert(
      schema.required.indexOf('partnerWorldEvents') !== -1,
      'partnerWorldEvents must be required.'
    );

    var body = GeminiClient.__test.buildRequestBody({
      systemInstruction: 'test',
      contents: [{
        role: 'user',
        parts: [{ text: 'test' }]
      }]
    }, null, {
      responseMimeType: 'application/json',
      responseJsonSchema: schema
    });

    assert(
      body.generationConfig.responseMimeType === 'application/json',
      'Structured response MIME type must be application/json.'
    );
    assert(
      body.generationConfig.responseJsonSchema === schema,
      'Structured response schema must be included in the Gemini request.'
    );
  });

  test('duplicate request helper yields positive retry seconds', function() {
    var seconds = ChatService.__test.computeRetryAfterSeconds({
      nextAttemptAt: '2099-01-01T00:00:10+09:00'
    });
    assert(seconds >= 1, 'Retry delay should be positive.');
  });

  test('in-flight duplicate warning maps processing event to queued status', function() {
    var warnings = ChatService.__test.buildInFlightWarnings({
      status: 'PROCESSING'
    });
    assert(warnings.length === 1, 'Processing event should produce one warning.');
    assert(warnings[0].indexOf('already in progress') !== -1, 'Processing warning should mention in-progress work.');
  });

  test('processing event returns queued result from user-message state helper', function() {
    var originalSheetRepository = SheetRepository;
    SheetRepository = {
      getConversationByRequestId: function(requestId) {
        assert(requestId === '11111111-1111-4111-8111-111111111111', 'RequestId should be forwarded.');
        return {
          requestId: requestId,
          userMessage: {
            messageId: '22222222-2222-4222-8222-222222222222',
            requestId: requestId,
            createdAt: '2026-07-06T10:00:00+09:00',
            role: 'user',
            messageType: 'text',
            text: 'Hi',
            image: null,
            status: 'accepted',
            error: null
          },
          assistantMessage: null
        };
      },
      getRows: function() {
        return [{
          event_id: '33333333-3333-4333-8333-333333333333',
          event_type: 'CHAT_REPLY',
          dedupe_key: 'CHAT_REPLY:11111111-1111-4111-8111-111111111111',
          payload_json: {
            requestId: '11111111-1111-4111-8111-111111111111'
          },
          status: 'PROCESSING',
          attempt_count: 0,
          next_attempt_at: null,
          updated_at: '2026-07-06T10:00:01+09:00',
          last_error_code: null,
          last_error_message: null
        }];
      }
    };
    try {
      var state = ChatService.__test.ensureUserMessageState({
        requestId: '11111111-1111-4111-8111-111111111111',
        text: 'Hi',
        image: null
      }, {
        requestId: '11111111-1111-4111-8111-111111111111',
        now: '2026-07-06T10:00:00+09:00'
      }, null);
      assert(state.result.status === 'queued', 'Processing event should short-circuit to queued.');
      assert(state.result.assistantMessage === null, 'Processing event should not fabricate an assistant message.');
    } finally {
      SheetRepository = originalSheetRepository;
    }
  });

  test('completed image request resend does not prepare image again', function() {
    var originalLockManager = LockManager;
    var originalSheetRepository = SheetRepository;
    var originalPropertiesService = PropertiesService;
    var originalConfigRepository = ConfigRepository;
    var originalImageService = ImageService;
    var prepareCalls = 0;
    LockManager = {
      withScriptLock: function(_, callback) {
        return callback();
      }
    };
    PropertiesService = {
      getScriptProperties: function() {
        return {
          getProperties: function() {
            return {
              GEMINI_API_KEY: 'stub',
              OWNER_EMAIL: 'owner@example.com',
              APP_ENV: 'test',
              SPREADSHEET_ID: 'sheet',
              DIARY_DOC_ID: 'doc',
              TEMP_FOLDER_ID: 'temp',
              BACKUP_FOLDER_ID: 'backup',
              SCHEMA_VERSION: APP_CONSTANTS.SCHEMA_VERSION
            };
          }
        };
      }
    };
    SheetRepository = {
      ensureDefaultUserState: function() {},
      getConversationByRequestId: function() {
        return {
          requestId: '11111111-1111-4111-8111-111111111111',
          userMessage: {
            messageId: '22222222-2222-4222-8222-222222222222',
            requestId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-07-06T10:00:00+09:00',
            role: 'user',
            messageType: 'image',
            text: 'What is this?',
            image: {
              name: 'photo.jpg',
              mimeType: 'image/jpeg',
              summary: 'cat'
            },
            status: 'accepted',
            error: null
          },
          assistantMessage: {
            messageId: '33333333-3333-4333-8333-333333333333',
            requestId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-07-06T10:00:02+09:00',
            role: 'assistant',
            messageType: 'text',
            text: 'A cat.',
            image: null,
            status: 'completed',
            error: null
          }
        };
      },
      getRows: function() {
        return [];
      }
    };
    ConfigRepository = {
      getByKey: function(key) {
        if (key === 'MAX_USER_TEXT_CHARS') {
          return { value: 4000 };
        }
        if (key === 'IMAGE_MAX_BYTES') {
          return { value: 4194304 };
        }
        return null;
      }
    };
    ImageService = Object.assign({}, ImageService, {
      prepareGeminiInput: function() {
        prepareCalls += 1;
        throw new Error('prepareGeminiInput should not be called for completed duplicate requests.');
      }
    });
    try {
      var result = ChatService.send({
        requestId: '11111111-1111-4111-8111-111111111111',
        text: 'What is this?',
        clientTimestamp: '2026-07-06T10:00:00+09:00',
        image: {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          base64: 'Zm9v'
        }
      }, {
        requestId: '11111111-1111-4111-8111-111111111111',
        now: '2026-07-06T10:00:00+09:00'
      });
      assert(result.status === 'completed', 'Completed duplicate requests should short-circuit.');
      assert(prepareCalls === 0, 'Image preparation should not run for completed duplicates.');
    } finally {
      LockManager = originalLockManager;
      SheetRepository = originalSheetRepository;
      PropertiesService = originalPropertiesService;
      ConfigRepository = originalConfigRepository;
      ImageService = originalImageService;
    }
  });

  test('processing image request resend does not create a new temp file', function() {
    var originalLockManager = LockManager;
    var originalSheetRepository = SheetRepository;
    var originalPropertiesService = PropertiesService;
    var originalConfigRepository = ConfigRepository;
    var originalImageService = ImageService;
    var prepareCalls = 0;
    LockManager = {
      withScriptLock: function(_, callback) {
        return callback();
      }
    };
    PropertiesService = {
      getScriptProperties: function() {
        return {
          getProperties: function() {
            return {
              GEMINI_API_KEY: 'stub',
              OWNER_EMAIL: 'owner@example.com',
              APP_ENV: 'test',
              SPREADSHEET_ID: 'sheet',
              DIARY_DOC_ID: 'doc',
              TEMP_FOLDER_ID: 'temp',
              BACKUP_FOLDER_ID: 'backup',
              SCHEMA_VERSION: APP_CONSTANTS.SCHEMA_VERSION
            };
          }
        };
      }
    };
    SheetRepository = {
      ensureDefaultUserState: function() {},
      getConversationByRequestId: function() {
        return {
          requestId: '11111111-1111-4111-8111-111111111111',
          userMessage: {
            messageId: '22222222-2222-4222-8222-222222222222',
            requestId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-07-06T10:00:00+09:00',
            role: 'user',
            messageType: 'image',
            text: 'What is this?',
            image: {
              name: 'photo.jpg',
              mimeType: 'image/jpeg',
              summary: 'cat'
            },
            status: 'accepted',
            error: null
          },
          assistantMessage: null
        };
      },
      getRows: function() {
        return [{
          event_id: '33333333-3333-4333-8333-333333333333',
          event_type: 'CHAT_REPLY',
          dedupe_key: 'CHAT_REPLY:11111111-1111-4111-8111-111111111111',
          payload_json: {
            requestId: '11111111-1111-4111-8111-111111111111'
          },
          status: 'PROCESSING',
          attempt_count: 0,
          next_attempt_at: null,
          updated_at: '2026-07-06T10:00:01+09:00',
          last_error_code: null,
          last_error_message: null
        }];
      }
    };
    ConfigRepository = {
      getByKey: function(key) {
        if (key === 'MAX_USER_TEXT_CHARS') {
          return { value: 4000 };
        }
        if (key === 'IMAGE_MAX_BYTES') {
          return { value: 4194304 };
        }
        return null;
      }
    };
    ImageService = Object.assign({}, ImageService, {
      prepareGeminiInput: function() {
        prepareCalls += 1;
        throw new Error('prepareGeminiInput should not run for in-flight duplicates.');
      }
    });
    try {
      var result = ChatService.send({
        requestId: '11111111-1111-4111-8111-111111111111',
        text: 'What is this?',
        clientTimestamp: '2026-07-06T10:00:00+09:00',
        image: {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          base64: 'Zm9v'
        }
      }, {
        requestId: '11111111-1111-4111-8111-111111111111',
        now: '2026-07-06T10:00:00+09:00'
      });
      assert(result.status === 'queued', 'In-flight duplicate requests should return queued status.');
      assert(prepareCalls === 0, 'Image preparation should not run for in-flight duplicates.');
    } finally {
      LockManager = originalLockManager;
      SheetRepository = originalSheetRepository;
      PropertiesService = originalPropertiesService;
      ConfigRepository = originalConfigRepository;
      ImageService = originalImageService;
    }
  });

  test('chat prompt includes latest current user turn', function() {
    var contents = ChatService.__test.buildContents({
      recentMessages: [{
        messageId: '22222222-2222-4222-8222-222222222222',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:00+09:00',
        role: 'user',
        messageType: 'image',
        text: '[Image] cat photo',
        image: {
          name: 'cat.jpg',
          mimeType: 'image/jpeg',
          summary: 'cat photo'
        },
        status: 'accepted',
        error: null
      }]
    }, {
      requestId: '11111111-1111-4111-8111-111111111111',
      text: 'What is in this image?'
    }, {
      storedImage: {
        name: 'cat.jpg',
        mimeType: 'image/jpeg',
        summary: 'cat photo'
      }
    });
    assert(contents.length === 1, 'Current request should collapse to one latest user turn.');
    assert(contents[0].role === 'user', 'Current turn should be sent as a user role.');
    assert(contents[0].parts[0].text === 'What is in this image?', 'Current user text should be preserved.');
  });

  test('context builder appends current user message after prior messages only', function() {
    var originalSheetRepository = SheetRepository;
    SheetRepository = {
      listMessagesBefore: function(messageId, limit) {
        assert(messageId === '33333333-3333-4333-8333-333333333333', 'Context should anchor on current user message.');
        assert(limit === 2, 'Context should reserve one slot for the current user message.');
        return [{
          messageId: '11111111-1111-4111-8111-111111111111',
          requestId: 'r-1',
          createdAt: '2026-07-06T09:58:00+09:00',
          role: 'assistant',
          messageType: 'text',
          text: 'Earlier',
          image: null,
          status: 'completed',
          error: null
        }, {
          messageId: '22222222-2222-4222-8222-222222222222',
          requestId: 'r-2',
          createdAt: '2026-07-06T09:59:00+09:00',
          role: 'user',
          messageType: 'text',
          text: 'Previous',
          image: null,
          status: 'accepted',
          error: null
        }];
      },
      listActiveMemories: function() {
        return [];
      }
    };
    try {
      var context = ContextService.buildChatContext({
        now: '2026-07-06T10:00:00+09:00',
        currentUserMessage: {
          messageId: '33333333-3333-4333-8333-333333333333',
          requestId: 'r-3',
          createdAt: '2026-07-06T10:00:00+09:00',
          role: 'user',
          messageType: 'text',
          text: 'Current',
          image: null,
          status: 'accepted',
          error: null
        }
      });
      assert(context.recentMessages.length === 3, 'Context should contain prior messages plus current user message.');
      assert(context.recentMessages[2].text === 'Current', 'Current user message should be last.');
    } finally {
      SheetRepository = originalSheetRepository;
    }
  });

  test('image summary can be derived from assistant response', function() {
    var summary = ImageService.summarizeFromAssistantText('A small orange cat is sitting on a windowsill and looking outside.');
    assert(summary.indexOf('orange cat') !== -1, 'Assistant-based summary should preserve image meaning.');
    assert(summary.length <= 150, 'Assistant-based summary should stay bounded.');
  });

  test('race after prepare cleans up only newly created temp files', function() {
    var originalLockManager = LockManager;
    var originalSheetRepository = SheetRepository;
    var originalPropertiesService = PropertiesService;
    var originalConfigRepository = ConfigRepository;
    var originalImageService = ImageService;
    var prepareCalls = 0;
    var cleanupCalls = 0;
    var conversationReadCount = 0;
    LockManager = {
      withScriptLock: function(_, callback) {
        return callback();
      }
    };
    PropertiesService = {
      getScriptProperties: function() {
        return {
          getProperties: function() {
            return {
              GEMINI_API_KEY: 'stub',
              OWNER_EMAIL: 'owner@example.com',
              APP_ENV: 'test',
              SPREADSHEET_ID: 'sheet',
              DIARY_DOC_ID: 'doc',
              TEMP_FOLDER_ID: 'temp',
              BACKUP_FOLDER_ID: 'backup',
              SCHEMA_VERSION: APP_CONSTANTS.SCHEMA_VERSION
            };
          }
        };
      }
    };
    ConfigRepository = {
      getByKey: function(key) {
        if (key === 'MAX_USER_TEXT_CHARS') {
          return { value: 4000 };
        }
        if (key === 'IMAGE_MAX_BYTES') {
          return { value: 4194304 };
        }
        return null;
      }
    };
    SheetRepository = {
      ensureDefaultUserState: function() {},
      getConversationByRequestId: function() {
        conversationReadCount += 1;
        if (conversationReadCount === 1) {
          return {
            requestId: '11111111-1111-4111-8111-111111111111',
            userMessage: null,
            assistantMessage: null
          };
        }
        return {
          requestId: '11111111-1111-4111-8111-111111111111',
          userMessage: {
            messageId: '22222222-2222-4222-8222-222222222222',
            requestId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-07-06T10:00:00+09:00',
            role: 'user',
            messageType: 'image',
            text: 'What is this?',
            image: {
              name: 'photo.jpg',
              mimeType: 'image/jpeg',
              summary: 'cat'
            },
            status: 'accepted',
            error: null
          },
          assistantMessage: {
            messageId: '33333333-3333-4333-8333-333333333333',
            requestId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-07-06T10:00:02+09:00',
            role: 'assistant',
            messageType: 'text',
            text: 'A cat.',
            image: null,
            status: 'completed',
            error: null
          }
        };
      },
      getRows: function() {
        return [];
      }
    };
    ImageService = Object.assign({}, ImageService, {
      prepareGeminiInput: function() {
        prepareCalls += 1;
        return {
          queueImage: {
            tempFileId: 'new-temp'
          },
          cleanupTarget: {
            tempFileId: 'new-temp',
            createdByCurrentRequest: true
          },
          storedImage: {
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            summary: 'placeholder'
          }
        };
      },
      cleanupPreparedImage: function(preparedImage) {
        if (preparedImage.cleanupTarget.createdByCurrentRequest) {
          cleanupCalls += 1;
          return true;
        }
        return false;
      }
    });
    try {
      var result = ChatService.send({
        requestId: '11111111-1111-4111-8111-111111111111',
        text: 'What is this?',
        clientTimestamp: '2026-07-06T10:00:00+09:00',
        image: {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          base64: 'Zm9v'
        }
      }, {
        requestId: '11111111-1111-4111-8111-111111111111',
        now: '2026-07-06T10:00:00+09:00'
      });
      assert(result.status === 'completed', 'Race should resolve to the existing completed result.');
      assert(prepareCalls === 1, 'Prepare should have run before the race became visible.');
      assert(cleanupCalls === 1, 'Newly created temp file should be cleaned on race short-circuit.');
    } finally {
      LockManager = originalLockManager;
      SheetRepository = originalSheetRepository;
      PropertiesService = originalPropertiesService;
      ConfigRepository = originalConfigRepository;
      ImageService = originalImageService;
    }
  });

  test('non-retryable Gemini error can be persisted as DEAD event', function() {
    var originalLockManager = LockManager;
    var originalSheetRepository = SheetRepository;
    var updatedEvent = null;
    LockManager = {
      withScriptLock: function(_, callback) {
        return callback();
      }
    };
    SheetRepository = {
      updateEvent: function(eventId, patch) {
        updatedEvent = {
          eventId: eventId,
          patch: patch
        };
      }
    };
    try {
      var result = ChatService.__test.markDeadAndFail({
        requestId: '11111111-1111-4111-8111-111111111111',
        now: '2026-07-06T10:00:00+09:00'
      }, {
        messageId: '22222222-2222-4222-8222-222222222222',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:00+09:00',
        role: 'user',
        messageType: 'text',
        text: 'Hi',
        image: null,
        status: 'accepted',
        error: null
      }, createAppError('GEMINI_AUTH_FAILED', 'Permission denied.'), {
        eventId: '33333333-3333-4333-8333-333333333333',
        attemptCount: 0
      });
      assert(updatedEvent != null, 'DEAD event update should be persisted.');
      assert(updatedEvent.patch.status === 'DEAD', 'Event should be marked DEAD.');
      assert(updatedEvent.patch.lastError.code === 'GEMINI_AUTH_FAILED', 'Last error code should be stored.');
      assert(result.status === 'failed', 'Non-retryable failures should return failed status.');
    } finally {
      LockManager = originalLockManager;
      SheetRepository = originalSheetRepository;
    }
  });

  test('non-retryable Gemini errors remain non-retryable for dead-event persistence flow', function() {
    var error = GeminiClient.__test.mapHttpError(404, {
      error: {
        message: 'Model not found.'
      }
    });
    assert(error.code === 'GEMINI_MODEL_UNAVAILABLE', '404 model errors should map to model unavailable.');
    assert(error.retryable === false, 'Model unavailable should be non-retryable.');
  });

  test('image summary truncates to 150 chars', function() {
    var summary = ImageService.buildImageSummary({
      name: 'photo.jpg'
    }, new Array(200).join('a'));
    assert(summary.length <= 150, 'Summary should be bounded.');
  });

  test('assistant response summary is written back to the user image message', function() {
    var originalSheetRepository = SheetRepository;
    var patchedMessage = null;
    SheetRepository = {
      updateConversationMessage: function(messageId, patch) {
        patchedMessage = {
          messageId: messageId,
          patch: patch
        };
        return {
          messageId: messageId,
          image: patch.image
        };
      }
    };
    try {
      var updated = ChatService.__test.updateUserImageSummary({
        messageId: '22222222-2222-4222-8222-222222222222',
        image: {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          summary: 'placeholder'
        }
      }, 'A brown dog is running across a grassy field.');
      assert(patchedMessage != null, 'Image summary update should hit the repository.');
      assert(patchedMessage.patch.image.summary.indexOf('brown dog') !== -1, 'Saved summary should come from assistant text.');
      assert(updated.image.summary.indexOf('brown dog') !== -1, 'Updated message should expose the new summary.');
    } finally {
      SheetRepository = originalSheetRepository;
    }
  });

  test('existing tempFileId is not trashed on cleanupAfterSuccess', function() {
    var originalDriveTempRepository = DriveTempRepository;
    var trashed = 0;
    DriveTempRepository = {
      trashTempImage: function() {
        trashed += 1;
      }
    };
    try {
      var result = ImageService.cleanupAfterSuccess({
        cleanupTarget: {
          tempFileId: 'existing-temp',
          createdByCurrentRequest: false
        }
      });
      assert(result === false, 'Existing temp files should not be cleaned by another request.');
      assert(trashed === 0, 'Existing temp files should not be trashed.');
    } finally {
      DriveTempRepository = originalDriveTempRepository;
    }
  });

  test('prepareGeminiInput marks existing tempFileId as not created by current request', function() {
    var originalDriveTempRepository = DriveTempRepository;
    var originalConfigRepository = ConfigRepository;
    ConfigRepository = {
      getByKey: function(key) {
        if (key === 'IMAGE_MAX_BYTES') {
          return { value: 4194304 };
        }
        if (key === 'TEMP_IMAGE_TTL_HOURS') {
          return { value: 24 };
        }
        return null;
      }
    };
    DriveTempRepository = {
      getTempImageData: function(tempFileId) {
        assert(tempFileId === 'existing-temp', 'Existing tempFileId should be read.');
        return {
          tempFileId: tempFileId,
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          base64: 'Zm9v',
          sizeBytes: 3
        };
      },
      createTempImage: function() {
        throw new Error('createTempImage should not run when an existing tempFileId is supplied.');
      },
      trashTempImage: function() {
        throw new Error('trashTempImage should not be called during prepare.');
      }
    };
    try {
      var prepared = ImageService.prepareGeminiInput({
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        tempFileId: 'existing-temp'
      }, {
        now: '2026-07-06T10:00:00+09:00'
      });
      assert(prepared.createdTempFile === false, 'Existing temp file should not be marked as newly created.');
      assert(prepared.cleanupTarget.createdByCurrentRequest === false, 'Existing temp file should not be owned by the current request.');
    } finally {
      DriveTempRepository = originalDriveTempRepository;
      ConfigRepository = originalConfigRepository;
    }
  });

  return results;
}

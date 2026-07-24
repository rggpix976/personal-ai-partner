function runA11CharacterChatIntegrationTests() {
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

  function expectCode(callback, code) {
    var thrown = null;
    try {
      callback();
    } catch (error) {
      thrown = error;
    }
    assert(thrown && thrown.code === code, 'Expected error code ' + code + '.');
    return thrown;
  }

  function withGlobals(overrides, callback) {
    var originals = {};
    Object.keys(overrides).forEach(function(name) {
      originals[name] = globalThis[name];
      globalThis[name] = overrides[name];
    });
    try {
      return callback();
    } finally {
      Object.keys(overrides).forEach(function(name) {
        globalThis[name] = originals[name];
      });
    }
  }

  test('non-character notices are neutral product UI copy', function() {
    var product = CharacterStatusNoticeService.forRoute('PRODUCT_INFO');
    var admin = CharacterStatusNoticeService.forRoute('ADMIN_OOC');
    assert(product.title === 'このアプリについて', 'Product notice title is invalid.');
    assert(product.message.indexOf('AI') !== -1, 'Product notice must disclose AI use.');
    assert(product.message.indexOf('推し本人の発言ではなく') !== -1, 'Product notice must identify product voice.');
    assert(admin.message.indexOf('アプリの管理情報') !== -1, 'Admin notice must remain product voice.');
  });

  test('chat entry signals cover safety admin and unavailable external operations', function() {
    [
      '死にたい。今ひとりや。',
      'I want to kill myself.',
      '薬を大量に飲んだ'
    ].forEach(function(text) {
      assert(
        CharacterChatContextService.__test
          .deriveClassificationSignals(text).safetyRequired === true,
        'Urgent safety text did not activate the safety route: ' + text
      );
    });
    [
      'Apps Scriptのトリガーが動いてるか確認して',
      'このアプリの認証状態を見せて',
      'Show the app queue status.'
    ].forEach(function(text) {
      assert(
        CharacterChatContextService.__test
          .deriveClassificationSignals(text).adminRequest === true,
        'Admin status text did not activate the admin route: ' + text
      );
    });
    [
      'このメールを送って',
      'スマホでアラームを設定して',
      'Open the browser for me.'
    ].forEach(function(text) {
      assert(
        CharacterChatContextService.__test
          .deriveClassificationSignals(text).capabilityUnavailable === true,
        'Unavailable operation did not activate the capability route: ' + text
      );
    });
    [
      'メールの送り方を教えて',
      'AIのニュースについて話そう',
      '「このメールを送って」を英訳して'
    ].forEach(function(text) {
      var signals = CharacterChatContextService.__test
        .deriveClassificationSignals(text);
      assert(
        signals.safetyRequired === false &&
          signals.adminRequest === false &&
          signals.capabilityUnavailable === false,
        'Ordinary or attributed content was over-classified: ' + text
      );
    });
  });

  test('enforced chat context excludes legacy authority and memory', function() {
    var originalCharacterContextService = CharacterContextService;
    var originalSheetRepository = SheetRepository;
    var originalConfigRepository = ConfigRepository;
    var captured = null;
    CharacterContextService = {
      buildActive: function(input) {
        captured = input;
        return { issued: true };
      }
    };
    SheetRepository = {
      listMessagesBefore: function() {
        return [{
          messageId: '11111111-1111-4111-8111-111111111111',
          requestId: '22222222-2222-4222-8222-222222222222',
          role: 'assistant',
          messageType: 'text',
          text: '前の会話',
          model: 'legacy-model',
          inputTokens: 123,
          characterApproval: null
        }];
      }
    };
    ConfigRepository = {
      getByKey: function() {
        return { value: 20 };
      }
    };
    try {
      var result = CharacterChatContextService.build({
        currentTime: '2026-07-24T10:00:00+09:00',
        currentUserMessage: {
          messageId: '33333333-3333-4333-8333-333333333333',
          role: 'user',
          messageType: 'image',
          text: 'これ見て',
          image: {
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            summary: 'upload'
          }
        },
        hasImage: true
      });
      assert(result.issued === true, 'Context result was not returned.');
      assert(captured.surface === 'chat', 'Character context scope must be chat.');
      assert(captured.memories.length === 0, 'Legacy memories must not enter PR4 context.');
      assert(captured.userFacts.length === 0, 'Unintegrated user facts must remain empty.');
      assert(captured.recentMessages.length === 2, 'Bounded history and current turn are required.');
      assert(!Object.prototype.hasOwnProperty.call(captured.recentMessages[0], 'messageId'), 'Operational message ID leaked into context.');
      assert(!Object.prototype.hasOwnProperty.call(captured.recentMessages[0], 'model'), 'Legacy model metadata leaked into context.');
      assert(captured.realWorldObservations.length === 1, 'Current image evidence marker is required.');
      assert(captured.currentRequest.type === 'image', 'Current image state is missing.');
    } finally {
      CharacterContextService = originalCharacterContextService;
      SheetRepository = originalSheetRepository;
      ConfigRepository = originalConfigRepository;
    }
  });

  test('legacy proactive speech keeps partner role while operational rows are excluded', function() {
    var proactive = CharacterChatContextService.__test
      .normalizeHistoricalMessage({
        role: 'system',
        messageType: 'proactive',
        text: '今日はどないしてるん。'
      });
    var operational = CharacterChatContextService.__test
      .normalizeHistoricalMessage({
        role: 'system',
        messageType: 'error',
        text: 'Internal queue failure.'
      });
    assert(
      proactive && proactive.role === 'assistant',
      'Partner proactive speech must remain on the assistant side of history.'
    );
    assert(
      operational === null,
      'Operational system rows must not enter character conversation history.'
    );
  });

  test('enforced chat context passes the real typed evidence boundary', function() {
    var originalCharacterProfileService = CharacterProfileService;
    var originalSheetRepository = SheetRepository;
    var originalConfigRepository = ConfigRepository;
    var activePack = CharacterPackService.getActive();
    var profile = JSON.parse(APP_CONSTANTS.CHARACTER.DEFAULT_PROFILE_JSON);
    CharacterProfileService = {
      requireActive: function() {
        return {
          policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
          catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
          profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
          profileRevision: 3,
          characterPackId: activePack.packId,
          characterPackVersion: activePack.packVersion,
          profile: profile
        };
      },
      validateV2: originalCharacterProfileService.validateV2
    };
    SheetRepository = {
      listMessagesBefore: function() {
        return [];
      }
    };
    ConfigRepository = {
      getByKey: function() {
        return { value: 20 };
      }
    };
    try {
      var context = CharacterChatContextService.build({
        currentTime: '2026-07-24T10:00:00+09:00',
        currentUserMessage: {
          messageId: '33333333-3333-4333-8333-333333333333',
          role: 'user',
          messageType: 'image',
          text: 'これ見て',
          image: {
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            summary: 'upload'
          }
        },
        hasImage: true
      });
      CharacterContextService.assertUnclassifiedActive(context, 'chat');
      assert(context.data.currentRequest.type === 'image', 'Typed image request was lost.');
      assert(context.data.recentMessages[0].type === 'image', 'Typed recent image row was lost.');
      assert(context.data.recentMessages[0].summary === 'upload', 'Image summary was not kept as untrusted evidence.');
      assert(
        context.data.realWorldObservations[0].kind === 'user_supplied_image',
        'Real-world image evidence marker was lost.'
      );
    } finally {
      CharacterProfileService = originalCharacterProfileService;
      SheetRepository = originalSheetRepository;
      ConfigRepository = originalConfigRepository;
    }
  });

  test('queued requests cannot cross the legacy and enforced runtime boundary', function() {
    var originalCharacterProfileService = CharacterProfileService;
    CharacterProfileService = {
      inspectRuntime: function() {
        return {
          state: 'legacy',
          runtimeMode: 'legacy'
        };
      }
    };
    try {
      var legacy = ChatService.__test.resolveQueuedRuntime({
        requestId: '11111111-1111-4111-8111-111111111111'
      });
      assert(legacy.mode === 'legacy', 'Unmarked historical events must remain legacy.');
      var thrown = null;
      try {
        ChatService.__test.resolveQueuedRuntime({
          requestId: '11111111-1111-4111-8111-111111111111',
          characterRuntimeMode: 'enforced',
          characterBinding: {}
        });
      } catch (error) {
        thrown = error;
      }
      assert(thrown && thrown.code === 'CHARACTER_CONFIG_CONFLICT', 'Cross-mode queue processing must fail closed.');
      assert(
        thrown.toUserDto().message === CharacterStatusNoticeService.forConfigError().message,
        'Cross-mode failure must use neutral status UI copy.'
      );
    } finally {
      CharacterProfileService = originalCharacterProfileService;
    }
  });

  test('persisted character configuration failures keep neutral UI copy', function() {
    var requestId = '11111111-1111-4111-8111-111111111111';
    withGlobals({
      SheetRepository: {
        getConversationByRequestId: function() {
          return {
            userMessage: {
              messageId: '22222222-2222-4222-8222-222222222222',
              requestId: requestId,
              role: 'user',
              messageType: 'text',
              text: 'こんにちは'
            },
            assistantMessage: null
          };
        },
        getRows: function() {
          return [{
            event_id: '33333333-3333-4333-8333-333333333333',
            event_type: 'CHAT_REPLY',
            dedupe_key: 'CHAT_REPLY:' + requestId,
            payload_json: {
              requestId: requestId
            },
            status: 'DEAD',
            attempt_count: 1,
            updated_at: '2026-07-24T10:00:01+09:00',
            last_error_code: 'CHARACTER_CONFIG_CONFLICT',
            last_error_message: 'Internal runtime binding mismatch.'
          }];
        }
      }
    }, function() {
      var result = ChatService.__test.getExistingRequestResult(requestId);
      assert(result.status === 'failed', 'Persisted configuration error must fail.');
      assert(
        result.error.message ===
          CharacterStatusNoticeService.forConfigError().message,
        'Persisted configuration error exposed non-neutral copy.'
      );
    });
  });

  test('non-character route completes without an assistant row', function() {
    var originalSheetRepository = SheetRepository;
    var updatedEvent = null;
    var assistantWrites = 0;
    var userMessage = {
      messageId: '22222222-2222-4222-8222-222222222222',
      requestId: '11111111-1111-4111-8111-111111111111',
      role: 'user',
      messageType: 'text',
      text: 'このアプリはAIを使ってる？',
      status: 'accepted'
    };
    SheetRepository = {
      getConversationByRequestId: function() {
        return {
          userMessage: userMessage,
          assistantMessage: null
        };
      },
      updateEvent: function(eventId, patch) {
        updatedEvent = { eventId: eventId, patch: patch };
      },
      appendConversation: function() {
        assistantWrites += 1;
      }
    };
    try {
      var result = ChatService.__test.finalizeRouted(
        '11111111-1111-4111-8111-111111111111',
        userMessage,
        {
          eventId: '33333333-3333-4333-8333-333333333333',
          status: 'PROCESSING',
          payload: {
            requestId: '11111111-1111-4111-8111-111111111111',
            userMessageId: userMessage.messageId,
            characterRuntimeMode: 'enforced',
            characterBinding: makeBinding_()
          }
        },
        'PRODUCT_INFO',
        '2026-07-24T10:00:01+09:00'
      );
      assert(result.status === 'routed', 'Product request must return routed status.');
      assert(result.assistantMessage === null, 'Product route must not return an assistant message.');
      assert(assistantWrites === 0, 'Product route must not persist an assistant row.');
      assert(updatedEvent.patch.status === 'DONE', 'Product route event must complete.');
      assert(updatedEvent.patch.payload_json.completionRoute === 'PRODUCT_INFO', 'Route code must be persisted without character text.');
    } finally {
      SheetRepository = originalSheetRepository;
    }
  });

  test('queued routed image remains retryable until event completion is durable', function() {
    var originalImageService = ImageService;
    var originalDriveTempRepository = DriveTempRepository;
    var cleanupCalls = 0;
    var trashCalls = 0;
    ImageService = {
      cleanupAfterSuccess: function() {
        cleanupCalls += 1;
      }
    };
    DriveTempRepository = {
      trashTempImage: function() {
        trashCalls += 1;
      }
    };
    try {
      var payload = {
        image: {
          tempFileId: 'temporary-image-id'
        }
      };
      var preparedImage = {
        createdTempFile: false
      };
      var retained = ChatService.__test.cleanupQueuedImageAfterResult(
        payload,
        preparedImage,
        { status: 'routed', route: 'PRODUCT_INFO' }
      );
      assert(retained === false, 'Routed queued image must be retained for event retry.');
      assert(cleanupCalls === 0 && trashCalls === 0, 'Routed image was deleted before markDone.');

      var cleaned = ChatService.__test.cleanupQueuedImageAfterResult(
        payload,
        preparedImage,
        { status: 'completed' }
      );
      assert(cleaned === true, 'Completed queued image must use normal cleanup.');
      assert(cleanupCalls === 1 && trashCalls === 1, 'Completed image cleanup did not run once.');
    } finally {
      ImageService = originalImageService;
      DriveTempRepository = originalDriveTempRepository;
    }
  });

  test('completed image cleanup failure never changes the reply result', function() {
    var warnings = 0;
    withGlobals({
      ImageService: {
        cleanupAfterSuccess: function() {
          throw createAppError('DRIVE_ERROR', 'Cleanup failed.');
        },
        cleanupPreparedImage: function() {
          throw createAppError('DRIVE_ERROR', 'Prepared cleanup failed.');
        }
      },
      DriveTempRepository: {
        trashTempImage: function() {
          throw createAppError('DRIVE_ERROR', 'Fallback cleanup failed.');
        }
      },
      AppLogger: {
        warn: function() {
          warnings += 1;
        }
      }
    }, function() {
      var cleaned = ChatService.__test.cleanupQueuedImageAfterResult(
        {
          requestId: '11111111-1111-4111-8111-111111111111',
          image: {
            tempFileId: 'temporary-image-id'
          }
        },
        {
          createdTempFile: false
        },
        {
          status: 'completed'
        }
      );
      assert(cleaned === false, 'Cleanup failure must be reported as non-critical.');
      assert(
        ChatService.__test.cleanupPreparedImageIfOwned({
          createdTempFile: true
        }) === false,
        'Prepared image cleanup failure must remain non-critical.'
      );
      assert(warnings === 3, 'All cleanup failures should remain observable.');
    });
  });

  test('usage accounting failure cannot undo a durable approved reply', function() {
    var eventPatch = null;
    var warningCount = 0;
    withGlobals({
      SheetRepository: {
        appendConversation: function(message) {
          return {
            messageId: message.messageId,
            requestId: message.requestId,
            createdAt: message.createdAt,
            role: message.role,
            messageType: message.messageType,
            text: message.text,
            image: null,
            status: message.status,
            replyToMessageId: message.replyToMessageId,
            characterApproval: message.characterApproval
          };
        },
        updateUserState: function() {},
        updateEvent: function(_, patch) {
          eventPatch = patch;
        },
        incrementUsageDaily: function() {
          throw createAppError('STORAGE_WRITE_FAILED', 'Usage write failed.');
        }
      },
      AppLogger: {
        warn: function() {
          warningCount += 1;
        }
      }
    }, function() {
      var result = ChatService.__test.persistApprovedChat({
        requestId: '11111111-1111-4111-8111-111111111111',
        now: '2026-07-24T10:00:01+09:00',
        userMessage: {
          messageId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          text: 'こんにちは'
        },
        event: {
          eventId: '33333333-3333-4333-8333-333333333333'
        },
        payload: {
          text: '今日はどないしたん。'
        },
        artifact: makeArtifact_('CHAT_TEXT_SYNC', 'generated'),
        session: makeSession_(),
        markEventDone: true
      });
      assert(result.status === 'completed', 'Durable reply must still complete.');
      assert(eventPatch && eventPatch.status === 'DONE', 'Event must be DONE before usage accounting.');
      assert(warningCount === 1, 'Usage failure should be logged once.');
    });
  });

  test('a stale send failure cannot downgrade an already DONE reply', function() {
    var updates = 0;
    var requestId = '11111111-1111-4111-8111-111111111111';
    var userMessage = {
      messageId: '22222222-2222-4222-8222-222222222222',
      requestId: requestId,
      role: 'user',
      messageType: 'text',
      text: 'こんにちは',
      characterApproval: null
    };
    var assistantMessage = {
      messageId: '44444444-4444-4444-8444-444444444444',
      requestId: requestId,
      role: 'assistant',
      messageType: 'text',
      text: '今日はどないしたん。',
      characterApproval: null
    };
    var persistedEvent = {
      eventId: '33333333-3333-4333-8333-333333333333',
      status: 'DONE',
      payload: {
        requestId: requestId,
        userMessageId: userMessage.messageId,
        characterRuntimeMode: 'legacy'
      }
    };
    withGlobals({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getEventById: function() {
          return persistedEvent;
        },
        getConversationByRequestId: function() {
          return {
            userMessage: userMessage,
            assistantMessage: assistantMessage
          };
        },
        updateEvent: function() {
          updates += 1;
        }
      }
    }, function() {
      var staleEvent = {
        eventId: persistedEvent.eventId,
        status: 'PROCESSING',
        payload: persistedEvent.payload
      };
      var failed = createAppError('UNKNOWN', 'Late failure.');
      var deadResult = ChatService.__test.markDeadAndFail({
        requestId: requestId,
        now: '2026-07-24T10:00:02+09:00'
      }, userMessage, failed, staleEvent);
      assert(deadResult.status === 'completed', 'DONE reply must win over stale failure.');

      var retryResult = ChatService.__test.queueRetry({
        requestId: requestId,
        now: '2026-07-24T10:00:02+09:00'
      }, userMessage, null, failed, staleEvent);
      assert(retryResult.status === 'completed', 'DONE reply must win over stale retry.');
      assert(updates === 0, 'No transition may run after DONE.');
    });
  });

  test('completed enforced rows must match their immutable event approval binding', function() {
    var userMessage = {
      messageId: '22222222-2222-4222-8222-222222222222',
      role: 'user',
      messageType: 'text',
      text: 'こんにちは',
      characterApproval: null
    };
    var assistantMessage = {
      messageId: '44444444-4444-4444-8444-444444444444',
      role: 'assistant',
      messageType: 'text',
      text: 'どないしたん。',
      replyToMessageId: userMessage.messageId,
      characterApproval: makeArtifact_('CHAT_TEXT_QUEUED', 'generated')
    };
    var event = {
      status: 'DONE',
      payload: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userMessageId: userMessage.messageId,
        characterRuntimeMode: 'enforced',
        characterBinding: makeBinding_()
      }
    };
    assert(
      ChatService.assertPersistedPair(
        { userMessage: userMessage, assistantMessage: assistantMessage },
        event
      ) === true,
      'Matching enforced text pair should remain readable.'
    );

    var missingApproval = JSON.parse(JSON.stringify(assistantMessage));
    missingApproval.characterApproval = null;
    expectCode(function() {
      ChatService.assertPersistedPair(
        { userMessage: userMessage, assistantMessage: missingApproval },
        event
      );
    }, 'STORAGE_DATA_CORRUPTED');

    var staleApproval = JSON.parse(JSON.stringify(assistantMessage));
    staleApproval.characterApproval.profileRevision += 1;
    expectCode(function() {
      ChatService.assertPersistedPair(
        { userMessage: userMessage, assistantMessage: staleApproval },
        event
      );
    }, 'STORAGE_DATA_CORRUPTED');

    var wrongSurface = JSON.parse(JSON.stringify(assistantMessage));
    wrongSurface.characterApproval.surface = 'PROACTIVE_AI';
    expectCode(function() {
      ChatService.assertPersistedPair(
        { userMessage: userMessage, assistantMessage: wrongSurface },
        event
      );
    }, 'STORAGE_DATA_CORRUPTED');

    var wrongLink = JSON.parse(JSON.stringify(assistantMessage));
    wrongLink.replyToMessageId = '55555555-5555-4555-8555-555555555555';
    expectCode(function() {
      ChatService.assertPersistedPair(
        { userMessage: userMessage, assistantMessage: wrongLink },
        event
      );
    }, 'STORAGE_DATA_CORRUPTED');
  });

  test('completed enforced image rows require one matching pair approval', function() {
    var approval = makeArtifact_('CHAT_IMAGE', 'rewrite');
    var userMessage = {
      messageId: '22222222-2222-4222-8222-222222222222',
      role: 'user',
      messageType: 'image',
      text: 'これ見て',
      image: {
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        summary: '机の上に皿が写っている。'
      },
      characterApproval: JSON.parse(JSON.stringify(approval))
    };
    var assistantMessage = {
      messageId: '44444444-4444-4444-8444-444444444444',
      role: 'assistant',
      messageType: 'text',
      text: '机の上に皿があるな。',
      replyToMessageId: userMessage.messageId,
      characterApproval: JSON.parse(JSON.stringify(approval))
    };
    var event = {
      status: 'DONE',
      payload: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userMessageId: userMessage.messageId,
        image: {
          tempFileId: 'temp-image',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          expiresAt: '2026-07-25T10:00:00+09:00'
        },
        characterRuntimeMode: 'enforced',
        characterBinding: makeBinding_()
      }
    };
    assert(
      ChatService.assertPersistedPair(
        { userMessage: userMessage, assistantMessage: assistantMessage },
        event
      ) === true,
      'Matching enforced image pair should remain readable.'
    );
    userMessage.characterApproval.source = 'generated';
    expectCode(function() {
      ChatService.assertPersistedPair(
        { userMessage: userMessage, assistantMessage: assistantMessage },
        event
      );
    }, 'STORAGE_DATA_CORRUPTED');
  });

  test('ChatService enforced text runs classification guard sink and persistence end to end', function() {
    var originalValidators = Validators;
    var originalProfileService = CharacterProfileService;
    var validatorStub = {};
    Object.keys(originalValidators).forEach(function(key) {
      validatorStub[key] = originalValidators[key];
    });
    validatorStub.validateScriptProperties = function() {
      return true;
    };

    var requestId = '11111111-1111-4111-8111-111111111111';
    var userMessage = null;
    var assistantMessage = null;
    var queueEvent = null;
    var usagePatch = null;
    var requireActiveCalls = 0;
    var profile = JSON.parse(APP_CONSTANTS.CHARACTER.DEFAULT_PROFILE_JSON);
    var pack = CharacterPackService.getActive();
    var active = {
      profile: profile,
      profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 3,
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: pack.packId,
      characterPackVersion: pack.packVersion
    };

    function toMessage(message) {
      return {
        messageId: message.messageId,
        requestId: message.requestId || null,
        createdAt: message.createdAt,
        role: message.role,
        messageType: message.messageType,
        text: message.text || '',
        image: message.image || null,
        status: message.status,
        replyToMessageId: message.replyToMessageId || null,
        model: message.model || null,
        inputTokens: message.inputTokens == null ? null : message.inputTokens,
        outputTokens: message.outputTokens == null ? null : message.outputTokens,
        error: null,
        characterApproval: message.characterApproval || null
      };
    }

    var sheetStub = {
      ensureDefaultUserState: function() {},
      getConversationByRequestId: function() {
        return {
          requestId: requestId,
          userMessage: userMessage,
          assistantMessage: assistantMessage
        };
      },
      getRows: function(sheetName) {
        if (sheetName !== APP_CONSTANTS.SHEETS.EVENT_QUEUE || !queueEvent) {
          return [];
        }
        return [{
          event_id: queueEvent.eventId,
          event_type: queueEvent.eventType,
          dedupe_key: queueEvent.dedupeKey,
          payload_json: queueEvent.payload,
          status: queueEvent.status,
          attempt_count: queueEvent.attemptCount,
          next_attempt_at: queueEvent.nextAttemptAt,
          locked_at: queueEvent.lockedAt,
          locked_by: queueEvent.lockedBy,
          created_at: queueEvent.createdAt,
          updated_at: queueEvent.updatedAt,
          completed_at: queueEvent.completedAt,
          last_error: queueEvent.lastError
        }];
      },
      appendConversation: function(message) {
        if (message.role === 'user') {
          if (!userMessage) {
            userMessage = toMessage(message);
          }
          return userMessage;
        }
        if (!assistantMessage) {
          assistantMessage = toMessage(message);
        }
        return assistantMessage;
      },
      updateUserState: function() {},
      insertEvent: function(event) {
        queueEvent = event;
      },
      updateEvent: function(_, patch) {
        Object.keys(patch).forEach(function(key) {
          if (key === 'payload_json') {
            queueEvent.payload = patch[key];
          } else {
            queueEvent[key] = patch[key];
          }
        });
      },
      assertCharacterApprovalColumns: function() {
        return true;
      },
      listMessagesBefore: function() {
        return [];
      },
      incrementUsageDaily: function(_, patch) {
        usagePatch = patch;
      }
    };

    withGlobals({
      Validators: validatorStub,
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperties: function() {
              return {};
            }
          };
        }
      },
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: sheetStub,
      ConfigRepository: {
        getByKey: function() {
          return { value: 20 };
        }
      },
      CharacterProfileService: {
        inspectRuntime: function() {
          return {
            state: 'ready',
            reason: null,
            runtimeMode: 'enforced',
            profileMode: 'v2',
            profileSchemaVersion: active.profileSchemaVersion,
            profileRevision: active.profileRevision,
            profile: active.profile,
            characterPackId: active.characterPackId,
            characterPackVersion: active.characterPackVersion
          };
        },
        requireActive: function() {
          requireActiveCalls += 1;
          return active;
        },
        validateV2: originalProfileService.validateV2
      },
      ContextService: {
        buildChatContext: function() {
          throw new Error('Legacy context must not run in enforced mode.');
        }
      },
      GeminiClient: {
        generateText: function() {
          return {
            text: '今日はどないしたん。',
            model: 'gemini-test',
            usage: {
              inputTokens: 10,
              outputTokens: 5
            }
          };
        },
        generateStructured: function(_, schemaName) {
          assert(
            schemaName === 'immersion-semantic-verdict',
            'Text chat used the wrong structured schema.'
          );
          return {
            data: {
              verdict: 'allow',
              category: null,
              evidenceKeys: []
            },
            model: 'gemini-test',
            usage: {
              inputTokens: 7,
              outputTokens: 2
            }
          };
        }
      },
      AppLogger: {
        info: function() {}
      }
    }, function() {
      var result = ChatService.send({
        requestId: requestId,
        text: 'こんにちは',
        clientTimestamp: '2026-07-24T10:00:00+09:00'
      }, {
        now: '2026-07-24T10:00:00+09:00'
      });
      assert(result.status === 'completed', 'Enforced text chat did not complete.');
      assert(result.assistantMessage.text === '今日はどないしたん。', 'Approved text was not returned.');
      assert(
        result.assistantMessage.characterApproval &&
          result.assistantMessage.characterApproval.surface === 'CHAT_TEXT_SYNC',
        'Protected sink approval metadata was not persisted.'
      );
      assert(queueEvent.status === 'DONE', 'Chat event was not completed after the sink write.');
      assert(
        usagePatch && usagePatch.apiCalls === 2,
        'Generation and semantic verification usage was not aggregated.'
      );
      assert(
        requireActiveCalls >= 2,
        'Active profile was not rechecked at the protected sink.'
      );
    });
  });

  test('approved text persistence records artifact metadata and aggregate usage', function() {
    var originalSheetRepository = SheetRepository;
    var appended = null;
    var usagePatch = null;
    SheetRepository = {
      appendConversation: function(message) {
        appended = message;
        return {
          messageId: message.messageId,
          requestId: message.requestId,
          createdAt: message.createdAt,
          role: message.role,
          messageType: message.messageType,
          text: message.text,
          image: null,
          status: message.status,
          characterApproval: message.characterApproval
        };
      },
      updateUserState: function() {},
      incrementUsageDaily: function(_, patch) {
        usagePatch = patch;
      }
    };
    try {
      var result = ChatService.__test.persistApprovedChat({
        requestId: '11111111-1111-4111-8111-111111111111',
        now: '2026-07-24T10:00:01+09:00',
        userMessage: {
          messageId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          text: 'こんにちは'
        },
        event: null,
        payload: { text: 'こんにちは。今日はどないしたん。' },
        artifact: makeArtifact_('CHAT_TEXT_QUEUED', 'rewrite'),
        session: makeSession_(),
        markEventDone: false
      });
      assert(result.status === 'completed', 'Approved text must complete.');
      assert(appended.text === 'こんにちは。今日はどないしたん。', 'Only approved payload text may persist.');
      assert(appended.characterApproval.source === 'rewrite', 'Artifact source metadata is missing.');
      assert(appended.characterApproval.profileRevision === 3, 'Profile revision metadata is missing.');
      assert(usagePatch.apiCalls === 4, 'All character pipeline API calls must be counted.');
      assert(usagePatch.imageCalls === 0, 'Text pipeline must not count image calls.');
    } finally {
      SheetRepository = originalSheetRepository;
    }
  });

  test('approved image pair persists the exact approved summary before reply', function() {
    var originalSheetRepository = SheetRepository;
    var imagePatch = null;
    var appended = null;
    SheetRepository = {
      updateConversationMessage: function(messageId, patch) {
        imagePatch = patch;
        return {
          messageId: messageId,
          image: patch.image,
          characterApproval: patch.characterApproval
        };
      },
      appendConversation: function(message) {
        appended = message;
        return {
          messageId: message.messageId,
          requestId: message.requestId,
          createdAt: message.createdAt,
          role: message.role,
          messageType: message.messageType,
          text: message.text,
          image: null,
          status: message.status,
          characterApproval: message.characterApproval
        };
      },
      updateUserState: function() {},
      incrementUsageDaily: function() {}
    };
    try {
      ChatService.__test.persistApprovedChat({
        requestId: '11111111-1111-4111-8111-111111111111',
        now: '2026-07-24T10:00:01+09:00',
        userMessage: {
          messageId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          text: 'これ見て',
          image: {
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            summary: 'unapproved placeholder'
          }
        },
        event: null,
        payload: {
          replyText: '見えてる範囲やと、机の上に皿があるな。',
          imageSummary: '机の上に皿が写っている。'
        },
        artifact: makeArtifact_('CHAT_IMAGE', 'generated'),
        session: makeSession_(2),
        markEventDone: false
      });
      assert(imagePatch.image.summary === '机の上に皿が写っている。', 'Approved image summary was not persisted exactly.');
      assert(imagePatch.characterApproval.surface === 'CHAT_IMAGE', 'Image summary approval metadata is missing.');
      assert(appended.text === '見えてる範囲やと、机の上に皿があるな。', 'Approved image reply was not persisted exactly.');
    } finally {
      SheetRepository = originalSheetRepository;
    }
  });

  test('stale queued worker cannot persist a legacy reply after lease loss', function() {
    var requestId = '11111111-1111-4111-8111-111111111111';
    var eventId = '22222222-2222-4222-8222-222222222222';
    var staleLease = 'queue-lease:v1:33333333-3333-4333-8333-333333333333';
    var queueEvent = {
      eventId: eventId,
      eventType: 'CHAT_REPLY',
      status: 'PROCESSING',
      lockedBy: staleLease,
      payload: {
        requestId: requestId
      }
    };
    var userMessage = {
      messageId: '44444444-4444-4444-8444-444444444444',
      requestId: requestId,
      createdAt: '2026-07-24T10:00:00+09:00',
      role: 'user',
      messageType: 'text',
      text: '縺薙ｓ縺ｫ縺｡縺ｯ',
      image: null,
      status: 'accepted'
    };
    var appendCount = 0;
    var updateCount = 0;

    var thrown = withGlobals({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      CharacterProfileService: {
        inspectRuntime: function() {
          return {
            state: 'legacy',
            runtimeMode: 'legacy'
          };
        }
      },
      ContextService: {
        buildChatContext: function() {
          return {
            persona: {
              partnerName: 'Partner',
              userName: 'User',
              systemPersona: 'Calm and kind.',
              promptVersion: 'test'
            },
            currentTime: '2026-07-24T10:00:01+09:00',
            memories: [],
            recentMessages: [userMessage]
          };
        }
      },
      GeminiClient: {
        generateText: function() {
          queueEvent.lockedBy =
            'queue-lease:v1:55555555-5555-4555-8555-555555555555';
          return {
            text: 'generated but stale',
            model: 'test-model',
            usage: null
          };
        }
      },
      SheetRepository: {
        getEventById: function() {
          return queueEvent;
        },
        getConversationByRequestId: function() {
          return {
            userMessage: userMessage,
            assistantMessage: null
          };
        },
        appendConversation: function() {
          appendCount += 1;
          return null;
        },
        updateConversationMessage: function() {
          updateCount += 1;
          return null;
        }
      }
    }, function() {
      return expectCode(function() {
        ChatService.processQueuedReply(queueEvent.payload, {
          now: '2026-07-24T10:00:01+09:00',
          eventId: eventId,
          leaseToken: staleLease
        });
      }, 'QUEUE_LOCK_BUSY');
    });

    assert(
      thrown.details && thrown.details.reason === 'QUEUE_LEASE_MISMATCH',
      'Lease loss must use the queue fencing reason.'
    );
    assert(appendCount === 0, 'A stale worker must not append an assistant row.');
    assert(updateCount === 0, 'A stale worker must not mutate the user image row.');
  });

  function makeArtifact_(surface, source) {
    return {
      surface: surface,
      source: source,
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 3,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: CharacterPackService.getActive().packId,
      characterPackVersion: CharacterPackService.getActive().packVersion
    };
  }

  function makeBinding_() {
    var pack = CharacterPackService.getActive();
    return {
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 3,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: pack.packId,
      characterPackVersion: pack.packVersion
    };
  }

  function makeSession_(imageCalls) {
    return {
      getGenerationMetadata: function(source) {
        return source === 'generated' || source === 'rewrite'
          ? {
            model: 'test-model',
            inputTokens: 10,
            outputTokens: 5
          }
          : null;
      },
      getUsage: function() {
        return {
          apiCalls: 4,
          imageCalls: imageCalls || 0,
          inputTokens: 40,
          outputTokens: 20
        };
      }
    };
  }

  return results;
}

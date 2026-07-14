function runA8ProactiveConversationTests() {
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
        message: error && error.message
          ? error.message
          : String(error)
      });
    }
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed.');
    }
  }

  function withOverrides(overrides, callback) {
    var originalValues = {};
    Object.keys(overrides).forEach(function(key) {
      originalValues[key] = this[key];
      this[key] = overrides[key];
    }, this);
    try {
      callback();
    } finally {
      Object.keys(overrides).forEach(function(key) {
        this[key] = originalValues[key];
      }, this);
    }
  }

  function buildConfig(values) {
    return {
      getByKey: function(key) {
        return Object.prototype.hasOwnProperty.call(values, key)
          ? {
            value: values[key]
          }
          : null;
      }
    };
  }

  function buildBaseConfig(overrides) {
    var values = {
      QUIET_START: '23:00',
      QUIET_END: '08:00',
      SILENCE_MINUTES: 240,
      PROACTIVE_COOLDOWN_MINUTES: 240,
      PROACTIVE_MAX_PER_DAY: 2,
      PROACTIVE_RECHECK_MINUTES: 60,
      PROACTIVE_POLICY_MODE: 'probability',
      PROACTIVE_SILENCE_CEILING_MINUTES: 480,
      PROACTIVE_PROBABILITY_CURVE: 1.3,
      PROACTIVE_DAY_START: '10:00',
      PROACTIVE_EVENING_START: '18:00',
      PROACTIVE_MORNING_WEIGHT: 0.7,
      PROACTIVE_DAY_WEIGHT: 1.0,
      PROACTIVE_EVENING_WEIGHT: 1.2,
      PROACTIVE_AI_GENERATION_ENABLED: false,
      PROACTIVE_MESSAGE_MIN_CHARS: 20,
      PROACTIVE_MESSAGE_MAX_CHARS: 220,
      PARTNER_NAME: 'Partner',
      USER_NAME: 'User',
      SYSTEM_PERSONA: 'Configured persona.',
      PROACTIVE_MESSAGE_STYLE: 'Brief and considerate.',
      PROACTIVE_SUBJECT_TEMPLATE: '{partnerName}',
      PROACTIVE_BODY_TEMPLATE: 'Configured proactive message.'
    };

    Object.keys(overrides || {}).forEach(function(key) {
      values[key] = overrides[key];
    });
    return values;
  }

  test(
    'probability is zero at the minimum silence boundary and one at the ceiling',
    function() {
      var atMinimum = ProactiveMessageService.__test.calculateProbability(
        240,
        240,
        480,
        1.3,
        1
      );
      var midpoint = ProactiveMessageService.__test.calculateProbability(
        360,
        240,
        480,
        1.3,
        1
      );
      var atCeiling = ProactiveMessageService.__test.calculateProbability(
        480,
        240,
        480,
        1.3,
        1
      );

      assert(atMinimum === 0, 'Minimum boundary must produce zero probability.');
      assert(midpoint > atMinimum, 'Probability must increase after the minimum boundary.');
      assert(atCeiling === 1, 'Ceiling must produce probability one at unit weight.');
      assert(midpoint < atCeiling, 'Midpoint probability must remain below the ceiling.');
    }
  );

  test('deterministic sampling is stable for the same seed', function() {
    var first = ProactiveMessageService.__test.deterministicSample(
      '2026-07-14|1|123|2026-07-14T08:00:00+09:00'
    );
    var second = ProactiveMessageService.__test.deterministicSample(
      '2026-07-14|1|123|2026-07-14T08:00:00+09:00'
    );
    var differentSlot = ProactiveMessageService.__test.deterministicSample(
      '2026-07-14|1|124|2026-07-14T08:00:00+09:00'
    );

    assert(first === second, 'Identical seeds must produce identical samples.');
    assert(first >= 0 && first < 1, 'Sample must be in the half-open interval [0, 1).');
    assert(first !== differentSlot, 'Different decision slots should produce different samples.');
  });

  test('queue and delivered-message dedupe keys are separate', function() {
    var queueKey = ProactiveMessageService.__test.buildQueueDedupeKey(
      '2026-07-14',
      2,
      '12345'
    );
    var messageKey = ProactiveMessageService.__test.buildMessageDedupeKey(
      '2026-07-14',
      2
    );

    assert(
      queueKey === 'PROACTIVE_SEND:2026-07-14:2:12345',
      'Queue key must include the decision slot.'
    );
    assert(
      messageKey === 'PROACTIVE_MESSAGE:2026-07-14:2',
      'Delivered-message key must omit the decision slot.'
    );
  });

  test('probability mode does not enqueue at the minimum silence boundary', function() {
    withOverrides({
      ConfigRepository: buildConfig(buildBaseConfig()),
      SheetRepository: {
        ensureDefaultUserState: function() {
          return {};
        },
        getUserState: function() {
          return {
            last_user_message_at: '2026-07-14T08:00:00+09:00',
            last_proactive_at: null,
            proactive_count_date: '2026-07-14',
            proactive_count: 0,
            next_proactive_check_at: null,
            quiet_until: null
          };
        }
      },
      GmailNotifier: {
        getRemainingQuota: function() {
          return 10;
        }
      }
    }, function() {
      var evaluation = ProactiveMessageService.evaluateLocalConditions(
        '2026-07-14T12:00:00+09:00'
      );

      assert(
        evaluation.eligible === false,
        'Minimum silence boundary must not enqueue in probability mode.'
      );
      assert(
        evaluation.reason === 'PROBABILITY_MISS',
        'The boundary should fail through the probability decision.'
      );
      assert(
        evaluation.probability === 0,
        'Reported probability must be zero at the boundary.'
      );
    });
  });

  test('probability mode enqueues at the configured ceiling', function() {
    withOverrides({
      ConfigRepository: buildConfig(buildBaseConfig()),
      SheetRepository: {
        ensureDefaultUserState: function() {
          return {};
        },
        getUserState: function() {
          return {
            last_user_message_at: '2026-07-14T08:00:00+09:00',
            last_proactive_at: null,
            proactive_count_date: '2026-07-14',
            proactive_count: 0,
            next_proactive_check_at: null,
            quiet_until: null
          };
        }
      },
      GmailNotifier: {
        getRemainingQuota: function() {
          return 10;
        }
      }
    }, function() {
      var first = ProactiveMessageService.evaluateLocalConditions(
        '2026-07-14T16:00:00+09:00'
      );
      var second = ProactiveMessageService.evaluateLocalConditions(
        '2026-07-14T16:00:00+09:00'
      );

      assert(first.eligible === true, 'Ceiling must enqueue at unit daytime weight.');
      assert(first.probability === 1, 'Ceiling probability must be one.');
      assert(first.sample === second.sample, 'Same slot must not reroll the sample.');
      assert(
        first.payload &&
          first.payload.requestedAt === '2026-07-14T16:00:00+09:00',
        'Payload must persist the enqueue decision time.'
      );
      assert(
        first.payload &&
          !Object.prototype.hasOwnProperty.call(first.payload, 'body'),
        'Queued payload must not persist a generated body.'
      );
      assert(
        first.dedupeKey.indexOf('PROACTIVE_SEND:2026-07-14:1:') === 0,
        'Queue dedupe key must include the decision slot.'
      );
    });
  });

  test('dispatch is cancelled when the user spoke after enqueue', function() {
    withOverrides({
      ConfigRepository: buildConfig(buildBaseConfig()),
      SheetRepository: {
        getMessageByRequestIdAndRole: function() {
          return null;
        },
        ensureDefaultUserState: function() {
          return {
            last_user_message_at: '2026-07-14T12:05:00+09:00'
          };
        },
        getUserState: function() {
          return {
            last_user_message_at: '2026-07-14T12:05:00+09:00',
            last_proactive_at: null,
            proactive_count_date: '2026-07-14',
            proactive_count: 0,
            next_proactive_check_at: null,
            quiet_until: null
          };
        }
      },
      GmailNotifier: {
        getRemainingQuota: function() {
          return 10;
        }
      }
    }, function() {
      var result = ProactiveMessageService.prepareDispatch({
        targetDate: '2026-07-14',
        sequence: 1,
        requestedAt: '2026-07-14T12:00:00+09:00',
        decisionSlot: '12345',
        messageDedupeKey: 'PROACTIVE_MESSAGE:2026-07-14:1',
        probability: 0.5,
        sample: 0.2,
        elapsedMinutes: 300,
        timeWeight: 1,
        reason: 'deterministic_probability_hit'
      }, '2026-07-14T12:06:00+09:00');

      assert(result.eligible === false, 'Post-enqueue user activity must cancel delivery.');
      assert(
        result.reason === 'USER_ACTIVITY_AFTER_ENQUEUE',
        'Cancellation reason must identify post-enqueue activity.'
      );
      assert(result.message === null, 'Cancelled dispatch must not prepare a message.');
    });
  });

  test('generated proactive body length is validated strictly', function() {
    var tooShort = null;
    var tooLong = null;

    try {
      ProactiveMessageService.__test.validateGeneratedBody('1234', 5, 10);
    } catch (error) {
      tooShort = error;
    }

    try {
      ProactiveMessageService.__test.validateGeneratedBody(
        '12345678901',
        5,
        10
      );
    } catch (error) {
      tooLong = error;
    }

    var accepted = ProactiveMessageService.__test.validateGeneratedBody(
      '12345',
      5,
      10
    );

    assert(
      tooShort && tooShort.code === 'GEMINI_BAD_RESPONSE',
      'Too-short generated text must be retryable bad response.'
    );
    assert(
      tooLong && tooLong.code === 'GEMINI_BAD_RESPONSE',
      'Too-long generated text must be retryable bad response.'
    );
    assert(accepted === '12345', 'Exact minimum length must be accepted.');
  });

  test('quoted generated bodies are normalized without mojibake', function() {
    var normalized = ProactiveMessageService.__test.normalizeGeneratedBody(
      '\u300chello\u300d'
    );
    var nested = ProactiveMessageService.__test.normalizeGeneratedBody(
      '\u300ehello\u300f'
    );
    assert(normalized === 'hello', 'Japanese corner quotes must be removed.');
    assert(nested === 'hello', 'Japanese double corner quotes must be removed.');
  });

  test('invalid decision samples are rejected instead of clamped', function() {
    var caught = null;
    try {
      ProactiveMessageService.prepareDispatch({
        targetDate: '2026-07-14',
        sequence: 1,
        requestedAt: '2026-07-14T12:00:00+09:00',
        decisionSlot: '12345',
        messageDedupeKey: 'PROACTIVE_MESSAGE:2026-07-14:1',
        probability: 0.5,
        sample: 1,
        elapsedMinutes: 300,
        timeWeight: 1
      }, '2026-07-14T12:01:00+09:00');
    } catch (error) {
      caught = error;
    }
    assert(
      caught && caught.code === 'VALIDATION_REQUEST_INVALID',
      'A sample of one must be rejected by the runtime contract.'
    );
  });

  test('failed delivery reuses the stored body without another Gemini call', function() {
    var geminiCalls = 0;
    withOverrides({
      ConfigRepository: buildConfig(buildBaseConfig({
        PROACTIVE_AI_GENERATION_ENABLED: true
      })),
      SheetRepository: {
        ensureDefaultUserState: function() {
          return {
            last_user_message_at: '2026-07-14T08:00:00+09:00',
            last_proactive_at: null,
            proactive_count_date: '2026-07-14',
            proactive_count: 0,
            next_proactive_check_at: null,
            quiet_until: null
          };
        },
        getUserState: function() {
          return this.ensureDefaultUserState();
        },
        getMessageByRequestIdAndRole: function() {
          return {
            messageId: '00000000-0000-4000-8000-000000000001',
            requestId: 'PROACTIVE_MESSAGE:2026-07-14:1',
            createdAt: '2026-07-14T12:00:00+09:00',
            role: 'system',
            messageType: 'proactive',
            text: 'Stored failed proactive body.',
            status: 'failed',
            model: 'configured-model',
            inputTokens: 10,
            outputTokens: 5
          };
        }
      },
      GmailNotifier: {
        getRemainingQuota: function() {
          return 10;
        }
      },
      GeminiClient: {
        generateText: function() {
          geminiCalls += 1;
          throw new Error('Gemini must not be called for a stored failed marker.');
        }
      }
    }, function() {
      var prepared = ProactiveMessageService.prepareDispatch({
        targetDate: '2026-07-14',
        sequence: 1,
        requestedAt: '2026-07-14T12:00:00+09:00',
        decisionSlot: '12345',
        messageDedupeKey: 'PROACTIVE_MESSAGE:2026-07-14:1',
        probability: 0.5,
        sample: 0.2,
        elapsedMinutes: 300,
        timeWeight: 1
      }, '2026-07-14T12:10:00+09:00');

      assert(prepared.eligible === true, 'Failed delivery must remain retryable.');
      assert(
        prepared.message.body === 'Stored failed proactive body.',
        'Retry must reuse the body already stored in the marker.'
      );
      assert(geminiCalls === 0, 'Retry must not regenerate the message body.');
    });
  });

  test('failed marker is resent once without appending a duplicate row', function() {
    var marker = {
      messageId: '00000000-0000-4000-8000-000000000001',
      requestId: 'PROACTIVE_MESSAGE:2026-07-14:1',
      createdAt: '2026-07-14T12:00:00+09:00',
      role: 'system',
      messageType: 'proactive',
      text: 'Stored failed proactive body.',
      status: 'failed'
    };
    var appendCalls = 0;
    var sentBodies = [];
    var usageCalls = 0;
    var statePatch = null;

    withOverrides({
      ConfigRepository: buildConfig(buildBaseConfig()),
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function() {
              return 'owner@example.invalid';
            }
          };
        }
      },
      SheetRepository: {
        getMessageByRequestIdAndRole: function() {
          return marker;
        },
        appendConversation: function() {
          appendCalls += 1;
          throw new Error('A failed marker retry must not append another row.');
        },
        updateConversationMessage: function(messageId, patch) {
          Object.keys(patch).forEach(function(key) {
            if (key === 'error') {
              marker.error = patch.error;
            } else {
              marker[key] = patch[key];
            }
          });
          return marker;
        },
        ensureDefaultUserState: function() {
          return {
            last_proactive_at: null,
            proactive_count_date: '2026-07-14',
            proactive_count: 0,
            next_proactive_check_at: null
          };
        },
        updateUserState: function(patch) {
          statePatch = patch;
          return patch;
        },
        incrementUsageDaily: function() {
          usageCalls += 1;
        }
      },
      GmailNotifier: {
        send: function(ownerEmail, subject, body) {
          sentBodies.push(body);
        }
      }
    }, function() {
      var result = ProactiveMessageService.send({
        targetDate: '2026-07-14',
        sequence: 1,
        dedupeKey: 'PROACTIVE_MESSAGE:2026-07-14:1',
        subject: 'Subject',
        body: 'A newly generated body must not replace the stored one.',
        sentAt: '2026-07-14T12:00:00+09:00'
      });

      assert(result.sent === true, 'Failed marker retry must send successfully.');
      assert(result.duplicate === false, 'A failed marker is not a completed duplicate.');
      assert(appendCalls === 0, 'Retry must not append a duplicate marker.');
      assert(sentBodies.length === 1, 'Retry must perform one mail send.');
      assert(
        sentBodies[0] === 'Stored failed proactive body.',
        'Retry must deliver the stored body.'
      );
      assert(marker.status === 'completed', 'Marker must become completed.');
      assert(usageCalls === 1, 'Successful retry must increment mail usage once.');
      assert(
        statePatch && statePatch.proactive_count === 1,
        'Successful retry must reconcile proactive state.'
      );
    });
  });

  test('completed marker is idempotent and does not send again', function() {
    var marker = {
      messageId: '00000000-0000-4000-8000-000000000002',
      requestId: 'PROACTIVE_MESSAGE:2026-07-14:1',
      createdAt: '2026-07-14T12:00:00+09:00',
      role: 'system',
      messageType: 'proactive',
      text: 'Completed proactive body.',
      status: 'completed'
    };
    var sendCalls = 0;
    var statePatch = null;

    withOverrides({
      ConfigRepository: buildConfig(buildBaseConfig()),
      SheetRepository: {
        getMessageByRequestIdAndRole: function() {
          return marker;
        },
        ensureDefaultUserState: function() {
          return {
            last_proactive_at: null,
            proactive_count_date: '2026-07-14',
            proactive_count: 0,
            next_proactive_check_at: null
          };
        },
        updateUserState: function(patch) {
          statePatch = patch;
          return patch;
        }
      },
      GmailNotifier: {
        send: function() {
          sendCalls += 1;
        }
      }
    }, function() {
      var result = ProactiveMessageService.send({
        targetDate: '2026-07-14',
        sequence: 1,
        dedupeKey: 'PROACTIVE_MESSAGE:2026-07-14:1',
        subject: 'Subject',
        body: 'Completed proactive body.',
        sentAt: '2026-07-14T12:00:00+09:00'
      });

      assert(result.sent === false, 'Completed marker must not send again.');
      assert(result.duplicate === true, 'Completed marker must be a duplicate.');
      assert(sendCalls === 0, 'Completed marker must not call Gmail.');
      assert(
        statePatch && statePatch.proactive_count === 1,
        'Completed duplicate must reconcile state idempotently.'
      );
    });
  });

  test('memory query is derived from recent user and assistant messages', function() {
    var query = ProactiveMessageService.__test.buildMemoryQuery([{
      role: 'system',
      text: 'Internal proactive marker'
    }, {
      role: 'user',
      text: 'Discuss the garden plan'
    }, {
      role: 'assistant',
      text: 'We can review the seedlings'
    }]);

    assert(
      query.indexOf('garden plan') !== -1,
      'The query should contain recent user context.'
    );
    assert(
      query.indexOf('seedlings') !== -1,
      'The query should contain recent assistant context.'
    );
    assert(
      query.indexOf('Internal proactive marker') === -1,
      'System markers must not become memory search terms.'
    );
  });

  test('Gemini generation failure rolls back to the configured template', function() {
    withOverrides({
      ConfigRepository: buildConfig(buildBaseConfig({
        PROACTIVE_AI_GENERATION_ENABLED: true,
        PROACTIVE_BODY_TEMPLATE: 'Configured fallback body for {userName}.'
      })),
      SheetRepository: {
        ensureDefaultUserState: function() {
          return {
            last_user_message_at: '2026-07-14T08:00:00+09:00',
            last_proactive_at: null,
            proactive_count_date: '2026-07-14',
            proactive_count: 0,
            next_proactive_check_at: null,
            quiet_until: null
          };
        },
        getUserState: function() {
          return this.ensureDefaultUserState();
        },
        getMessageByRequestIdAndRole: function() {
          return null;
        },
        listRecentMessages: function() {
          return [{
            messageId: '11111111-1111-4111-8111-111111111111',
            role: 'user',
            messageType: 'text',
            text: 'Recent conversation context.'
          }];
        }
      },
      GmailNotifier: {
        getRemainingQuota: function() {
          return 10;
        }
      },
      MemoryService: {
        findRelevant: function() {
          return [];
        }
      },
      GeminiClient: {
        generateText: function() {
          throw createAppError(
            'GEMINI_TEMPORARY_FAILURE',
            'temporary'
          );
        }
      }
    }, function() {
      var prepared = ProactiveMessageService.prepareDispatch({
        targetDate: '2026-07-14',
        sequence: 1,
        requestedAt: '2026-07-14T12:00:00+09:00',
        decisionSlot: '495744',
        messageDedupeKey: 'PROACTIVE_MESSAGE:2026-07-14:1',
        probability: 0.5,
        sample: 0.2,
        elapsedMinutes: 300,
        timeWeight: 1
      }, '2026-07-14T12:01:00+09:00');

      assert(prepared.eligible === true, 'Template rollback should remain sendable.');
      assert(prepared.usedAi === false, 'Template rollback must report usedAi=false.');
      assert(
        prepared.fallbackReason === 'GEMINI_TEMPORARY_FAILURE',
        'The fallback reason should preserve the Gemini error code.'
      );
      assert(
        prepared.message.body === 'Configured fallback body for User.',
        'The configured template should replace the failed generation.'
      );
    });
  });

  return results;
}

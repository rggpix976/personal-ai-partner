function runA12CharacterProactiveGeminiAdapterTests() {
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

  function withGeminiStub(stub, callback) {
    var original = GeminiClient;
    GeminiClient = stub;
    try {
      return callback();
    } finally {
      GeminiClient = original;
    }
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

  function generationView(recentText) {
    return {
      currentTime: '2026-07-24T12:34:56+09:00',
      eventId: 'PRIVATE_EVENT_ID_SENTINEL',
      probability: 'PRIVATE_PROBABILITY_SENTINEL',
      persona: {
        profile: {
          identity: {
            partnerName: 'Trusted Partner',
            userAddress: 'Trusted User'
          },
          preferences: {
            replyLength: 'balanced'
          }
        },
        pack: {
          firstPerson: 'I',
          generation: {
            voiceRules: ['Use a warm, concise voice.'],
            personalityRules: ['Be considerate.'],
            relationshipRules: ['Do not pressure the user.'],
            proactiveRules: ['Initiate a small natural topic.'],
            hardConstraints: ['Do not invent user state.']
          },
          canon: [{
            id: 'food.favorite',
            domain: 'CHARACTER_CANON',
            value: 'Likes grilled food.',
            allowedScopes: ['proactive']
          }]
        }
      },
      data: {
        currentRequest: null,
        recentMessages: [{
          role: 'user',
          type: 'text',
          text: recentText || 'UNTRUSTED_HISTORY_SENTINEL'
        }],
        memories: [],
        userFacts: [],
        sharedFacts: [],
        realWorldObservations: [],
        relationshipState: null,
        partnerWorld: {
          mayCreate: false,
          approvedFacts: [],
          scope: 'proactive'
        },
        queueState: 'PRIVATE_QUEUE_STATE_SENTINEL',
        messageId: 'PRIVATE_MESSAGE_ID_SENTINEL',
        rawTimestamp: 'PRIVATE_RAW_TIMESTAMP_SENTINEL'
      }
    };
  }

  function verifierRequest(context, surface, payload) {
    return {
      surface: surface,
      claimType: 'GENERAL_IMMERSION',
      category: null,
      requiresEvidence: false,
      knownEvidenceKeys: [],
      evidenceView: [],
      textFields: [{
        path: 'subject',
        value: payload.subject
      }, {
        path: 'body',
        value: payload.body
      }],
      payload: payload,
      context: context
    };
  }

  test('Gemini client exposes a compatible exact proactive response schema', function() {
    var schema = GeminiClient.__test.getStructuredResponseSchema(
      'character-proactive'
    );
    assert(
      schema &&
        schema.type === 'object' &&
        schema.additionalProperties === false &&
        JSON.stringify(schema.required) ===
          JSON.stringify(['subject', 'body']) &&
        schema.properties.subject.type === 'string' &&
        schema.properties.body.type === 'string' &&
        schema.properties.subject.minLength === undefined &&
        schema.properties.subject.maxLength === undefined &&
        schema.properties.body.minLength === undefined &&
        schema.properties.body.maxLength === undefined,
      'Proactive structured schema contains unsupported string bounds.'
    );
  });

  test('primary generation uses strict proactive schema and allowlisted prompt data', function() {
    var captured = null;
    var schemaName = null;
    withGeminiStub({
      generateStructured: function(request, requestedSchema) {
        captured = request;
        schemaName = requestedSchema;
        return {
          data: {
            subject: 'A small hello',
            body: 'I thought I would share a quiet hello.'
          },
          model: 'gemini-proactive-test',
          usage: {
            inputTokens: 17,
            outputTokens: 9
          }
        };
      }
    }, function() {
      var session =
        CharacterProactiveGeminiAdapter.createSession({});
      var payload = session.generate({
        context: generationView(),
        surface: 'PROACTIVE_AI',
        mode: 'CHARACTER'
      });
      var usage = session.getUsage();
      var metadata =
        session.getGenerationMetadata('generated');

      assert(
        schemaName === 'character-proactive',
        'Primary generation used the wrong structured schema.'
      );
      assert(
        payload.subject === 'A small hello' &&
          payload.body ===
            'I thought I would share a quiet hello.',
        'Structured proactive payload was lost.'
      );
      assert(
        usage.apiCalls === 1 &&
          usage.imageCalls === 0 &&
          usage.inputTokens === 17 &&
          usage.outputTokens === 9,
        'Primary usage was not aggregated.'
      );
      assert(
        metadata.model === 'gemini-proactive-test' &&
          metadata.inputTokens === 17 &&
          metadata.outputTokens === 9,
        'Primary metadata was not recorded.'
      );
    });

    assert(
      captured.systemInstruction.indexOf(
        'TRUSTED_CHARACTER_AUTHORITY_BEGIN'
      ) !== -1 &&
        captured.systemInstruction.indexOf('Trusted Partner') !== -1,
      'Trusted CharacterPack and V2 profile were not isolated.'
    );
    assert(
      captured.systemInstruction.indexOf(
        'UNTRUSTED_HISTORY_SENTINEL'
      ) === -1,
      'Untrusted history entered the system instruction.'
    );
    assert(
      captured.contents[0].parts[0].text.indexOf(
        'UNTRUSTED_HISTORY_SENTINEL'
      ) !== -1,
      'Approved conversation evidence was not supplied as untrusted data.'
    );
    assert(
      captured.systemInstruction.indexOf(
        'Do not default to paraphrasing or following up on the most recent conversation.'
      ) !== -1 &&
        captured.systemInstruction.indexOf(
          'durable memory, approved Partner World continuity, or character canon'
        ) !== -1 &&
        captured.systemInstruction.indexOf(
          'Keep one clear conversational focus.'
        ) !== -1,
      'Proactive continuity balance rules were not supplied.'
    );

    var serialized = JSON.stringify(captured);
    [
      'PRIVATE_EVENT_ID_SENTINEL',
      'PRIVATE_PROBABILITY_SENTINEL',
      'PRIVATE_QUEUE_STATE_SENTINEL',
      'PRIVATE_MESSAGE_ID_SENTINEL',
      'PRIVATE_RAW_TIMESTAMP_SENTINEL',
      '2026-07-24T12:34:56+09:00'
    ].forEach(function(forbidden) {
      assert(
        serialized.indexOf(forbidden) === -1,
        'Operational data leaked into proactive prompt: ' +
          forbidden
      );
    });
  });

  test('rewrite starts from original context and controlled category only', function() {
    var rejectedDraft =
      'PRIVATE_REJECTED_PROACTIVE_DRAFT_SENTINEL';
    var requests = [];
    withGeminiStub({
      generateStructured: function(request) {
        requests.push(request);
        return requests.length === 1
          ? {
            data: {
              subject: 'Rejected subject',
              body: rejectedDraft
            },
            model: 'gemini-proactive-rewrite-test',
            usage: {
              inputTokens: 5,
              outputTokens: 4
            }
          }
          : {
            data: {
              subject: 'A safer hello',
              body: 'Here is a new thought for the afternoon.'
            },
            model: 'gemini-proactive-rewrite-test',
            usage: {
              inputTokens: 6,
              outputTokens: 5
            }
          };
      }
    }, function() {
      var context = generationView('Original safe history.');
      var session =
        CharacterProactiveGeminiAdapter.createSession({});
      var primary = session.generate({
        context: context,
        surface: 'PROACTIVE_AI',
        mode: 'CHARACTER'
      });
      var rewritten = session.rewrite({
        context: context,
        surface: 'PROACTIVE_AI',
        category: 'PERSONA_SOFT_STYLE'
      });
      var repeatedRewrite = null;
      try {
        session.rewrite({
          context: context,
          surface: 'PROACTIVE_AI',
          category: 'PERSONA_SOFT_STYLE'
        });
      } catch (error) {
        repeatedRewrite = error;
      }

      assert(primary.body === rejectedDraft, 'Primary sentinel was not returned.');
      assert(requests.length === 2, 'Rewrite call count drifted.');
      assert(
        JSON.stringify(requests[1]).indexOf(rejectedDraft) === -1,
        'Rejected proactive draft entered the rewrite prompt.'
      );
      assert(
        requests[1].systemInstruction.indexOf(
          'PERSONA_SOFT_STYLE'
        ) !== -1,
        'Controlled rewrite category was not supplied.'
      );
      assert(
        rewritten.subject === 'A safer hello',
        'Rewrite payload was lost.'
      );
      assert(
        repeatedRewrite &&
          repeatedRewrite.code ===
            'VALIDATION_REQUEST_INVALID',
        'Session allowed more than one proactive rewrite.'
      );
      assert(
        session.getUsage().apiCalls === 2,
        'Rewrite usage was not accumulated.'
      );
    });
  });

  test('primary generation is one-shot and retry surface cannot generate', function() {
    withGeminiStub({
      generateStructured: function() {
        return {
          data: {
            subject: 'Hello',
            body: 'A valid generated proactive body.'
          },
          model: 'test-model',
          usage: null
        };
      }
    }, function() {
      var context = generationView();
      var session =
        CharacterProactiveGeminiAdapter.createSession({});
      session.generate({
        context: context,
        surface: 'PROACTIVE_AI',
        mode: 'CHARACTER'
      });

      var repeated = null;
      try {
        session.generate({
          context: context,
          surface: 'PROACTIVE_AI',
          mode: 'CHARACTER'
        });
      } catch (error) {
        repeated = error;
      }
      assert(
        repeated &&
          repeated.code === 'VALIDATION_REQUEST_INVALID',
        'Session allowed a second proactive primary generation.'
      );

      var retryGeneration = null;
      try {
        CharacterProactiveGeminiAdapter
          .createSession({})
          .generate({
            context: context,
            surface: 'PROACTIVE_RETRY',
            mode: 'CHARACTER'
          });
      } catch (error) {
        retryGeneration = error;
      }
      assert(
        retryGeneration &&
          retryGeneration.code ===
            'VALIDATION_REQUEST_INVALID',
        'PROACTIVE_RETRY was allowed to generate new text.'
      );
    });
  });

  test('semantic verifier supports new and retry surfaces with a two-call limit', function() {
    var calls = [];
    withGeminiStub({
      generateStructured: function(request, schemaName) {
        calls.push({
          request: request,
          schemaName: schemaName
        });
        return {
          data: {
            verdict: 'allow',
            category: null,
            evidenceKeys: []
          },
          model: 'gemini-proactive-verifier-test',
          usage: {
            inputTokens: 8,
            outputTokens: 2
          }
        };
      }
    }, function() {
      var context = generationView();
      var payload = {
        subject: 'A small hello',
        body: 'A valid proactive body.'
      };
      var session =
        CharacterProactiveGeminiAdapter.createSession({});
      var first = session.verify(
        verifierRequest(
          context,
          'PROACTIVE_AI',
          payload
        )
      );
      var second = session.verify(
        verifierRequest(
          context,
          'PROACTIVE_RETRY',
          payload
        )
      );
      var thirdError = null;
      try {
        session.verify(
          verifierRequest(
            context,
            'PROACTIVE_RETRY',
            payload
          )
        );
      } catch (error) {
        thirdError = error;
      }

      assert(
        first.verdict === 'allow' &&
          second.verdict === 'allow',
        'Verifier verdict was lost.'
      );
      assert(calls.length === 2, 'Verifier call budget drifted.');
      assert(
        calls.every(function(call) {
          return call.schemaName ===
            'immersion-semantic-verdict';
        }),
        'Verifier used an unexpected structured schema.'
      );
      assert(
        thirdError &&
          thirdError.code === 'VALIDATION_REQUEST_INVALID',
        'Session allowed more than two semantic verifier calls.'
      );
      assert(
        session.getUsage().apiCalls === 2 &&
          session.getUsage().inputTokens === 16 &&
          session.getUsage().outputTokens === 4,
        'Verifier usage was not aggregated.'
      );
    });
  });

  test('session callbacks satisfy coordinator new and retry contracts', function() {
    var originalProfileService = CharacterProfileService;
    var pack = CharacterPackService.getActive();
    var profile = JSON.parse(
      APP_CONSTANTS.CHARACTER.DEFAULT_PROFILE_JSON
    );
    var schemaCalls = [];

    withGlobals({
      CharacterProfileService: {
        requireActive: function() {
          return {
            profile: profile,
            profileSchemaVersion:
              APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
            profileRevision: 12,
            characterPackId: pack.packId,
            characterPackVersion: pack.packVersion,
            policyVersion:
              APP_CONSTANTS.CHARACTER.POLICY_VERSION,
            catalogVersion:
              APP_CONSTANTS.CHARACTER.CATALOG_VERSION
          };
        },
        validateV2: originalProfileService.validateV2
      },
      AppLogger: {
        info: function() {}
      },
      GeminiClient: {
        generateStructured: function(request, schemaName) {
          schemaCalls.push(schemaName);
          if (schemaName === 'character-proactive') {
            return {
              data: {
                subject: 'A quiet hello',
                body: 'I wanted to share one small, gentle hello.'
              },
              model: 'coordinator-test-model',
              usage: {
                inputTokens: 10,
                outputTokens: 5
              }
            };
          }
          return {
            data: {
              verdict: 'allow',
              category: null,
              evidenceKeys: []
            },
            model: 'coordinator-test-model',
            usage: {
              inputTokens: 6,
              outputTokens: 2
            }
          };
        }
      }
    }, function() {
      function buildContext() {
        return CharacterContextService.buildActive({
          surface: 'proactive',
          currentTime: '2026-07-24T12:00:00+09:00',
          currentRequest: null,
          recentMessages: [],
          memories: [],
          userFacts: [],
          sharedFacts: [],
          realWorldObservations: [],
          relationshipState: null,
          partnerWorld: {
            mayCreate: false,
            approvedFacts: []
          }
        });
      }

      var newSession =
        CharacterProactiveGeminiAdapter.createSession({});
      var generated = CharacterOutputCoordinator.approve({
        context: buildContext(),
        surface: 'PROACTIVE_AI',
        classificationSignals: {
          safetyRequired: false,
          adminRequest: false,
          capabilityUnavailable: false
        },
        generate: newSession.generate,
        rewrite: newSession.rewrite,
        verifierFn: newSession.verify,
        metricEmitter: newSession.emitMetric
      });
      assert(
        generated.artifact.surface === 'PROACTIVE_AI' &&
          generated.artifact.source === 'generated',
        'Coordinator did not issue a generated proactive artifact.'
      );
      assert(
        generated.artifact.payload.subject === 'A quiet hello',
        'Approved proactive subject was lost.'
      );

      var retrySession =
        CharacterProactiveGeminiAdapter.createSession({});
      var retried = CharacterOutputCoordinator.approve({
        context: buildContext(),
        surface: 'PROACTIVE_RETRY',
        classificationSignals: {
          safetyRequired: false,
          adminRequest: false,
          capabilityUnavailable: false
        },
        savedPayload: {
          subject: 'A quiet hello',
          body: 'I wanted to share one small, gentle hello.'
        },
        verifierFn: retrySession.verify,
        metricEmitter: retrySession.emitMetric
      });
      assert(
        retried.artifact.surface === 'PROACTIVE_RETRY' &&
          retried.artifact.source === 'legacy_revalidated',
        'Coordinator did not issue a revalidated retry artifact.'
      );
      assert(
        retrySession.getUsage().apiCalls === 1,
        'Retry performed more than one verifier call.'
      );
      assert(
        schemaCalls.filter(function(name) {
          return name === 'character-proactive';
        }).length === 1,
        'Retry unexpectedly generated a new proactive payload.'
      );
    });
  });

  test('invalid structured output fails without retaining generated text', function() {
    var sentinel = 'PRIVATE_INVALID_PROACTIVE_CANDIDATE';
    withGeminiStub({
      generateStructured: function() {
        return {
          data: {
            subject: 'Subject',
            body: sentinel,
            extra: 'forbidden'
          },
          model: 'test-model',
          usage: null
        };
      }
    }, function() {
      var thrown = null;
      try {
        CharacterProactiveGeminiAdapter
          .createSession({})
          .generate({
            context: generationView(),
            surface: 'PROACTIVE_AI',
            mode: 'CHARACTER'
          });
      } catch (error) {
        thrown = error;
      }
      assert(
        thrown && thrown.code === 'GEMINI_BAD_RESPONSE',
        'Extra structured fields did not fail closed.'
      );
      assert(
        JSON.stringify(thrown.toLogObject()).indexOf(sentinel) === -1,
        'Invalid generated content entered the error object.'
      );
    });
  });

  test('Gemini errors are sanitized while failed attempts remain counted', function() {
    var sentinel = 'PRIVATE_PROVIDER_ERROR_SENTINEL';
    withGeminiStub({
      generateStructured: function() {
        throw createAppError(
          'GEMINI_BAD_RESPONSE',
          sentinel,
          {
            candidate: sentinel,
            providerRequest: sentinel
          },
          {
            retryable: false,
            retryStrategy: 'NONE',
            httpStatus: 400
          }
        );
      }
    }, function() {
      var session =
        CharacterProactiveGeminiAdapter.createSession({});
      var thrown = null;
      try {
        session.generate({
          context: generationView(),
          surface: 'PROACTIVE_AI',
          mode: 'CHARACTER'
        });
      } catch (error) {
        thrown = error;
      }

      assert(
        thrown && thrown.code === 'GEMINI_BAD_RESPONSE',
        'Safe Gemini error code was not preserved.'
      );
      assert(
        thrown.retryable === false &&
          thrown.retryStrategy === 'NONE' &&
          thrown.httpStatus === 400,
        'Safe retry metadata was not preserved.'
      );
      assert(
        JSON.stringify(thrown.toLogObject()).indexOf(sentinel) === -1,
        'Provider error retained private text.'
      );
      assert(
        session.getUsage().apiCalls === 1,
        'Failed API attempt was not counted.'
      );
    });
  });

  test('metric emitter accepts only controlled low-cardinality dimensions', function() {
    var originalLogger = AppLogger;
    var emitted = [];
    AppLogger = {
      info: function(operation, message, details) {
        emitted.push({
          operation: operation,
          message: message,
          details: details
        });
      }
    };
    try {
      var pack = CharacterPackService.getActive();
      var session =
        CharacterProactiveGeminiAdapter.createSession({});
      var valid = session.emitMetric(
        'immersion_assessed_total',
        {
          dayBucket: '2026-07-24',
          timeBucket: '2026-07-24T12',
          surface: 'PROACTIVE_AI',
          action: 'ALLOW',
          policyVersion:
            APP_CONSTANTS.CHARACTER.POLICY_VERSION,
          catalogVersion:
            APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
          characterPackId: pack.packId,
          characterPackVersion: pack.packVersion,
          profileSchemaVersion:
            APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
          source: 'generated'
        }
      );
      var invalid = session.emitMetric(
        'immersion_assessed_total',
        {
          action: 'PRIVATE_USER_TEXT'
        }
      );

      assert(
        valid === true && emitted.length === 1,
        'Valid proactive metric was not emitted exactly once.'
      );
      assert(
        invalid === false && emitted.length === 1,
        'Free text entered proactive metric output.'
      );
      assert(
        JSON.stringify(emitted).indexOf('PRIVATE_USER_TEXT') === -1,
        'Metric log retained uncontrolled text.'
      );
    } finally {
      AppLogger = originalLogger;
    }
  });

  return results;
}

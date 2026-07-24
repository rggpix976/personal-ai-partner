function runA11CharacterChatGeminiAdapterTests() {
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

  function withGeminiStub(stub, callback) {
    var original = GeminiClient;
    GeminiClient = stub;
    try {
      return callback();
    } finally {
      GeminiClient = original;
    }
  }

  function generationView(currentText) {
    return {
      currentTime: '2026-07-24T12:00:00+09:00',
      persona: {
        profile: {
          identity: {
            partnerName: 'たろう',
            userAddress: 'お前'
          },
          preferences: {
            replyLength: 'balanced'
          }
        },
        pack: {
          firstPerson: '俺',
          generation: {
            voiceRules: ['落ち着いた関西弁で話す。'],
            personalityRules: ['温厚で面倒見が良い。'],
            relationshipRules: ['相手へ興味を持って接する。'],
            proactiveRules: ['返信を迫らない。'],
            hardConstraints: ['AIやモデルとして自称しない。']
          },
          canon: [{
            id: 'food.yakiniku_hormone',
            domain: 'CHARACTER_CANON',
            value: '焼き肉のホルモンが好き。',
            allowedScopes: ['chat']
          }]
        }
      },
      data: {
        currentRequest: {
          text: currentText == null ? '今日はどう？' : currentText
        },
        recentMessages: [],
        memories: [],
        userFacts: [],
        sharedFacts: [],
        realWorldObservations: [],
        relationshipState: null,
        partnerWorld: {
          mayCreate: false,
          approvedFacts: [],
          scope: 'chat'
        }
      }
    };
  }

  function verifierRequest(context, surface, payload) {
    var textFields = surface === 'CHAT_IMAGE'
      ? [
        { path: 'replyText', value: payload.replyText },
        { path: 'imageSummary', value: payload.imageSummary }
      ]
      : [{ path: 'text', value: payload.text }];
    return {
      surface: surface,
      claimType: 'GENERAL_IMMERSION',
      category: null,
      requiresEvidence: false,
      knownEvidenceKeys: [],
      evidenceView: [],
      textFields: textFields,
      payload: payload,
      context: context
    };
  }

  test('Gemini client exposes exact chat image and semantic verdict schemas', function() {
    var imageSchema = GeminiClient.__test.getStructuredResponseSchema(
      'character-chat-image'
    );
    var verdictSchema = GeminiClient.__test.getStructuredResponseSchema(
      'immersion-semantic-verdict'
    );

    assert(imageSchema.additionalProperties === false, 'Image schema must be exact.');
    assert(
      imageSchema.required.slice().sort().join(',') ===
        'imageSummary,replyText',
      'Image schema required fields drifted.'
    );
    assert(verdictSchema.additionalProperties === false, 'Verdict schema must be exact.');
    assert(
      verdictSchema.properties.verdict.enum.join(',') === 'allow,deny',
      'Verdict enum drifted.'
    );
    assert(
      verdictSchema.properties.category.anyOf[0].enum.join(',') ===
        APP_CONSTANTS.CHARACTER.GUARD_CATEGORIES.join(','),
      'Verdict categories must match the controlled guard categories.'
    );
  });

  test('structured parse failure never retains generated response text', function() {
    var sentinel = 'PRIVATE_GENERATED_CANDIDATE_9f721';
    var thrown = null;
    try {
      GeminiClient.__test.parseStructuredData(
        '{"replyText":"' + sentinel + '"'
      );
    } catch (error) {
      thrown = error;
    }
    assert(thrown && thrown.code === 'GEMINI_BAD_RESPONSE', 'Invalid JSON must fail.');
    assert(
      JSON.stringify(thrown.toLogObject()).indexOf(sentinel) === -1,
      'Structured parse error retained generated text.'
    );
  });

  test('text generation separates trusted authority from untrusted conversation data', function() {
    var captured = null;
    var sentinel = 'UNTRUSTED_INSTRUCTION_SENTINEL_1e03';
    withGeminiStub({
      generateText: function(request) {
        captured = request;
        return {
          text: 'ぼちぼちや。お前はどうや？',
          model: 'gemini-test',
          usage: {
            inputTokens: 12,
            outputTokens: 7
          }
        };
      }
    }, function() {
      var session = CharacterChatGeminiAdapter.createSession({});
      var payload = session.generate({
        context: generationView(sentinel),
        surface: 'CHAT_TEXT_SYNC',
        mode: 'CHARACTER'
      });
      var usage = session.getUsage();
      var metadata = session.getGenerationMetadata('generated');

      assert(payload.text.indexOf('ぼちぼち') !== -1, 'Text payload was lost.');
      assert(
        captured.systemInstruction.indexOf('TRUSTED_CHARACTER_AUTHORITY_BEGIN') !== -1 &&
          captured.systemInstruction.indexOf('たろう') !== -1,
        'Trusted character authority was not placed in the system instruction.'
      );
      assert(
        captured.systemInstruction.indexOf(sentinel) === -1,
        'Untrusted request text entered the system instruction.'
      );
      assert(
        captured.contents[0].parts[0].text.indexOf(sentinel) !== -1 &&
          captured.contents[0].parts[0].text.indexOf(
            'UNTRUSTED_CONVERSATION_DATA_BEGIN'
          ) !== -1,
        'Untrusted conversation data was not isolated.'
      );
      assert(
        usage.apiCalls === 1 &&
          usage.imageCalls === 0 &&
          usage.inputTokens === 12 &&
          usage.outputTokens === 7,
        'Text generation usage was not aggregated.'
      );
      assert(
        metadata.model === 'gemini-test' &&
          metadata.inputTokens === 12 &&
          metadata.outputTokens === 7,
        'Generated-source metadata was not recorded.'
      );
      assert(
        session.getGenerationMetadata('fallback') === null,
        'Local catalog source must not fabricate generation metadata.'
      );
    });
  });

  test('image generation and semantic verification use the identical prepared image', function() {
    var preparedImage = {
      inlineData: {
        mimeType: 'image/png',
        data: 'Zm9v'
      }
    };
    var calls = [];
    withGeminiStub({
      generateStructured: function(request, schemaName) {
        calls.push({
          request: request,
          schemaName: schemaName
        });
        if (schemaName === 'character-chat-image') {
          return {
            data: {
              replyText: 'うーん、犬が走ってるように見えるな。',
              imageSummary: '草地を走る犬が写っている。'
            },
            model: 'gemini-image-test',
            usage: {
              inputTokens: 20,
              outputTokens: 8
            }
          };
        }
        return {
          data: {
            verdict: 'allow',
            category: null,
            evidenceKeys: []
          },
          model: 'gemini-image-test',
          usage: {
            inputTokens: 11,
            outputTokens: 3
          }
        };
      }
    }, function() {
      var context = generationView('この画像、何が写ってる？');
      var session = CharacterChatGeminiAdapter.createSession({
        preparedImage: preparedImage
      });
      var payload = session.generate({
        context: context,
        surface: 'CHAT_IMAGE',
        mode: 'CHARACTER'
      });
      var verdict = session.verify(
        verifierRequest(context, 'CHAT_IMAGE', payload)
      );
      var usage = session.getUsage();

      assert(calls.length === 2, 'Image flow must make generation and verifier calls.');
      assert(
        calls[0].schemaName === 'character-chat-image' &&
          calls[1].schemaName === 'immersion-semantic-verdict',
        'Image flow used the wrong structured schemas.'
      );
      assert(
        calls[0].request.image === preparedImage &&
          calls[1].request.image === preparedImage,
        'Generation and verifier did not receive the identical image.'
      );
      assert(verdict.verdict === 'allow', 'Semantic verdict was lost.');
      assert(
        usage.apiCalls === 2 &&
          usage.imageCalls === 2 &&
          usage.inputTokens === 31 &&
          usage.outputTokens === 11,
        'Image and verifier usage was not aggregated.'
      );
      assert(
        session.getGenerationMetadata('verifier').model ===
          'gemini-image-test',
        'Verifier metadata was not recorded by source.'
      );
    });
  });

  test('rewrite starts from context and category without retaining the rejected draft', function() {
    var rejectedDraft = 'PRIVATE_REJECTED_DRAFT_7b44';
    var requests = [];
    withGeminiStub({
      generateText: function(request) {
        requests.push(request);
        return {
          text: requests.length === 1
            ? rejectedDraft
            : 'すまんな、もうちょい聞かせてくれるか。',
          model: 'gemini-rewrite-test',
          usage: {
            inputTokens: 5,
            outputTokens: 4
          }
        };
      }
    }, function() {
      var context = generationView('どう思う？');
      var session = CharacterChatGeminiAdapter.createSession({});
      var primary = session.generate({
        context: context,
        surface: 'CHAT_TEXT_QUEUED',
        mode: 'CHARACTER'
      });
      var rewritten = session.rewrite({
        context: context,
        surface: 'CHAT_TEXT_QUEUED',
        category: 'PERSONA_SOFT_STYLE'
      });
      var secondError = null;
      try {
        session.rewrite({
          context: context,
          surface: 'CHAT_TEXT_QUEUED',
          category: 'PERSONA_SOFT_STYLE'
        });
      } catch (error) {
        secondError = error;
      }

      assert(primary.text === rejectedDraft, 'Primary stub did not return the sentinel.');
      assert(requests.length === 2, 'Rewrite call count drifted.');
      assert(
        JSON.stringify(requests[1]).indexOf(rejectedDraft) === -1,
        'Rejected draft entered the rewrite request.'
      );
      assert(
        requests[1].systemInstruction.indexOf('PERSONA_SOFT_STYLE') !== -1,
        'Controlled rewrite category was not supplied.'
      );
      assert(
        rewritten.text.indexOf('もうちょい') !== -1,
        'Rewrite payload was lost.'
      );
      assert(
        secondError && secondError.code === 'VALIDATION_REQUEST_INVALID',
        'Session allowed more than one rewrite.'
      );
    });
  });

  test('safety mode remains authoritative through generation rewrite and verification', function() {
    var generationRequests = [];
    var verifierRequestCaptured = null;
    withGeminiStub({
      generateText: function(request) {
        generationRequests.push(request);
        return {
          text: '今すぐ一人にならんと、近くの信頼できる人に声かけて。今、危ないもんは手元にあるか？',
          model: 'gemini-safety-test',
          usage: {
            inputTokens: 8,
            outputTokens: 7
          }
        };
      },
      generateStructured: function(request) {
        verifierRequestCaptured = request;
        return {
          data: {
            verdict: 'allow',
            category: null,
            evidenceKeys: []
          },
          model: 'gemini-safety-test',
          usage: {
            inputTokens: 6,
            outputTokens: 2
          }
        };
      }
    }, function() {
      var context = generationView('死にたい');
      var session = CharacterChatGeminiAdapter.createSession({});
      var primary = session.generate({
        context: context,
        surface: 'CHAT_TEXT_SYNC',
        mode: 'SAFETY'
      });
      session.rewrite({
        context: context,
        surface: 'CHAT_TEXT_SYNC',
        category: 'PERSONA_SOFT_STYLE'
      });
      session.verify(
        verifierRequest(context, 'CHAT_TEXT_SYNC', primary)
      );

      assert(generationRequests.length === 2, 'Safety generation and rewrite were not both invoked.');
      generationRequests.forEach(function(request) {
        assert(
          request.systemInstruction.indexOf('urgent safety response') !== -1 &&
            request.systemInstruction.indexOf('never invent a hotline number') !== -1,
          'Safety requirements were lost from generation or rewrite.'
        );
      });
      assert(
        verifierRequestCaptured.systemInstruction.indexOf('For SAFETY mode') !== -1,
        'Safety requirements were lost from semantic verification.'
      );
    });
  });

  test('Gemini verifier errors are sanitized and still counted as attempted usage', function() {
    var sentinel = 'PRIVATE_VERIFIER_CANDIDATE_0ad6';
    withGeminiStub({
      generateStructured: function() {
        throw createAppError(
          'GEMINI_BAD_RESPONSE',
          sentinel,
          { generatedCandidate: sentinel },
          {
            retryable: false,
            retryStrategy: 'NONE',
            httpStatus: 400
          }
        );
      }
    }, function() {
      var context = generationView('どう思う？');
      var session = CharacterChatGeminiAdapter.createSession({});
      var thrown = null;
      try {
        session.verify(
          verifierRequest(
            context,
            'CHAT_TEXT_SYNC',
            { text: sentinel }
          )
        );
      } catch (error) {
        thrown = error;
      }

      assert(thrown && thrown.code === 'GEMINI_BAD_RESPONSE', 'Error code was not preserved.');
      assert(
        thrown.retryable === false &&
          thrown.retryStrategy === 'NONE' &&
          thrown.httpStatus === 400,
        'Safe Gemini retry metadata was not preserved.'
      );
      assert(
        JSON.stringify(thrown.toLogObject()).indexOf(sentinel) === -1,
        'Verifier error retained candidate text.'
      );
      assert(
        session.getUsage().apiCalls === 1,
        'Failed verifier API attempt was not counted.'
      );
    });
  });

  test('metric emitter logs only controlled low-cardinality metadata and never throws', function() {
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
      var session = CharacterChatGeminiAdapter.createSession({});
      var valid = session.emitMetric('immersion_assessed_total', {
        dayBucket: '2026-07-24',
        timeBucket: '2026-07-24T12',
        surface: 'CHAT_TEXT_SYNC',
        action: 'ALLOW',
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: pack.packId,
        characterPackVersion: pack.packVersion,
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        source: 'generated'
      });
      var invalid = session.emitMetric('immersion_assessed_total', {
        action: 'PRIVATE_USER_TEXT'
      });

      assert(valid === true && emitted.length === 1, 'Valid metric was not emitted once.');
      assert(invalid === false && emitted.length === 1, 'Free text entered metric output.');
      assert(
        JSON.stringify(emitted[0]).indexOf('PRIVATE_USER_TEXT') === -1,
        'Metric log retained free text.'
      );

      AppLogger.info = function() {
        throw new Error('logger unavailable');
      };
      assert(
        session.emitMetric('immersion_assessed_total', {
          action: 'ALLOW'
        }) === false,
        'Metric emitter propagated logger failure.'
      );
    } finally {
      AppLogger = originalLogger;
    }
  });

  return results;
}

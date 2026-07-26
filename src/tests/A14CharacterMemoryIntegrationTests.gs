function runA14CharacterMemoryIntegrationTests() {
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

  function binding() {
    return {
      profileSchemaVersion:
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 8,
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: 'tsukiyomi-kansai',
      characterPackVersion: '2026.07.1'
    };
  }

  function approval() {
    var value = binding();
    return {
      surface: 'MEMORY_EXTRACTION',
      source: 'generated',
      policyVersion: value.policyVersion,
      profileSchemaVersion: value.profileSchemaVersion,
      profileRevision: value.profileRevision,
      catalogVersion: value.catalogVersion,
      characterPackId: value.characterPackId,
      characterPackVersion: value.characterPackVersion
    };
  }

  function sourceMessageId() {
    return '11111111-1111-4111-8111-111111111111';
  }

  function eventId() {
    return '22222222-2222-4222-8222-222222222222';
  }

  function payload() {
    return {
      firstMessageId: sourceMessageId(),
      lastMessageId: sourceMessageId(),
      sourceMessageIds: [sourceMessageId()],
      requestedAt: '2026-07-24T10:00:00+09:00',
      characterRuntimeMode: 'enforced',
      characterBinding: binding()
    };
  }

  function candidate() {
    return {
      action: 'create',
      category: 'preference',
      normalizedKey: 'favorite.drink',
      content: 'ユーザーは温かいお茶が好き。',
      confidence: 0.9,
      sourceMessageIds: [sourceMessageId()],
      reason: 'ユーザーが明示した。'
    };
  }

  function generationView(memories) {
    return {
      currentTime: '2026-07-24T10:00:00+09:00',
      persona: {
        profile: {
          identity: {
            partnerName: '月読',
            userAddress: 'お前'
          },
          preferences: {
            replyLength: 'balanced'
          }
        },
        pack: {
          firstPerson: '俺',
          generation: {},
          canon: []
        }
      },
      data: {
        currentRequest: null,
        recentMessages: [{
          messageId: sourceMessageId(),
          role: 'user',
          type: 'text',
          text: '温かいお茶が好き'
        }],
        memories: memories || [],
        userFacts: [],
        sharedFacts: [],
        realWorldObservations: [],
        relationshipState: null,
        partnerWorld: null
      }
    };
  }

  test('memory context excludes legacy rows and unapproved partner messages', function() {
    var captured = null;
    var approvedRow = {
      memory_id: '33333333-3333-4333-8333-333333333333',
      category: 'preference',
      normalized_key: 'favorite.drink',
      content: 'ユーザーは温かいお茶が好き。',
      confidence: 0.9,
      status: 'active',
      source_message_ids_json: [sourceMessageId()],
      created_at: '2026-07-24T10:00:00+09:00',
      last_confirmed_at: '2026-07-24T10:00:00+09:00',
      memory_approval_json: approval(),
      memory_origin_event_ids_json: [eventId()]
    };
    withGlobals({
      CharacterContextService: {
        buildActive: function(input) {
          captured = input;
          return input;
        }
      },
      CharacterPackService: {
        assertActiveBinding: function() {
          return true;
        }
      },
      SheetRepository: {
        listActiveMemories: function() {
          return [
            approvedRow,
            {
              memory_id:
                '44444444-4444-4444-8444-444444444444',
              category: 'other',
              normalized_key: 'legacy',
              content: 'legacy must not enter',
              confidence: 1,
              status: 'active',
              source_message_ids_json: [sourceMessageId()]
            }
          ];
        }
      }
    }, function() {
      CharacterMemoryContextService.build({
        currentTime: '2026-07-24T10:00:00+09:00',
        sourceMessages: [{
          messageId: sourceMessageId(),
          role: 'user',
          messageType: 'text',
          text: '温かいお茶が好き',
          status: 'accepted'
        }, {
          messageId:
            '55555555-5555-4555-8555-555555555555',
          role: 'assistant',
          messageType: 'text',
          text: 'unapproved must not enter',
          status: 'completed'
        }]
      });
    });
    assert(captured.memories.length === 1, 'Legacy memory entered context.');
    assert(
      captured.recentMessages.length === 1 &&
        captured.recentMessages[0].role === 'user',
      'Unapproved partner message entered memory evidence.'
    );
    assert(captured.partnerWorld === null, 'Partner World entered memory context.');
  });

  test('memory adapter rejects candidate source ids outside the queued evidence', function() {
    var error = null;
    withGlobals({
      GeminiClient: {
        generateStructured: function() {
          var value = candidate();
          value.sourceMessageIds = [
            '66666666-6666-4666-8666-666666666666'
          ];
          return {
            data: {
              candidates: [value]
            }
          };
        }
      }
    }, function() {
      var session = CharacterMemoryGeminiAdapter.createSession({
        allowedSourceMessageIds: [sourceMessageId()]
      });
      try {
        session.generate({
          context: generationView(),
          surface: 'MEMORY_EXTRACTION',
          mode: 'CHARACTER'
        });
      } catch (caught) {
        error = caught;
      }
    });
    assert(
      error && error.code === 'GEMINI_BAD_RESPONSE',
      'Out-of-range memory provenance was not rejected.'
    );
  });

  test('every non-empty memory payload requires semantic grounding', function() {
    var decision = CharacterFixedPolicy.inspect(
      {
        candidates: [candidate()]
      },
      'MEMORY_EXTRACTION',
      {
        data: {
          currentRequest: null,
          partnerWorld: null
        },
        persona: {
          profile: {
            identity: {
              partnerName: '月読',
              userAddress: 'お前'
            }
          }
        }
      }
    );
    assert(
      decision.verdict === 'VERIFY' &&
        decision.claimType === 'USER_STATE' &&
        decision.requiresEvidence === true,
      'Memory grounding was not mandatory.'
    );
  });

  test('memory verifier approval requires direct source-message evidence', function() {
    var calls = 0;
    var error = null;
    withGlobals({
      GeminiClient: {
        generateStructured: function(request, schemaName) {
          calls += 1;
          if (schemaName === 'character-memory-candidates') {
            return {
              data: {
                candidates: [candidate()]
              }
            };
          }
          return {
            data: {
              verdict: 'allow',
              category: null,
              evidenceKeys: ['memories:0']
            }
          };
        }
      }
    }, function() {
      var session = CharacterMemoryGeminiAdapter.createSession({
        allowedSourceMessageIds: [sourceMessageId()]
      });
      var generated = session.generate({
        context: generationView(),
        surface: 'MEMORY_EXTRACTION',
        mode: 'CHARACTER'
      });
      try {
        session.verify({
          context: generationView(),
          surface: 'MEMORY_EXTRACTION',
          claimType: 'USER_STATE',
          category: 'GROUNDING_USER_STATE_UNSUPPORTED',
          requiresEvidence: true,
          knownEvidenceKeys: ['recentMessages:0', 'memories:0'],
          evidenceView: [],
          textFields: ['ユーザーは温かいお茶が好き。'],
          payload: generated
        });
      } catch (caught) {
        error = caught;
      }
    });
    assert(calls === 2, 'Unexpected memory adapter call count.');
    assert(
      error && error.code === 'GEMINI_BAD_RESPONSE',
      'Non-source memory evidence was accepted.'
    );
  });

  test('enforced memory preserves coordinator failures without reaching the sink', function() {
    [
      'CONFIG_MISSING',
      'GEMINI_RATE_LIMIT',
      'GEMINI_AUTH_FAILED',
      'GEMINI_MODEL_UNAVAILABLE',
      'GEMINI_BAD_RESPONSE',
      'GEMINI_TEMPORARY_FAILURE',
      'CHARACTER_OUTPUT_BLOCKED'
    ].forEach(function(code) {
      var queuePayload = payload();
      var leaseToken = 'queue-lease:v1:memory-failure';
      var sinkCalls = 0;
      var writeCalls = 0;
      var usageCalls = 0;
      var error = null;
      withGlobals({
        SheetRepository: {
          getEventById: function() {
            return {
              eventId: eventId(),
              eventType: 'MEMORY_EXTRACT',
              payload: queuePayload,
              status: 'PROCESSING',
              lockedBy: leaseToken
            };
          },
          assertMemoryProvenanceColumns: function() {
            return true;
          },
          listActiveMemories: function() {
            return [];
          },
          listMessagesByIds: function() {
            return [{
              messageId: sourceMessageId(),
              role: 'user',
              messageType: 'text',
              text: 'approved source',
              status: 'accepted'
            }];
          },
          upsertMemory: function() {
            writeCalls += 1;
          },
          incrementUsageDaily: function() {
            usageCalls += 1;
          }
        },
        CharacterMemoryContextService: {
          acceptedSourceMessageIds: function() {
            return [sourceMessageId()];
          },
          build: function() {
            return generationView();
          },
          assertBindingMatchesContext: function() {
            return true;
          },
          classificationSignals: function() {
            return {
              safetyRequired: false,
              adminRequest: false,
              capabilityUnavailable: false
            };
          }
        },
        CharacterMemoryGeminiAdapter: {
          createSession: function() {
            return {
              generate: function() {
                throw new Error('generate should be owned by coordinator');
              },
              rewrite: function() {
                throw new Error('rewrite should not run');
              },
              verify: function() {
                throw new Error('verify should not run');
              },
              emitMetric: function() {},
              getUsage: function() {
                return {
                  apiCalls: 1,
                  imageCalls: 0,
                  inputTokens: 0,
                  outputTokens: 0
                };
              }
            };
          }
        },
        CharacterOutputCoordinator: {
          approve: function() {
            throw createAppError(code, 'controlled memory failure');
          }
        },
        CharacterSinkAdapter: {
          deliver: function() {
            sinkCalls += 1;
          }
        },
        AppLogger: {
          writeDebugLog: function() {}
        }
      }, function() {
        try {
          MemoryService.extract(queuePayload, {
            eventId: eventId(),
            leaseToken: leaseToken
          });
        } catch (caught) {
          error = caught;
        }
      });
      assert(
        error && error.code === code,
        code + ' changed at the MemoryService boundary.'
      );
      assert(
        sinkCalls === 0 && writeCalls === 0,
        code + ' reached the memory sink.'
      );
      assert(
        usageCalls === 1,
        code + ' did not record its single generation call.'
      );
    });
  });

  test('enforced memory writes only the approved candidate with provenance', function() {
    var queuePayload = payload();
    var leaseToken = 'queue-lease:v1:memory-test';
    var writes = [];
    var artifact = Object.assign({
      surface: 'MEMORY_EXTRACTION',
      source: 'generated',
      payload: {
        candidates: [candidate()]
      }
    }, approval());
    withGlobals({
      SheetRepository: {
        getEventById: function() {
          return {
            eventId: eventId(),
            eventType: 'MEMORY_EXTRACT',
            payload: queuePayload,
            status: 'PROCESSING',
            lockedBy: leaseToken
          };
        },
        assertMemoryProvenanceColumns: function() {
          return true;
        },
        listMessagesByIds: function() {
          return [{
            messageId: sourceMessageId(),
            role: 'user',
            messageType: 'text',
            text: '温かいお茶が好き',
            status: 'accepted'
          }];
        },
        listActiveMemories: function() {
          return [];
        },
        upsertMemory: function(memory) {
          writes.push(memory);
          return memory;
        },
        incrementUsageDaily: function() {}
      },
      CharacterMemoryContextService: {
        acceptedSourceMessageIds: function() {
          return [sourceMessageId()];
        },
        loadAcceptedMemories: function() {
          return [];
        },
        build: function() {
          return generationView();
        },
        assertBindingMatchesContext: function() {
          return true;
        },
        classificationSignals: function() {
          return {
            safetyRequired: false,
            adminRequest: false,
            capabilityUnavailable: false
          };
        },
        isAcceptedMemoryRow: function() {
          return false;
        }
      },
      CharacterMemoryGeminiAdapter: {
        createSession: function() {
          return {
            generate: function() {
              return artifact.payload;
            },
            rewrite: function() {
              throw new Error('rewrite should not run');
            },
            verify: function() {
              return {
                verdict: 'allow',
                category: null,
                evidenceKeys: ['recentMessages:0']
              };
            },
            emitMetric: function() {},
            getUsage: function() {
              return {
                apiCalls: 2,
                inputTokens: 5,
                outputTokens: 3
              };
            }
          };
        }
      },
      CharacterOutputCoordinator: {
        approve: function() {
          return {
            artifact: artifact,
            classifiedContext: generationView()
          };
        }
      },
      CharacterSinkAdapter: {
        deliver: function(input) {
          assert(
            input.expectedSurface === 'MEMORY_EXTRACTION',
            'Wrong memory sink surface.'
          );
          return input.write(input.artifact.payload, input.artifact);
        }
      }
    }, function() {
      var result = MemoryService.extract(queuePayload, {
        eventId: eventId(),
        leaseToken: leaseToken
      });
      assert(result.created === 1, 'Approved memory was not created.');
    });
    assert(writes.length === 1, 'Unexpected memory write count.');
    assert(
      writes[0].memoryApproval.surface === 'MEMORY_EXTRACTION' &&
        writes[0].memoryOriginEventId === eventId(),
      'Approved memory provenance was not persisted.'
    );
    assert(
      writes[0].sourceMessageIds[0] === sourceMessageId(),
      'Memory source provenance changed.'
    );
  });

  test('enforced memory loses all sink authority with its queue lease', function() {
    var queuePayload = payload();
    var writes = 0;
    var error = null;
    withGlobals({
      SheetRepository: {
        getEventById: function() {
          return {
            eventType: 'MEMORY_EXTRACT',
            payload: queuePayload,
            status: 'RETRY_WAIT',
            lockedBy: null
          };
        },
        upsertMemory: function() {
          writes += 1;
        }
      }
    }, function() {
      try {
        MemoryService.extract(queuePayload, {
          eventId: eventId(),
          leaseToken: 'queue-lease:v1:expired'
        });
      } catch (caught) {
        error = caught;
      }
    });
    assert(error && error.code === 'QUEUE_LOCK_BUSY', 'Lost lease was not fenced.');
    assert(writes === 0, 'Lost lease reached the memory sink.');
  });

  test('memory retry with a prior origin performs zero new generation or writes', function() {
    var queuePayload = payload();
    var leaseToken = 'queue-lease:v1:memory-retry';
    var generated = 0;
    var writes = 0;
    var result;
    withGlobals({
      SheetRepository: {
        getEventById: function() {
          return {
            eventType: 'MEMORY_EXTRACT',
            payload: queuePayload,
            status: 'PROCESSING',
            lockedBy: leaseToken
          };
        },
        assertMemoryProvenanceColumns: function() {
          return true;
        },
        listActiveMemories: function() {
          return [{
            memory_id:
              '88888888-8888-4888-8888-888888888888',
            status: 'active',
            memory_origin_event_ids_json: [eventId()]
          }];
        },
        upsertMemory: function() {
          writes += 1;
        }
      },
      CharacterMemoryContextService: {
        isAcceptedMemoryRow: function() {
          return true;
        }
      },
      CharacterMemoryGeminiAdapter: {
        createSession: function() {
          generated += 1;
          throw new Error('must not generate');
        }
      }
    }, function() {
      result = MemoryService.extract(queuePayload, {
        eventId: eventId(),
        leaseToken: leaseToken
      });
    });
    assert(result.duplicate === true, 'Prior origin was not idempotent.');
    assert(generated === 0 && writes === 0, 'Retry produced a new side effect.');
  });

  test('accepted memory retrieval never promotes a legacy row', function() {
    var found;
    withGlobals({
      CharacterMemoryContextService: {
        loadAcceptedMemories: function() {
          return [{
            memoryId:
              '77777777-7777-4777-8777-777777777777',
            category: 'preference',
            normalizedKey: 'favorite.drink',
            content: 'ユーザーは温かいお茶が好き。',
            confidence: 0.9,
            createdAt: '2026-07-24T10:00:00+09:00',
            lastConfirmedAt: '2026-07-24T10:00:00+09:00'
          }];
        }
      }
    }, function() {
      found = MemoryService.findAcceptedRelevant('お茶', 5);
    });
    assert(found.length === 1, 'Accepted memory was not retrieved.');
    assert(
      found[0].content === 'ユーザーは温かいお茶が好き。',
      'Accepted memory content changed.'
    );
  });

  return results;
}

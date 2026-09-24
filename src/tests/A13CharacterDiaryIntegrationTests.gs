function runA13CharacterDiaryIntegrationTests() {
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
      profileRevision: 7,
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: 'tsukiyomi-kansai',
      characterPackVersion: '2026.07.1'
    };
  }

  function approval(source) {
    var value = binding();
    return {
      surface: 'DIARY',
      source: source || 'generated',
      policyVersion: value.policyVersion,
      profileSchemaVersion: value.profileSchemaVersion,
      profileRevision: value.profileRevision,
      catalogVersion: value.catalogVersion,
      characterPackId: value.characterPackId,
      characterPackVersion: value.characterPackVersion
    };
  }

  function diaryPayload() {
    return {
      title: '今日のこと',
      narrative: '今日は話を聞けて、少し安心した。',
      groundedSummary: 'ユーザーは休憩したと話した。',
      partnerWorldEvents: ['帰り道に少し風が吹いた。'],
      thingsToRemember: ['休憩を取れた。'],
      unresolvedFollowUps: []
    };
  }

  function worldOnlyDiaryPayload() {
    return {
      title: '道を空けた夜',
      narrative: '邪魔になっとったバイクを、隣のビルの前へ置き直しといた。',
      groundedSummary: '',
      partnerWorldEvents: [
        '邪魔になっていたバイクを隣のビルの前へ置き直した。'
      ],
      thingsToRemember: [],
      unresolvedFollowUps: []
    };
  }

  function enforcedPayload() {
    return {
      diaryDate: '2026-07-23',
      requestedAt: '2026-07-24T00:10:00+09:00',
      characterRuntimeMode: 'enforced',
      characterBinding: binding()
    };
  }

  function makeContext() {
    return {
      schemaVersion: APP_CONSTANTS.CHARACTER.CONTEXT_SCHEMA_VERSION,
      surface: 'diary',
      runtime: binding(),
      persona: {
        profile: {},
        pack: {
          firstPerson: '俺',
          generation: {},
          canon: [],
          worldSeeds: [{
            id: 'care.small_pleasures',
            value: 'Vary the writer perspective.',
            allowedScopes: ['diary']
          }]
        }
      },
      data: {
        currentRequest: null,
        recentMessages: [{
          role: 'user',
          type: 'text',
          text: '今日は休んだ'
        }],
        recentOutputs: [{
          surface: 'diary',
          date: '2026-07-22',
          text: 'RECENT_DIARY_OUTPUT_SENTINEL'
        }],
        memories: [],
        partnerWorld: {
          scope: 'diary',
          mayCreate: true,
          generationMode: 'mixed',
          approvedFacts: []
        }
      }
    };
  }

  function makeWorldOnlyContext() {
    var context = makeContext();
    context.data.recentMessages = [];
    context.data.memories = [{
      category: 'preference',
      content: 'WORLD_ONLY_MEMORY_MUST_NOT_ENTER_GENERATION'
    }];
    context.data.partnerWorld.generationMode = 'world_only';
    return context;
  }

  test('diary context excludes unapproved partner output and legacy memory', function() {
    var captured = null;
    withGlobals({
      CharacterContextService: {
        buildActive: function(input) {
          captured = input;
          return input;
        }
      },
      SheetRepository: {
        listRecentDiarySummariesBefore: function() {
          return [];
        }
      }
    }, function() {
      CharacterDiaryContextService.build({
        diaryDate: '2026-07-23',
        currentTime: '2026-07-24T00:10:00+09:00',
        messages: [{
          role: 'user',
          messageType: 'text',
          text: '今日は休んだ',
          status: 'accepted'
        }, {
          role: 'assistant',
          messageType: 'text',
          text: 'approved',
          status: 'completed',
          characterApproval: {
            surface: 'CHAT_TEXT_SYNC'
          }
        }, {
          role: 'assistant',
          messageType: 'text',
          text: 'legacy must not enter',
          status: 'completed'
        }],
        mayCreatePartnerWorld: true
      });
    });
    assert(captured.memories.length === 0, 'Legacy memory entered diary context.');
    assert(captured.recentMessages.length === 2, 'Diary history approval filter failed.');
    assert(
      captured.partnerWorld.generationMode === 'mixed',
      'Conversation-backed diary did not use mixed Partner World mode.'
    );
    assert(
      captured.recentMessages[1].text === 'approved',
      'Unapproved partner output entered diary context.'
    );
  });

  test('diary context marks no-conversation Partner World generation explicitly', function() {
    var captured = null;
    withGlobals({
      CharacterContextService: {
        buildActive: function(input) {
          captured = input;
          return input;
        }
      },
      SheetRepository: {
        listRecentDiarySummariesBefore: function() {
          return [];
        }
      }
    }, function() {
      CharacterDiaryContextService.build({
        diaryDate: '2026-07-23',
        currentTime: '2026-07-23T23:10:00+09:00',
        messages: [],
        mayCreatePartnerWorld: true
      });
    });
    assert(captured.recentMessages.length === 0, 'Unexpected diary messages entered context.');
    assert(
      captured.partnerWorld.mayCreate === true &&
        captured.partnerWorld.generationMode === 'world_only',
      'No-conversation diary did not use the world-only contract.'
    );
  });

  test('partner world continuity accepts only complete approved diary provenance', function() {
    var payload = diaryPayload();
    var rows = [{
      summary_date: '2026-07-22',
      diary_status: 'DONE',
      diary_payload_json: payload,
      diary_approval_json: approval(),
      diary_origin_event_id:
        '11111111-1111-4111-8111-111111111111'
    }, {
      summary_date: '2026-07-21',
      diary_status: 'DONE',
      diary_payload_json: payload,
      diary_approval_json: null,
      diary_origin_event_id:
        '22222222-2222-4222-8222-222222222222'
    }];
    var facts;
    var outputs;
    withGlobals({
      SheetRepository: {
        listRecentDiarySummariesBefore: function() {
          return rows;
        }
      },
      CharacterPackService: {
        assertKnownBinding: function(packId, packVersion) {
          assert(packId === binding().characterPackId, 'Wrong pack id.');
          assert(packVersion === binding().characterPackVersion, 'Wrong pack version.');
          return true;
        }
      }
    }, function() {
      facts =
        CharacterDiaryContextService.loadApprovedPartnerWorldFactsBefore(
          '2026-07-23',
          10
        );
      outputs = CharacterDiaryContextService.__test
        .loadRecentDiaryOutputs('2026-07-23');
    });
    assert(facts.length === 1, 'Unapproved Partner World fact was accepted.');
    assert(facts[0].date === '2026-07-22', 'Approved fact date was lost.');
    assert(
      outputs.length === 1 &&
        outputs[0].date === '2026-07-22' &&
        outputs[0].text.indexOf(payload.groundedSummary) !== -1,
      'Approved recent diary comparison history was not normalized safely.'
    );
  });

  test('diary context blends relevant and durable memories without duplicates', function() {
    var calls = [];
    var relevant = {
      category: 'preference',
      normalizedKey: 'favorite drink',
      content: 'The user likes coffee.',
      confidence: 0.9
    };
    var durable = {
      category: 'routine',
      normalizedKey: 'evening routine',
      content: 'The user prefers quiet evenings.',
      confidence: 0.95
    };
    var memories;
    withGlobals({
      MemoryService: {
        findAcceptedRelevant: function(query, limit) {
          calls.push({ query: query, limit: limit });
          return query ? [relevant] : [relevant, durable];
        }
      }
    }, function() {
      memories = CharacterDiaryContextService.__test
        .loadBalancedAcceptedMemories('coffee today');
    });
    assert(
      calls.length === 2 &&
        calls[0].limit === 6 &&
        calls[1].query === '' &&
        calls[1].limit === 4,
      'Diary memory blend did not request both evidence pools.'
    );
    assert(
      memories.length === 2 &&
        memories[0].content === relevant.content &&
        memories[1].content === durable.content,
      'Diary memory blend lost order or retained a duplicate.'
    );
  });

  test('diary Gemini adapter keeps generation and verification bounded', function() {
    var calls = [];
    var session;
    withGlobals({
      GeminiClient: {
        generateStructured: function(request, schemaName, modelRole, metricContext) {
          calls.push({
            request: request,
            schemaName: schemaName,
            modelRole: modelRole,
            metricContext: metricContext
          });
          if (schemaName === 'character-diary') {
            return {
              data: diaryPayload(),
              model: 'test-model',
              usage: {
                inputTokens: 10,
                outputTokens: 20
              }
            };
          }
          return {
            data: {
              verdict: 'allow',
              category: null,
              evidenceKeys: []
            },
            model: 'test-model',
            usage: {
              inputTokens: 5,
              outputTokens: 2
            }
          };
        }
      }
    }, function() {
      session = CharacterDiaryGeminiAdapter.createSession({
        diaryDate: '2026-07-23'
      });
      var generated = session.generate({
        context: makeContext(),
        surface: 'DIARY',
        mode: 'CHARACTER'
      });
      assert(generated.title === '今日のこと', 'Diary payload was not returned.');
      var verdict = session.verify({
        context: makeContext(),
        surface: 'DIARY',
        claimType: 'general',
        category: null,
        requiresEvidence: false,
        knownEvidenceKeys: [],
        evidenceView: [],
        textFields: ['今日のこと'],
        payload: generated
      });
      assert(verdict.verdict === 'allow', 'Verifier verdict was not returned.');
    });
    assert(calls.length === 2, 'Unexpected Gemini call count.');
    assert(calls[0].schemaName === 'character-diary', 'Wrong diary schema.');
    assert(
      calls[0].modelRole === 'GENERATION' &&
        calls[1].modelRole === 'UTILITY' &&
        calls[0].metricContext.source === 'generated' &&
        calls[1].metricContext.source === 'verifier',
      'Diary generation and verification did not split model roles.'
    );
    assert(
      calls[0].request.systemInstruction.indexOf(
        'Write a reflective diary entry, not a transcript recap'
      ) !== -1 &&
        calls[0].request.systemInstruction.indexOf(
          'durable long-term memories, character canon, and Partner World continuity'
        ) !== -1 &&
        calls[0].request.systemInstruction.indexOf(
          'Do not let the final or longest conversation dominate'
        ) !== -1,
      'Diary continuity balance rules were not supplied.'
    );
    assert(
      calls[0].request.contents[0].parts[0].text.indexOf(
        'RECENT_DIARY_OUTPUT_SENTINEL'
      ) !== -1 &&
        calls[0].request.systemInstruction.indexOf(
          'Vary the writer perspective.'
        ) !== -1 &&
        calls[1].request.contents[0].parts[0].text.indexOf(
          'RECENT_DIARY_OUTPUT_SENTINEL'
        ) !== -1,
      'Diary repetition comparison or trusted world seeds were omitted.'
    );
    assert(
      session.getUsage().apiCalls === 2 &&
        session.getUsage().inputTokens === 15,
      'Diary usage was not accumulated.'
    );
  });

  test('world-only diary uses a bounded generation and verification contract', function() {
    var calls = [];
    var context = makeWorldOnlyContext();
    withGlobals({
      GeminiClient: {
        generateStructured: function(request, schemaName) {
          calls.push({ request: request, schemaName: schemaName });
          if (schemaName === 'character-diary') {
            return {
              data: worldOnlyDiaryPayload(),
              model: 'test-model',
              usage: null
            };
          }
          return {
            data: {
              verdict: 'allow',
              category: null,
              evidenceKeys: []
            },
            model: 'test-model',
            usage: null
          };
        }
      }
    }, function() {
      var session = CharacterDiaryGeminiAdapter.createSession({
        diaryDate: '2026-07-23'
      });
      var generated = session.generate({
        context: context,
        surface: 'DIARY',
        mode: 'CHARACTER'
      });
      session.verify({
        context: context,
        surface: 'DIARY',
        claimType: 'GENERAL_IMMERSION',
        category: null,
        requiresEvidence: false,
        knownEvidenceKeys: [],
        evidenceView: [],
        textFields: CharacterPayloadService.textFields('DIARY', generated),
        payload: generated
      });
    });
    assert(calls.length === 2, 'World-only diary did not use one generation and one verification.');
    assert(
      calls[0].request.systemInstruction.indexOf(
        'WORLD_ONLY_DIARY_MODE is active'
      ) !== -1 &&
      calls[0].request.systemInstruction.indexOf(
          'create exactly one restrained Partner World event'
        ) !== -1 &&
        calls[0].request.contents[0].parts[0].text.indexOf(
          'WORLD_ONLY_MEMORY_MUST_NOT_ENTER_GENERATION'
        ) === -1,
      'World-only generation contract was omitted.'
    );
    assert(
      calls[1].request.systemInstruction.indexOf(
        'WORLD_ONLY_DIARY_MODE is authorized'
      ) !== -1 &&
        calls[1].request.contents[0].parts[0].text.indexOf(
          '"generationMode":"world_only"'
        ) !== -1,
      'World-only verification authorization was omitted.'
    );
  });

  test('world-only diary rejects conversation-grounded collection fields', function() {
    var error = null;
    var invalid = worldOnlyDiaryPayload();
    invalid.groundedSummary = 'ユーザーは休んだと話した。';
    withGlobals({
      GeminiClient: {
        generateStructured: function() {
          return {
            data: invalid,
            model: 'test-model',
            usage: null
          };
        }
      }
    }, function() {
      try {
        CharacterDiaryGeminiAdapter.createSession({
          diaryDate: '2026-07-23'
        }).generate({
          context: makeWorldOnlyContext(),
          surface: 'DIARY',
          mode: 'CHARACTER'
        });
      } catch (caught) {
        error = caught;
      }
    });
    assert(
      error && error.code === 'GEMINI_BAD_RESPONSE',
      'World-only diary accepted unsupported conversation-grounded fields.'
    );
  });

  test('persisted diary verification does not reapply repetition comparison', function() {
    var captured = null;
    withGlobals({
      GeminiClient: {
        generateStructured: function(request) {
          captured = request;
          return {
            data: { verdict: 'allow', category: null, evidenceKeys: [] },
            model: 'test-model',
            usage: null
          };
        }
      }
    }, function() {
      CharacterDiaryGeminiAdapter.createSession({
        diaryDate: '2026-07-23'
      }).verify({
        context: makeContext(),
        surface: 'DIARY',
        claimType: 'general',
        category: null,
        requiresEvidence: false,
        knownEvidenceKeys: [],
        evidenceView: [],
        textFields: ['今日のこと'],
        payload: diaryPayload()
      });
    });
    assert(
      captured.contents[0].parts[0].text.indexOf(
        'RECENT_DIARY_OUTPUT_SENTINEL'
      ) === -1,
      'Persisted diary artifact was incorrectly subjected to repetition comparison.'
    );
  });

  test('enforced diary persists approved provenance before the document sink', function() {
    var eventId = '33333333-3333-4333-8333-333333333333';
    var leaseToken = 'queue-lease:v1:test';
    var payload = enforcedPayload();
    var artifact = Object.assign({
      artifactVersion: 'approved-character-artifact.v1',
      artifactId: '44444444-4444-4444-8444-444444444444',
      surface: 'DIARY',
      source: 'generated',
      payload: diaryPayload()
    }, approval());
    var summary = null;
    var anchor = null;
    var sequence = [];
    withGlobals({
      SheetRepository: {
        getEventById: function() {
          return {
            eventId: eventId,
            eventType: 'DIARY_GENERATE',
            payload: payload,
            status: 'PROCESSING',
            lockedBy: leaseToken
          };
        },
        assertDiaryProvenanceColumns: function() {
          return true;
        },
        getDailySummary: function() {
          return summary;
        },
        listMessagesByDate: function() {
          return [{
            role: 'user',
            messageType: 'text',
            text: '今日は休んだ',
            status: 'accepted'
          }];
        },
        upsertDailySummary: function(input) {
          sequence.push(input.diaryStatus);
          summary = {
            summary_date: input.summaryDate,
            conversation_count: input.conversationCount,
            summary_text: input.summaryText,
            key_topics_json: input.keyTopics,
            memory_candidate_count: input.memoryCandidateCount,
            diary_status: input.diaryStatus,
            diary_doc_anchor: input.diaryDocAnchor,
            created_at: input.createdAt,
            updated_at: input.updatedAt,
            diary_payload_json: input.diaryPayload ||
              (summary && summary.diary_payload_json),
            diary_approval_json: input.diaryApproval ||
              (summary && summary.diary_approval_json),
            diary_origin_event_id: input.diaryOriginEventId ||
              (summary && summary.diary_origin_event_id)
          };
          return summary;
        },
        updateUserState: function() {},
        incrementUsageDaily: function() {}
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return anchor ? 1 : 0;
        },
        findDiaryEntryAnchor: function() {
          return anchor;
        },
        appendDiaryEntry: function() {
          assert(
            summary && summary.diary_status === 'PENDING',
            'Document write occurred before approved provenance persistence.'
          );
          anchor = 'AI Diary - 2026-07-23';
          sequence.push('DOC');
          return {
            appended: true,
            anchor: anchor,
            documentId: 'redacted-test-document'
          };
        }
      },
      CharacterDiaryContextService: {
        build: function() {
          return makeContext();
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
      CharacterDiaryGeminiAdapter: {
        createSession: function() {
          return {
            generate: function() {
              return diaryPayload();
            },
            rewrite: function() {
              throw new Error('rewrite should not run');
            },
            verify: function() {
              return {
                verdict: 'allow',
                category: null,
                evidenceKeys: []
              };
            },
            emitMetric: function() {},
            getUsage: function() {
              return {
                apiCalls: 1,
                inputTokens: 1,
                outputTokens: 1
              };
            },
            getGenerationMetadata: function() {
              return {
                model: 'test-model'
              };
            }
          };
        }
      },
      CharacterOutputCoordinator: {
        approve: function() {
          return {
            artifact: artifact,
            classifiedContext: makeContext()
          };
        }
      },
      CharacterSinkAdapter: {
        deliver: function(input) {
          assert(input.expectedSurface === 'DIARY', 'Wrong sink surface.');
          return input.write(input.artifact.payload, input.artifact);
        }
      },
      ConfigRepository: {
        getByKey: function(key) {
          if (key === 'PARTNER_WORLD_ENABLED') {
            return { value: false };
          }
          return null;
        }
      }
    }, function() {
      var result = DiaryService.generate(payload, {
        eventId: eventId,
        leaseToken: leaseToken
      });
      assert(result.generated === true, 'Enforced diary did not complete.');
    });
    assert(
      sequence.join(',') === 'PENDING,DOC,DONE',
      'Approved diary sink order was not transactional.'
    );
    assert(
      summary.diary_origin_event_id === eventId &&
        summary.diary_approval_json.surface === 'DIARY',
      'Diary approval provenance was not retained.'
    );
  });

  test('enforced diary fails closed after its queue lease is lost', function() {
    var payload = enforcedPayload();
    var error = null;
    withGlobals({
      SheetRepository: {
        getEventById: function() {
          return {
            eventType: 'DIARY_GENERATE',
            payload: payload,
            status: 'RETRY_WAIT',
            lockedBy: null
          };
        }
      }
    }, function() {
      try {
        DiaryService.generate(payload, {
          eventId: '55555555-5555-4555-8555-555555555555',
          leaseToken: 'queue-lease:v1:expired'
        });
      } catch (caught) {
        error = caught;
      }
    });
    assert(error && error.code === 'QUEUE_LOCK_BUSY', 'Lost lease was not fenced.');
  });

  return results;
}

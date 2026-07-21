function runA5MemoryDiaryTests() {
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

  test('MEMORY_EXTRACT enqueue uses dedupe key and suppresses duplicates', function() {
    var inserted = [];
    withOverrides({
      SheetRepository: {
        insertEvent: function(event) {
          if (inserted.length > 0) {
            throw createAppError('DUPLICATE_REQUEST', 'duplicate');
          }
          inserted.push(event);
        },
        getActiveEventByDedupeKey: function(dedupeKey) {
          return {
            eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            dedupeKey: dedupeKey
          };
        }
      }
    }, function() {
      var range = {
        firstMessageId: '11111111-1111-4111-8111-111111111111',
        lastMessageId: '22222222-2222-4222-8222-222222222222',
        sourceMessageIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222'
        ],
        requestedAt: '2026-07-07T10:00:00+09:00'
      };
      var first = MemoryService.enqueueExtraction(range);
      var second = MemoryService.enqueueExtraction(range);
      assert(first.enqueued === true, 'First enqueue should create an event.');
      assert(inserted[0].dedupeKey === 'MEMORY_EXTRACT:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222', 'Dedupe key must match the A1 format.');
      assert(second.duplicate === true, 'Second enqueue should be recognized as a duplicate.');
    });
  });

  test('DIARY_GENERATE enqueue uses dedupe key and suppresses duplicates', function() {
    var inserted = [];
    var summaryRow = null;
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        insertEvent: function(event) {
          inserted.push(event);
        },
        getActiveEventByDedupeKey: function() {
          return inserted.length > 0 ? inserted[0] : null;
        },
        listEventsByType: function() {
          return inserted;
        },
        getDailySummary: function() {
          return summaryRow;
        },
        upsertDailySummary: function(summary) {
          summaryRow = summary;
          return summary;
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 0;
        },
        findDiaryEntryAnchor: function() {
          return null;
        }
      }
    }, function() {
      var first = DiaryService.enqueue('2026-07-07');
      var second = DiaryService.enqueue('2026-07-07');
      assert(first.enqueued === true, 'First diary enqueue should create an event.');
      assert(inserted[0].dedupeKey === 'DIARY_GENERATE:2026-07-07', 'Diary dedupe key must match the A1 format.');
      assert(summaryRow.diaryStatus === 'PENDING', 'Diary enqueue should mark the summary pending.');
      assert(second.duplicate === true, 'Second diary enqueue should be recognized as a duplicate.');
    });
  });

  test('applyCandidates handles create update confirm and ignore', function() {
    var writes = [];
    var lockName = null;
    withOverrides({
      LockManager: {
        withScriptLock: function(name, callback) {
          lockName = name;
          return callback();
        }
      },
      SheetRepository: {
        listActiveMemories: function() {
          return [{
            memory_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            category: 'preference',
            normalized_key: 'favorite drink',
            content: 'The user likes coffee.',
            confidence: 0.7,
            status: 'active',
            source_message_ids_json: ['10111111-1111-4111-8111-111111111111'],
            created_at: '2026-07-01T09:00:00+09:00',
            last_confirmed_at: '2026-07-01T09:00:00+09:00',
            supersedes_memory_id: null,
            usage_count: 0,
            last_used_at: null
          }];
        },
        upsertMemory: function(memory) {
          writes.push(memory);
          return memory;
        }
      }
    }, function() {
      var result = MemoryService.applyCandidates([
        {
          action: 'create',
          category: 'goal',
          normalizedKey: 'trip plan',
          content: 'The user wants to visit Kyoto in autumn.',
          confidence: 0.8,
          sourceMessageIds: ['20111111-1111-4111-8111-111111111111'],
          reason: 'A durable future plan.'
        },
        {
          action: 'confirm',
          category: 'preference',
          normalizedKey: 'favorite drink',
          content: 'The user likes coffee.',
          confidence: 0.9,
          existingMemoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sourceMessageIds: ['30111111-1111-4111-8111-111111111111'],
          reason: 'The preference was restated.'
        },
        {
          action: 'update',
          category: 'preference',
          normalizedKey: 'favorite drink',
          content: 'The user prefers iced coffee in summer.',
          confidence: 0.95,
          existingMemoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sourceMessageIds: ['40111111-1111-4111-8111-111111111111'],
          reason: 'The preference became more specific.'
        },
        {
          action: 'ignore',
          category: 'other',
          normalizedKey: 'small talk',
          content: 'The weather was mentioned once.',
          confidence: 0.1,
          sourceMessageIds: ['50111111-1111-4111-8111-111111111111'],
          reason: 'Not useful as long-term memory.'
        }
      ]);
      assert(result.created === 1, 'One new memory should be created.');
      assert(result.confirmed === 1, 'One memory should be confirmed.');
      assert(result.updated === 1, 'One memory should be updated.');
      assert(result.ignored === 1, 'One candidate should be ignored.');
      assert(writes.length === 3, 'Ignore should not write a memory row.');
      assert(lockName === 'memory-apply-candidates', 'applyCandidates should use the fixed script lock.');
    });
  });

  test('candidate action rules reject missing or forbidden existingMemoryId', function() {
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        listActiveMemories: function() {
          return [];
        },
        upsertMemory: function() {
          throw new Error('upsertMemory should not be called for rejected candidates.');
        }
      }
    }, function() {
      var result = MemoryService.applyCandidates([
        {
          action: 'create',
          category: 'profile',
          normalizedKey: 'name',
          content: 'The user is Alex.',
          confidence: 0.8,
          existingMemoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sourceMessageIds: ['60111111-1111-4111-8111-111111111111'],
          reason: 'Invalid create.'
        },
        {
          action: 'confirm',
          category: 'profile',
          normalizedKey: 'name',
          content: 'The user is Alex.',
          confidence: 0.8,
          sourceMessageIds: ['70111111-1111-4111-8111-111111111111'],
          reason: 'Missing existingMemoryId.'
        }
      ]);
      assert(result.rejected === 2, 'Invalid candidates should be rejected safely.');
    });
  });

  test('applyCandidates rethrows repository failures', function() {
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        listActiveMemories: function() {
          return [];
        },
        upsertMemory: function() {
          throw createAppError('STORAGE_WRITE_FAILED', 'temporary sheet failure');
        }
      }
    }, function() {
      var thrown = null;
      try {
        MemoryService.applyCandidates([{
          action: 'create',
          category: 'goal',
          normalizedKey: 'trip plan',
          content: 'The user wants to visit Kyoto in autumn.',
          confidence: 0.8,
          sourceMessageIds: ['20111111-1111-4111-8111-111111111111'],
          reason: 'A durable future plan.'
        }]);
      } catch (error) {
        thrown = error;
      }
      assert(thrown && thrown.code === 'STORAGE_WRITE_FAILED', 'Repository failures must be rethrown for A6 retry handling.');
    });
  });

  test('applyCandidates does not create duplicate active memory for the same normalizedKey', function() {
    var writes = [];
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        listActiveMemories: function() {
          return [];
        },
        upsertMemory: function(memory) {
          writes.push(memory);
          return memory;
        }
      }
    }, function() {
      var result = MemoryService.applyCandidates([{
        action: 'create',
        category: 'goal',
        normalizedKey: 'kyoto trip',
        content: 'The user wants to visit Kyoto in autumn.',
        confidence: 0.8,
        sourceMessageIds: ['20111111-1111-4111-8111-111111111111'],
        reason: 'Durable plan.'
      }, {
        action: 'create',
        category: 'goal',
        normalizedKey: 'kyoto trip',
        content: 'The user wants to visit Kyoto in autumn.',
        confidence: 0.85,
        sourceMessageIds: ['30111111-1111-4111-8111-111111111111'],
        reason: 'Repeated plan.'
      }]);
      assert(result.created === 1, 'Only one active memory should be created.');
      assert(result.confirmed === 1, 'The duplicate create should fold into a confirm.');
      assert(writes.length === 2, 'The second write should update the same memory rather than create another one.');
      assert(writes[0].memoryId === writes[1].memoryId, 'The same memoryId should be reused for duplicate normalizedKey writes.');
    });
  });

  test('findRelevant is bounded and deterministic', function() {
    var rows = [{
      memory_id: '11111111-1111-4111-8111-111111111111',
      category: 'goal',
      normalized_key: 'kyoto trip',
      content: 'The user wants a Kyoto trip in autumn.',
      confidence: 0.9,
      status: 'active',
      source_message_ids_json: [],
      created_at: '2026-07-01T09:00:00+09:00',
      last_confirmed_at: '2026-07-06T09:00:00+09:00'
    }, {
      memory_id: '22222222-2222-4222-8222-222222222222',
      category: 'preference',
      normalized_key: 'favorite drink',
      content: 'The user likes coffee.',
      confidence: 0.95,
      status: 'active',
      source_message_ids_json: [],
      created_at: '2026-07-01T09:00:00+09:00',
      last_confirmed_at: '2026-07-05T09:00:00+09:00'
    }, {
      memory_id: '33333333-3333-4333-8333-333333333333',
      category: 'interest',
      normalized_key: 'books',
      content: 'The user enjoys mystery novels.',
      confidence: 0.7,
      status: 'active',
      source_message_ids_json: [],
      created_at: '2026-06-01T09:00:00+09:00',
      last_confirmed_at: '2026-06-10T09:00:00+09:00'
    }];
    withOverrides({
      SheetRepository: {
        listActiveMemories: function() {
          return rows;
        }
      }
    }, function() {
      var first = MemoryService.findRelevant('Kyoto autumn travel plans', 2);
      var second = MemoryService.findRelevant('Kyoto autumn travel plans', 2);
      assert(first.length === 2, 'Result should respect the limit.');
      assert(first[0].memoryId === second[0].memoryId && first[1].memoryId === second[1].memoryId, 'Result ordering should be deterministic.');
      assert(first[0].normalizedKey === 'kyoto trip', 'Most relevant memory should rank first.');
    });
  });

  test('DiaryService diary request uses spreadsheet personalization config', function() {
    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            PARTNER_NAME: { value: 'PartnerX' },
            USER_NAME: { value: 'UserY' },
            SYSTEM_PERSONA: { value: 'Configured persona for tests.' },
            DIARY_STYLE: { value: 'Quiet, grounded, and concise.' },
            DIARY_MIN_CHARS: { value: 120 },
            DIARY_MAX_CHARS: { value: 240 },
            PARTNER_WORLD_ENABLED: { value: true },
            PARTNER_WORLD_DIARY_FREQUENCY: { value: 0.75 },
            PARTNER_WORLD_STYLE: { value: 'A quiet fictional city with changing weather and ordinary daily life.' },
            PARTNER_WORLD_RECENT_DIARY_LIMIT: { value: 2 }
          };
          return values[key] || null;
        }
      }
    }, function() {
      var request = DiaryService.__test.buildDiaryRequest(
        '2026-07-07',
        [{
          createdAt: '2026-07-07T10:00:00+09:00',
          role: 'user',
          text: 'Today I talked about a small plan.'
        }],
        [{
          normalizedKey: 'test preference',
          content: 'UserY prefers concise replies.'
        }],
        [{
          summary_date: '2026-07-06',
          summary_text: 'Grounded: UserY discussed a small plan. Partner World fiction: PartnerX watched rain from the window.'
        }]
      );
      var instruction = request.systemInstruction;

      assert(instruction.indexOf('Partner display name: PartnerX') !== -1, 'Diary prompt should include partner name.');
      assert(instruction.indexOf('User display name: UserY') !== -1, 'Diary prompt should include user name.');
      assert(instruction.indexOf('System persona: Configured persona for tests.') !== -1, 'Diary prompt should include system persona.');
      assert(instruction.indexOf('Diary style: Quiet, grounded, and concise.') !== -1, 'Diary prompt should include diary style.');
      assert(
        instruction.indexOf('The narrative field alone must be 120 to 240 characters after trimming.') !== -1,
        'Diary prompt should define the configured length range for the narrative field alone.'
      );
      assert(instruction.indexOf('Partner World enabled: true') !== -1, 'Diary prompt should include the Partner World enabled setting.');
      assert(instruction.indexOf('Partner World diary frequency: 0.75') !== -1, 'Diary prompt should include the configured Partner World frequency.');
      assert(instruction.indexOf('Partner World style: A quiet fictional city with changing weather and ordinary daily life.') !== -1, 'Diary prompt should include the configured Partner World style.');
      assert(instruction.indexOf('partnerWorldEvents, thingsToRemember, and unresolvedFollowUps must be arrays of strings') !== -1, 'Diary prompt should explicitly require array fields.');
      assert(instruction.indexOf('use [] when empty') !== -1, 'Diary prompt should specify empty arrays.');
      assert(instruction.indexOf('Partner-side fictional events are allowed') !== -1, 'Diary prompt should explicitly allow fictional partner-side events.');
      assert(instruction.indexOf('User-side facts require evidence') !== -1, 'Diary prompt should require evidence for user-side facts.');
      assert(instruction.indexOf('must remain grounded') !== -1, 'Diary prompt should require grounded content.');

      var promptText = request.contents[0].parts[0].text;
      assert(promptText.indexOf('Recent completed diary summaries:') !== -1, 'Diary prompt should include recent diary continuity context.');
      assert(promptText.indexOf('2026-07-06') !== -1, 'Diary prompt should include the recent diary date.');
      assert(promptText.indexOf('Partner World fiction: PartnerX watched rain from the window.') !== -1, 'Diary prompt should include prior Partner World context.');
    });
  });

  test('DiaryService Partner World inclusion is deterministic', function() {
    var enabledConfig = {
      partnerWorldEnabled: true,
      partnerWorldDiaryFrequency: 0.65
    };

    var first = DiaryService.__test.shouldIncludePartnerWorld(
      '2026-07-07',
      enabledConfig
    );
    var second = DiaryService.__test.shouldIncludePartnerWorld(
      '2026-07-07',
      enabledConfig
    );

    assert(first === second, 'The same diary date and config must always produce the same decision.');
    assert(
      DiaryService.__test.shouldIncludePartnerWorld('2026-07-07', {
        partnerWorldEnabled: false,
        partnerWorldDiaryFrequency: 1
      }) === false,
      'Disabled Partner World must never be included.'
    );
    assert(
      DiaryService.__test.shouldIncludePartnerWorld('2026-07-07', {
        partnerWorldEnabled: true,
        partnerWorldDiaryFrequency: 0
      }) === false,
      'Zero frequency must never include Partner World.'
    );
    assert(
      DiaryService.__test.shouldIncludePartnerWorld('2026-07-07', {
        partnerWorldEnabled: true,
        partnerWorldDiaryFrequency: 1
      }) === true,
      'Frequency one must always include Partner World.'
    );
  });
  test('DiaryService rejects non-array Partner World events', function() {
    var rejected = null;

    try {
      DiaryService.__test.normalizeDiaryEntry({
        title: 'Invalid structured response',
        narrative: 'A quiet evening passed.',
        groundedSummary: '',
        partnerWorldEvents: 'The partner read a book.',
        thingsToRemember: [],
        unresolvedFollowUps: []
      }, true, {
        minChars: 1,
        maxChars: 200
      });
    } catch (error) {
      rejected = error;
    }

    assert(
      rejected && rejected.code === 'GEMINI_BAD_RESPONSE',
      'partnerWorldEvents must be rejected when it is not an array.'
    );
  });
  test('DiaryService rejects Partner World events when not selected', function() {
    var response = {
      title: 'Unexpected rain',
      narrative: 'Rain fell outside the window.',
      groundedSummary: '',
      partnerWorldEvents: [
        'The partner experienced fictional rain.'
      ],
      thingsToRemember: [],
      unresolvedFollowUps: []
    };
    var rejected = null;

    try {
      DiaryService.__test.normalizeDiaryEntry(response, false, {
        minChars: 1,
        maxChars: 200
      });
    } catch (error) {
      rejected = error;
    }

    assert(
      rejected && rejected.code === 'GEMINI_BAD_RESPONSE',
      'Partner World events must be rejected when Partner World was not selected.'
    );

    var accepted = DiaryService.__test.normalizeDiaryEntry(response, true, {
      minChars: 1,
      maxChars: 200
    });
    assert(
      accepted.partnerWorldEvents.length === 1,
      'Partner World events should be accepted when Partner World was selected.'
    );
  });
  test('DiaryService accepts non-empty short narratives and enforces maximum length after trimming', function() {
    function buildResponse(narrative) {
      return {
        title: 'Length boundary',
        narrative: narrative,
        groundedSummary: '',
        partnerWorldEvents: [],
        thingsToRemember: [],
        unresolvedFollowUps: []
      };
    }

    var config = {
      minChars: 5,
      maxChars: 10
    };
    var warnings = [];
    var longError = null;
    var shortEntry = DiaryService.__test.normalizeDiaryEntry(
      buildResponse('1234'),
      false,
      config,
      warnings
    );

    try {
      DiaryService.__test.normalizeDiaryEntry(
        buildResponse('12345678901'),
        false,
        config
      );
    } catch (error) {
      longError = error;
    }

    assert(
      shortEntry.narrative === '1234',
      'Non-empty narratives below the configured target should be accepted.'
    );
    assert(
      warnings.length === 1 && warnings[0].indexOf('shorter than the configured target') !== -1,
      'A short accepted narrative should add a controlled warning.'
    );
    assert(
      longError && longError.code === 'GEMINI_BAD_RESPONSE',
      'Narratives above the configured maximum must be rejected.'
    );
    assert(
      longError.message.indexOf('configured maximum of 10') !== -1,
      'Maximum-length rejection should identify the configured boundary.'
    );

    var minimum = DiaryService.__test.normalizeDiaryEntry(
      buildResponse(' 12345 '),
      false,
      config
    );
    var maximum = DiaryService.__test.normalizeDiaryEntry(
      buildResponse('1234567890'),
      false,
      config
    );

    assert(
      minimum.narrative === '12345',
      'Trimming should occur before minimum-length validation.'
    );
    assert(
      maximum.narrative === '1234567890',
      'A narrative exactly at the configured maximum should be accepted.'
    );
  });
  test('MemoryService extraction request uses identity context without character-flavored memories', function() {
    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            USER_NAME: { value: 'UserY' },
            PARTNER_NAME: { value: 'PartnerX' }
          };
          return values[key] || null;
        }
      },
      SheetRepository: {
        listActiveMemories: function() {
          return [{
            memory_id: '11111111-1111-4111-8111-111111111111',
            category: 'preference',
            normalized_key: 'reply style',
            content: 'UserY prefers concise replies.'
          }];
        }
      }
    }, function() {
      var request = MemoryService.__test.buildExtractionRequest(
        {
          sourceMessageIds: ['22222222-2222-4222-8222-222222222222']
        },
        [{
          createdAt: '2026-07-07T10:00:00+09:00',
          role: 'user',
          text: 'Please remember that I prefer concise replies.'
        }]
      );
      var instruction = request.systemInstruction;

      assert(instruction.indexOf('User display name: UserY') !== -1, 'Memory prompt should include user name.');
      assert(instruction.indexOf('Partner display name: PartnerX') !== -1, 'Memory prompt should include partner name.');
      assert(instruction.indexOf('Use the display names only to resolve references') !== -1, 'Memory prompt should limit identity usage.');
      assert(instruction.indexOf('factual, neutral, grounded') !== -1, 'Memory prompt should keep memory content neutral.');
      assert(instruction.indexOf('Do not make stored memory content character-flavored.') !== -1, 'Memory prompt should reject character-flavored storage.');
    });
  });

  test('DiaryService.isGenerated checks summaries and document markers', function() {
    withOverrides({
      SheetRepository: {
        getDailySummary: function(date) {
          return date === '2026-07-07' ? { diary_status: 'DONE' } : null;
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function(date) {
          return date === '2026-07-08' ? 1 : 0;
        },
        findDiaryEntryAnchor: function(date) {
          return date === '2026-07-08' ? 'AI Diary - 2026-07-08' : null;
        }
      }
    }, function() {
      assert(DiaryService.isGenerated('2026-07-07') === false, 'DONE summaries without a document anchor must require manual review.');
      var lifecycle = DiaryService.getLifecycleState('2026-07-07');
      assert(lifecycle.status === 'INCONSISTENT', 'DONE without an anchor should be classified as inconsistent.');
      assert(!Object.prototype.hasOwnProperty.call(lifecycle, 'summary'), 'Public lifecycle state must not expose summary content.');
      assert(DiaryService.isGenerated('2026-07-08') === true, 'Document markers should count as generated.');
      assert(DiaryService.isGenerated('2026-07-09') === false, 'Missing summary and marker should be false.');
    });
  });

  test('DiaryService.generate appends once and skips duplicates', function() {
    var summaryRow = null;
    var appended = 0;
    var appendedEntry = null;
    var locks = [];
    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            DIARY_MIN_CHARS: {
              value: 100
            },
            DIARY_MAX_CHARS: {
              value: 1000
            },
            PARTNER_WORLD_ENABLED: {
              value: true
            },
            PARTNER_WORLD_DIARY_FREQUENCY: {
              value: 1
            },
            PARTNER_WORLD_RECENT_DIARY_LIMIT: {
              value: 0
            }
          };
          return values[key] || null;
        }
      },
      LockManager: {
        withScriptLock: function(name, callback) {
          locks.push(name);
          return callback();
        }
      },
      SheetRepository: {
        listMessagesByDate: function() {
          return [{
            messageId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-07-07T09:00:00+09:00',
            role: 'user',
            text: 'I want to plan a Kyoto trip this fall.',
            image: null
          }, {
            messageId: '22222222-2222-4222-8222-222222222222',
            createdAt: '2026-07-07T09:01:00+09:00',
            role: 'assistant',
            text: 'Let us remember that and think through the plan.',
            image: null
          }];
        },
        getDailySummary: function() {
          return summaryRow;
        },
        upsertDailySummary: function(summary) {
          summaryRow = {
            summary_date: summary.summaryDate,
            conversation_count: summary.conversationCount,
            summary_text: summary.summaryText,
            key_topics_json: summary.keyTopics,
            memory_candidate_count: summary.memoryCandidateCount,
            diary_status: summary.diaryStatus,
            diary_doc_anchor: summary.diaryDocAnchor,
            created_at: summary.createdAt,
            updated_at: summary.updatedAt
          };
          return summaryRow;
        },
        updateUserState: function() {
          return true;
        }
      },
      DocumentRepository: {
        findDiaryEntryAnchor: function() {
          return summaryRow && summaryRow.diary_status === 'DONE' ? 'AI Diary - 2026-07-07' : null;
        },
        appendDiaryEntry: function(entry) {
          appended += 1;
          appendedEntry = entry;
          return {
            documentId: 'doc-1',
            anchor: 'AI Diary - 2026-07-07',
            appended: true
          };
        }
      },
      GeminiClient: {
        generateStructured: function() {
          return {
            data: {
              title: 'Rain after dusk',
              narrative: 'Rain began after dusk, so I stayed by the window for a while. Later, I thought again about the autumn Kyoto plan we discussed.',
              groundedSummary: 'The user wants to plan a Kyoto trip this fall.',
              partnerWorldEvents: [
                'The partner experienced fictional rain after dusk and stayed by the window.'
              ],
              thingsToRemember: ['Kyoto trip in autumn'],
              unresolvedFollowUps: ['Help build an itinerary later']
            }
          };
        }
      },
      MemoryService: {
        findRelevant: function() {
          return [];
        }
      }
    }, function() {
      var first = DiaryService.generate({
        diaryDate: '2026-07-07',
        requestedAt: '2026-07-07T23:30:00+09:00'
      });
      var second = DiaryService.generate({
        diaryDate: '2026-07-07',
        requestedAt: '2026-07-07T23:31:00+09:00'
      });
      assert(first.generated === true && first.skipped === false, 'First generation should append the diary.');
      assert(second.generated === false && second.skipped === true, 'Second generation should skip duplicates.');
      assert(appended === 1, 'Diary should be appended only once.');
      assert(appendedEntry != null, 'The rendered diary entry should be passed to the document repository.');
      assert(
        appendedEntry.body === 'Rain began after dusk, so I stayed by the window for a while. Later, I thought again about the autumn Kyoto plan we discussed.',
        'Google Docs should receive the natural diary narrative without fixed report headings.'
      );
      assert(
        summaryRow.summary_text.indexOf('Grounded: The user wants to plan a Kyoto trip this fall.') !== -1,
        'The stored summary should label grounded user information.'
      );
      assert(
        summaryRow.summary_text.indexOf('Partner World fiction: The partner experienced fictional rain after dusk and stayed by the window.') !== -1,
        'The stored summary should label fictional partner-side events.'
      );
      assert(locks.indexOf('diary-generate-2026-07-07') !== -1, 'Diary generation should use a per-date lock.');
    });
  });

  test('DiaryService.generate writes selected Partner World diary without conversation', function() {
    var summaryRow = null;
    var appendedEntry = null;
    var capturedRequest = null;
    var memorySearchCalls = 0;

    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            PARTNER_NAME: { value: 'PartnerX' },
            USER_NAME: { value: 'UserY' },
            SYSTEM_PERSONA: { value: 'Configured persona for tests.' },
            DIARY_STYLE: { value: 'Natural private diary.' },
            DIARY_MIN_CHARS: { value: 120 },
            DIARY_MAX_CHARS: { value: 240 },
            PARTNER_WORLD_ENABLED: { value: true },
            PARTNER_WORLD_DIARY_FREQUENCY: { value: 1 },
            PARTNER_WORLD_STYLE: { value: 'A quiet fictional city with ordinary daily life.' },
            PARTNER_WORLD_RECENT_DIARY_LIMIT: { value: 0 }
          };
          return values[key] || null;
        }
      },
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        listMessagesByDate: function() {
          return [];
        },
        getDailySummary: function() {
          return summaryRow;
        },
        upsertDailySummary: function(summary) {
          summaryRow = {
            summary_date: summary.summaryDate,
            conversation_count: summary.conversationCount,
            summary_text: summary.summaryText,
            key_topics_json: summary.keyTopics,
            memory_candidate_count: summary.memoryCandidateCount,
            diary_status: summary.diaryStatus,
            diary_doc_anchor: summary.diaryDocAnchor,
            created_at: summary.createdAt,
            updated_at: summary.updatedAt
          };
          return summaryRow;
        },
        updateUserState: function() {
          return true;
        }
      },
      DocumentRepository: {
        findDiaryEntryAnchor: function() {
          return null;
        },
        appendDiaryEntry: function(entry) {
          appendedEntry = entry;
          return {
            documentId: 'doc-1',
            anchor: 'AI Diary - 2026-07-08',
            appended: true
          };
        }
      },
      GeminiClient: {
        generateStructured: function(request) {
          capturedRequest = request;
          return {
            data: {
              title: 'Rain at the window',
              narrative: 'Rain began in the evening. I listened to it against the window and spent the rest of the night reading quietly. The room felt calm.',
              groundedSummary: '',
              partnerWorldEvents: [
                'The partner experienced fictional evening rain and read by the window.'
              ],
              thingsToRemember: [],
              unresolvedFollowUps: []
            }
          };
        }
      },
      MemoryService: {
        findRelevant: function() {
          memorySearchCalls += 1;
          return [];
        }
      }
    }, function() {
      var result = DiaryService.generate({
        diaryDate: '2026-07-08',
        requestedAt: '2026-07-08T23:30:00+09:00'
      });

      assert(result.generated === true, 'Selected Partner World diary should be generated without conversation.');
      assert(result.skipped === false, 'Selected Partner World diary should not be skipped.');
      assert(appendedEntry != null, 'Partner World diary should be sent to the document repository.');
      assert(
        appendedEntry.body === 'Rain began in the evening. I listened to it against the window and spent the rest of the night reading quietly. The room felt calm.',
        'Google Docs should receive the natural Partner World narrative.'
      );
      assert(summaryRow.conversation_count === 0, 'Conversation count should remain zero.');
      assert(
        summaryRow.summary_text.indexOf('Grounded: none') !== -1,
        'Missing grounded user information should be stored explicitly as none.'
      );
      assert(
        summaryRow.summary_text.indexOf('Partner World fiction: The partner experienced fictional evening rain and read by the window.') !== -1,
        'The fictional partner-side event should remain clearly separated.'
      );
      assert(memorySearchCalls === 0, 'Empty conversation must not trigger relevant-memory search.');
      assert(
        capturedRequest.systemInstruction.indexOf('Partner World selected for this diary: true') !== -1,
        'The prompt should identify this diary as a selected Partner World day.'
      );
    });
  });
  test('DiaryService repairs DONE summary state when doc anchor already exists', function() {
    var summaryRow = {
      summary_date: '2026-07-07',
      conversation_count: 0,
      summary_text: null,
      key_topics_json: null,
      memory_candidate_count: 0,
      diary_status: 'PENDING',
      diary_doc_anchor: null,
      created_at: '2026-07-07T23:00:00+09:00',
      updated_at: '2026-07-07T23:00:00+09:00'
    };
    var appended = 0;
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getDailySummary: function() {
          return summaryRow;
        },
        listMessagesByDate: function() {
          return [{
            messageId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-07-07T09:00:00+09:00',
            role: 'user',
            text: 'I want to plan a Kyoto trip this fall.',
            image: null
          }];
        },
        upsertDailySummary: function(summary) {
          summaryRow = {
            summary_date: summary.summaryDate,
            conversation_count: summary.conversationCount,
            summary_text: summary.summaryText,
            key_topics_json: summary.keyTopics,
            memory_candidate_count: summary.memoryCandidateCount,
            diary_status: summary.diaryStatus,
            diary_doc_anchor: summary.diaryDocAnchor,
            created_at: summary.createdAt,
            updated_at: summary.updatedAt
          };
          return summaryRow;
        },
        updateUserState: function() {
          return true;
        }
      },
      DocumentRepository: {
        findDiaryEntryAnchor: function() {
          return 'AI Diary - 2026-07-07';
        },
        appendDiaryEntry: function() {
          appended += 1;
          return {
            documentId: 'doc-1',
            anchor: 'AI Diary - 2026-07-07',
            appended: true
          };
        }
      }
    }, function() {
      var result = DiaryService.generate({
        diaryDate: '2026-07-07',
        requestedAt: '2026-07-07T23:31:00+09:00'
      });
      assert(result.skipped === true, 'Existing anchor should skip duplicate generation.');
      assert(summaryRow.diary_status === 'DONE', 'Existing anchor should repair summary status to DONE.');
      assert(summaryRow.diary_doc_anchor === 'AI Diary - 2026-07-07', 'Existing anchor should be persisted back to daily_summaries.');
      assert(appended === 0, 'Repair path should not append a second diary entry.');
    });
  });

  test('Gemini retryable errors propagate from MemoryService.extract', function() {
    withOverrides({
      SheetRepository: {
        listMessagesByIds: function() {
          return [{
            messageId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-07-07T10:00:00+09:00',
            role: 'user',
            text: 'Please remember that I prefer coffee.',
            image: null
          }];
        },
        listActiveMemories: function() {
          return [];
        }
      },
      GeminiClient: {
        generateStructured: function() {
          throw createAppError('GEMINI_TEMPORARY_FAILURE', 'temporary failure');
        }
      }
    }, function() {
      var thrown = null;
      try {
        MemoryService.extract({
          firstMessageId: '11111111-1111-4111-8111-111111111111',
          lastMessageId: '11111111-1111-4111-8111-111111111111',
          sourceMessageIds: ['11111111-1111-4111-8111-111111111111'],
          requestedAt: '2026-07-07T10:00:00+09:00'
        });
      } catch (error) {
        thrown = error;
      }
      assert(thrown && thrown.code === 'GEMINI_TEMPORARY_FAILURE', 'Retryable Gemini failures should be surfaced.');
    });
  });

  test('DiaryService finalizes an intentional no-content skip as NONE', function() {
    var summaryRow = {
      summary_date: '2026-07-10',
      conversation_count: 0,
      summary_text: null,
      key_topics_json: null,
      memory_candidate_count: 0,
      diary_status: 'PENDING',
      diary_doc_anchor: null,
      created_at: '2026-07-10T23:30:00+09:00',
      updated_at: '2026-07-10T23:30:00+09:00'
    };
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            PARTNER_WORLD_ENABLED: { value: false },
            PARTNER_WORLD_DIARY_FREQUENCY: { value: 0 }
          };
          return values[key] || null;
        }
      },
      SheetRepository: {
        getDailySummary: function() {
          return summaryRow;
        },
        listMessagesByDate: function() {
          return [];
        },
        upsertDailySummary: function(summary) {
          summaryRow = {
            summary_date: summary.summaryDate,
            conversation_count: summary.conversationCount,
            summary_text: summary.summaryText,
            key_topics_json: summary.keyTopics,
            memory_candidate_count: summary.memoryCandidateCount,
            diary_status: summary.diaryStatus,
            diary_doc_anchor: summary.diaryDocAnchor,
            created_at: summary.createdAt,
            updated_at: summary.updatedAt
          };
          return summaryRow;
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 0;
        },
        findDiaryEntryAnchor: function() {
          return null;
        }
      },
      GeminiClient: {
        generateStructured: function() {
          throw new Error('Gemini must not run for an intentional no-content skip.');
        }
      }
    }, function() {
      var result = DiaryService.generate({
        diaryDate: '2026-07-10',
        requestedAt: '2026-07-10T23:30:00+09:00'
      });
      assert(result.skipped === true, 'The diary should be skipped without supported content.');
      assert(summaryRow.diary_status === 'NONE', 'An intentional skip must be terminal NONE.');
      assert(DiaryService.getLifecycleState('2026-07-10').status === 'NONE', 'NONE must remain a finalized lifecycle state.');
    });
  });

  test('DiaryService reconciles a completed no-content event to NONE without exposing ids', function() {
    var sourceEvent = {
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      eventType: 'DIARY_GENERATE',
      status: 'DONE',
      payload: {
        diaryDate: '2026-07-10',
        requestedAt: '2026-07-10T23:30:00+09:00'
      },
      completedAt: '2026-07-10T23:31:00+09:00'
    };
    var summaryRow = {
      summary_date: '2026-07-10',
      conversation_count: 0,
      diary_status: 'PENDING',
      diary_doc_anchor: null,
      created_at: '2026-07-10T23:30:00+09:00'
    };
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      ConfigRepository: {
        getByKey: function(key) {
          return key === 'PARTNER_WORLD_ENABLED' || key === 'PARTNER_WORLD_DIARY_FREQUENCY'
            ? { value: 0 }
            : null;
        }
      },
      SheetRepository: {
        getEventById: function() {
          return sourceEvent;
        },
        listEventsByType: function() {
          return [sourceEvent];
        },
        getDailySummary: function() {
          return summaryRow;
        },
        listMessagesByDate: function() {
          return [];
        },
        upsertDailySummary: function(summary) {
          summaryRow.diary_status = summary.diaryStatus;
          return summaryRow;
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 0;
        },
        findDiaryEntryAnchor: function() {
          return null;
        }
      },
      GeminiClient: {
        generateStructured: function() {
          throw new Error('Gemini must not run for a completed no-content reconciliation.');
        }
      }
    }, function() {
      var result = DiaryService.reconcileCompletedGeneration(sourceEvent.eventId);
      var serialized = JSON.stringify(result);
      assert(result.reconciled === true && result.diaryStatus === 'NONE', 'Completed no-content reconciliation should finalize NONE.');
      assert(summaryRow.diary_status === 'NONE', 'The stale PENDING summary should become NONE.');
      assert(serialized.indexOf(sourceEvent.eventId) === -1, 'Completed reconciliation must not expose the source event id.');
    });
  });

  test('DiaryService does not automatically enqueue FAILED diary dates', function() {
    withOverrides({
      SheetRepository: {
        getDailySummary: function() {
          return {
            diary_status: 'FAILED'
          };
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 0;
        },
        findDiaryEntryAnchor: function() {
          return null;
        }
      },
      QueueService: {
        enqueue: function() {
          throw new Error('FAILED diary dates must use the dedicated repair workflow.');
        }
      }
    }, function() {
      var result = DiaryService.enqueue('2026-07-10');
      assert(result.enqueued === false, 'FAILED must not be enqueued automatically.');
      assert(result.reason === 'DIARY_MANUAL_REPAIR_REQUIRED', 'FAILED should name the manual repair requirement.');
    });
  });

  test('DiaryService marks terminal queue failure as FAILED without an anchor', function() {
    var summaryRow = {
      summary_date: '2026-07-10',
      conversation_count: 2,
      summary_text: null,
      key_topics_json: null,
      memory_candidate_count: 0,
      diary_status: 'PENDING',
      diary_doc_anchor: null,
      created_at: '2026-07-10T23:30:00+09:00'
    };
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getDailySummary: function() {
          return summaryRow;
        },
        upsertDailySummary: function(summary) {
          summaryRow.diary_status = summary.diaryStatus;
          summaryRow.diary_doc_anchor = summary.diaryDocAnchor;
          return summaryRow;
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 0;
        }
      }
    }, function() {
      var result = DiaryService.markFailed({
        diaryDate: '2026-07-10',
        requestedAt: '2026-07-10T23:30:00+09:00'
      });
      assert(result.marked === true, 'Terminal failure should be recorded.');
      assert(summaryRow.diary_status === 'FAILED', 'Terminal failure must replace stale PENDING with FAILED.');
    });
  });

  test('DiaryService diary repair assessment is sanitized and blocks ambiguous anchors', function() {
    withOverrides({
      SheetRepository: {
        getEventById: function() {
          return {
            eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eventType: 'DIARY_GENERATE',
            status: 'DEAD',
            payload: {
              diaryDate: '2026-07-10',
              privateText: 'must-not-appear'
            }
          };
        },
        getDailySummary: function() {
          return {
            diary_status: 'PENDING'
          };
        },
        listEventsByType: function() {
          return [];
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 2;
        },
        findDiaryEntryAnchor: function() {
          return 'AI Diary - 2026-07-10';
        }
      }
    }, function() {
      var result = DiaryService.assessDeadGeneration('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      var serialized = JSON.stringify(result);
      assert(result.action === 'MANUAL_REVIEW_REQUIRED', 'Duplicate anchors must stop automatic repair.');
      assert(result.reason === 'DUPLICATE_DIARY_ANCHOR', 'Duplicate anchors need a controlled reason.');
      assert(serialized.indexOf('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') === -1, 'Assessment must not expose event ids.');
      assert(serialized.indexOf('must-not-appear') === -1, 'Assessment must not expose payload content.');
    });
  });

  test('DiaryService treats a newer completed diary event as resolving an older DEAD event', function() {
    var sourceEvent = {
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      eventType: 'DIARY_GENERATE',
      status: 'DEAD',
      payload: { diaryDate: '2026-07-10' },
      completedAt: '2026-07-10T23:30:00+09:00'
    };
    var completedEvent = {
      eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      eventType: 'DIARY_GENERATE',
      status: 'DONE',
      payload: { diaryDate: '2026-07-10' },
      completedAt: '2026-07-11T09:00:00+09:00'
    };
    withOverrides({
      SheetRepository: {
        getEventById: function() {
          return sourceEvent;
        },
        getDailySummary: function() {
          return { diary_status: 'DONE' };
        },
        listEventsByType: function() {
          return [completedEvent, sourceEvent];
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 1;
        },
        findDiaryEntryAnchor: function() {
          return '[DIARY:2026-07-10]';
        }
      }
    }, function() {
      var result = DiaryService.assessDeadGeneration(sourceEvent.eventId);
      assert(result.action === 'NO_ACTION', 'A newer completed diary event should resolve the old failure.');
      assert(result.reason === 'DIARY_FAILURE_ALREADY_RESOLVED', 'Resolved failures should return the dedicated reason.');
    });
  });

  test('DiaryService does not repair an intentionally skipped NONE diary', function() {
    var sourceEvent = {
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      eventType: 'DIARY_GENERATE',
      status: 'DEAD',
      payload: { diaryDate: '2026-07-10' }
    };
    withOverrides({
      SheetRepository: {
        getEventById: function() {
          return sourceEvent;
        },
        getDailySummary: function() {
          return { diary_status: 'NONE' };
        },
        listEventsByType: function() {
          return [sourceEvent];
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 0;
        },
        findDiaryEntryAnchor: function() {
          return null;
        }
      },
      QueueService: {
        requeueDeadDiaryAsNewEvent: function() {
          throw new Error('NONE diary dates must not be repaired.');
        }
      }
    }, function() {
      var assessment = DiaryService.assessDeadGeneration(sourceEvent.eventId);
      var result = DiaryService.repairDeadGeneration(
        sourceEvent.eventId,
        '22222222-2222-4222-8222-222222222222'
      );
      assert(assessment.action === 'NO_ACTION', 'NONE should not be offered for repair.');
      assert(assessment.reason === 'DIARY_NOT_REQUIRED', 'NONE should retain its intentional skip reason.');
      assert(result.enqueued === false && result.reason === 'DIARY_NOT_REQUIRED', 'Repair should remain a no-op for NONE.');
    });
  });

  test('DiaryService repair is idempotent for one manual request and returns sanitized results', function() {
    var summaryRow = {
      summary_date: '2026-07-10',
      diary_status: 'FAILED',
      diary_doc_anchor: null
    };
    var existingRepair = null;
    var sourceEvent = {
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      eventType: 'DIARY_GENERATE',
      status: 'DEAD',
      payload: {
        diaryDate: '2026-07-10'
      }
    };
    withOverrides({
      SheetRepository: {
        getEventById: function() {
          return sourceEvent;
        },
        getEventByDedupeKey: function() {
          return existingRepair;
        },
        getDailySummary: function() {
          return summaryRow;
        },
        listEventsByType: function() {
          return existingRepair ? [sourceEvent, existingRepair] : [sourceEvent];
        },
        upsertDailySummary: function(summary) {
          summaryRow.diary_status = summary.diaryStatus;
          return summaryRow;
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 0;
        },
        findDiaryEntryAnchor: function() {
          return null;
        }
      },
      QueueService: {
        requeueDeadDiaryAsNewEvent: function(_, manualRequestId) {
          if (!existingRepair) {
            existingRepair = {
              eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              eventType: 'DIARY_GENERATE',
              dedupeKey: 'DIARY_GENERATE_REPAIR:2026-07-10:' + manualRequestId,
              payload: { diaryDate: '2026-07-10' },
              status: 'PENDING',
              createdAt: '2026-07-11T09:00:00+09:00'
            };
          }
          return existingRepair;
        }
      }
    }, function() {
      var manualRequestId = '22222222-2222-4222-8222-222222222222';
      var first = DiaryService.repairDeadGeneration(sourceEvent.eventId, manualRequestId);
      assert(summaryRow.diary_status === 'PENDING', 'A new repair should move FAILED to PENDING.');
      existingRepair.status = 'DONE';
      summaryRow.diary_status = 'FAILED';
      var second = DiaryService.repairDeadGeneration(sourceEvent.eventId, manualRequestId);
      var serialized = JSON.stringify(second);
      assert(first.enqueued === true && first.duplicate === false, 'The first repair request should enqueue once.');
      assert(second.enqueued === false && second.duplicate === true, 'The same repair request must be idempotent after completion.');
      assert(summaryRow.diary_status === 'FAILED', 'An idempotent repair call must not rewrite the current diary state.');
      assert(second.reason === 'REPAIR_REQUEST_ALREADY_RECORDED', 'The duplicate repair response should explain that the request was already recorded.');
      assert(serialized.indexOf(sourceEvent.eventId) === -1, 'Repair result must not expose the source event id.');
      assert(serialized.indexOf(manualRequestId) === -1, 'Repair result must not expose the manual request id.');
    });
  });

  test('DiaryService backlog repair reconciles completed skips and enqueues unresolved DEAD once', function() {
    var completedEvent = {
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      eventType: 'DIARY_GENERATE',
      status: 'DONE',
      payload: {
        diaryDate: '2026-07-09',
        requestedAt: '2026-07-09T23:30:00+09:00'
      },
      completedAt: '2026-07-09T23:31:00+09:00'
    };
    var deadEvent = {
      eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      eventType: 'DIARY_GENERATE',
      status: 'DEAD',
      payload: {
        diaryDate: '2026-07-10',
        requestedAt: '2026-07-10T23:30:00+09:00'
      },
      completedAt: '2026-07-10T23:31:00+09:00'
    };
    var events = [deadEvent, completedEvent];
    var summaries = {
      '2026-07-09': { summary_date: '2026-07-09', diary_status: 'PENDING' },
      '2026-07-10': { summary_date: '2026-07-10', diary_status: 'FAILED' }
    };
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      ConfigRepository: {
        getByKey: function(key) {
          return key === 'PARTNER_WORLD_ENABLED' || key === 'PARTNER_WORLD_DIARY_FREQUENCY'
            ? { value: 0 }
            : null;
        }
      },
      SheetRepository: {
        getEventById: function(eventId) {
          return events.filter(function(event) {
            return event.eventId === eventId;
          })[0] || null;
        },
        getEventByDedupeKey: function(dedupeKey) {
          return events.filter(function(event) {
            return event.dedupeKey === dedupeKey;
          })[0] || null;
        },
        listEventsByType: function() {
          return events;
        },
        getDailySummary: function(diaryDate) {
          return summaries[diaryDate] || null;
        },
        listMessagesByDate: function() {
          return [];
        },
        upsertDailySummary: function(summary) {
          summaries[summary.summaryDate] = {
            summary_date: summary.summaryDate,
            diary_status: summary.diaryStatus,
            diary_doc_anchor: summary.diaryDocAnchor || null
          };
          return summaries[summary.summaryDate];
        }
      },
      DocumentRepository: {
        countDiaryEntryAnchors: function() {
          return 0;
        },
        findDiaryEntryAnchor: function() {
          return null;
        }
      },
      QueueService: {
        requeueDeadDiaryAsNewEvent: function(sourceEventId, manualRequestId) {
          var repair = {
            eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            eventType: 'DIARY_GENERATE',
            dedupeKey: 'DIARY_GENERATE_REPAIR:2026-07-10:' + manualRequestId,
            payload: { diaryDate: '2026-07-10' },
            status: 'PENDING',
            createdAt: '2026-07-11T09:00:00+09:00'
          };
          events.unshift(repair);
          return repair;
        }
      },
      GeminiClient: {
        generateStructured: function() {
          throw new Error('Gemini must not run for a no-content backlog item.');
        }
      },
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      var first = DiaryService.repairGenerationBacklog();
      var second = DiaryService.repairGenerationBacklog();
      assert(first.completedEventsReconciled === 1, 'The stale completed event should be reconciled once.');
      assert(first.deadRepairEventsEnqueued === 1, 'The unresolved DEAD date should enqueue one repair.');
      assert(summaries['2026-07-09'].diary_status === 'NONE', 'The completed no-content date should finish as NONE.');
      assert(summaries['2026-07-10'].diary_status === 'PENDING', 'The repaired DEAD date should move to PENDING.');
      assert(second.completedEventsReconciled === 0, 'A second backlog pass must not reopen the completed date.');
      assert(second.deadRepairEventsEnqueued === 0, 'A second backlog pass must not enqueue another active repair.');
      assert(JSON.stringify(first).indexOf(completedEvent.eventId) === -1, 'Backlog results must not expose event ids.');
    });
  });

  return results;
}

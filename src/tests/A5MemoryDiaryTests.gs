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
      SheetRepository: {
        insertEvent: function(event) {
          if (inserted.length > 0) {
            throw createAppError('DUPLICATE_REQUEST', 'duplicate');
          }
          inserted.push(event);
        },
        getActiveEventByDedupeKey: function(dedupeKey) {
          return {
            eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            dedupeKey: dedupeKey
          };
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

  test('DiaryService.isGenerated checks summaries and document markers', function() {
    withOverrides({
      SheetRepository: {
        getDailySummary: function(date) {
          return date === '2026-07-07' ? { diary_status: 'DONE' } : null;
        }
      },
      DocumentRepository: {
        findDiaryEntryAnchor: function(date) {
          return date === '2026-07-08' ? 'AI Diary - 2026-07-08' : null;
        }
      }
    }, function() {
      assert(DiaryService.isGenerated('2026-07-07') === true, 'DONE summaries should count as generated.');
      assert(DiaryService.isGenerated('2026-07-08') === true, 'Document markers should count as generated.');
      assert(DiaryService.isGenerated('2026-07-09') === false, 'Missing summary and marker should be false.');
    });
  });

  test('DiaryService.generate appends once and skips duplicates', function() {
    var summaryRow = null;
    var appended = 0;
    var locks = [];
    withOverrides({
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
        appendDiaryEntry: function() {
          appended += 1;
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
              title: 'Quiet progress',
              observedConversation: 'We talked about planning a Kyoto trip for the fall.',
              inferredMoodContext: 'The user seemed hopeful and practical, based only on the planning tone.',
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
      assert(locks.indexOf('diary-generate-2026-07-07') !== -1, 'Diary generation should use a per-date lock.');
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

  return results;
}

function runA6QueueSchedulerTests() {
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

  test('QueueService.enqueue reuses active duplicate dedupe keys', function() {
    var inserted = [];
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getActiveEventByDedupeKey: function(dedupeKey) {
          return inserted.length ? inserted[0] : null;
        },
        insertEvent: function(event) {
          inserted.push(event);
          return event;
        }
      }
    }, function() {
      var first = QueueService.enqueue({
        eventType: 'DIARY_GENERATE',
        payload: {
          diaryDate: '2026-07-06',
          requestedAt: '2026-07-07T00:01:00+09:00'
        }
      });
      var second = QueueService.enqueue({
        eventType: 'DIARY_GENERATE',
        payload: {
          diaryDate: '2026-07-06',
          requestedAt: '2026-07-07T00:02:00+09:00'
        }
      });
      assert(inserted.length === 1, 'Only one event should be inserted.');
      assert(first.dedupeKey === 'DIARY_GENERATE:2026-07-06', 'Dedupe key should follow the A1 format.');
      assert(second.eventId === first.eventId, 'Second enqueue should return the existing event.');
    });
  });

  test('QueueService.enqueue does not reuse DEAD events', function() {
    var inserted = [];
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getActiveEventByDedupeKey: function() {
          return null;
        },
        insertEvent: function(event) {
          inserted.push(event);
          return event;
        }
      }
    }, function() {
      var event = QueueService.enqueue({
        eventType: 'DIARY_GENERATE',
        payload: {
          diaryDate: '2026-07-06',
          requestedAt: '2026-07-07T00:03:00+09:00'
        }
      });
      assert(inserted.length === 1, 'A new event should be inserted when only DEAD history exists.');
      assert(event.eventId === inserted[0].eventId, 'Inserted event should be returned.');
    });
  });

  test('claimBatch transitions PENDING and RETRY_WAIT to PROCESSING only', function() {
    var patches = [];
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        listClaimableEvents: function() {
          return [{
            eventId: '11111111-1111-4111-8111-111111111111',
            status: 'PENDING'
          }, {
            eventId: '22222222-2222-4222-8222-222222222222',
            status: 'RETRY_WAIT'
          }];
        },
        updateEvent: function(eventId, patch) {
          patches.push({
            eventId: eventId,
            patch: patch
          });
        },
        getEventById: function(eventId) {
          return {
            eventId: eventId,
            status: 'PROCESSING'
          };
        }
      }
    }, function() {
      var claimed = QueueService.claimBatch(2, 'worker-1', '2026-07-07T09:00:00+09:00');
      assert(claimed.length === 2, 'Both eligible events should be claimed.');
      assert(patches[0].patch.status === 'PROCESSING', 'Claim should move the event to PROCESSING.');
      assert(patches[1].patch.lockedBy === 'worker-1', 'Claim should record the worker id.');
    });
  });

  test('listClaimableEvents respects PENDING nextAttemptAt due time', function() {
    var rows = [{
      event_id: '11111111-1111-4111-8111-111111111111',
      event_type: 'CHAT_REPLY',
      dedupe_key: 'CHAT_REPLY:1',
      payload_json: {},
      status: 'PENDING',
      attempt_count: 0,
      next_attempt_at: null,
      locked_at: null,
      locked_by: null,
      created_at: '2026-07-07T09:00:00+09:00',
      updated_at: '2026-07-07T09:00:00+09:00',
      completed_at: null,
      last_error_code: null,
      last_error_message: null
    }, {
      event_id: '22222222-2222-4222-8222-222222222222',
      event_type: 'CHAT_REPLY',
      dedupe_key: 'CHAT_REPLY:2',
      payload_json: {},
      status: 'PENDING',
      attempt_count: 0,
      next_attempt_at: '2026-07-07T09:05:00+09:00',
      locked_at: null,
      locked_by: null,
      created_at: '2026-07-07T09:01:00+09:00',
      updated_at: '2026-07-07T09:01:00+09:00',
      completed_at: null,
      last_error_code: null,
      last_error_message: null
    }, {
      event_id: '33333333-3333-4333-8333-333333333333',
      event_type: 'CHAT_REPLY',
      dedupe_key: 'CHAT_REPLY:3',
      payload_json: {},
      status: 'PENDING',
      attempt_count: 0,
      next_attempt_at: '2026-07-07T08:55:00+09:00',
      locked_at: null,
      locked_by: null,
      created_at: '2026-07-07T09:02:00+09:00',
      updated_at: '2026-07-07T09:02:00+09:00',
      completed_at: null,
      last_error_code: null,
      last_error_message: null
    }];

    var claimable =
      SheetRepository.__test.selectClaimableEvents(
        rows,
        10,
        '2026-07-07T09:00:00+09:00'
      );

    assert(
      claimable.length === 2,
      'Only due PENDING events should be claimable.'
    );
    assert(
      claimable[0].eventId ===
        '11111111-1111-4111-8111-111111111111',
      'Null nextAttemptAt PENDING should be claimable.'
    );
    assert(
      claimable[1].eventId ===
        '33333333-3333-4333-8333-333333333333',
      'Past-due PENDING should be claimable.'
    );
  });

  test('DONE and DEAD are not claimable', function() {
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        listClaimableEvents: function() {
          return [];
        }
      }
    }, function() {
      var claimed = QueueService.claimBatch(5, 'worker-1', '2026-07-07T09:00:00+09:00');
      assert(claimed.length === 0, 'No DONE or DEAD events should be claimed.');
    });
  });

  test('markDone only allows PROCESSING', function() {
    var thrown = null;
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getEventById: function() {
          return {
            eventId: '11111111-1111-4111-8111-111111111111',
            status: 'PENDING'
          };
        }
      }
    }, function() {
      try {
        QueueService.markDone('11111111-1111-4111-8111-111111111111', {});
      } catch (error) {
        thrown = error;
      }
      assert(thrown && thrown.code === 'VALIDATION_REQUEST_INVALID', 'markDone should reject non-PROCESSING states.');
    });
  });

  test('markDone clears persisted lastError fields', function() {
    var updatedPatch = null;
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getEventById: function() {
          return {
            eventId: '11111111-1111-4111-8111-111111111111',
            status: 'PROCESSING',
            attemptCount: 1,
            lastError: {
              code: 'GEMINI_TEMPORARY_FAILURE',
              message: 'temporary'
            }
          };
        },
        updateEvent: function(_, patch) {
          updatedPatch = patch;
        }
      }
    }, function() {
      QueueService.markDone('11111111-1111-4111-8111-111111111111', {
        createdAt: '2026-07-07T09:00:00+09:00'
      });
      assert(updatedPatch.lastError === null, 'markDone should clear lastError.');
    });
  });

  test('markRetry increments attempts and eventually marks DEAD', function() {
    var patches = [];
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getEventById: function() {
          return {
            eventId: '11111111-1111-4111-8111-111111111111',
            status: 'PROCESSING',
            attemptCount: 4
          };
        },
        updateEvent: function(eventId, patch) {
          patches.push({
            eventId: eventId,
            patch: patch
          });
        }
      }
    }, function() {
      QueueService.markRetry(
        '11111111-1111-4111-8111-111111111111',
        createAppError('GEMINI_TEMPORARY_FAILURE', 'temporary'),
        '2026-07-07T09:05:00+09:00'
      );
      assert(patches[0].patch.status === 'DEAD', 'Fifth failure should move the event to DEAD.');
    });
  });

  test('recoverStale moves PROCESSING to RETRY_WAIT without incrementing attempts', function() {
    var patches = [];
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      ConfigRepository: {
        getByKey: function() {
          return { value: 15 };
        }
      },
      SheetRepository: {
        listStaleProcessingEvents: function() {
          return [{
            eventId: '11111111-1111-4111-8111-111111111111'
          }];
        },
        updateEvent: function(eventId, patch) {
          patches.push({
            eventId: eventId,
            patch: patch
          });
        },
        getEventById: function() {
          return {
            eventId: '11111111-1111-4111-8111-111111111111',
            status: 'RETRY_WAIT'
          };
        }
      }
    }, function() {
      var recovered = QueueService.recoverStale('2026-07-07T09:00:00+09:00');
      assert(recovered.length === 1, 'One stale event should be recovered.');
      assert(patches[0].patch.status === 'RETRY_WAIT', 'Recovered events should move to RETRY_WAIT.');
      assert(!Object.prototype.hasOwnProperty.call(patches[0].patch, 'attemptCount'), 'Stale recovery should not change attemptCount.');
    });
  });

  test('requeueDeadAsNewEvent inserts a new event and leaves original DEAD event unchanged', function() {
    var inserted = null;
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getEventById: function() {
          return {
            eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eventType: 'CHAT_REPLY',
            status: 'DEAD',
            payload: {
              requestId: '11111111-1111-4111-8111-111111111111'
            }
          };
        },
        getEventByDedupeKey: function() {
          return null;
        },
        insertEvent: function(event) {
          inserted = event;
        }
      }
    }, function() {
      var event = QueueService.requeueDeadAsNewEvent(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '22222222-2222-4222-8222-222222222222',
        '2026-07-07T09:00:00+09:00'
      );
      assert(inserted.eventId !== 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Requeue must create a new event id.');
      assert(event.dedupeKey === 'CHAT_REPLY_MANUAL:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222', 'Manual retry should use the manual dedupe format.');
    });
  });

  test('requeueDeadAsNewEvent is idempotent for the same manual request id', function() {
    var existingRetry = {
      eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      eventType: 'CHAT_REPLY',
      status: 'DONE',
      dedupeKey: 'CHAT_REPLY_MANUAL:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
    };
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getEventById: function() {
          return {
            eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eventType: 'CHAT_REPLY',
            status: 'DEAD',
            payload: {
              requestId: '11111111-1111-4111-8111-111111111111'
            }
          };
        },
        getEventByDedupeKey: function() {
          return existingRetry;
        },
        insertEvent: function() {
          throw new Error('An idempotent retry must not insert another event.');
        }
      }
    }, function() {
      var result = QueueService.requeueDeadAsNewEvent(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '22222222-2222-4222-8222-222222222222',
        '2026-07-07T09:00:00+09:00'
      );
      assert(result.eventId === existingRetry.eventId, 'The existing manual retry should be returned.');
    });
  });

  test('requeueDeadDiaryAsNewEvent creates an idempotent repair event and preserves the DEAD event', function() {
    var inserted = null;
    var original = {
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      eventType: 'DIARY_GENERATE',
      status: 'DEAD',
      payload: {
        diaryDate: '2026-07-10',
        requestedAt: '2026-07-10T23:30:00+09:00'
      }
    };
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getEventById: function() {
          return original;
        },
        getEventByDedupeKey: function() {
          return null;
        },
        listEventsByType: function() {
          return [original];
        },
        insertEvent: function(event) {
          inserted = event;
        }
      }
    }, function() {
      var result = QueueService.requeueDeadDiaryAsNewEvent(
        original.eventId,
        '22222222-2222-4222-8222-222222222222',
        '2026-07-11T09:00:00+09:00'
      );
      assert(original.status === 'DEAD', 'The original diary event must remain DEAD.');
      assert(inserted != null && inserted.eventId !== original.eventId, 'Repair must create a new event.');
      assert(result.dedupeKey === 'DIARY_GENERATE_REPAIR:2026-07-10:22222222-2222-4222-8222-222222222222', 'Repair must use its own idempotency key.');
      assert(result.payload.originalEventId === original.eventId, 'Repair payload should retain the audit link.');
      assert(result.payload.manualRequestId === '22222222-2222-4222-8222-222222222222', 'Repair payload should retain the manual request id.');
    });
  });

  test('QueueService allows only one active diary event per date across dedupe formats', function() {
    var activeRepair = {
      eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      eventType: 'DIARY_GENERATE',
      dedupeKey: 'DIARY_GENERATE_REPAIR:2026-07-10:22222222-2222-4222-8222-222222222222',
      payload: {
        diaryDate: '2026-07-10'
      },
      status: 'PENDING',
      createdAt: '2026-07-11T09:00:00+09:00',
      updatedAt: '2026-07-11T09:00:00+09:00'
    };
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        listEventsByType: function() {
          return [activeRepair];
        },
        insertEvent: function() {
          throw new Error('A second active diary event must not be inserted.');
        }
      }
    }, function() {
      var result = QueueService.enqueue({
        eventType: 'DIARY_GENERATE',
        payload: {
          diaryDate: '2026-07-10',
          requestedAt: '2026-07-11T09:01:00+09:00'
        },
        status: 'PENDING',
        createdAt: '2026-07-11T09:01:00+09:00',
        updatedAt: '2026-07-11T09:01:00+09:00'
      });
      assert(result.eventId === activeRepair.eventId, 'The active repair event should win date-level deduplication.');
    });
  });

  test('assessDeadEventRecovery blocks replay of side-effecting events', function() {
    withOverrides({
      SheetRepository: {
        getEventById: function() {
          return {
            eventType: 'PROACTIVE_SEND',
            status: 'DEAD'
          };
        }
      }
    }, function() {
      var result = QueueService.assessDeadEventRecovery(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      );
      assert(result.action === 'DO_NOT_REPLAY', 'Proactive sends must not be replayed from DEAD.');
      assert(!Object.prototype.hasOwnProperty.call(result, 'eventId'), 'Assessment must not expose an event id.');
      assert(!Object.prototype.hasOwnProperty.call(result, 'payload'), 'Assessment must not expose a payload.');
    });
  });

  test('processQueueJob safely skips overlapping workers when the queue lock is busy', function() {
    var logged = null;
    withOverrides({
      QueueService: {
        recoverStale: function() {
          throw createAppError('QUEUE_LOCK_BUSY', 'busy');
        },
        claimBatch: function() {
          throw new Error('claimBatch should not run after a lock conflict.');
        }
      },
      AppLogger: {
        writeDebugLog: function(level, operation, message, details) {
          logged = {
            level: level,
            operation: operation,
            message: message,
            details: details
          };
        }
      }
    }, function() {
      var result = processQueueJob();
      assert(result.skipped === true, 'The overlapping worker should be skipped.');
      assert(result.reason === 'QUEUE_LOCK_BUSY', 'The skip reason should be machine-readable.');
      assert(result.claimedCount === 0, 'A skipped worker must not claim events.');
      assert(logged && logged.level === 'WARN', 'The safe skip should be recorded as a warning.');
    });
  });

  test('processQueueJob dispatches each event type and isolates failures', function() {
    var processed = [];
    var dead = [];
    var done = [];
    withOverrides({
      QueueService: {
        recoverStale: function() {},
        claimBatch: function() {
          return [{
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'MEMORY_EXTRACT',
            payload: {}
          }, {
            eventId: '22222222-2222-4222-8222-222222222222',
            eventType: 'DIARY_GENERATE',
            payload: {}
          }];
        },
        markDone: function(eventId) {
          done.push(eventId);
        },
        markRetry: function() {
          throw new Error('markRetry should not be called in this test.');
        },
        markDead: function(eventId) {
          dead.push(eventId);
        }
      },
      MemoryService: {
        extract: function() {
          processed.push('MEMORY_EXTRACT');
          return {};
        }
      },
      DiaryService: {
        generate: function() {
          processed.push('DIARY_GENERATE');
          throw createAppError('VALIDATION_REQUEST_INVALID', 'bad payload');
        }
      },
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      processQueueJob();
      assert(processed[0] === 'MEMORY_EXTRACT' && processed[1] === 'DIARY_GENERATE', 'Both events should be dispatched.');
      assert(done.length === 1 && dead.length === 1, 'One failing event should not stop the next transition handling.');
    });
  });

  test('MAIL_QUOTA_EXHAUSTED uses next-day retry window instead of short retry', function() {
    var retried = null;
    var targetDate = formatDateInTokyo(
      new Date(new Date().getTime() + 2 * 24 * 60 * 60 * 1000)
    );

    withOverrides({
      QueueService: {
        recoverStale: function() {},
        claimBatch: function() {
          return [{
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'PROACTIVE_SEND',
            attemptCount: 0,
            payload: {
              targetDate: targetDate
            }
          }];
        },
        markDone: function() {},
        markRetry: function(eventId, error, nextAttemptAt) {
          retried = {
            eventId: eventId,
            error: error,
            nextAttemptAt: nextAttemptAt
          };
        },
        markDead: function() {}
      },
      ProactiveMessageService: {
        evaluateLocalConditions: function() {
          throw new Error('Dispatch must not rerun enqueue probability.');
        },
        prepareDispatch: function() {
          return {
            eligible: false,
            reason: 'MAIL_QUOTA_EXHAUSTED',
            message: null,
            createdAt: toIsoStringInTokyo(new Date())
          };
        }
      },
      RetryPolicy: RetryPolicy,
      SheetRepository: {
        incrementUsageDaily: function() {}
      },
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      processQueueJob();
      assert(retried != null, 'Mail quota failures should be retried.');
      assert(
        Utilities.formatDate(
          retried.nextAttemptAt,
          APP_CONSTANTS.TIME_ZONE,
          'HH:mm'
        ) === APP_CONSTANTS.DAILY_MAIL_RETRY_TIME,
        'Mail quota retry should use the configured daily retry window.'
      );
    });
  });

  test('PROACTIVE_SEND preserves the enqueue decision and skips after new user activity', function() {
    var done = [];
    var sendCalls = 0;
    var originalPayload = {
      targetDate: '2099-07-07',
      sequence: 1,
      requestedAt: '2099-07-07T09:00:00+09:00',
      decisionSlot: '11355801',
      messageDedupeKey: 'PROACTIVE_MESSAGE:2099-07-07:1',
      probability: 0.5,
      sample: 0.25,
      elapsedMinutes: 300,
      timeWeight: 1,
      reason: 'deterministic_probability_hit'
    };

    withOverrides({
      QueueService: {
        recoverStale: function() {},
        claimBatch: function() {
          return [{
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'PROACTIVE_SEND',
            attemptCount: 1,
            payload: originalPayload
          }];
        },
        markDone: function(eventId) {
          done.push(eventId);
        },
        markRetry: function() {
          throw new Error('markRetry should not be called.');
        },
        markDead: function() {
          throw new Error('markDead should not be called.');
        }
      },
      ProactiveMessageService: {
        evaluateLocalConditions: function() {
          throw new Error('Dispatch must not rerun enqueue probability.');
        },
        prepareDispatch: function(payload) {
          assert(
            payload === originalPayload,
            'Dispatch must use the queued decision payload.'
          );
          return {
            eligible: false,
            reason: 'USER_ACTIVITY_AFTER_ENQUEUE',
            message: null,
            createdAt: '2099-07-07T09:05:00+09:00'
          };
        },
        send: function() {
          sendCalls += 1;
        }
      },
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      processQueueJob();
      assert(done.length === 1, 'A safety skip should finish the event.');
      assert(sendCalls === 0, 'A safety skip must not send a message.');
    });
  });

  test('PROACTIVE_SEND sends without rerolling the queued probability decision', function() {
    var sentBodies = [];
    var originalPayload = {
      targetDate: '2099-07-08',
      sequence: 1,
      requestedAt: '2099-07-08T08:00:00+09:00',
      decisionSlot: '11355824',
      messageDedupeKey: 'PROACTIVE_MESSAGE:2099-07-08:1',
      probability: 0.6,
      sample: 0.2,
      elapsedMinutes: 360,
      timeWeight: 1,
      reason: 'deterministic_probability_hit'
    };

    withOverrides({
      QueueService: {
        recoverStale: function() {},
        claimBatch: function() {
          return [{
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'PROACTIVE_SEND',
            attemptCount: 1,
            payload: originalPayload
          }];
        },
        markDone: function() {},
        markRetry: function() {
          throw new Error('markRetry should not be called.');
        },
        markDead: function() {
          throw new Error('markDead should not be called.');
        }
      },
      ProactiveMessageService: {
        evaluateLocalConditions: function() {
          throw new Error('Dispatch must not rerun enqueue probability.');
        },
        prepareDispatch: function(payload) {
          assert(
            payload.sample === 0.2 &&
              payload.probability === 0.6 &&
              payload.decisionSlot === '11355824',
            'Dispatch must retain the original probability decision.'
          );
          return {
            eligible: true,
            reason: 'READY',
            message: {
              targetDate: payload.targetDate,
              sequence: payload.sequence,
              dedupeKey: payload.messageDedupeKey,
              subject: 'Prepared',
              body: 'Prepared from the original decision.',
              sentAt: '2099-07-08T08:05:00+09:00'
            },
            createdAt: '2099-07-08T08:05:00+09:00'
          };
        },
        send: function(payload) {
          sentBodies.push(payload.body);
          return {
            sent: true,
            createdAt: payload.sentAt
          };
        }
      },
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      processQueueJob();
      assert(sentBodies.length === 1, 'Prepared proactive message should be sent once.');
      assert(
        sentBodies[0] === 'Prepared from the original decision.',
        'The dispatch-prepared body should be sent.'
      );
    });
  });

  test('schedulerJob avoids duplicate diary, memory, proactive, and weekly backup insertions', function() {
    var queued = [];
    var proactiveEvent = null;
    withOverrides({
      MaintenanceService: {
        runPeriodicMaintenance: function() {
          return {};
        }
      },
      ProactiveMessageService: {
        evaluateLocalConditions: function() {
          return {
            eligible: true,
            reason: 'ELIGIBLE',
            dedupeKey: 'PROACTIVE_SEND:2026-07-07:1:495720',
            payload: {
              targetDate: '2026-07-07',
              sequence: 1,
              requestedAt: '2026-07-07T09:00:00+09:00',
              decisionSlot: '495720',
              messageDedupeKey: 'PROACTIVE_MESSAGE:2026-07-07:1',
              probability: 1,
              sample: 0,
              elapsedMinutes: 240,
              timeWeight: 1,
              reason: 'local_silence_threshold'
            }
          };
        }
      },
      QueueService: {
        enqueue: function(event) {
          if (event.eventType === 'PROACTIVE_SEND') {
            proactiveEvent = event;
          }
          queued.push(event.dedupeKey);
          return {
            eventId: generateUuidV4(),
            dedupeKey: event.dedupeKey
          };
        }
      },
      DiaryService: {
        getLifecycleState: function() {
          return {
            status: 'MISSING'
          };
        },
        enqueue: function(date) {
          queued.push('DIARY_GENERATE:' + date);
          return {
            enqueued: true
          };
        }
      },
      SheetRepository: {
        ensureDefaultUserState: function() {
          return {
            last_memory_cursor: null
          };
        },
        getEventByDedupeKey: function() {
          return null;
        },
        listRecentMessages: function() {
          return [{
            messageId: '11111111-1111-4111-8111-111111111111',
            role: 'user'
          }, {
            messageId: '22222222-2222-4222-8222-222222222222',
            role: 'assistant'
          }, {
            messageId: '33333333-3333-4333-8333-333333333333',
            role: 'user'
          }, {
            messageId: '44444444-4444-4444-8444-444444444444',
            role: 'assistant'
          }, {
            messageId: '55555555-5555-4555-8555-555555555555',
            role: 'user'
          }, {
            messageId: '66666666-6666-4666-8666-666666666666',
            role: 'assistant'
          }, {
            messageId: '77777777-7777-4777-8777-777777777777',
            role: 'user'
          }, {
            messageId: '88888888-8888-4888-8888-888888888888',
            role: 'assistant'
          }, {
            messageId: '99999999-9999-4999-8999-999999999999',
            role: 'user'
          }, {
            messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            role: 'assistant'
          }];
        },
        listMessagesAfter: function() {
          return [];
        }
      },
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            DIARY_DUE_TIME: { value: '00:00' },
            MEMORY_EXTRACT_INTERVAL: { value: 10 }
          };
          return values[key] || null;
        }
      },
      MemoryService: {
        enqueueExtraction: function(range) {
          queued.push('MEMORY_EXTRACT:' + range.firstMessageId + ':' + range.lastMessageId);
          return {
            enqueued: true
          };
        }
      },
      OperationalHealthService: {
        run: function() {
          return {
            status: 'OK'
          };
        }
      },
      ScriptApp: {
        getProjectTriggers: function() {
          return [{
            getHandlerFunction: function() {
              return 'processQueueJob';
            }
          }, {
            getHandlerFunction: function() {
              return 'schedulerJob';
            }
          }];
        }
      }
    }, function() {
      schedulerJob();
      assert(queued.indexOf('PROACTIVE_SEND:2026-07-07:1:495720') !== -1, 'Proactive event should be queued.');
      assert(
        proactiveEvent != null &&
          proactiveEvent.nextAttemptAt ===
            '2026-07-07T09:00:00+09:00' &&
          proactiveEvent.createdAt ===
            '2026-07-07T09:00:00+09:00' &&
          proactiveEvent.updatedAt ===
            '2026-07-07T09:00:00+09:00',
        'Proactive queue timestamps must use requestedAt.'
      );
      assert(queued.some(function(item) { return item.indexOf('DIARY_GENERATE:') === 0; }), 'Diary event should be queued.');
      assert(queued.some(function(item) { return item.indexOf('MEMORY_EXTRACT:') === 0; }), 'Memory extraction should be queued.');
      assert(queued.some(function(item) { return item.indexOf('WEEKLY_BACKUP:') === 0; }) === false, 'Weekly backup should respect the current window.');
    });
  });

  test('scheduler does not automatically replay terminal or in-progress diary states', function() {
    var enqueueCalls = 0;
    var currentDiaryStatus = 'PENDING';
    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          return key === 'DIARY_DUE_TIME' ? { value: '00:00' } : null;
        }
      },
      DiaryService: {
        getLifecycleState: function() {
          return {
            status: currentDiaryStatus
          };
        },
        enqueue: function() {
          enqueueCalls += 1;
          return { enqueued: true };
        }
      }
    }, function() {
      var statuses = ['PENDING', 'NONE', 'FAILED', 'INCONSISTENT', 'DONE'];
      for (var i = 0; i < statuses.length; i += 1) {
        currentDiaryStatus = statuses[i];
        var result = enqueueDiaryIfDue_(new Date('2026-07-11T09:00:00+09:00'));
        assert(result.enqueued === false, statuses[i] + ' must not be auto-enqueued.');
      }
      assert(enqueueCalls === 0, 'Terminal and in-progress states must not call DiaryService.enqueue.');
    });
  });

  test('terminal DIARY_GENERATE failure records FAILED after preserving the DEAD transition', function() {
    var deadCalls = 0;
    var failedCalls = 0;
    withOverrides({
      QueueService: {
        markDead: function() {
          deadCalls += 1;
        }
      },
      DiaryService: {
        markFailed: function() {
          failedCalls += 1;
          return { marked: true };
        }
      },
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      handleQueueFailure_({
        eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        eventType: 'DIARY_GENERATE',
        attemptCount: 0,
        payload: {
          diaryDate: '2026-07-10',
          requestedAt: '2026-07-10T23:30:00+09:00'
        }
      }, createAppError('CONFIG_MISSING', 'missing'), 'correlation');
      assert(deadCalls === 1, 'The queue event must become DEAD first.');
      assert(failedCalls === 1, 'The diary summary must become FAILED after terminal queue failure.');
    });
  });

  test('OperationalHealthService reports only aggregate queue and trigger health', function() {
    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            OPS_QUEUE_DELAY_GRACE_MINUTES: { value: 20 },
            QUEUE_STALE_MINUTES: { value: 15 },
            OPS_DEAD_LOOKBACK_HOURS: { value: 168 }
          };
          return values[key] || null;
        }
      },
      SheetRepository: {
        listEvents: function() {
          return [{
            eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eventType: 'CHAT_REPLY',
            status: 'PROCESSING',
            lockedAt: '2026-07-07T08:30:00+09:00',
            createdAt: '2026-07-07T08:30:00+09:00',
            payload: { privateText: 'must-not-appear' }
          }, {
            eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            eventType: 'DIARY_GENERATE',
            status: 'DEAD',
            completedAt: '2026-07-07T08:45:00+09:00',
            createdAt: '2026-07-07T08:00:00+09:00',
            lastError: {
              code: 'GEMINI_BAD_RESPONSE',
              message: 'private failure detail'
            }
          }, {
            eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            eventType: 'MEMORY_EXTRACT',
            status: 'PENDING',
            createdAt: '2026-07-07T08:00:00+09:00'
          }];
        }
      }
    }, function() {
      var report = OperationalHealthService.inspect(
        new Date('2026-07-07T09:00:00+09:00'),
        {
          required: {
            processQueueJob: { count: 1 },
            schedulerJob: { count: 1 }
          },
          missingCount: 0,
          duplicateCount: 0,
          unexpectedCount: 0
        }
      );
      var serialized = JSON.stringify(report);
      assert(report.status === 'CRITICAL', 'A stale PROCESSING event should be critical.');
      assert(report.queue.recentDead.total === 1, 'Recent DEAD events should be counted.');
      assert(report.queue.overdue.pending === 1, 'Overdue PENDING events should be counted.');
      assert(serialized.indexOf('must-not-appear') === -1, 'Payload content must not appear in health output.');
      assert(serialized.indexOf('private failure detail') === -1, 'Error messages must not appear in health output.');
      assert(serialized.indexOf('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') === -1, 'Event ids must not appear in health output.');
    });
  });

  test('OperationalHealthService treats a newer DONE diary repair as resolving an immutable DEAD event', function() {
    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            OPS_QUEUE_DELAY_GRACE_MINUTES: { value: 20 },
            QUEUE_STALE_MINUTES: { value: 15 },
            OPS_DEAD_LOOKBACK_HOURS: { value: 168 }
          };
          return values[key] || null;
        }
      },
      SheetRepository: {
        listEvents: function() {
          return [{
            eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eventType: 'DIARY_GENERATE',
            status: 'DEAD',
            payload: { diaryDate: '2026-07-10' },
            completedAt: '2026-07-10T23:45:00+09:00',
            lastError: { code: 'GEMINI_BAD_RESPONSE', message: 'private detail' }
          }, {
            eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            eventType: 'DIARY_GENERATE',
            status: 'DONE',
            payload: { diaryDate: '2026-07-10' },
            completedAt: '2026-07-11T09:05:00+09:00'
          }];
        }
      }
    }, function() {
      var report = OperationalHealthService.inspect(
        new Date('2026-07-11T10:00:00+09:00'),
        {
          required: {
            processQueueJob: { count: 1 },
            schedulerJob: { count: 1 }
          }
        }
      );
      assert(report.status === 'OK', 'A successfully repaired diary should no longer degrade health.');
      assert(report.queue.byStatus.DEAD === 1, 'The immutable DEAD event must remain in audit counts.');
      assert(report.queue.recentDead.total === 0, 'Resolved DEAD should not count as unresolved.');
      assert(report.queue.recentDead.resolvedTotal === 1, 'Resolved DEAD should be reported as retained audit history.');
    });
  });

  test('OperationalHealthService rate-limits sanitized reports and keeps email opt-in', function() {
    var propertyValue = null;
    var logCount = 0;
    var emailCount = 0;
    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            OPS_QUEUE_DELAY_GRACE_MINUTES: { value: 20 },
            QUEUE_STALE_MINUTES: { value: 15 },
            OPS_DEAD_LOOKBACK_HOURS: { value: 168 },
            OPS_ALERT_COOLDOWN_MINUTES: { value: 720 },
            OPS_ALERT_EMAIL_ENABLED: { value: false }
          };
          return values[key] || null;
        }
      },
      SheetRepository: {
        listEvents: function() {
          return [];
        }
      },
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function(key) {
              return key === APP_CONSTANTS.PROPERTY_KEYS.OPS_ALERT_STATE
                ? propertyValue
                : null;
            },
            setProperty: function(key, value) {
              if (key === APP_CONSTANTS.PROPERTY_KEYS.OPS_ALERT_STATE) {
                propertyValue = value;
              }
            }
          };
        }
      },
      AppLogger: {
        writeDebugLog: function() {
          logCount += 1;
        }
      },
      GmailNotifier: {
        send: function() {
          emailCount += 1;
        }
      }
    }, function() {
      var triggerHealth = {
        required: {
          processQueueJob: { count: 0 },
          schedulerJob: { count: 1 }
        },
        unexpectedCount: 0
      };
      var first = OperationalHealthService.run(
        new Date('2026-07-07T09:00:00+09:00'),
        triggerHealth
      );
      var second = OperationalHealthService.run(
        new Date('2026-07-07T09:15:00+09:00'),
        triggerHealth
      );
      assert(first.status === 'CRITICAL', 'A missing trigger should be critical.');
      assert(first.notification.logged === true, 'The first incident should be logged.');
      assert(second.notification.logged === false, 'The repeated incident should respect cooldown.');
      assert(logCount === 1, 'Only one incident log should be written during cooldown.');
      assert(emailCount === 0, 'Operational email must remain disabled by default.');
    });
  });

  test('OperationalHealthService defers reporting safely when the script lock is busy', function() {
    var warnings = 0;
    withOverrides({
      ConfigRepository: {
        getByKey: function() {
          return null;
        }
      },
      SheetRepository: {
        listEvents: function() {
          return [];
        }
      },
      LockManager: {
        withScriptLock: function() {
          throw createAppError('QUEUE_LOCK_BUSY', 'busy');
        }
      },
      AppLogger: {
        warn: function() {
          warnings += 1;
        }
      }
    }, function() {
      var result = OperationalHealthService.run(
        new Date('2026-07-07T09:00:00+09:00'),
        {
          required: {
            processQueueJob: { count: 1 },
            schedulerJob: { count: 1 }
          }
        }
      );
      assert(result.status === 'OK', 'The read-only health result should still be returned.');
      assert(result.notification.reason === 'QUEUE_LOCK_BUSY', 'Reporting should be deferred explicitly.');
      assert(warnings === 1, 'The deferred report should write one console warning.');
    });
  });

  test('enqueueWeeklyBackupIfDue does not create a new event when DONE backup already exists', function() {
    var enqueueCalls = 0;
    withOverrides({
      SheetRepository: {
        getEventByDedupeKey: function(dedupeKey) {
          assert(dedupeKey === 'WEEKLY_BACKUP:2026-07-12', 'Weekly backup dedupe key should use the Tokyo date.');
          return {
            eventId: '11111111-1111-4111-8111-111111111111',
            status: 'DONE'
          };
        }
      },
      QueueService: {
        enqueue: function() {
          enqueueCalls += 1;
          throw new Error('QueueService.enqueue should not run when a DONE weekly backup exists.');
        }
      }
    }, function() {
      var result = enqueueWeeklyBackupIfDue_(new Date('2026-07-12T03:15:00+09:00'));
      assert(result.enqueued === false, 'Existing DONE weekly backup should suppress auto-enqueue.');
      assert(result.reason === 'WEEKLY_BACKUP_ALREADY_EXISTS', 'Reason should explain why enqueue was skipped.');
      assert(result.status === 'DONE', 'Existing event status should be returned.');
      assert(enqueueCalls === 0, 'No new weekly backup event should be created.');
    });
  });

  test('enqueueWeeklyBackupIfDue does not create a new event when DEAD backup already exists', function() {
    var enqueueCalls = 0;
    withOverrides({
      SheetRepository: {
        getEventByDedupeKey: function() {
          return {
            eventId: '22222222-2222-4222-8222-222222222222',
            status: 'DEAD'
          };
        }
      },
      QueueService: {
        enqueue: function() {
          enqueueCalls += 1;
          throw new Error('QueueService.enqueue should not run when a DEAD weekly backup exists.');
        }
      }
    }, function() {
      var result = enqueueWeeklyBackupIfDue_(new Date('2026-07-12T04:00:00+09:00'));
      assert(result.enqueued === false, 'Existing DEAD weekly backup should suppress auto-enqueue.');
      assert(result.reason === 'WEEKLY_BACKUP_ALREADY_EXISTS', 'Reason should explain why enqueue was skipped.');
      assert(result.status === 'DEAD', 'Existing DEAD status should be returned.');
      assert(enqueueCalls === 0, 'No new weekly backup event should be created.');
    });
  });

  test('enqueueWeeklyBackupIfDue creates a new event only when none exists in the Sunday window', function() {
    var enqueued = null;
    withOverrides({
      SheetRepository: {
        getEventByDedupeKey: function(dedupeKey) {
          assert(dedupeKey === 'WEEKLY_BACKUP:2026-07-12', 'Weekly backup dedupe key should use the Tokyo date.');
          return null;
        }
      },
      QueueService: {
        enqueue: function(event) {
          enqueued = event;
          return {
            eventId: '33333333-3333-4333-8333-333333333333',
            dedupeKey: event.dedupeKey
          };
        }
      }
    }, function() {
      var result = enqueueWeeklyBackupIfDue_(new Date('2026-07-12T03:01:00+09:00'));
      assert(result.enqueued === true, 'A missing weekly backup should be enqueued in the Sunday window.');
      assert(result.eventId === '33333333-3333-4333-8333-333333333333', 'Created weekly backup event id should be returned.');
      assert(enqueued && enqueued.dedupeKey === 'WEEKLY_BACKUP:2026-07-12', 'The queued event should use the expected dedupe key.');
    });
  });

  test('proactive evaluation enforces quiet hours, max per day, cooldown, and mail quota', function() {
    withOverrides({
      SheetRepository: {
        ensureDefaultUserState: function() {},
        getUserState: function() {
          return {
            last_user_message_at: '2026-07-07T00:00:00+09:00',
            last_proactive_at: '2026-07-07T01:00:00+09:00',
            proactive_count_date: '2026-07-07',
            proactive_count: 2,
            next_proactive_check_at: null,
            quiet_until: null
          };
        }
      },
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            QUIET_START: { value: '23:00' },
            QUIET_END: { value: '08:00' },
            SILENCE_MINUTES: { value: 240 },
            PROACTIVE_COOLDOWN_MINUTES: { value: 240 },
            PROACTIVE_MAX_PER_DAY: { value: 2 }
          };
          return values[key];
        }
      },
      GmailNotifier: {
        getRemainingQuota: function() {
          return 0;
        }
      }
    }, function() {
      var quiet = ProactiveMessageService.evaluateLocalConditions('2026-07-07T07:00:00+09:00');
      var capped = ProactiveMessageService.evaluateLocalConditions('2026-07-07T12:00:00+09:00');
      assert(quiet.reason === 'QUIET_HOURS', 'Quiet hours should block proactive messages.');
      assert(capped.reason === 'MAX_PER_DAY_REACHED' || capped.reason === 'COOLDOWN_ACTIVE', 'Daily cap or cooldown should block proactive messages.');
    });
  });

  test('ProactiveMessageService renders subject and body from spreadsheet config templates', function() {
    withOverrides({
      ConfigRepository: {
        getByKey: function(key) {
          var values = {
            PARTNER_NAME: { value: 'PartnerX' },
            USER_NAME: { value: 'UserY' },
            SYSTEM_PERSONA: { value: 'Configured persona.' },
            PROACTIVE_MESSAGE_STYLE: { value: 'Brief and calm.' },
            PROACTIVE_SUBJECT_TEMPLATE: { value: '{partnerName} to {userName} ({targetDate})' },
            PROACTIVE_BODY_TEMPLATE: { value: 'Hello {userName}. From {partnerName}. Last: {lastUserMessageAt}. Style: {messageStyle}. Now: {now}.' }
          };
          return values[key] || null;
        }
      }
    }, function() {
      var state = {
        last_user_message_at: '2026-07-07T06:30:00+09:00'
      };
      var subject = ProactiveMessageService.__test.buildSubject(
        '2026-07-07',
        state,
        '2026-07-07T12:00:00+09:00'
      );
      var body = ProactiveMessageService.__test.buildBody(
        state,
        '2026-07-07T12:00:00+09:00',
        '2026-07-07'
      );

      assert(subject === 'PartnerX to UserY (2026-07-07)', 'Subject should use spreadsheet template placeholders.');
      assert(body.indexOf('Hello UserY. From PartnerX.') !== -1, 'Body should include configured names.');
      assert(body.indexOf('Last: 7/7 6:30.') !== -1, 'Body should include formatted last user message time.');
      assert(body.indexOf('Style: Brief and calm.') !== -1, 'Body should expose proactive message style placeholder.');
      assert(body.indexOf('Now: 2026-07-07T12:00:00+09:00.') !== -1, 'Body should include generation timestamp.');
    });
  });

  test('GmailNotifier does not send when quota is zero', function() {
    var thrown = null;
    withOverrides({
      MailApp: {
        getRemainingDailyQuota: function() {
          return 0;
        },
        sendEmail: function() {
          throw new Error('sendEmail should not be called.');
        }
      }
    }, function() {
      try {
        GmailNotifier.send('owner@example.com', 'Hello', 'Test body');
      } catch (error) {
        thrown = error;
      }
      assert(thrown && thrown.code === 'MAIL_QUOTA_EXHAUSTED', 'Quota exhaustion should be surfaced before sendEmail.');
    });
  });

  test('ProactiveMessageService.send claims a marker before mail and completes it after success', function() {
    var storedMarker = null;
    var appendCalls = 0;
    var updateCalls = [];
    var usageCalls = 0;

    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function(key) {
              if (key === APP_CONSTANTS.PROPERTY_KEYS.OWNER_EMAIL) {
                return 'owner@example.com';
              }
              return null;
            }
          };
        }
      },
      SheetRepository: {
        getMessageByRequestIdAndRole: function() {
          return storedMarker;
        },
        appendConversation: function(message) {
          appendCalls += 1;
          storedMarker = {
            messageId: message.messageId,
            requestId: message.requestId,
            createdAt: message.createdAt,
            status: message.status,
            messageType: message.messageType,
            text: message.text,
            model: message.model || null,
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens
          };
          return storedMarker;
        },
        updateConversationMessage: function(messageId, patch) {
          updateCalls.push(patch);
          Object.keys(patch).forEach(function(key) {
            if (key === 'error') {
              storedMarker.error = patch.error;
            } else {
              storedMarker[key] = patch[key];
            }
          });
          return storedMarker;
        },
        ensureDefaultUserState: function() {
          return {
            proactive_count_date: '2026-07-08',
            proactive_count: 0,
            last_proactive_at: null,
            next_proactive_check_at: null
          };
        },
        updateUserState: function() {},
        incrementUsageDaily: function() {
          usageCalls += 1;
        }
      },
      GmailNotifier: {
        send: function() {
          return {
            sent: true
          };
        }
      }
    }, function() {
      var result = ProactiveMessageService.send({
        targetDate: '2026-07-08',
        sequence: 1,
        dedupeKey: 'PROACTIVE_MESSAGE:2026-07-08:1',
        subject: 'Hello',
        body: 'Fresh proactive mail',
        sentAt: '2026-07-08T08:05:00+09:00'
      });

      assert(result.sent === true, 'Send should succeed.');
      assert(appendCalls === 1, 'One marker should be appended.');
      assert(
        updateCalls.some(function(patch) {
          return patch.status === 'completed';
        }),
        'Successful send should mark the marker completed.'
      );
      assert(storedMarker.status === 'completed', 'The marker should be completed.');
      assert(usageCalls === 1, 'Mail usage should be recorded once.');
    });
  });

  test('ProactiveMessageService.send retries a failed marker with the stored body and current attempt time', function() {
    var storedMarker = null;
    var appendCalls = 0;
    var sendCalls = 0;
    var sentBodies = [];
    var latestStatePatch = null;

    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function(key) {
              if (key === APP_CONSTANTS.PROPERTY_KEYS.OWNER_EMAIL) {
                return 'owner@example.com';
              }
              return null;
            }
          };
        }
      },
      SheetRepository: {
        getMessageByRequestIdAndRole: function() {
          return storedMarker;
        },
        appendConversation: function(message) {
          appendCalls += 1;
          storedMarker = {
            messageId: message.messageId,
            requestId: message.requestId,
            createdAt: message.createdAt,
            status: message.status,
            messageType: message.messageType,
            text: message.text,
            model: message.model || null,
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens
          };
          return storedMarker;
        },
        updateConversationMessage: function(messageId, patch) {
          Object.keys(patch).forEach(function(key) {
            if (key === 'error') {
              storedMarker.error = patch.error;
            } else {
              storedMarker[key] = patch[key];
            }
          });
          return storedMarker;
        },
        ensureDefaultUserState: function() {
          return {
            proactive_count_date: '2026-07-08',
            proactive_count: 0,
            last_proactive_at: null,
            next_proactive_check_at: null
          };
        },
        updateUserState: function(patch) {
          latestStatePatch = patch;
        },
        incrementUsageDaily: function() {}
      },
      GmailNotifier: {
        send: function(ownerEmail, subject, body) {
          sendCalls += 1;
          sentBodies.push(body);
          if (sendCalls === 1) {
            throw createAppError('MAIL_QUOTA_EXHAUSTED', 'quota');
          }
          return {
            sent: true
          };
        }
      }
    }, function() {
      var firstError = null;
      try {
        ProactiveMessageService.send({
          targetDate: '2026-07-08',
          sequence: 1,
          dedupeKey: 'PROACTIVE_MESSAGE:2026-07-08:1',
          subject: 'Hello',
          body: 'Stored proactive mail',
          sentAt: '2026-07-08T08:05:00+09:00'
        });
      } catch (error) {
        firstError = error;
      }

      assert(
        firstError && firstError.code === 'MAIL_QUOTA_EXHAUSTED',
        'The first failure should be surfaced.'
      );
      assert(storedMarker.status === 'failed', 'The marker should be failed.');

      var result = ProactiveMessageService.send({
        targetDate: '2026-07-08',
        sequence: 1,
        dedupeKey: 'PROACTIVE_MESSAGE:2026-07-08:1',
        subject: 'Hello',
        body: 'A replacement body that must not be used',
        sentAt: '2026-07-08T10:05:00+09:00'
      });

      assert(result.sent === true, 'The failed marker should be retried.');
      assert(result.duplicate === false, 'A failed marker is not completed.');
      assert(sendCalls === 2, 'Mail should be attempted twice.');
      assert(appendCalls === 1, 'Retry must reuse the original marker.');
      assert(
        sentBodies[1] === 'Stored proactive mail',
        'Retry must reuse the stored body.'
      );
      assert(
        storedMarker.createdAt === '2026-07-08T10:05:00+09:00',
        'Retry must update the marker to the actual attempt time.'
      );
      assert(storedMarker.status === 'completed', 'Retry should complete the marker.');
      assert(
        latestStatePatch &&
          latestStatePatch.last_proactive_at ===
            '2026-07-08T10:05:00+09:00',
        'Cooldown state must use the successful retry time.'
      );
    });
  });

  test('maintenance cleanup keeps non-expired temp files', function() {
    var trashed = 0;
    function iterator(items) {
      var index = 0;
      return {
        hasNext: function() {
          return index < items.length;
        },
        next: function() {
          return items[index++];
        }
      };
    }
    withOverrides({
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function() {
              return 'temp-folder-id';
            }
          };
        }
      },
      DriveApp: {
        getFolderById: function() {
          return {
            getFiles: function() {
              return iterator([{
                getId: function() {
                  return 'keep-me';
                },
                getLastUpdated: function() {
                  return new Date('2026-07-07T08:30:00+09:00');
                },
                getDateCreated: function() {
                  return new Date('2026-07-07T08:30:00+09:00');
                },
                setTrashed: function() {
                  trashed += 1;
                }
              }]);
            }
          };
        }
      }
    }, function() {
      var result = DriveTempRepository.cleanupExpiredTempImages(new Date('2026-07-07T09:00:00+09:00'), 24);
      assert(result.deletedCount === 0, 'Fresh temp files should not be deleted.');
      assert(trashed === 0, 'Fresh temp files should not be trashed.');
    });
  });

  test('QueueService.enqueue rejects incomplete PROACTIVE_SEND decision payloads', function() {
    var inserted = false;
    var thrown = null;

    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getActiveEventByDedupeKey: function() {
          return null;
        },
        insertEvent: function() {
          inserted = true;
        }
      }
    }, function() {
      try {
        QueueService.enqueue({
          eventType: 'PROACTIVE_SEND',
          payload: {
            targetDate: '2026-07-08',
            sequence: 1,
            requestedAt: '2026-07-08T08:00:00+09:00'
          }
        });
      } catch (error) {
        thrown = error;
      }

      assert(
        thrown && thrown.code === 'VALIDATION_REQUEST_INVALID',
        'Incomplete proactive decisions must be rejected.'
      );
      assert(inserted === false, 'Invalid payloads must not be inserted.');
    });
  });

  test('ProactiveMessageService.send suppresses a concurrent accepted marker', function() {
    var sendCalls = 0;

    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function() {
              return 'owner@example.com';
            }
          };
        }
      },
      SheetRepository: {
        getMessageByRequestIdAndRole: function() {
          return {
            messageId: '11111111-1111-4111-8111-111111111111',
            requestId: 'PROACTIVE_MESSAGE:2026-07-08:1',
            createdAt: '2026-07-08T08:05:00+09:00',
            role: 'system',
            messageType: 'proactive',
            text: 'Claimed proactive body',
            status: 'accepted'
          };
        }
      },
      GmailNotifier: {
        send: function() {
          sendCalls += 1;
        }
      }
    }, function() {
      var result = ProactiveMessageService.send({
        targetDate: '2026-07-08',
        sequence: 1,
        dedupeKey: 'PROACTIVE_MESSAGE:2026-07-08:1',
        subject: 'Hello',
        body: 'Claimed proactive body',
        sentAt: '2026-07-08T08:05:00+09:00'
      });

      assert(result.sent === false, 'The second claimant must not send.');
      assert(result.duplicate === true, 'The accepted marker must be treated as claimed.');
      assert(sendCalls === 0, 'Gmail must not be called by the second claimant.');
    });
  });

  return results;
}

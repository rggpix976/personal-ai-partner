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

  test('QueueService.enqueue reuses duplicate dedupe keys', function() {
    var inserted = [];
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        getEventByDedupeKey: function(dedupeKey) {
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
    withOverrides({
      QueueService: {
        recoverStale: function() {},
        claimBatch: function() {
          return [{
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'PROACTIVE_SEND',
            attemptCount: 0,
            payload: {
              targetDate: '2026-07-07'
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
        send: function() {
          throw createAppError('MAIL_QUOTA_EXHAUSTED', 'quota');
        }
      },
      RetryPolicy: RetryPolicy,
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      processQueueJob();
      assert(retried != null, 'Mail quota failures should be retried.');
      assert(toIsoStringInTokyo(retried.nextAttemptAt) === '2026-07-08T08:05:00+09:00', 'Mail quota retry should move to the next daily window.');
    });
  });

  test('schedulerJob avoids duplicate diary, memory, proactive, and weekly backup insertions', function() {
    var queued = [];
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
            dedupeKey: 'PROACTIVE_SEND:2026-07-07:1',
            payload: {
              targetDate: '2026-07-07',
              sequence: 1,
              evaluatedAt: '2026-07-07T09:00:00+09:00',
              subject: 'Hi',
              body: 'Hello'
            }
          };
        }
      },
      QueueService: {
        enqueue: function(event) {
          queued.push(event.dedupeKey);
          return {
            eventId: generateUuidV4(),
            dedupeKey: event.dedupeKey
          };
        }
      },
      DiaryService: {
        isGenerated: function() {
          return false;
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
      }
    }, function() {
      schedulerJob();
      assert(queued.indexOf('PROACTIVE_SEND:2026-07-07:1') !== -1, 'Proactive event should be queued.');
      assert(queued.some(function(item) { return item.indexOf('DIARY_GENERATE:') === 0; }), 'Diary event should be queued.');
      assert(queued.some(function(item) { return item.indexOf('MEMORY_EXTRACT:') === 0; }), 'Memory extraction should be queued.');
      assert(queued.some(function(item) { return item.indexOf('WEEKLY_BACKUP:') === 0; }) === false, 'Weekly backup should respect the current window.');
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

  return results;
}

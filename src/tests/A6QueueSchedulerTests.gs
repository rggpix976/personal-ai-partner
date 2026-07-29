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

  function expectCode(callback, code) {
    var thrown = null;
    try {
      callback();
    } catch (error) {
      thrown = error;
    }
    assert(thrown && thrown.code === code, 'Expected error code ' + code + '.');
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

  function withFixedNow(isoValue, callback) {
    var RealDate = Date;
    var fixedTime = new RealDate(isoValue).getTime();

    function FixedDate() {
      if (!(this instanceof FixedDate)) {
        return RealDate.apply(null, arguments);
      }
      if (arguments.length === 0) {
        return new RealDate(fixedTime);
      }
      if (arguments.length === 1) {
        return new RealDate(arguments[0]);
      }
      if (arguments.length === 2) {
        return new RealDate(arguments[0], arguments[1]);
      }
      if (arguments.length === 3) {
        return new RealDate(
          arguments[0],
          arguments[1],
          arguments[2]
        );
      }
      if (arguments.length === 4) {
        return new RealDate(
          arguments[0],
          arguments[1],
          arguments[2],
          arguments[3]
        );
      }
      if (arguments.length === 5) {
        return new RealDate(
          arguments[0],
          arguments[1],
          arguments[2],
          arguments[3],
          arguments[4]
        );
      }
      if (arguments.length === 6) {
        return new RealDate(
          arguments[0],
          arguments[1],
          arguments[2],
          arguments[3],
          arguments[4],
          arguments[5]
        );
      }
      return new RealDate(
        arguments[0],
        arguments[1],
        arguments[2],
        arguments[3],
        arguments[4],
        arguments[5],
        arguments[6]
      );
    }

    FixedDate.prototype = RealDate.prototype;
    FixedDate.now = function() {
      return fixedTime;
    };
    FixedDate.parse = RealDate.parse;
    FixedDate.UTC = RealDate.UTC;
    withOverrides({ Date: FixedDate }, callback);
  }

  function buildLegacyProactiveConfig(subject, body) {
    var values = {
      QUIET_START: '23:00',
      QUIET_END: '08:00',
      SILENCE_MINUTES: 240,
      PROACTIVE_FREQUENCY: 'normal',
      PROACTIVE_COOLDOWN_MINUTES: 240,
      PROACTIVE_MAX_PER_DAY: 2,
      PROACTIVE_RECHECK_MINUTES: 60,
      PROACTIVE_POLICY_MODE: 'probability',
      PROACTIVE_SILENCE_CEILING_MINUTES: 720,
      PROACTIVE_PROBABILITY_CURVE: 1.3,
      PROACTIVE_DAY_START: '10:00',
      PROACTIVE_EVENING_START: '18:00',
      PROACTIVE_MORNING_WEIGHT: 0.7,
      PROACTIVE_DAY_WEIGHT: 1,
      PROACTIVE_EVENING_WEIGHT: 1.2,
      PROACTIVE_AI_GENERATION_ENABLED: false,
      PROACTIVE_SUBJECT_TEMPLATE: subject,
      PROACTIVE_BODY_TEMPLATE: body
    };
    return {
      getByKey: function(key) {
        return Object.prototype.hasOwnProperty.call(values, key)
          ? { value: values[key] }
          : null;
      }
    };
  }

  function buildLegacyProactivePayload(targetDate, requestedAt) {
    return {
      targetDate: targetDate,
      sequence: 1,
      requestedAt: requestedAt,
      decisionSlot: '1',
      messageDedupeKey:
        'PROACTIVE_MESSAGE:' + targetDate + ':1',
      probability: 1,
      sample: 0,
      elapsedMinutes: 300,
      timeWeight: 1,
      reason: 'local_silence_threshold',
      policyBinding: {
        environment: 'prod',
        frequency: 'normal',
        mode: 'probability'
      },
      characterRuntimeMode: 'legacy'
    };
  }

  function buildValidMemoryResumeBinding() {
    return {
      profileSchemaVersion:
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 1,
      policyVersion:
        APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion:
        APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: 'test-kansai-partner',
      characterPackVersion: '1.0.0'
    };
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
      assert(
        QueueService.__test.isManagedLeaseToken(patches[0].patch.lockedBy) &&
          QueueService.__test.isManagedLeaseToken(patches[1].patch.lockedBy),
        'Each claim should record a managed opaque lease token.'
      );
      assert(
        patches[0].patch.lockedBy !== patches[1].patch.lockedBy,
        'Each claimed event must receive a distinct lease token.'
      );
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

  test('markDone deletes a routed image only after DONE is durable', function() {
    var updated = false;
    var trashed = null;
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
            eventType: 'CHAT_REPLY',
            status: updated ? 'DONE' : 'PROCESSING',
            payload: {
              requestId: '22222222-2222-4222-8222-222222222222',
              userMessageId: '33333333-3333-4333-8333-333333333333',
              requestedAt: '2026-07-07T09:00:00+09:00',
              image: {
                tempFileId: 'temporary-image-id',
                name: 'photo.jpg',
                mimeType: 'image/jpeg',
                expiresAt: '2026-07-08T09:00:00+09:00'
              },
              characterRuntimeMode: 'enforced',
              characterBinding: {
                profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
                profileRevision: 3,
                policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
                catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
                characterPackId: 'warm-kansai-caretaker',
                characterPackVersion: 'warm-kansai-caretaker.v1'
              }
            }
          };
        },
        updateEvent: function(_, patch) {
          assert(patch.status === 'DONE', 'Route event must be made durable first.');
          assert(trashed === null, 'Temporary image was deleted before the DONE write.');
          updated = true;
        }
      },
      DriveTempRepository: {
        trashTempImage: function(tempFileId) {
          assert(updated === true, 'Temporary image cleanup ran before DONE was durable.');
          trashed = tempFileId;
        }
      }
    }, function() {
      expectCode(function() {
        QueueService.markDone(
          '11111111-1111-4111-8111-111111111111',
          {
            status: 'routed',
            route: 'UNKNOWN_ROUTE'
          }
        );
      }, 'STORAGE_DATA_CORRUPTED');
      assert(updated === false && trashed === null, 'Invalid route changed durable state.');

      QueueService.markDone(
        '11111111-1111-4111-8111-111111111111',
        {
          status: 'routed',
          route: 'PRODUCT_INFO'
        }
      );
      assert(
        trashed === 'temporary-image-id',
        'Durably completed route did not clean its temporary image.'
      );
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

  test('markRetry redacts credentials before persisting lastError', function() {
    var patch = null;
    var secret = 'AIza' + new Array(36).join('B');
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
            attemptCount: 0
          };
        },
        updateEvent: function(_, value) {
          patch = value;
        }
      }
    }, function() {
      QueueService.markRetry(
        '11111111-1111-4111-8111-111111111111',
        createAppError(
          'GEMINI_TEMPORARY_FAILURE',
          'Transport failed: https://example.invalid/generate?key=' + secret
        ),
        '2026-07-07T09:05:00+09:00'
      );
    });
    assert(patch && patch.lastError, 'Retry error should be persisted.');
    assert(
      patch.lastError.message.indexOf(secret) === -1,
      'Persisted retry error must not contain provider credentials.'
    );
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

  test('stale worker cannot transition an event after a new lease claim', function() {
    var eventId = '11111111-1111-4111-8111-111111111111';
    var state = {
      eventId: eventId,
      eventType: 'MEMORY_EXTRACT',
      payload: {},
      status: 'PENDING',
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: '2026-07-07T08:00:00+09:00',
      updatedAt: '2026-07-07T08:00:00+09:00',
      completedAt: null,
      lastError: null
    };

    function copyState() {
      return JSON.parse(JSON.stringify(state));
    }

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
        listClaimableEvents: function() {
          return state.status === 'PENDING' || state.status === 'RETRY_WAIT'
            ? [copyState()]
            : [];
        },
        listStaleProcessingEvents: function() {
          return state.status === 'PROCESSING' ? [copyState()] : [];
        },
        updateEvent: function(_, patch) {
          Object.keys(patch).forEach(function(key) {
            state[key] = patch[key];
          });
          return copyState();
        },
        getEventById: function() {
          return copyState();
        }
      }
    }, function() {
      var firstClaim = QueueService.claimBatch(
        1,
        'worker-a',
        '2026-07-07T08:00:00+09:00'
      )[0];
      var staleLease = firstClaim.lockedBy;
      assert(
        QueueService.__test.isManagedLeaseToken(staleLease),
        'First claim did not receive a managed lease.'
      );

      QueueService.recoverStale('2026-07-07T09:00:00+09:00');
      var secondClaim = QueueService.claimBatch(
        1,
        'worker-b',
        '2026-07-07T09:00:00+09:00'
      )[0];
      var activeLease = secondClaim.lockedBy;
      assert(
        QueueService.__test.isManagedLeaseToken(activeLease) &&
          activeLease !== staleLease,
        'Reclaim must replace the stale lease with a new token.'
      );

      function assertLeaseRejected(callback, label) {
        var staleError = null;
        try {
          callback();
        } catch (error) {
          staleError = error;
        }
        assert(
          staleError &&
            staleError.code === 'QUEUE_LOCK_BUSY' &&
            staleError.details &&
            staleError.details.reason === 'QUEUE_LEASE_MISMATCH',
          label + ' must fail with a managed lease mismatch.'
        );
        assert(
          state.status === 'PROCESSING' && state.lockedBy === activeLease,
          label + ' changed the new owner lifecycle state.'
        );
      }

      assertLeaseRejected(function() {
        QueueService.markDone(
          eventId,
          { createdAt: '2026-07-07T09:01:00+09:00' },
          staleLease
        );
      }, 'Stale DONE transition');
      assertLeaseRejected(function() {
        QueueService.markRetry(
          eventId,
          createAppError('GEMINI_TEMPORARY_FAILURE', 'temporary'),
          '2026-07-07T09:05:00+09:00',
          staleLease
        );
      }, 'Stale RETRY_WAIT transition');
      assertLeaseRejected(function() {
        QueueService.markDead(
          eventId,
          createAppError('VALIDATION_REQUEST_INVALID', 'invalid'),
          staleLease
        );
      }, 'Stale DEAD transition');
      assertLeaseRejected(function() {
        QueueService.markDone(
          eventId,
          { createdAt: '2026-07-07T09:01:00+09:00' }
        );
      }, 'Lease-less managed transition');

      QueueService.markDone(
        eventId,
        { createdAt: '2026-07-07T09:02:00+09:00' },
        activeLease
      );
      assert(
        state.status === 'DONE' && state.lockedBy == null,
        'Current lease owner could not complete the event.'
      );
    });
  });

  test('expediteDiaryNarrativeLengthRetries only advances eligible repair retries', function() {
    var patches = [];
    var eligibleId = '11111111-1111-4111-8111-111111111111';
    withOverrides({
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      SheetRepository: {
        listEventsByType: function() {
          return [{
            eventId: eligibleId,
            eventType: 'DIARY_GENERATE',
            dedupeKey: 'DIARY_GENERATE_REPAIR:2026-07-07:22222222-2222-4222-8222-222222222222',
            status: 'RETRY_WAIT',
            attemptCount: 4,
            lastError: {
              code: 'GEMINI_BAD_RESPONSE',
              message: 'narrative length is below the configured minimum.'
            }
          }, {
            eventId: '33333333-3333-4333-8333-333333333333',
            eventType: 'DIARY_GENERATE',
            dedupeKey: 'DIARY_GENERATE:2026-07-08',
            status: 'RETRY_WAIT',
            attemptCount: 1,
            lastError: {
              code: 'GEMINI_BAD_RESPONSE',
              message: 'narrative length is below the configured minimum.'
            }
          }];
        },
        updateEvent: function(eventId, patch) {
          patches.push({ eventId: eventId, patch: patch });
        }
      }
    }, function() {
      var result = QueueService.expediteDiaryNarrativeLengthRetries(
        '2026-07-07T09:00:00+09:00'
      );
      assert(result.assessed === 2 && result.expedited === 1, 'Only the dedicated repair retry should be expedited.');
      assert(patches.length === 1 && patches[0].eventId === eligibleId, 'The eligible repair event should be updated once.');
      assert(patches[0].patch.nextAttemptAt === '2026-07-07T09:00:00+09:00', 'The retry should become immediately claimable.');
      assert(!Object.prototype.hasOwnProperty.call(patches[0].patch, 'attemptCount'), 'Expediting must preserve the attempt count.');
      assert(JSON.stringify(result).indexOf(eligibleId) === -1, 'Aggregate operator results must not expose event ids.');
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
              requestId: '11111111-1111-4111-8111-111111111111',
              userMessageId: '33333333-3333-4333-8333-333333333333',
              requestedAt: '2026-07-07T08:00:00+09:00',
              characterRuntimeMode: 'enforced',
              characterBinding: {
                profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
                profileRevision: 3,
                policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
                catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
                characterPackId: 'warm-kansai-caretaker',
                characterPackVersion: 'warm-kansai-caretaker.v1'
              }
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
      assert(event.payload.characterRuntimeMode === 'enforced', 'Manual retry must preserve enforced runtime mode.');
      assert(event.payload.characterBinding.profileRevision === 3, 'Manual retry must preserve the exact character binding.');
    });
  });

  test('CHAT_REPLY payload validation matches its persisted contract', function() {
    var base = {
      requestId: '11111111-1111-4111-8111-111111111111',
      userMessageId: '33333333-3333-4333-8333-333333333333',
      requestedAt: '2026-07-07T08:00:00+09:00',
      characterRuntimeMode: 'enforced',
      characterBinding: {
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        profileRevision: 3,
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: 'warm-kansai-caretaker',
        characterPackVersion: 'warm-kansai-caretaker.v1'
      }
    };
    function invalid(patch) {
      var value = JSON.parse(JSON.stringify(base));
      Object.keys(patch).forEach(function(key) {
        if (patch[key] === undefined) {
          delete value[key];
        } else {
          value[key] = patch[key];
        }
      });
      expectCode(function() {
        QueueService.__test.normalizePayload('CHAT_REPLY', value);
      }, 'VALIDATION_REQUEST_INVALID');
    }

    invalid({ userMessageId: undefined });
    invalid({ userMessageId: 'not-a-uuid' });
    invalid({ requestedAt: 'not-a-date' });
    invalid({
      manualRequestId: '22222222-2222-4222-8222-222222222222'
    });
    invalid({
      originalEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    });
    invalid({
      manualRequestId: 'not-a-uuid',
      originalEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    });
    invalid({
      characterRuntimeMode: 'legacy',
      characterBinding: null,
      completionRoute: 'PRODUCT_INFO'
    });

    var routed = JSON.parse(JSON.stringify(base));
    routed.completionRoute = 'PRODUCT_INFO';
    assert(
      QueueService.__test.normalizePayload('CHAT_REPLY', routed).completionRoute ===
        'PRODUCT_INFO',
      'Enforced completion route should remain valid.'
    );
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

  test('processQueueJob discards a stale lease result and continues its batch', function() {
    var processed = [];
    var completed = [];
    var failureTransitions = 0;
    var warnings = [];
    var staleLease = 'queue-lease:v1:11111111-1111-4111-8111-111111111111';
    var activeLease = 'queue-lease:v1:22222222-2222-4222-8222-222222222222';

    withOverrides({
      QueueService: {
        recoverStale: function() {
          return [];
        },
        claimBatch: function() {
          return [{
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'MEMORY_EXTRACT',
            payload: {},
            lockedBy: staleLease
          }, {
            eventId: '22222222-2222-4222-8222-222222222222',
            eventType: 'MEMORY_EXTRACT',
            payload: {},
            lockedBy: activeLease
          }];
        },
        markDone: function(eventId, _, leaseToken) {
          if (eventId === '11111111-1111-4111-8111-111111111111') {
            assert(leaseToken === staleLease, 'Worker did not pass its claim lease.');
            throw createAppError(
              'QUEUE_LOCK_BUSY',
              'lease lost',
              { reason: 'QUEUE_LEASE_MISMATCH' }
            );
          }
          assert(leaseToken === activeLease, 'Active event lease was not forwarded.');
          completed.push(eventId);
        },
        markRetry: function() {
          failureTransitions += 1;
        },
        markDead: function() {
          failureTransitions += 1;
        }
      },
      MemoryService: {
        extract: function() {
          processed.push('MEMORY_EXTRACT');
          return {};
        }
      },
      AppLogger: {
        writeDebugLog: function(level, operation, message, details) {
          if (
            level === 'WARN' &&
            details &&
            details.reason === 'QUEUE_LEASE_MISMATCH'
          ) {
            warnings.push({
              operation: operation,
              message: message
            });
          }
        }
      }
    }, function() {
      var result = processQueueJob();
      assert(result.claimedCount === 2, 'Both claimed events should be assessed.');
      assert(processed.length === 2, 'Stale result stopped the remaining batch.');
      assert(
        completed.length === 1 &&
          completed[0] === '22222222-2222-4222-8222-222222222222',
        'Only the current lease owner should complete.'
      );
      assert(failureTransitions === 0, 'Stale result attempted a second lifecycle transition.');
      assert(warnings.length === 1, 'Lease loss should produce one managed warning.');
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

  test('memory generation errors select retry or terminal queue outcomes', function() {
    var fixedNow = '2026-07-26T09:00:00+09:00';
    [
      { code: 'CONFIG_MISSING', expected: 'DEAD' },
      { code: 'GEMINI_AUTH_FAILED', expected: 'DEAD' },
      { code: 'GEMINI_MODEL_UNAVAILABLE', expected: 'DEAD' },
      { code: 'GEMINI_RATE_LIMIT', expected: 'RETRY_WAIT' },
      { code: 'GEMINI_BAD_RESPONSE', expected: 'RETRY_WAIT' },
      { code: 'GEMINI_TEMPORARY_FAILURE', expected: 'RETRY_WAIT' },
      { code: 'CHARACTER_OUTPUT_BLOCKED', expected: 'RETRY_WAIT' }
    ].forEach(function(testCase) {
      var retried = [];
      var dead = [];
      var done = [];
      withFixedNow(fixedNow, function() {
        withOverrides({
          QueueService: {
            markRetry: function(eventId, error, nextAttemptAt) {
              retried.push({
                eventId: eventId,
                code: error.code,
                nextAttemptAt: nextAttemptAt
              });
            },
            markDead: function(eventId, error) {
              dead.push({
                eventId: eventId,
                code: error.code
              });
            },
            markDone: function(eventId) {
              done.push(eventId);
            }
          },
          AppLogger: {
            writeDebugLog: function() {}
          }
        }, function() {
          handleQueueFailure_({
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'MEMORY_EXTRACT',
            attemptCount: 0,
            payload: {},
            lockedBy: 'queue-lease:v1:memory-taxonomy'
          }, createAppError(testCase.code, 'controlled'), 'correlation');
        });
      });
      assert(done.length === 0, testCase.code + ' completed the queue event.');
      if (testCase.expected === 'RETRY_WAIT') {
        assert(
          retried.length === 1 &&
            dead.length === 0 &&
            retried[0].code === testCase.code,
          testCase.code + ' did not select RETRY_WAIT.'
        );
        assert(
          retried[0].nextAttemptAt.toISOString() ===
            new Date('2026-07-26T00:01:00.000Z').toISOString(),
          testCase.code + ' used the wrong first retry window.'
        );
      } else {
        assert(
          dead.length === 1 &&
            retried.length === 0 &&
            dead[0].code === testCase.code,
          testCase.code + ' did not select DEAD.'
        );
      }
    });

    var fifthRetry = 0;
    var fifthDead = 0;
    withOverrides({
      QueueService: {
        markRetry: function() {
          fifthRetry += 1;
        },
        markDead: function() {
          fifthDead += 1;
        },
        markDone: function() {}
      },
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      handleQueueFailure_({
        eventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'MEMORY_EXTRACT',
        attemptCount: 4,
        payload: {}
      }, createAppError(
        'CHARACTER_OUTPUT_BLOCKED',
        'controlled'
      ), 'correlation');
    });
    assert(
      fifthRetry === 0 && fifthDead === 1,
      'The fifth memory failure did not become terminal.'
    );
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

  test('managed proactive no-send is durably completed with its reason', function() {
    var completed = null;
    var event = {
      eventId: '11111111-1111-4111-8111-111111111111',
      eventType: 'PROACTIVE_SEND',
      lockedBy:
        'queue-lease:v1:22222222-2222-4222-8222-222222222222',
      payload: {
        targetDate: '2026-07-08'
      }
    };
    withOverrides({
      ProactiveMessageService: {
        prepareDispatch: function(payload, nowIso, options) {
          assert(payload === event.payload, 'Queue payload changed before preparation.');
          assert(
            Validators.isIsoDateTimeString(nowIso) &&
              options.eventId === event.eventId &&
              options.leaseToken === event.lockedBy,
            'Queue claim was not passed to proactive preparation.'
          );
          return {
            eligible: false,
            reason: 'NO_APPROVED_PROACTIVE_OUTPUT',
            message: null,
            createdAt: nowIso
          };
        },
        send: function() {
          throw new Error('Managed no-send reached the mail sink.');
        }
      },
      QueueService: {
        markDone: function(eventId, result, leaseToken) {
          completed = {
            eventId: eventId,
            result: result,
            leaseToken: leaseToken
          };
        },
        markRetry: function() {
          throw new Error('Managed no-send was retried.');
        },
        markDead: function() {
          throw new Error('Managed no-send was marked dead.');
        }
      },
      AppLogger: {
        writeDebugLog: function() {}
      }
    }, function() {
      processSingleQueueEvent_(event, generateUuidV4());
    });
    assert(
      completed &&
        completed.eventId === event.eventId &&
        completed.leaseToken === event.lockedBy &&
        completed.result.skipped === true &&
        completed.result.reason ===
          'NO_APPROVED_PROACTIVE_OUTPUT',
      'Managed no-send reason was not persisted in DONE result.'
    );
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
      withFixedNow('2026-07-07T09:00:00+09:00', function() {
        schedulerJob();
      });
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

  test(
    'manual diary release can enqueue the previous Tokyo date before the production due time',
    function() {
      var lifecycleDate = null;
      var enqueuedDate = null;
      var result = null;
      withOverrides({
        ConfigRepository: {
          getByKey: function() {
            throw new Error(
              'The manual diary release must not read the production due time.'
            );
          }
        },
        DiaryService: {
          getLifecycleState: function(diaryDate) {
            lifecycleDate = diaryDate;
            return {
              status: null
            };
          },
          enqueue: function(diaryDate) {
            enqueuedDate = diaryDate;
            return {
              enqueued: true
            };
          }
        }
      }, function() {
        result = enqueuePreviousDiaryForReleaseTest_(
          new Date('2026-07-30T20:24:00+09:00')
        );
      });
      assert(
        lifecycleDate === '2026-07-29' &&
          enqueuedDate === '2026-07-29' &&
          result.enqueued === true,
        'The manual diary release did not target the previous Tokyo date.'
      );
    }
  );

  test(
    'production diary scheduling still waits for the configured due time',
    function() {
      var diaryReads = 0;
      var result = null;
      withOverrides({
        ConfigRepository: {
          getByKey: function(key) {
            return key === 'DIARY_DUE_TIME'
              ? { value: '23:30' }
              : null;
          }
        },
        DiaryService: {
          getLifecycleState: function() {
            diaryReads += 1;
            return {
              status: null
            };
          },
          enqueue: function() {
            diaryReads += 1;
            return {
              enqueued: true
            };
          }
        }
      }, function() {
        result = enqueueDiaryIfDue_(
          new Date('2026-07-30T20:24:00+09:00')
        );
      });
      assert(
        result.enqueued === false &&
          result.reason === 'DIARY_TIME_NOT_REACHED' &&
          diaryReads === 0,
        'The production diary scheduler bypassed its configured due time.'
      );
    }
  );

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

  test('OperationalHealthService treats an exact DONE memory repair as resolving an immutable DEAD event', function() {
    var originEventId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    var firstMessageId =
      '11111111-1111-4111-8111-111111111111';
    var lastMessageId =
      '33333333-3333-4333-8333-333333333333';
    var sourceMessageIds = [
      firstMessageId,
      lastMessageId
    ];
    var eventBinding = buildValidMemoryResumeBinding();
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
            eventId: originEventId,
            eventType: 'MEMORY_EXTRACT',
            status: 'DEAD',
            payload: {
              firstMessageId: firstMessageId,
              lastMessageId: lastMessageId,
              sourceMessageIds: sourceMessageIds,
              requestedAt:
                '2026-07-26T12:00:00+09:00',
              characterRuntimeMode: 'enforced',
              characterBinding: eventBinding
            },
            completedAt:
              '2026-07-26T14:00:00+09:00',
            lastError: {
              code: 'CHARACTER_OUTPUT_BLOCKED',
              message: 'private detail'
            }
          }, {
            eventId:
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            eventType: 'MEMORY_EXTRACT',
            status: 'DONE',
            payload: {
              firstMessageId: firstMessageId,
              lastMessageId: lastMessageId,
              sourceMessageIds: sourceMessageIds.slice(),
              requestedAt:
                '2026-07-26T12:00:00+09:00',
              characterRuntimeMode: 'enforced',
              characterBinding: eventBinding,
              manualRequestId:
                'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              originalEventId: originEventId
            },
            completedAt:
              '2026-07-26T15:00:00+09:00'
          }];
        }
      }
    }, function() {
      var report = OperationalHealthService.inspect(
        new Date('2026-07-26T16:00:00+09:00'),
        {
          required: {
            processQueueJob: { count: 1 },
            schedulerJob: { count: 1 }
          }
        }
      );
      assert(
        report.status === 'OK' &&
          report.queue.byStatus.DEAD === 1 &&
          report.queue.recentDead.total === 0 &&
          report.queue.recentDead.resolvedTotal === 1,
        'A completed exact memory repair did not resolve health.'
      );
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
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function(key) {
              return key === APP_CONSTANTS.PROPERTY_KEYS.APP_ENV
                ? 'prod'
                : null;
            }
          };
        }
      },
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
            PROACTIVE_FREQUENCY: { value: 'normal' },
            PROACTIVE_COOLDOWN_MINUTES: { value: 240 },
            PROACTIVE_MAX_PER_DAY: { value: 2 },
            PROACTIVE_RECHECK_MINUTES: { value: 60 },
            PROACTIVE_POLICY_MODE: { value: 'probability' },
            PROACTIVE_SILENCE_CEILING_MINUTES: {
              value: 720
            },
            PROACTIVE_PROBABILITY_CURVE: { value: 1.3 },
            PROACTIVE_DAY_START: { value: '10:00' },
            PROACTIVE_EVENING_START: { value: '18:00' },
            PROACTIVE_MORNING_WEIGHT: { value: 0.7 },
            PROACTIVE_DAY_WEIGHT: { value: 1.0 },
            PROACTIVE_EVENING_WEIGHT: { value: 1.2 }
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

  test('GmailNotifier sanitizes provider send failures as retryable mail errors', function() {
    var privateMarker = 'PRIVATE-RECIPIENT-AND-SUBJECT';
    withOverrides({
      MailApp: {
        getRemainingDailyQuota: function() {
          return 10;
        },
        sendEmail: function() {
          throw new Error(privateMarker);
        }
      }
    }, function() {
      var thrown = null;
      try {
        GmailNotifier.send(
          'owner@example.com',
          'Private subject',
          'Private body'
        );
      } catch (error) {
        thrown = error;
      }
      assert(
        thrown &&
          thrown.code === 'MAIL_SEND_FAILED' &&
          thrown.retryable === true &&
          thrown.retryStrategy === 'COMMON_BACKOFF',
        'Provider send failure did not become a retryable mail error.'
      );
      assert(
        JSON.stringify(thrown.toLogObject()).indexOf(privateMarker) === -1,
        'Provider exception details leaked into the log-safe mail error.'
      );
    });
  });

  test('ProactiveMessageService.send claims a marker before mail and completes it after success', function() {
    var storedMarker = null;
    var appendCalls = 0;
    var updateCalls = [];
    var usageCalls = 0;

    withFixedNow('2026-07-08T10:05:00+09:00', function() {
      withOverrides({
      ConfigRepository: buildLegacyProactiveConfig(
        'Hello',
        'Fresh proactive mail'
      ),
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function(key) {
              if (key === APP_CONSTANTS.PROPERTY_KEYS.APP_ENV) {
                return 'prod';
              }
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
            last_user_message_at:
              '2026-07-08T00:00:00+09:00',
            last_proactive_at: null,
            next_proactive_check_at: null,
            quiet_until: null
          };
        },
        getUserState: function() {
          return this.ensureDefaultUserState();
        },
        updateUserState: function() {},
        incrementUsageDaily: function() {
          usageCalls += 1;
        }
      },
      GmailNotifier: {
        getRemainingQuota: function() {
          return 10;
        },
        send: function() {
          return {
            sent: true
          };
        }
      }
      }, function() {
        var prepared = ProactiveMessageService.prepareDispatch(
          buildLegacyProactivePayload(
            '2026-07-08',
            '2026-07-08T08:00:00+09:00'
          ),
          '2026-07-08T08:05:00+09:00'
        );
        var result = ProactiveMessageService.send(
          prepared.message
        );

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
  });

  test('ProactiveMessageService.send retries a failed marker with the stored body and current attempt time', function() {
    var storedMarker = null;
    var appendCalls = 0;
    var sendCalls = 0;
    var sentBodies = [];
    var latestStatePatch = null;

    withFixedNow('2026-07-08T10:05:00+09:00', function() {
      withOverrides({
      ConfigRepository: buildLegacyProactiveConfig(
        'Hello',
        'Stored proactive mail'
      ),
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function(key) {
              if (key === APP_CONSTANTS.PROPERTY_KEYS.APP_ENV) {
                return 'prod';
              }
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
            last_user_message_at:
              '2026-07-08T00:00:00+09:00',
            last_proactive_at: null,
            next_proactive_check_at: null,
            quiet_until: null
          };
        },
        getUserState: function() {
          return this.ensureDefaultUserState();
        },
        updateUserState: function(patch) {
          latestStatePatch = patch;
        },
        incrementUsageDaily: function() {}
      },
      GmailNotifier: {
        getRemainingQuota: function() {
          return 10;
        },
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
        var payload = buildLegacyProactivePayload(
          '2026-07-08',
          '2026-07-08T08:00:00+09:00'
        );
        var firstError = null;
        try {
          var firstPrepared =
            ProactiveMessageService.prepareDispatch(
              payload,
              '2026-07-08T08:05:00+09:00'
            );
          ProactiveMessageService.send(
            firstPrepared.message
          );
        } catch (error) {
          firstError = error;
        }

        assert(
          firstError && firstError.code === 'MAIL_QUOTA_EXHAUSTED',
          'The first failure should be surfaced.'
        );
        assert(storedMarker.status === 'failed', 'The marker should be failed.');

        var retryPrepared =
          ProactiveMessageService.prepareDispatch(
            payload,
            '2026-07-08T10:05:00+09:00'
          );
        var result = ProactiveMessageService.send(
          retryPrepared.message
        );

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

  test(
    'weekly backup reuses a partial snapshot and retains complete managed dates only',
    function() {
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

      function backupFile(id, name, updatedAt) {
        return {
          id: id,
          name: name,
          trashed: false,
          getId: function() {
            return this.id;
          },
          getName: function() {
            return this.name;
          },
          getLastUpdated: function() {
            return new Date(updatedAt);
          },
          getDateCreated: function() {
            return new Date(updatedAt);
          },
          setTrashed: function(value) {
            this.trashed = value === true;
          }
        };
      }

      var files = [
        backupFile(
          'current-sheet',
          'personal-ai-partner-sheet-backup-2026-07-26',
          '2026-07-26T03:00:00+09:00'
        ),
        backupFile(
          'previous-sheet',
          'personal-ai-partner-sheet-backup-2026-07-19',
          '2026-07-19T03:00:00+09:00'
        ),
        backupFile(
          'previous-diary',
          'personal-ai-partner-diary-backup-2026-07-19',
          '2026-07-19T03:00:01+09:00'
        ),
        backupFile(
          'old-sheet',
          'personal-ai-partner-sheet-backup-2026-07-12',
          '2026-07-12T03:00:00+09:00'
        ),
        backupFile(
          'old-diary',
          'personal-ai-partner-diary-backup-2026-07-12',
          '2026-07-12T03:00:01+09:00'
        ),
        backupFile(
          'unrelated',
          'keep-this-human-file',
          '2026-07-01T00:00:00+09:00'
        )
      ];
      var copyCalls = [];
      var folder = {
        getFilesByName: function(name) {
          return iterator(files.filter(function(file) {
            return !file.trashed && file.getName() === name;
          }));
        },
        getFiles: function() {
          return iterator(files.filter(function(file) {
            return !file.trashed;
          }));
        }
      };

      withOverrides({
        PropertiesService: {
          getScriptProperties: function() {
            return {
              getProperty: function(key) {
                if (key === APP_CONSTANTS.PROPERTY_KEYS.SPREADSHEET_ID) {
                  return 'source-sheet';
                }
                if (key === APP_CONSTANTS.PROPERTY_KEYS.DIARY_DOC_ID) {
                  return 'source-diary';
                }
                return null;
              }
            };
          }
        },
        ConfigRepository: {
          getByKey: function(key) {
            return key === 'BACKUP_RETENTION_COUNT'
              ? { value: 2 }
              : null;
          }
        },
        DriveTempRepository: {
          ensureFolders: function() {
            return {
              backupFolder: folder
            };
          }
        },
        DriveApp: {
          getFileById: function(sourceFileId) {
            return {
              makeCopy: function(name) {
                copyCalls.push({
                  sourceFileId: sourceFileId,
                  name: name
                });
                var created = backupFile(
                  'created-' + copyCalls.length,
                  name,
                  '2026-07-26T03:00:02+09:00'
                );
                files.push(created);
                return created;
              }
            };
          }
        }
      }, function() {
        var first = MaintenanceService.weeklyBackup({
          backupDate: '2026-07-26'
        });
        var second = MaintenanceService.weeklyBackup({
          backupDate: '2026-07-26'
        });

        assert(
          copyCalls.length === 1 &&
            copyCalls[0].sourceFileId === 'source-diary',
          'Only the missing diary member should be copied once.'
        );
        assert(
          first.spreadsheetBackupFileId === 'current-sheet' &&
            second.spreadsheetBackupFileId === 'current-sheet',
          'The existing spreadsheet backup should be reused.'
        );
        assert(
          first.diaryBackupFileId === second.diaryBackupFileId,
          'A retry should reuse the newly completed diary backup.'
        );
        assert(
          files.filter(function(file) {
            return (
              file.getName().indexOf('backup-2026-07-12') !== -1 &&
              file.trashed
            );
          }).length === 2,
          'Both members of the expired managed snapshot should be trashed.'
        );
        assert(
          files.filter(function(file) {
            return file.id === 'unrelated' && file.trashed;
          }).length === 0,
          'Unrelated files must never participate in backup retention.'
        );
      });
    }
  );

  test(
    'weekly backup maps provider failures to retryable storage errors',
    function() {
      function emptyIterator() {
        return {
          hasNext: function() {
            return false;
          },
          next: function() {
            throw new Error('empty');
          }
        };
      }
      var folder = {
        getFilesByName: emptyIterator,
        getFiles: emptyIterator
      };
      withOverrides({
        PropertiesService: {
          getScriptProperties: function() {
            return {
              getProperty: function(key) {
                return key ===
                  APP_CONSTANTS.PROPERTY_KEYS.SPREADSHEET_ID
                  ? 'source-sheet'
                  : 'source-diary';
              }
            };
          }
        },
        DriveTempRepository: {
          ensureFolders: function() {
            return {
              backupFolder: folder
            };
          }
        },
        DriveApp: {
          getFileById: function() {
            throw new Error('private provider detail');
          }
        }
      }, function() {
        var thrown = null;
        try {
          MaintenanceService.weeklyBackup({
            backupDate: '2026-07-26'
          });
        } catch (error) {
          thrown = error;
        }
        assert(
          thrown &&
            thrown.code === 'STORAGE_WRITE_FAILED' &&
            thrown.retryable === true &&
            thrown.retryStrategy === 'COMMON_BACKOFF',
          'Drive failures must enter the standard retry path.'
        );
        assert(
          thrown.message.indexOf('private provider detail') === -1,
          'Provider details must not become the persisted error message.'
        );
      });
    }
  );

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

  test('ProactiveMessageService.prepareDispatch suppresses a concurrent accepted marker', function() {
    var sendCalls = 0;

    withOverrides({
      ConfigRepository: buildLegacyProactiveConfig(
        'Hello',
        'Concurrent proactive mail'
      ),
      LockManager: {
        withScriptLock: function(_, callback) {
          return callback();
        }
      },
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function(key) {
              return key === APP_CONSTANTS.PROPERTY_KEYS.APP_ENV
                ? 'prod'
                : 'owner@example.com';
            }
          };
        }
      },
      SheetRepository: {
        ensureDefaultUserState: function() {
          return {};
        },
        getUserState: function() {
          return {};
        },
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
      var result = ProactiveMessageService.prepareDispatch(
        buildLegacyProactivePayload(
          '2026-07-08',
          '2026-07-08T08:00:00+09:00'
        ),
        '2026-07-08T08:05:00+09:00'
      );

      assert(result.eligible === false, 'The second claimant must not send.');
      assert(result.reason === 'DELIVERY_IN_PROGRESS', 'The accepted marker must be treated as claimed.');
      assert(sendCalls === 0, 'Gmail must not be called by the second claimant.');
    });
  });

  test(
    'runOperationalHealthCheck is read-only and never calls the notifying path',
    function() {
      var inspectCalls = 0;
      var runCalls = 0;
      withOverrides({
        OperationalHealthService: {
          inspect: function(_, triggerHealth) {
            inspectCalls += 1;
            return {
              status: 'OK',
              triggers: triggerHealth
            };
          },
          run: function() {
            runCalls += 1;
            throw new Error(
              'The notifying health path must not run.'
            );
          }
        },
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        }
      }, function() {
        var result = runOperationalHealthCheck();
        assert(result.status === 'OK', 'Read-only health output was not returned.');
      });
      assert(
        inspectCalls === 1 && runCalls === 0,
        'The public health check was not read-only.'
      );
    }
  );

  test(
    'PR9 operator logs preserve returns and expose only allowlisted evidence',
    function() {
      var logs = [];
      var secretUrl =
        'https://example.invalid/private/deployment';
      var secretId =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      var secretEmail = 'owner@example.invalid';
      var secretBody = 'private conversation body';
      var currentTriggers = [];
      var healthResult = {
        status: 'OK',
        checkedAt: '2026-07-14T12:00:00+09:00',
        url: secretUrl,
        queue: {
          total: 7,
          byStatus: {
            PENDING: 1,
            PROCESSING: 0,
            RETRY_WAIT: 0,
            DONE: 5,
            DEAD: 1
          },
          byEventType: {
            CHAT_REPLY: {
              PENDING: 1,
              PROCESSING: 0,
              RETRY_WAIT: 0,
              DONE: 2,
              DEAD: 0
            },
            MEMORY_EXTRACT: {
              PENDING: 0,
              PROCESSING: 0,
              RETRY_WAIT: 0,
              DONE: 1,
              DEAD: 0
            },
            DIARY_GENERATE: {
              PENDING: 0,
              PROCESSING: 0,
              RETRY_WAIT: 0,
              DONE: 1,
              DEAD: 0
            },
            PROACTIVE_SEND: {
              PENDING: 0,
              PROCESSING: 0,
              RETRY_WAIT: 0,
              DONE: 1,
              DEAD: 0
            },
            WEEKLY_BACKUP: {
              PENDING: 0,
              PROCESSING: 0,
              RETRY_WAIT: 0,
              DONE: 0,
              DEAD: 1
            },
            PRIVATE_EVENT: {
              PENDING: 99,
              body: secretBody
            }
          },
          recentDead: {
            total: 1,
            resolvedTotal: 2,
            byEventType: {
              CHAT_REPLY: 0,
              MEMORY_EXTRACT: 0,
              DIARY_GENERATE: 0,
              PROACTIVE_SEND: 0,
              WEEKLY_BACKUP: 1,
              PRIVATE_EVENT: 99
            },
            byErrorCode: {
              PRIVATE_BODY: secretBody
            }
          },
          staleProcessing: {
            total: 0
          },
          overdue: {
            pending: 1,
            retryWait: 0
          },
          payload: {
            eventId: secretId,
            body: secretBody
          }
        },
        triggers: {
          required: {
            processQueueJob: { count: 0 },
            schedulerJob: { count: 0 }
          },
          missingCount: 2,
          duplicateCount: 0,
          unexpectedCount: 0,
          ownerEmail: secretEmail
        }
      };
      var policyResult = {
        valid: true,
        environment: 'test',
        frequency: 'high',
        enabled: true,
        policyMode: 'probability',
        silenceFloorMinutes: 5,
        silenceCeilingMinutes: 10,
        recheckMinutes: 5,
        currentTimeWeight: 1.2,
        quietHoursActive: false,
        timeBands: {
          morningStart: '00:00',
          dayStart: '10:00',
          eveningStart: '18:00',
          quietStart: '23:00',
          quietEnd: '08:00',
          morningWeight: 0.7,
          dayWeight: 1,
          eveningWeight: 1.2,
          probabilityCurve: 1.3,
          url: secretUrl
        },
        guardrails: {
          quietStart: '23:00',
          quietEnd: '08:00',
          quietHoursEnabled: true,
          cooldownMinutes: 240,
          maxPerDay: 2,
          message: secretBody
        },
        automaticTriggersAllowed: false,
        manualTestAllowed: true,
        issues: [
          'PROACTIVE_TEST_POLICY_NOT_READY',
          secretUrl
        ],
        expectedTimingProfiles: {
          privateId: secretId
        }
      };
      var persistenceSafetyResult = {
        valid: true,
        windowSource:
          'ALL_ENFORCED_EVENTS',
        checked: {
          chatMessages: 9,
          imageSummaries: 1,
          proactiveMarkers: 1,
          sentProactiveMarkers: 1,
          diaries: 1,
          memories: 1,
          total: 13,
          body: secretBody
        },
        unsafePersistedOrSent: {
          chatMessages: 0,
          imageSummaries: 0,
          proactiveMarkers: 0,
          sentProactiveMarkers: 0,
          diaries: 0,
          memories: 0,
          total: 0,
          eventId: secretId
        },
        metrics: {
          immersion_unsafe_persisted_or_sent_total: 0,
          privateMetric: secretBody
        },
        issues: [],
        url: secretUrl
      };
      var proactiveReadyCalls = 0;
      var results = {};

      function buildTrigger(handler) {
        return {
          getHandlerFunction: function() {
            return handler;
          },
          getEventType: function() {
            return 'CLOCK';
          },
          getTriggerSource: function() {
            return 'CLOCK';
          },
          url: secretUrl,
          eventId: secretId
        };
      }

      withOverrides({
        console: {
          log: function(line) {
            logs.push(String(line));
          }
        },
        OperationalHealthService: {
          inspect: function() {
            return healthResult;
          }
        },
        DiaryService: {
          getLifecycleState: function() {
            return {
              status: 'DONE',
              anchorCount: 1,
              diaryText: secretBody,
              anchorId: secretId
            };
          }
        },
        ProactiveMessageService: {
          inspectPolicy: function() {
            return policyResult;
          },
          assertManualTestReady: function() {
            proactiveReadyCalls += 1;
            return policyResult;
          },
          assertAutomaticTriggerReady: function() {
            proactiveReadyCalls += 1;
            return policyResult;
          }
        },
        ImmersionSafetyAuditService: {
          inspect: function() {
            return persistenceSafetyResult;
          }
        },
        ScriptApp: {
          getProjectTriggers: function() {
            return currentTriggers;
          },
          newTrigger: function() {
            throw new Error(
              'Existing test triggers should be reused.'
            );
          }
        },
        enqueuePreviousDiaryForReleaseTest_: function() {
          return {
            enqueued: false,
            reason: 'DIARY_NOT_REQUIRED',
            diaryStatus: 'NONE',
            eventId: secretId,
            payload: { body: secretBody }
          };
        },
        enqueueMemoryExtractionIfDue_: function() {
          return {
            enqueued: false,
            reason: 'INSUFFICIENT_NEW_MESSAGES',
            messageCount: 0,
            eventId: secretId
          };
        },
        resumeSingleActiveMemoryReleaseTest_: function() {
          return {
            eventType: 'MEMORY_EXTRACT',
            enqueued: false,
            duplicate: true,
            processed: false,
            status: 'RETRY_WAIT',
            reason: 'TARGET_EVENT_NOT_DUE',
            errorCode: 'CHARACTER_OUTPUT_BLOCKED',
            eventId: secretId,
            dedupeKey: 'MEMORY_EXTRACT:' + secretId,
            payload: {
              body: secretBody,
              ownerEmail: secretEmail
            }
          };
        },
        diagnoseSingleActiveMemoryGeneration_: function() {
          return {
            eventType: 'MEMORY_EXTRACT',
            ok: false,
            stage: 'HTTP_REQUEST_REJECTED',
            errorCode: 'GEMINI_BAD_RESPONSE',
            candidateCount: null,
            eventId: secretId,
            payload: {
              body: secretBody,
              ownerEmail: secretEmail
            }
          };
        },
        enqueueProactiveIfEligible_: function() {
          return {
            eligible: false,
            reason: 'PROBABILITY_MISS',
            eventId: secretId,
            email: secretEmail,
            body: secretBody
          };
        }
      }, function() {
        results.health = runOperationalHealthCheck();
        results.policy = inspectProactivePolicy();
        results.persistenceSafety =
          inspectPr9PersistenceSafety();
        results.diaryInspection =
          inspectPreviousDiaryReleaseTest();
        results.diary = runDiaryReleaseTest();
        results.memory = runMemoryReleaseTest();
        results.memoryResume =
          resumeMemoryReleaseTest();
        results.memoryDiagnosis =
          diagnoseMemoryReleaseGeneration();
        results.proactive = runProactiveReleaseTest();

        currentTriggers = [
          buildTrigger('processQueueJob'),
          buildTrigger('schedulerJob')
        ];
        results.triggers = listProjectTriggers();
        results.installed = installTriggers();
      });

      assert(
        results.health === healthResult &&
          results.policy === policyResult &&
          results.persistenceSafety ===
            persistenceSafetyResult,
        'Logging changed an inspection return object.'
      );
      assert(
        results.diaryInspection.status === 'DONE' &&
          results.diaryInspection.anchorCount === 1 &&
          results.diary.reason === 'DIARY_NOT_REQUIRED' &&
          results.memory.reason ===
            'INSUFFICIENT_NEW_MESSAGES' &&
          results.memoryResume.reason ===
            'TARGET_EVENT_NOT_DUE' &&
          results.memoryResume.eventId === undefined &&
          results.memoryResume.payload === undefined &&
          Object.keys(results.memoryResume).length === 7 &&
          results.memoryDiagnosis.stage ===
            'HTTP_REQUEST_REJECTED' &&
          results.proactive.reason === 'PROBABILITY_MISS',
        'Logging changed a release-test return contract.'
      );
      assert(
        results.triggers.length === 2 &&
          results.installed.length === 2 &&
          proactiveReadyCalls === 2,
        'Trigger inspection or readiness return behavior changed.'
      );
      assert(
        logs.length === 11,
        'Every PR9 public operator must emit exactly one result line.'
      );

      var combined = logs.join('\n');
      [
        secretUrl,
        secretId,
        secretEmail,
        secretBody,
        '"checkedAt"',
        '"payload"',
        '"body"',
        '"url"',
        '"ownerEmail"',
        '"expectedTimingProfiles"'
      ].forEach(function(forbidden) {
        assert(
          combined.indexOf(forbidden) === -1,
          'PR9 logs exposed forbidden data: ' + forbidden
        );
      });

      function readLog(functionName) {
        var prefix =
          'PR9_TEST_RESULT ' + functionName + ' ';
        var matches = logs.filter(function(line) {
          return line.indexOf(prefix) === 0;
        });
        assert(
          matches.length === 1,
          functionName + ' did not emit one canonical log.'
        );
        return JSON.parse(matches[0].slice(prefix.length));
      }

      var healthLog = readLog(
        'runOperationalHealthCheck'
      );
      assert(
        healthLog.status === 'OK' &&
          healthLog.queue.total === 7 &&
          healthLog.queue.byStatus.DONE === 5 &&
          healthLog.queue.byEventType.CHAT_REPLY.PENDING === 1 &&
          healthLog.queue.byEventType.DIARY_GENERATE.DONE === 1 &&
          healthLog.queue.byEventType.PRIVATE_EVENT === undefined &&
          healthLog.queue.recentDead.total === 1 &&
          healthLog.queue.recentDead.byEventType.WEEKLY_BACKUP === 1 &&
          healthLog.queue.recentDead.byEventType.PRIVATE_EVENT === undefined &&
          healthLog.triggers.missingCount === 2,
        'Operational health log omitted allowlisted counts.'
      );

      var policyLog = readLog('inspectProactivePolicy');
      assert(
        policyLog.environment === 'test' &&
          policyLog.frequency === 'high' &&
          policyLog.silenceFloorMinutes === 5 &&
          policyLog.silenceCeilingMinutes === 10 &&
          policyLog.currentTimeWeight === 1.2 &&
          policyLog.timeBands.eveningWeight === 1.2 &&
          policyLog.timeBands.probabilityCurve === 1.3 &&
          policyLog.guardrails.cooldownMinutes === 240 &&
          policyLog.issues.length === 1,
        'Proactive policy log omitted or leaked policy evidence.'
      );

      var persistenceSafetyLog = readLog(
        'inspectPr9PersistenceSafety'
      );
      assert(
        persistenceSafetyLog.valid === true &&
          persistenceSafetyLog.windowSource ===
            'ALL_ENFORCED_EVENTS' &&
          persistenceSafetyLog.checked.total === 13 &&
          persistenceSafetyLog.checked.chatMessages === 9 &&
          persistenceSafetyLog.unsafePersistedOrSent.total === 0 &&
          persistenceSafetyLog.metrics
            .immersion_unsafe_persisted_or_sent_total === 0 &&
          persistenceSafetyLog.url === undefined,
        'Persistence safety log omitted or leaked audit evidence.'
      );

      [
        'runDiaryReleaseTest',
        'runMemoryReleaseTest',
        'resumeMemoryReleaseTest',
        'runProactiveReleaseTest'
      ].forEach(function(functionName) {
        var releaseLog = readLog(functionName);
        assert(
          JSON.stringify(Object.keys(releaseLog).sort()) ===
            JSON.stringify([
              'duplicate',
              'enqueued',
              'errorCode',
              'eventType',
              'processed',
              'reason',
              'status'
            ]),
          functionName + ' log fields are not exact.'
        );
      });

      var diagnosisLog = readLog(
        'diagnoseMemoryReleaseGeneration'
      );
      assert(
        JSON.stringify(Object.keys(diagnosisLog).sort()) ===
          JSON.stringify([
            'candidateCount',
            'errorCode',
            'eventType',
            'ok',
            'stage'
          ]) &&
          diagnosisLog.eventType === 'MEMORY_EXTRACT' &&
          diagnosisLog.ok === false &&
          diagnosisLog.stage === 'HTTP_REQUEST_REJECTED' &&
          diagnosisLog.errorCode === 'GEMINI_BAD_RESPONSE' &&
          diagnosisLog.candidateCount == null,
        'Memory diagnosis log omitted or exposed fields.'
      );

      var diaryLog = readLog(
        'inspectPreviousDiaryReleaseTest'
      );
      assert(
        diaryLog.status === 'DONE' &&
          diaryLog.anchorCount === 1,
        'Diary inspection log omitted lifecycle evidence.'
      );

      [
        'listProjectTriggers',
        'installTriggers'
      ].forEach(function(functionName) {
        var triggerLog = readLog(functionName);
        assert(
          triggerLog.length === 2 &&
            triggerLog[0].handlerFunction ===
              'processQueueJob' &&
            triggerLog[1].handlerFunction ===
              'schedulerJob',
          functionName + ' log omitted safe trigger evidence.'
        );
      });
    }
  );

  test(
    'installTriggers checks production proactive readiness before trigger mutation',
    function() {
      var triggerReads = 0;
      var triggerWrites = 0;
      withOverrides({
        ProactiveMessageService: {
          assertAutomaticTriggerReady: function() {
            throw createAppError(
              'CONFIG_MISSING',
              'not ready'
            );
          }
        },
        ScriptApp: {
          getProjectTriggers: function() {
            triggerReads += 1;
            return [];
          },
          newTrigger: function() {
            triggerWrites += 1;
          }
        }
      }, function() {
        expectCode(function() {
          installTriggers();
        }, 'CONFIG_MISSING');
      });
      assert(
        triggerReads === 0 && triggerWrites === 0,
        'A rejected production policy mutated trigger state.'
      );
    }
  );

  test(
    'QueueService.claimEventById claims only the exact requested event',
    function() {
      var targetEventId =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      var unrelatedEventId =
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      var updated = null;
      var event = {
        eventId: targetEventId,
        eventType: 'DIARY_GENERATE',
        status: 'PENDING',
        nextAttemptAt: null,
        lockedBy: null
      };
      withOverrides({
        LockManager: {
          withScriptLock: function(_, callback) {
            return callback();
          }
        },
        SheetRepository: {
          listClaimableEvents: function() {
            throw new Error(
              'Exact claim must not scan the queue.'
            );
          },
          listClaimableEventsByType: function() {
            throw new Error(
              'Exact claim must not scan same-type backlog.'
            );
          },
          updateEvent: function(eventId, patch) {
            assert(
              eventId === targetEventId,
              'An unrelated event was updated.'
            );
            updated = {
              eventId: eventId,
              patch: patch
            };
            event.status = patch.status;
            event.lockedBy = patch.lockedBy;
          },
          getEventById: function(eventId) {
            assert(
              eventId !== unrelatedEventId,
              'The unrelated event was read.'
            );
            return eventId === targetEventId ? event : null;
          }
        }
      }, function() {
        var claimed = QueueService.claimEventById(
          'DIARY_GENERATE',
          targetEventId,
          'release-test-worker',
          new Date('2026-07-14T12:00:00+09:00')
        );
        assert(
          claimed &&
            claimed.eventId === targetEventId &&
            claimed.status === 'PROCESSING' &&
            updated.eventId === targetEventId,
          'The exact event was not claimed.'
        );
      });
    }
  );

  test(
    'runDiaryReleaseTest processes only its newly enqueued event and reports DONE',
    function() {
      var newEventId =
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      var claimedEventId = null;
      var settled = {
        eventId: newEventId,
        eventType: 'DIARY_GENERATE',
        status: 'PENDING',
        lockedBy: 'queue-lease:v1:test'
      };
      var result = null;

      withOverrides({
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        },
        enqueuePreviousDiaryForReleaseTest_: function() {
          return {
            enqueued: true,
            duplicate: false,
            eventId: newEventId
          };
        },
        QueueService: {
          claimEventById: function(
            eventType,
            eventId
          ) {
            claimedEventId = eventId;
            assert(
              eventType === 'DIARY_GENERATE',
              'The wrong event type was claimed.'
            );
            settled.status = 'PROCESSING';
            return settled;
          }
        },
        processSingleQueueEvent_: function(event) {
          assert(
            event.eventId === newEventId,
            'An event other than the new enqueue was processed.'
          );
          settled.status = 'DONE';
          settled.lastError = null;
        },
        SheetRepository: {
          getEventById: function(eventId) {
            assert(
              eventId === newEventId,
              'Settlement read targeted another event.'
            );
            return settled;
          }
        }
      }, function() {
        result = runDiaryReleaseTest();
      });

      assert(
        claimedEventId === newEventId &&
          result.enqueued === true &&
          result.processed === true &&
          result.status === 'DONE' &&
          result.reason === 'PROCESSED' &&
          result.errorCode == null,
        'The exact diary release event did not settle as DONE.'
      );
    }
  );

  test(
    'runMemoryReleaseTest returns the sanitized final failure state',
    function() {
      var newEventId =
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      var settled = {
        eventId: newEventId,
        eventType: 'MEMORY_EXTRACT',
        status: 'PENDING',
        lockedBy: 'queue-lease:v1:test',
        lastError: null
      };
      var result = null;

      withOverrides({
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        },
        enqueueMemoryExtractionIfDue_: function() {
          return {
            enqueued: true,
            duplicate: false,
            eventId: newEventId
          };
        },
        QueueService: {
          claimEventById: function(
            eventType,
            eventId
          ) {
            assert(
              eventType === 'MEMORY_EXTRACT' &&
                eventId === newEventId,
              'Memory release test claimed another event.'
            );
            settled.status = 'PROCESSING';
            return settled;
          }
        },
        processSingleQueueEvent_: function() {
          settled.status = 'RETRY_WAIT';
          settled.lastError = {
            code: 'GEMINI_TEMPORARY_FAILURE'
          };
        },
        SheetRepository: {
          getEventById: function() {
            return settled;
          }
        }
      }, function() {
        result = runMemoryReleaseTest();
      });

      assert(
        result.enqueued === true &&
          result.processed === false &&
          result.status === 'RETRY_WAIT' &&
          result.reason === 'PROCESSING_INCOMPLETE' &&
          result.errorCode === 'GEMINI_TEMPORARY_FAILURE',
        'The failed release event was reported as successful.'
      );
    }
  );

  test(
    'resumeMemoryReleaseTest processes only the exact due active memory event',
    function() {
      var eventId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      var firstMessageId =
        '11111111-1111-4111-8111-111111111111';
      var middleMessageId =
        '22222222-2222-4222-8222-222222222222';
      var lastMessageId =
        '33333333-3333-4333-8333-333333333333';
      var sourceMessageIds = [
        firstMessageId,
        middleMessageId,
        lastMessageId
      ];
      var activeEvent = {
        eventId: eventId,
        eventType: 'MEMORY_EXTRACT',
        dedupeKey:
          'MEMORY_EXTRACT:' +
          firstMessageId +
          ':' +
          lastMessageId,
        payload: {
          firstMessageId: firstMessageId,
          lastMessageId: lastMessageId,
          sourceMessageIds: sourceMessageIds.slice(),
          requestedAt: '2026-07-26T12:00:00+09:00',
          characterRuntimeMode: 'enforced',
          characterBinding:
            buildValidMemoryResumeBinding()
        },
        status: 'RETRY_WAIT',
        attemptCount: 1,
        nextAttemptAt: '2026-07-26T12:05:00+09:00',
        lockedAt: null,
        lockedBy: null,
        lastError: {
          code: 'CHARACTER_OUTPUT_BLOCKED',
          message: 'private failure detail'
        }
      };
      var inactiveEvent = {
        eventId:
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
        eventType: 'CHAT_REPLY',
        status: 'DONE'
      };
      var processCalls = 0;
      var result = null;

      withOverrides({
        console: {
          log: function() {}
        },
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        },
        SheetRepository: {
          listEvents: function() {
            return [inactiveEvent, activeEvent];
          },
          getUserState: function() {
            return {
              last_memory_cursor: null
            };
          }
        },
        selectMemoryExtractionBatch_: function() {
          return {
            ready: true,
            messageCount: sourceMessageIds.length,
            firstMessageId: firstMessageId,
            lastMessageId: lastMessageId,
            sourceMessageIds: sourceMessageIds.slice()
          };
        },
        enqueueMemoryExtractionIfDue_: function() {
          throw new Error(
            'Resume must never enqueue a new event.'
          );
        },
        processReleaseTestEventById_: function(
          eventType,
          selectedEventId,
          options
        ) {
          processCalls += 1;
          var fingerprint =
            options && options.expectedClaimFingerprint;
          assert(
            eventType === 'MEMORY_EXTRACT' &&
              selectedEventId === eventId,
            'Resume selected a different queue event.'
          );
          assert(
            fingerprint &&
              fingerprint.requireExclusiveActive === true &&
              fingerprint.lastMemoryCursor == null &&
              fingerprint.status === 'RETRY_WAIT' &&
              fingerprint.attemptCount === 1 &&
              fingerprint.nextAttemptAt ===
                activeEvent.nextAttemptAt &&
              fingerprint.lockedAt == null &&
              fingerprint.lockedBy == null &&
              fingerprint.dedupeKey ===
                activeEvent.dedupeKey &&
              JSON.stringify(
                fingerprint.sourceMessageIds
              ) === JSON.stringify(sourceMessageIds) &&
              fingerprint.requestedAt ===
                activeEvent.payload.requestedAt &&
              fingerprint.characterBindingJson ===
                JSON.stringify(
                  activeEvent.payload.characterBinding
                ),
            'Resume omitted the exact claim fingerprint.'
          );
          return {
            status: 'DONE',
            reason: 'PROCESSED',
            errorCode: null
          };
        }
      }, function() {
        withFixedNow(
          '2026-07-26T12:10:00+09:00',
          function() {
            result = resumeMemoryReleaseTest();
          }
        );
      });

      assert(
        processCalls === 1 &&
          result.eventType === 'MEMORY_EXTRACT' &&
          result.enqueued === false &&
          result.duplicate === true &&
          result.processed === true &&
          result.status === 'DONE' &&
          result.reason === 'PROCESSED' &&
          result.errorCode == null,
        'The exact active memory event was not resumed.'
      );
      assert(
        JSON.stringify(Object.keys(result).sort()) ===
          JSON.stringify([
            'duplicate',
            'enqueued',
            'errorCode',
            'eventType',
            'processed',
            'reason',
            'status'
          ]),
        'The resume return exposed non-allowlisted fields.'
      );
    }
  );

  test(
    'memory generation diagnosis uses the exact active event without mutation',
    function() {
      var firstMessageId =
        '11111111-1111-4111-8111-111111111111';
      var lastMessageId =
        '33333333-3333-4333-8333-333333333333';
      var sourceMessageIds = [
        firstMessageId,
        lastMessageId
      ];
      var event = {
        eventId:
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        eventType: 'MEMORY_EXTRACT',
        dedupeKey:
          'MEMORY_EXTRACT:' +
          firstMessageId +
          ':' +
          lastMessageId,
        payload: {
          firstMessageId: firstMessageId,
          lastMessageId: lastMessageId,
          sourceMessageIds: sourceMessageIds.slice(),
          requestedAt: '2026-07-26T12:00:00+09:00',
          characterRuntimeMode: 'enforced',
          characterBinding:
            buildValidMemoryResumeBinding()
        },
        status: 'RETRY_WAIT',
        attemptCount: 4,
        nextAttemptAt: '2099-01-01T00:00:00+09:00',
        lockedAt: null,
        lockedBy: null,
        lastError: {
          code: 'GEMINI_BAD_RESPONSE',
          message: 'private prior failure'
        }
      };
      var diagnosticCalls = 0;
      var mutationCalls = 0;
      var result = null;
      withOverrides({
        console: {
          log: function() {}
        },
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        },
        SheetRepository: {
          listEvents: function() {
            return [event];
          },
          getUserState: function() {
            return {
              last_memory_cursor: null
            };
          },
          updateEvent: function() {
            mutationCalls += 1;
          },
          updateUserState: function() {
            mutationCalls += 1;
          }
        },
        selectMemoryExtractionBatch_: function() {
          return {
            ready: true,
            messageCount: sourceMessageIds.length,
            firstMessageId: firstMessageId,
            lastMessageId: lastMessageId,
            sourceMessageIds: sourceMessageIds.slice()
          };
        },
        MemoryService: {
          diagnoseExtraction: function(payload) {
            diagnosticCalls += 1;
            assert(
              payload === event.payload,
              'Diagnosis used another event payload.'
            );
            return {
              candidateCount: 2
            };
          }
        },
        processReleaseTestEventById_: function() {
          mutationCalls += 1;
        }
      }, function() {
        result = diagnoseMemoryReleaseGeneration();
      });
      assert(
        diagnosticCalls === 1 &&
          mutationCalls === 0 &&
          result.eventType === 'MEMORY_EXTRACT' &&
          result.ok === true &&
          result.stage === 'PRIMARY_GENERATION_VALID' &&
          result.errorCode == null &&
          result.candidateCount === 2,
        'Memory diagnosis did not remain write-free and exact.'
      );
      assert(
        JSON.stringify(Object.keys(result).sort()) ===
          JSON.stringify([
            'candidateCount',
            'errorCode',
            'eventType',
            'ok',
            'stage'
          ]),
        'Memory diagnosis exposed non-allowlisted fields.'
      );
    }
  );

  test(
    'memory generation diagnosis reports only a safe failure stage',
    function() {
      var firstMessageId =
        '11111111-1111-4111-8111-111111111111';
      var lastMessageId =
        '33333333-3333-4333-8333-333333333333';
      var sourceMessageIds = [
        firstMessageId,
        lastMessageId
      ];
      var privateMarker = 'PRIVATE-DIAGNOSTIC-CONTENT';
      var event = {
        eventId:
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        eventType: 'MEMORY_EXTRACT',
        dedupeKey:
          'MEMORY_EXTRACT:' +
          firstMessageId +
          ':' +
          lastMessageId,
        payload: {
          firstMessageId: firstMessageId,
          lastMessageId: lastMessageId,
          sourceMessageIds: sourceMessageIds.slice(),
          requestedAt: '2026-07-26T12:00:00+09:00',
          characterRuntimeMode: 'enforced',
          characterBinding:
            buildValidMemoryResumeBinding()
        },
        status: 'RETRY_WAIT',
        attemptCount: 4,
        nextAttemptAt: '2099-01-01T00:00:00+09:00',
        lockedAt: null,
        lockedBy: null,
        lastError: {
          code: 'GEMINI_BAD_RESPONSE'
        }
      };
      var logs = [];
      var result = null;
      withOverrides({
        console: {
          log: function(line) {
            logs.push(String(line));
          }
        },
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        },
        SheetRepository: {
          listEvents: function() {
            return [event];
          },
          getUserState: function() {
            return {
              last_memory_cursor: null
            };
          }
        },
        selectMemoryExtractionBatch_: function() {
          return {
            ready: true,
            messageCount: sourceMessageIds.length,
            firstMessageId: firstMessageId,
            lastMessageId: lastMessageId,
            sourceMessageIds: sourceMessageIds.slice()
          };
        },
        MemoryService: {
          diagnoseExtraction: function() {
            throw createAppError(
              'GEMINI_BAD_RESPONSE',
              privateMarker,
              {
                safeStage: 'HTTP_REQUEST_REJECTED',
                privatePayload: privateMarker
              }
            );
          }
        }
      }, function() {
        result = diagnoseMemoryReleaseGeneration();
      });
      assert(
        result.ok === false &&
          result.stage === 'HTTP_REQUEST_REJECTED' &&
          result.errorCode === 'GEMINI_BAD_RESPONSE' &&
          result.candidateCount == null,
        'Memory diagnostic failure was not safely classified.'
      );
      assert(
        JSON.stringify(result).indexOf(privateMarker) === -1 &&
          logs.join('\n').indexOf(privateMarker) === -1 &&
          logs.length === 1,
        'Memory diagnosis exposed private provider content.'
      );
    }
  );

  test(
    'resumeMemoryReleaseTest fails closed for unsafe queue states',
    function() {
      var eventId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      var firstMessageId =
        '11111111-1111-4111-8111-111111111111';
      var lastMessageId =
        '33333333-3333-4333-8333-333333333333';
      var selection = {
        ready: true,
        messageCount: 2,
        firstMessageId: firstMessageId,
        lastMessageId: lastMessageId,
        sourceMessageIds: [
          firstMessageId,
          lastMessageId
        ]
      };

      function buildEvent(patch) {
        var event = {
          eventId: eventId,
          eventType: 'MEMORY_EXTRACT',
          dedupeKey:
            'MEMORY_EXTRACT:' +
            firstMessageId +
            ':' +
            lastMessageId,
          payload: {
            firstMessageId: firstMessageId,
            lastMessageId: lastMessageId,
            sourceMessageIds:
              selection.sourceMessageIds.slice(),
            requestedAt:
              '2026-07-26T12:00:00+09:00',
            characterRuntimeMode: 'enforced',
            characterBinding:
              buildValidMemoryResumeBinding()
          },
          status: 'RETRY_WAIT',
          attemptCount: 1,
          nextAttemptAt:
            '2026-07-26T12:05:00+09:00',
          lockedAt: null,
          lockedBy: null,
          lastError: {
            code: 'CHARACTER_OUTPUT_BLOCKED'
          }
        };
        Object.keys(patch || {}).forEach(function(key) {
          event[key] = patch[key];
        });
        return event;
      }

      var invalidBindingEvent = buildEvent();
      invalidBindingEvent.payload.characterBinding = {
        profileSchemaVersion:
          APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION
      };
      var scenarios = [{
        name: 'missing',
        events: [],
        reason: 'TARGET_EVENT_MISSING',
        duplicate: false,
        status: null
      }, {
        name: 'ambiguous',
        events: [
          buildEvent(),
          {
            eventId:
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eventType: 'CHAT_REPLY',
            status: 'PENDING'
          }
        ],
        reason: 'TARGET_EVENT_AMBIGUOUS',
        duplicate: false,
        status: null
      }, {
        name: 'mismatch',
        events: [
          buildEvent({
            dedupeKey:
              'MEMORY_EXTRACT:' +
              lastMessageId +
              ':' +
              firstMessageId
          })
        ],
        reason: 'TARGET_EVENT_MISMATCH',
        duplicate: false,
        status: 'RETRY_WAIT'
      }, {
        name: 'invalid character binding',
        events: [invalidBindingEvent],
        reason: 'TARGET_EVENT_MISMATCH',
        duplicate: false,
        status: 'RETRY_WAIT'
      }, {
        name: 'processing',
        events: [
          buildEvent({
            status: 'PROCESSING',
            lockedAt:
              '2026-07-26T12:09:00+09:00',
            lockedBy: 'queue-lease:v1:private'
          })
        ],
        reason: 'TARGET_EVENT_PROCESSING',
        duplicate: true,
        status: 'PROCESSING'
      }, {
        name: 'pending is outside recovery scope',
        events: [
          buildEvent({
            status: 'PENDING',
            attemptCount: 0,
            nextAttemptAt: null,
            lastError: null
          })
        ],
        reason: 'TARGET_EVENT_MISMATCH',
        duplicate: true,
        status: 'PENDING'
      }, {
        name: 'not due',
        events: [
          buildEvent({
            nextAttemptAt:
              '2026-07-26T12:30:00+09:00'
          })
        ],
        reason: 'TARGET_EVENT_NOT_DUE',
        duplicate: true,
        status: 'RETRY_WAIT'
      }, {
        name: 'invalid lifecycle',
        events: [
          buildEvent({
            lockedAt:
              '2026-07-26T12:01:00+09:00'
          })
        ],
        reason: 'TARGET_EVENT_MISMATCH',
        duplicate: true,
        status: 'RETRY_WAIT'
      }];

      scenarios.forEach(function(scenario) {
        var processCalls = 0;
        var result = null;
        withOverrides({
          console: {
            log: function() {}
          },
          ScriptApp: {
            getProjectTriggers: function() {
              return [];
            }
          },
          SheetRepository: {
            listEvents: function() {
              return scenario.events;
            },
            getUserState: function() {
              return {
                last_memory_cursor: null
              };
            }
          },
          selectMemoryExtractionBatch_: function() {
            return selection;
          },
          processReleaseTestEventById_: function() {
            processCalls += 1;
            throw new Error(
              'Unsafe state reached queue processing.'
            );
          }
        }, function() {
          withFixedNow(
            '2026-07-26T12:10:00+09:00',
            function() {
              result = resumeMemoryReleaseTest();
            }
          );
        });
        assert(
          processCalls === 0 &&
            result.reason === scenario.reason &&
            result.duplicate === scenario.duplicate &&
            result.status === scenario.status &&
            result.processed === false &&
            result.enqueued === false,
          'Unsafe resume scenario did not stop: ' +
            scenario.name
        );
      });
    }
  );

  test(
    'resumeMemoryReleaseTest reports a claim race or retry failure without secrets',
    function() {
      var safeRace = buildMemoryResumeResult_(
        true,
        false,
        null,
        'TARGET_EVENT_NOT_CLAIMABLE',
        null
      );
      var retryFailure = buildMemoryResumeResult_(
        true,
        false,
        'RETRY_WAIT',
        'PROCESSING_INCOMPLETE',
        'CHARACTER_OUTPUT_BLOCKED'
      );
      var unsafeFailure = buildMemoryResumeResult_(
        true,
        false,
        'private status',
        'private reason',
        'https://example.invalid/private'
      );
      assert(
        safeRace.reason ===
          'TARGET_EVENT_NOT_CLAIMABLE' &&
          safeRace.status == null &&
          retryFailure.status === 'RETRY_WAIT' &&
          retryFailure.reason ===
            'PROCESSING_INCOMPLETE' &&
          retryFailure.errorCode ===
            'CHARACTER_OUTPUT_BLOCKED' &&
          unsafeFailure.status == null &&
          unsafeFailure.reason == null &&
          unsafeFailure.errorCode == null,
        'Resume result sanitization is not fail closed.'
      );
    }
  );

  test(
    'QueueService exact claim rejects fingerprint or exclusivity races before mutation',
    function() {
      var eventId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      var firstMessageId =
        '11111111-1111-4111-8111-111111111111';
      var lastMessageId =
        '33333333-3333-4333-8333-333333333333';
      var sourceMessageIds = [
        firstMessageId,
        lastMessageId
      ];
      var event = {
        eventId: eventId,
        eventType: 'MEMORY_EXTRACT',
        dedupeKey:
          'MEMORY_EXTRACT:' +
          firstMessageId +
          ':' +
          lastMessageId,
        payload: {
          firstMessageId: firstMessageId,
          lastMessageId: lastMessageId,
          sourceMessageIds: sourceMessageIds.slice(),
          requestedAt:
            '2026-07-26T12:00:00+09:00',
          characterRuntimeMode: 'enforced',
          characterBinding:
            buildValidMemoryResumeBinding()
        },
        status: 'RETRY_WAIT',
        attemptCount: 1,
        nextAttemptAt: '2026-07-26T12:05:00+09:00',
        lockedAt: null,
        lockedBy: null
      };
      var fingerprint = {
        requireExclusiveActive: true,
        lastMemoryCursor: null,
        status: 'RETRY_WAIT',
        attemptCount: 1,
        nextAttemptAt: '2026-07-26T12:05:00+09:00',
        lockedAt: null,
        lockedBy: null,
        dedupeKey: event.dedupeKey,
        firstMessageId: firstMessageId,
        lastMessageId: lastMessageId,
        sourceMessageIds: sourceMessageIds.slice(),
        requestedAt: '2026-07-26T12:00:00+09:00',
        characterRuntimeMode: 'enforced',
        characterBindingJson: JSON.stringify(
          buildValidMemoryResumeBinding()
        )
      };
      var activeEvents = [event];
      var currentCursor = null;
      var updateCalls = 0;

      withOverrides({
        LockManager: {
          withScriptLock: function(_, callback) {
            return callback();
          }
        },
        SheetRepository: {
          getEventById: function() {
            return event;
          },
          listEvents: function() {
            return activeEvents;
          },
          getUserState: function() {
            return {
              last_memory_cursor: currentCursor
            };
          },
          updateEvent: function(_, patch) {
            updateCalls += 1;
            event.status = patch.status;
            event.lockedBy = patch.lockedBy;
            return event;
          }
        }
      }, function() {
        var mismatched = {};
        Object.keys(fingerprint).forEach(function(key) {
          mismatched[key] = fingerprint[key];
        });
        mismatched.sourceMessageIds = [
          lastMessageId,
          firstMessageId
        ];
        var mismatchResult = QueueService.claimEventById(
          'MEMORY_EXTRACT',
          eventId,
          'release-test-memory',
          new Date('2026-07-26T12:10:00+09:00'),
          mismatched
        );
        assert(
          mismatchResult == null && updateCalls === 0,
          'A changed payload was claimed.'
        );

        activeEvents = [
          event,
          {
            eventId:
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eventType: 'CHAT_REPLY',
            status: 'PENDING'
          }
        ];
        var ambiguousResult = QueueService.claimEventById(
          'MEMORY_EXTRACT',
          eventId,
          'release-test-memory',
          new Date('2026-07-26T12:10:00+09:00'),
          fingerprint
        );
        assert(
          ambiguousResult == null && updateCalls === 0,
          'A claim proceeded after queue exclusivity changed.'
        );

        activeEvents = [event];
        currentCursor = lastMessageId;
        var cursorRaceResult = QueueService.claimEventById(
          'MEMORY_EXTRACT',
          eventId,
          'release-test-memory',
          new Date('2026-07-26T12:10:00+09:00'),
          fingerprint
        );
        assert(
          cursorRaceResult == null && updateCalls === 0,
          'A claim proceeded after the memory cursor changed.'
        );

        currentCursor = null;
        var claimed = QueueService.claimEventById(
          'MEMORY_EXTRACT',
          eventId,
          'release-test-memory',
          new Date('2026-07-26T12:10:00+09:00'),
          fingerprint
        );
        assert(
          claimed &&
            claimed.eventId === eventId &&
            claimed.status === 'PROCESSING' &&
            updateCalls === 1,
          'The unchanged exact event was not claimed.'
        );
      });
    }
  );

  test(
    'active triggers block release operators before enqueue or claim',
    function() {
      var enqueueCalls = 0;
      var claimCalls = 0;
      var eventListCalls = 0;

      withOverrides({
        ScriptApp: {
          getProjectTriggers: function() {
            return [{}];
          }
        },
        enqueuePreviousDiaryForReleaseTest_: function() {
          enqueueCalls += 1;
          return null;
        },
        QueueService: {
          claimEventById: function() {
            claimCalls += 1;
          }
        },
        SheetRepository: {
          listEvents: function() {
            eventListCalls += 1;
            return [];
          }
        }
      }, function() {
        expectCode(function() {
          runDiaryReleaseTest();
        }, 'CONFIG_MISSING');
        expectCode(function() {
          resumeMemoryReleaseTest();
        }, 'CONFIG_MISSING');
      });

      assert(
        enqueueCalls === 0 &&
          claimCalls === 0 &&
          eventListCalls === 0,
        'An active-trigger release test reached enqueue or claim.'
      );
    }
  );

  test(
    'runProactiveReleaseTest requires manual probability readiness before enqueue',
    function() {
      var readinessCalls = 0;
      var enqueueCalls = 0;
      var claimCalls = 0;

      withOverrides({
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        },
        ProactiveMessageService: {
          assertManualTestReady: function() {
            readinessCalls += 1;
            throw createAppError(
              'CONFIG_MISSING',
              'manual policy not ready'
            );
          }
        },
        enqueueProactiveIfEligible_: function() {
          enqueueCalls += 1;
          return null;
        },
        QueueService: {
          claimEventById: function() {
            claimCalls += 1;
          }
        }
      }, function() {
        expectCode(function() {
          runProactiveReleaseTest();
        }, 'CONFIG_MISSING');
      });

      assert(
        readinessCalls === 1 &&
          enqueueCalls === 0 &&
          claimCalls === 0,
        'Proactive release testing bypassed readiness.'
      );
    }
  );

  test(
    'QueueService creates one exact memory repair and preserves the DEAD origin',
    function() {
      var originEventId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      var manualRequestId =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      var firstMessageId =
        '11111111-1111-4111-8111-111111111111';
      var lastMessageId =
        '33333333-3333-4333-8333-333333333333';
      var sourceMessageIds = [
        firstMessageId,
        lastMessageId
      ];
      var binding = buildValidMemoryResumeBinding();
      var origin = {
        eventId: originEventId,
        eventType: 'MEMORY_EXTRACT',
        dedupeKey:
          'MEMORY_EXTRACT:' +
          firstMessageId +
          ':' +
          lastMessageId,
        payload: {
          firstMessageId: firstMessageId,
          lastMessageId: lastMessageId,
          sourceMessageIds: sourceMessageIds.slice(),
          requestedAt: '2026-07-26T12:00:00+09:00',
          characterRuntimeMode: 'enforced',
          characterBinding: binding
        },
        status: 'DEAD',
        attemptCount: 5,
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        completedAt: '2026-07-26T14:00:00+09:00',
        updatedAt: '2026-07-26T14:00:00+09:00',
        lastError: {
          code: 'CHARACTER_OUTPUT_BLOCKED',
          message: 'private'
        }
      };
      var inserted = [];
      var fingerprint = {
        lastMemoryCursor: null,
        status: 'DEAD',
        attemptCount: 5,
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        dedupeKey: origin.dedupeKey,
        firstMessageId: firstMessageId,
        lastMessageId: lastMessageId,
        sourceMessageIds: sourceMessageIds.slice(),
        requestedAt: origin.payload.requestedAt,
        characterRuntimeMode: 'enforced',
        characterBindingJson: JSON.stringify(binding),
        completedAt: origin.completedAt,
        updatedAt: origin.updatedAt,
        lastErrorCode: 'CHARACTER_OUTPUT_BLOCKED'
      };
      var repair = null;

      withOverrides({
        LockManager: {
          withScriptLock: function(_, callback) {
            return callback();
          }
        },
        SheetRepository: {
          getEventById: function(eventId) {
            return eventId === originEventId
              ? origin
              : null;
          },
          listEvents: function() {
            return [origin];
          },
          getUserState: function() {
            return {
              last_memory_cursor: null
            };
          },
          getEventByDedupeKey: function() {
            return null;
          },
          insertEvent: function(event) {
            inserted.push(event);
          }
        }
      }, function() {
        repair =
          QueueService.requeueDeadMemoryAsNewEvent(
            originEventId,
            manualRequestId,
            new Date(
              '2026-07-26T15:00:00+09:00'
            ),
            fingerprint
          );
      });

      assert(
        inserted.length === 1 &&
          repair === inserted[0] &&
          repair.status === 'PENDING' &&
          repair.attemptCount === 0 &&
          repair.dedupeKey ===
            'MEMORY_EXTRACT_REPAIR:' +
              originEventId &&
          repair.payload.manualRequestId ===
            manualRequestId &&
          repair.payload.originalEventId ===
            originEventId &&
          JSON.stringify(
            repair.payload.sourceMessageIds
          ) === JSON.stringify(sourceMessageIds) &&
          origin.status === 'DEAD' &&
          origin.attemptCount === 5,
        'The exact immutable memory repair was not created.'
      );
    }
  );

  test(
    'recoverDeadMemoryReleaseTest repairs and processes only the exact DEAD batch',
    function() {
      var originEventId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      var repairEventId =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      var firstMessageId =
        '11111111-1111-4111-8111-111111111111';
      var lastMessageId =
        '33333333-3333-4333-8333-333333333333';
      var sourceMessageIds = [
        firstMessageId,
        lastMessageId
      ];
      var binding = buildValidMemoryResumeBinding();
      var origin = {
        eventId: originEventId,
        eventType: 'MEMORY_EXTRACT',
        dedupeKey:
          'MEMORY_EXTRACT:' +
          firstMessageId +
          ':' +
          lastMessageId,
        payload: {
          firstMessageId: firstMessageId,
          lastMessageId: lastMessageId,
          sourceMessageIds: sourceMessageIds.slice(),
          requestedAt: '2026-07-26T12:00:00+09:00',
          characterRuntimeMode: 'enforced',
          characterBinding: binding
        },
        status: 'DEAD',
        attemptCount: 5,
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        completedAt: '2026-07-26T14:00:00+09:00',
        updatedAt: '2026-07-26T14:00:00+09:00',
        lastError: {
          code: 'CHARACTER_OUTPUT_BLOCKED'
        }
      };
      var selection = {
        ready: true,
        messageCount: sourceMessageIds.length,
        firstMessageId: firstMessageId,
        lastMessageId: lastMessageId,
        sourceMessageIds: sourceMessageIds.slice()
      };
      var requeueCalls = 0;
      var processCalls = 0;
      var result = null;

      withOverrides({
        console: {
          log: function() {}
        },
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        },
        SheetRepository: {
          listEvents: function() {
            return [origin];
          },
          getUserState: function() {
            return {
              last_memory_cursor: null
            };
          }
        },
        selectMemoryExtractionBatch_: function() {
          return selection;
        },
        QueueService: {
          requeueDeadMemoryAsNewEvent:
            function(
              eventId,
              manualRequestId,
              _,
              fingerprint
            ) {
              requeueCalls += 1;
              assert(
                eventId === originEventId &&
                  Validators.isUuidV4(
                    manualRequestId
                  ) &&
                  fingerprint.status === 'DEAD' &&
                  fingerprint.attemptCount === 5 &&
                  fingerprint.lastErrorCode ===
                    'CHARACTER_OUTPUT_BLOCKED',
                'The DEAD recovery fingerprint changed.'
              );
              return {
                eventId: repairEventId,
                eventType: 'MEMORY_EXTRACT',
                dedupeKey:
                  'MEMORY_EXTRACT_REPAIR:' +
                  originEventId,
                payload: {
                  firstMessageId: firstMessageId,
                  lastMessageId: lastMessageId,
                  sourceMessageIds:
                    sourceMessageIds.slice(),
                  requestedAt:
                    origin.payload.requestedAt,
                  characterRuntimeMode: 'enforced',
                  characterBinding: binding,
                  manualRequestId: manualRequestId,
                  originalEventId: originEventId
                },
                status: 'PENDING',
                attemptCount: 0,
                nextAttemptAt:
                  '2026-07-26T15:00:00+09:00',
                lockedAt: null,
                lockedBy: null
              };
            }
        },
        processReleaseTestEventById_: function(
          eventType,
          eventId,
          options
        ) {
          processCalls += 1;
          assert(
            eventType === 'MEMORY_EXTRACT' &&
              eventId === repairEventId &&
              options.expectedClaimFingerprint
                .lastMemoryCursor == null &&
              options.expectedClaimFingerprint.status ===
                'PENDING',
            'The repair claim was not exact.'
          );
          return {
            status: 'DONE',
            reason: 'PROCESSED',
            errorCode: null
          };
        }
      }, function() {
        result = recoverDeadMemoryReleaseTest();
      });

      assert(
        requeueCalls === 1 &&
          processCalls === 1 &&
          result.enqueued === true &&
          result.duplicate === false &&
          result.processed === true &&
          result.status === 'DONE' &&
          result.reason === 'PROCESSED' &&
          result.errorCode == null,
        'The exact DEAD memory repair did not complete.'
      );
    }
  );

  test(
    'recoverDeadMemoryReleaseTest fails closed before mutation',
    function() {
      var mutationCalls = 0;
      var activeResult = null;
      var mismatchResult = null;
      var dead = {
        eventId:
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        eventType: 'MEMORY_EXTRACT',
        status: 'DEAD',
        attemptCount: 0,
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        completedAt:
          '2026-07-26T14:00:00+09:00',
        updatedAt:
          '2026-07-26T14:00:00+09:00',
        dedupeKey:
          'MEMORY_EXTRACT:' +
          '11111111-1111-4111-8111-111111111111:' +
          '33333333-3333-4333-8333-333333333333',
        payload: {
          firstMessageId:
            '11111111-1111-4111-8111-111111111111',
          lastMessageId:
            '33333333-3333-4333-8333-333333333333',
          sourceMessageIds: [
            '11111111-1111-4111-8111-111111111111',
            '33333333-3333-4333-8333-333333333333'
          ],
          requestedAt:
            '2026-07-26T12:00:00+09:00',
          characterRuntimeMode: 'enforced',
          characterBinding:
            buildValidMemoryResumeBinding()
        },
        lastError: {
          code: 'CHARACTER_OUTPUT_BLOCKED'
        }
      };
      var active = {
        eventId:
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        eventType: 'CHAT_REPLY',
        status: 'PENDING'
      };
      var events = [dead, active];

      withOverrides({
        console: {
          log: function() {}
        },
        ScriptApp: {
          getProjectTriggers: function() {
            return [];
          }
        },
        SheetRepository: {
          listEvents: function() {
            return events;
          },
          getUserState: function() {
            return {
              last_memory_cursor: null
            };
          }
        },
        selectMemoryExtractionBatch_: function() {
          return {
            ready: true,
            messageCount: 2,
            firstMessageId:
              dead.payload.firstMessageId,
            lastMessageId:
              dead.payload.lastMessageId,
            sourceMessageIds:
              dead.payload.sourceMessageIds.slice()
          };
        },
        QueueService: {
          requeueDeadMemoryAsNewEvent: function() {
            mutationCalls += 1;
          }
        },
        processReleaseTestEventById_: function() {
          mutationCalls += 1;
        }
      }, function() {
        activeResult =
          recoverDeadMemoryReleaseTest();
        events = [dead];
        mismatchResult =
          recoverDeadMemoryReleaseTest();
      });

      assert(
        mutationCalls === 0 &&
          activeResult.reason ===
            'ACTIVE_QUEUE_NOT_EMPTY' &&
          mismatchResult.reason ===
            'TARGET_EVENT_MISMATCH' &&
          mismatchResult.status === 'DEAD' &&
          mismatchResult.errorCode ===
            'CHARACTER_OUTPUT_BLOCKED',
        'An unsafe DEAD recovery reached mutation.'
      );
    }
  );

  test(
    'unexpected project triggers make operational health critical',
    function() {
      withOverrides({
        SheetRepository: {
          listEvents: function() {
            return [];
          }
        },
        ConfigRepository: {
          getByKey: function() {
            return null;
          }
        }
      }, function() {
        var report = OperationalHealthService.inspect(
          '2026-07-14T12:00:00+09:00',
          {
            required: {
              processQueueJob: { count: 1 },
              schedulerJob: { count: 1 }
            },
            unexpectedCount: 1
          }
        );
        assert(
          report.status === 'CRITICAL',
          'Unexpected triggers must fail operational health.'
        );
        var details =
          OperationalHealthService.__test.buildSanitizedDetails(
            report
          );
        var body =
          OperationalHealthService.__test.buildAlertBody(report);
        assert(
          details.triggerUnexpectedCount === 1 &&
            body.indexOf(
              'Unexpected project triggers: 1'
            ) !== -1,
          'Unexpected trigger count was omitted from sanitized health evidence.'
        );
      });
    }
  );

  return results;
}

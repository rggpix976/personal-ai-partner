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

  function buildPolicyBinding(overrides) {
    var binding = {
      environment: 'prod',
      frequency: 'normal',
      mode: 'probability'
    };
    Object.keys(overrides || {}).forEach(function(key) {
      binding[key] = overrides[key];
    });
    return binding;
  }

  function buildProperties(environment, ownerEmail) {
    return {
      getScriptProperties: function() {
        return {
          getProperty: function(key) {
            if (key === 'APP_ENV') {
              return environment || 'prod';
            }
            if (key === 'OWNER_EMAIL') {
              return ownerEmail || 'owner@example.invalid';
            }
            return null;
          }
        };
      }
    };
  }

  function buildDecisionPayload(overrides) {
    var payload = {
      targetDate: '2026-07-14',
      sequence: 1,
      requestedAt: '2026-07-14T12:00:00+09:00',
      decisionSlot: '12345',
      messageDedupeKey:
        'PROACTIVE_MESSAGE:2026-07-14:1',
      probability: 1,
      sample: 0,
      elapsedMinutes: 720,
      timeWeight: 1,
      reason: 'deterministic_probability_hit',
      policyBinding: buildPolicyBinding(),
      characterRuntimeMode: 'legacy'
    };
    Object.keys(overrides || {}).forEach(function(key) {
      payload[key] = overrides[key];
    });
    return payload;
  }

  function buildLiveDeliveryFixture() {
    var now = new Date();
    var targetDate = formatDateInTokyo(now);
    var requestedAt = toIsoStringInTokyo(
      new Date(now.getTime() - 60 * 1000)
    );
    var lastUserAt = toIsoStringInTokyo(
      new Date(now.getTime() - 13 * 60 * 60 * 1000)
    );
    var quietStart = Utilities.formatDate(
      new Date(now.getTime() + 10 * 60 * 1000),
      APP_CONSTANTS.TIME_ZONE,
      'HH:mm'
    );
    var quietEnd = Utilities.formatDate(
      new Date(now.getTime() + 11 * 60 * 1000),
      APP_CONSTANTS.TIME_ZONE,
      'HH:mm'
    );
    return {
      now: now,
      nowIso: toIsoStringInTokyo(now),
      targetDate: targetDate,
      requestedAt: requestedAt,
      lastUserAt: lastUserAt,
      quietStart: quietStart,
      quietEnd: quietEnd,
      payload: buildDecisionPayload({
        targetDate: targetDate,
        requestedAt: requestedAt,
        messageDedupeKey:
          'PROACTIVE_MESSAGE:' + targetDate + ':1',
        elapsedMinutes: 13 * 60
      })
    };
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

  test(
    'test and production frequencies resolve to the approved timing profiles',
    function() {
      var expected = {
        test: {
          low: [60, 120, 5],
          normal: [15, 30, 5],
          high: [5, 10, 5]
        },
        prod: {
          low: [480, 720, 60],
          normal: [240, 720, 60],
          high: [120, 720, 60]
        }
      };

      Object.keys(expected).forEach(function(environment) {
        Object.keys(expected[environment]).forEach(function(frequency) {
          var resolved = null;
          withOverrides({
            ConfigRepository: buildConfig(buildBaseConfig({
              PROACTIVE_FREQUENCY: frequency
            })),
            PropertiesService: {
              getScriptProperties: function() {
                return {
                  getProperty: function(key) {
                    return key === 'APP_ENV'
                      ? environment
                      : null;
                  }
                };
              }
            }
          }, function() {
            resolved =
              ProactiveMessageService.__test.resolveTimingPolicy();
          });
          var values = expected[environment][frequency];
          assert(
            resolved.environment === environment &&
              resolved.frequency === frequency &&
              resolved.silenceFloorMinutes === values[0] &&
              resolved.silenceCeilingMinutes === values[1] &&
              resolved.recheckMinutes === values[2],
            environment + '/' + frequency +
              ' did not resolve to the approved timing.'
          );
        });
      });
    }
  );

  test(
    'off blocks eligibility before user-state or mail-quota access',
    function() {
      var stateReads = 0;
      var quotaReads = 0;
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig({
          PROACTIVE_FREQUENCY: 'off'
        })),
        PropertiesService: buildProperties('prod'),
        SheetRepository: {
          ensureDefaultUserState: function() {
            stateReads += 1;
          },
          getUserState: function() {
            stateReads += 1;
          }
        },
        GmailNotifier: {
          getRemainingQuota: function() {
            quotaReads += 1;
            return 10;
          }
        }
      }, function() {
        var result =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-14T20:00:00+09:00'
          );
        assert(
          result.eligible === false &&
            result.reason === 'PROACTIVE_FREQUENCY_OFF' &&
            result.payload === null,
          'Off must return the managed no-enqueue result.'
        );
      });
      assert(
        stateReads === 0 && quotaReads === 0,
        'Off must not read user state or mail quota.'
      );
    }
  );

  test(
    'invalid or duplicate frequency fails closed before eligibility state access',
    function() {
      var stateReads = 0;
      withOverrides({
        ConfigRepository: {
          getUniqueByKey: function(key) {
            if (key === 'PROACTIVE_FREQUENCY') {
              throw createAppError(
                'STORAGE_DATA_CORRUPTED',
                'duplicate'
              );
            }
            return null;
          },
          getByKey: function() {
            return null;
          }
        },
        PropertiesService: buildProperties('prod'),
        SheetRepository: {
          ensureDefaultUserState: function() {
            stateReads += 1;
          },
          getUserState: function() {
            stateReads += 1;
          }
        }
      }, function() {
        var duplicate =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-14T20:00:00+09:00'
          );
        assert(
          duplicate.eligible === false &&
            duplicate.reason === 'CONFIG_MISSING' &&
            duplicate.warnings.indexOf(
              'STORAGE_DATA_CORRUPTED'
            ) !== -1,
          'Duplicate frequency must fail closed.'
        );
      });
      assert(
        stateReads === 0,
        'Invalid frequency must fail before user-state access.'
      );
    }
  );

  test(
    'only the approved production probability policy allows automatic triggers',
    function() {
      var production = null;
      var accelerated = null;
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig()),
        PropertiesService: {
          getScriptProperties: function() {
            return {
              getProperty: function(key) {
                return key === 'APP_ENV' ? 'prod' : null;
              }
            };
          }
        }
      }, function() {
        production = ProactiveMessageService.inspectPolicy(
          '2026-07-14T20:00:00+09:00'
        );
      });
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig()),
        PropertiesService: {
          getScriptProperties: function() {
            return {
              getProperty: function(key) {
                return key === 'APP_ENV' ? 'test' : null;
              }
            };
          }
        }
      }, function() {
        accelerated = ProactiveMessageService.inspectPolicy(
          '2026-07-14T20:00:00+09:00'
        );
      });
      assert(
        production.valid === true &&
          production.automaticTriggersAllowed === true &&
          production.policyMode === 'probability' &&
          production.guardrails.cooldownMinutes === 240 &&
          production.guardrails.maxPerDay === 2 &&
          production.guardrails.quietHoursEnabled === true,
        'The approved production policy must allow automatic triggers.'
      );
      assert(
        accelerated.valid === true &&
          accelerated.automaticTriggersAllowed === false &&
          accelerated.manualTestAllowed === true,
        'The accelerated policy must never allow automatic triggers.'
      );
    }
  );

  test(
    'production threshold and approved-policy drift fail closed before state or delivery access',
    function() {
      [
        {
          label: 'threshold mode',
          config: {
            PROACTIVE_POLICY_MODE: 'threshold'
          },
          binding: {
            mode: 'threshold'
          }
        },
        {
          label: 'custom silence floor',
          config: {
            SILENCE_MINUTES: 300
          }
        },
        {
          label: 'custom probability ceiling',
          config: {
            PROACTIVE_SILENCE_CEILING_MINUTES: 600
          }
        },
        {
          label: 'custom decision slot',
          config: {
            PROACTIVE_RECHECK_MINUTES: 30
          }
        },
        {
          label: 'cooldown drift',
          config: {
            PROACTIVE_COOLDOWN_MINUTES: 239
          }
        },
        {
          label: 'daily-cap drift',
          config: {
            PROACTIVE_MAX_PER_DAY: 3
          }
        },
        {
          label: 'disabled quiet-hours boundary',
          config: {
            QUIET_START: '08:00',
            QUIET_END: '08:00'
          }
        }
      ].forEach(function(fixture) {
        var stateReads = 0;
        var markerReads = 0;
        var mailReads = 0;
        var evaluation = null;
        var prepared = null;
        withOverrides({
          ConfigRepository: buildConfig(
            buildBaseConfig(fixture.config)
          ),
          PropertiesService: {
            getScriptProperties: function() {
              return {
                getProperty: function(key) {
                  return key === 'APP_ENV'
                    ? 'prod'
                    : null;
                }
              };
            }
          },
          SheetRepository: {
            ensureDefaultUserState: function() {
              stateReads += 1;
              return null;
            },
            getUserState: function() {
              stateReads += 1;
              return null;
            },
            getMessageByRequestIdAndRole: function() {
              markerReads += 1;
              return null;
            }
          },
          GmailNotifier: {
            getRemainingQuota: function() {
              mailReads += 1;
              return 10;
            },
            send: function() {
              mailReads += 1;
            }
          }
        }, function() {
          evaluation =
            ProactiveMessageService.evaluateLocalConditions(
              '2026-07-14T20:00:00+09:00'
            );
          prepared = ProactiveMessageService.prepareDispatch(
            buildDecisionPayload({
              policyBinding: buildPolicyBinding(
                fixture.binding
              )
            }),
            '2026-07-14T20:01:00+09:00'
          );
        });
        assert(
          evaluation.eligible === false &&
            evaluation.reason ===
              'PROACTIVE_PRODUCTION_POLICY_NOT_READY',
          fixture.label +
            ' did not fail closed during evaluation.'
        );
        assert(
          prepared.eligible === false &&
            prepared.reason ===
              'PROACTIVE_PRODUCTION_POLICY_NOT_READY',
          fixture.label +
            ' did not fail closed during preparation.'
        );
        assert(
          stateReads === 0 &&
            markerReads === 0 &&
            mailReads === 0,
          fixture.label +
            ' reached state, marker, or mail access.'
        );
      });
    }
  );

  test(
    'missing duplicate or mistyped probability controls cannot pass production inspection',
    function() {
      var baseValues = buildBaseConfig();
      var missingValues = buildBaseConfig();
      delete missingValues.PROACTIVE_MORNING_WEIGHT;
      var repositories = [
        {
          label: 'missing weight',
          repository: buildConfig(missingValues)
        },
        {
          label: 'mistyped curve',
          repository: {
            getUniqueByKey: function(key) {
              return Object.prototype.hasOwnProperty.call(
                baseValues,
                key
              )
                ? {
                  value: baseValues[key],
                  type: key ===
                    'PROACTIVE_PROBABILITY_CURVE'
                    ? 'string'
                    : null
                }
                : null;
            },
            getByKey: function(key) {
              return this.getUniqueByKey(key);
            }
          }
        },
        {
          label: 'duplicate day start',
          repository: {
            getUniqueByKey: function(key) {
              if (key === 'PROACTIVE_DAY_START') {
                throw createAppError(
                  'STORAGE_DATA_CORRUPTED',
                  'duplicate'
                );
              }
              return Object.prototype.hasOwnProperty.call(
                baseValues,
                key
              )
                ? { value: baseValues[key] }
                : null;
            },
            getByKey: function(key) {
              return this.getUniqueByKey(key);
            }
          }
        }
      ];

      repositories.forEach(function(fixture) {
        var inspection = null;
        withOverrides({
          ConfigRepository: fixture.repository,
          PropertiesService: {
            getScriptProperties: function() {
              return {
                getProperty: function(key) {
                  return key === 'APP_ENV'
                    ? 'prod'
                    : null;
                }
              };
            }
          }
        }, function() {
          inspection = ProactiveMessageService.inspectPolicy(
            '2026-07-14T20:00:00+09:00'
          );
        });
        assert(
          inspection.valid === false &&
            inspection.automaticTriggersAllowed === false,
          fixture.label +
            ' incorrectly passed production inspection.'
        );
      });
    }
  );

  test(
    'test threshold policy cannot be evaluated through the manual profile',
    function() {
      var stateReads = 0;
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig({
          PROACTIVE_FREQUENCY: 'high',
          PROACTIVE_POLICY_MODE: 'threshold'
        })),
        PropertiesService: {
          getScriptProperties: function() {
            return {
              getProperty: function(key) {
                return key === 'APP_ENV'
                  ? 'test'
                  : null;
              }
            };
          }
        },
        SheetRepository: {
          ensureDefaultUserState: function() {
            stateReads += 1;
            return null;
          },
          getUserState: function() {
            stateReads += 1;
            return null;
          }
        }
      }, function() {
        var automatic =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-14T20:00:00+09:00'
          );
        var manual =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-14T20:00:00+09:00',
            { allowTestProfile: true }
          );
        var inspection = ProactiveMessageService.inspectPolicy(
          '2026-07-14T20:00:00+09:00'
        );
        assert(
          automatic.reason ===
            'PROACTIVE_TEST_PROFILE_MANUAL_ONLY',
          'Ordinary evaluation must reject every test profile.'
        );
        assert(
          manual.eligible === false &&
            manual.reason ===
              'PROACTIVE_TEST_POLICY_NOT_READY' &&
            inspection.manualTestAllowed === false,
          'Threshold must not become an approved manual test policy.'
        );
      });
      assert(
        stateReads === 0,
        'Rejected test threshold policy must not read user state.'
      );
    }
  );

  test(
    'test timing is manual-only and can be evaluated explicitly without automatic triggers',
    function() {
      var state = {
        last_user_message_at:
          '2026-07-14T19:50:00+09:00',
        last_proactive_at: null,
        proactive_count_date: '2026-07-14',
        proactive_count: 0,
        next_proactive_check_at: null,
        quiet_until: null
      };
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig({
          PROACTIVE_FREQUENCY: 'high'
        })),
        PropertiesService: {
          getScriptProperties: function() {
            return {
              getProperty: function(key) {
                return key === 'APP_ENV' ? 'test' : null;
              }
            };
          }
        },
        SheetRepository: {
          ensureDefaultUserState: function() {
            return state;
          },
          getUserState: function() {
            return state;
          }
        },
        GmailNotifier: {
          getRemainingQuota: function() {
            return 10;
          }
        }
      }, function() {
        var automatic =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-14T20:00:00+09:00'
          );
        var manual =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-14T20:00:00+09:00',
            { allowTestProfile: true }
          );
        assert(
          automatic.reason ===
            'PROACTIVE_TEST_PROFILE_MANUAL_ONLY',
          'Automatic evaluation must reject the accelerated profile.'
        );
        assert(
          manual.eligible === true &&
            manual.payload &&
            manual.payload.policyBinding.environment ===
              'test',
          'Explicit release-test evaluation must use the test binding.'
        );
      });
    }
  );

  test(
    'morning day evening weights rise while quiet hours remain authoritative',
    function() {
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig())
      }, function() {
        var morning =
          ProactiveMessageService.__test.getTimeWeight(
            new Date('2026-07-14T09:00:00+09:00')
          );
        var day =
          ProactiveMessageService.__test.getTimeWeight(
            new Date('2026-07-14T14:00:00+09:00')
          );
        var evening =
          ProactiveMessageService.__test.getTimeWeight(
            new Date('2026-07-14T20:00:00+09:00')
          );
        assert(
          morning === 0.7 && day === 1 && evening === 1.2,
          'Approved time weights were not preserved.'
        );
        assert(
          ProactiveMessageService.__test.calculateProbability(
            480,
            240,
            720,
            1.3,
            evening
          ) >
            ProactiveMessageService.__test.calculateProbability(
              480,
              240,
              720,
              1.3,
              day
            ),
          'Evening probability must exceed daytime probability.'
        );
      });

      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig()),
        PropertiesService: buildProperties('prod'),
        SheetRepository: {
          ensureDefaultUserState: function() {
            return {};
          },
          getUserState: function() {
            return {
              last_user_message_at:
                '2026-07-14T08:00:00+09:00',
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
        var quiet =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-14T23:30:00+09:00'
          );
        assert(
          quiet.reason === 'QUIET_HOURS',
          'Quiet hours must override the evening weight.'
        );
      });
    }
  );

  test(
    'final delivery assessment blocks off later user activity and the quiet-start boundary',
    function() {
      var payload = buildDecisionPayload({
        requestedAt: '2026-07-14T20:00:00+09:00'
      });
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig({
          PROACTIVE_FREQUENCY: 'off'
        })),
        PropertiesService: buildProperties('prod')
      }, function() {
        var off =
          ProactiveMessageService.__test.assessFinalDelivery(
            payload,
            '2026-07-14T20:01:00+09:00'
          );
        assert(
          off.allowed === false &&
            off.reason === 'PROACTIVE_FREQUENCY_OFF',
          'Final assessment must stop delivery after frequency is off.'
        );
      });

      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig()),
        PropertiesService: buildProperties('prod'),
        SheetRepository: {
          getUserState: function() {
            return {
              last_user_message_at:
                '2026-07-14T20:00:30+09:00',
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
        var laterActivity =
          ProactiveMessageService.__test.assessFinalDelivery(
            payload,
            '2026-07-14T20:01:00+09:00'
          );
        assert(
          laterActivity.allowed === false &&
            laterActivity.reason ===
              'USER_ACTIVITY_AFTER_ENQUEUE',
          'Final assessment must stop delivery after later user activity.'
        );
      });

      var boundaryPayload = buildDecisionPayload({
        requestedAt: '2026-07-14T07:00:00+09:00'
      });
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig()),
        PropertiesService: buildProperties('prod'),
        SheetRepository: {
          getUserState: function() {
            return {
              last_user_message_at:
                '2026-07-13T00:00:00+09:00',
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
        var atQuietStart =
          ProactiveMessageService.__test.assessFinalDelivery(
            boundaryPayload,
            '2026-07-14T23:00:00+09:00'
          );
        var atQuietEnd =
          ProactiveMessageService.__test.assessFinalDelivery(
            boundaryPayload,
            '2026-07-14T08:00:00+09:00'
          );
        assert(
          atQuietStart.allowed === false &&
            atQuietStart.reason === 'QUIET_HOURS',
          'Quiet start must be inclusive at the final gate.'
        );
        assert(
          atQuietEnd.allowed === true &&
            atQuietEnd.reason === 'ELIGIBLE',
          'Quiet end must be exclusive at the final gate.'
        );
      });
    }
  );

  test(
    'off or a changed policy binding cancels dispatch before marker and mail access',
    function() {
      var stateReads = 0;
      var markerReads = 0;
      var mailReads = 0;
      var payload = {
        targetDate: '2026-07-14',
        sequence: 1,
        requestedAt: '2026-07-14T20:00:00+09:00',
        decisionSlot: '1',
        messageDedupeKey:
          'PROACTIVE_MESSAGE:2026-07-14:1',
        probability: 1,
        sample: 0,
        elapsedMinutes: 720,
        timeWeight: 1.2,
        reason: 'deterministic_probability_hit',
        policyBinding: {
          environment: 'prod',
          frequency: 'normal',
          mode: 'probability'
        },
        characterRuntimeMode: 'legacy'
      };
      var repositories = {
        ensureDefaultUserState: function() {
          stateReads += 1;
        },
        getUserState: function() {
          stateReads += 1;
        },
        getMessageByRequestIdAndRole: function() {
          markerReads += 1;
          return null;
        }
      };
      var notifier = {
        getRemainingQuota: function() {
          mailReads += 1;
          return 10;
        },
        send: function() {
          mailReads += 1;
        }
      };

      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig({
          PROACTIVE_FREQUENCY: 'off'
        })),
        PropertiesService: buildProperties('prod'),
        SheetRepository: repositories,
        GmailNotifier: notifier
      }, function() {
        var off = ProactiveMessageService.prepareDispatch(
          payload,
          '2026-07-14T20:01:00+09:00'
        );
        assert(
          off.reason === 'PROACTIVE_FREQUENCY_OFF',
          'Turning frequency off must cancel queued delivery.'
        );
      });

      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig({
          PROACTIVE_FREQUENCY: 'high'
        })),
        PropertiesService: buildProperties('prod'),
        SheetRepository: repositories,
        GmailNotifier: notifier
      }, function() {
        var changed = ProactiveMessageService.prepareDispatch(
          payload,
          '2026-07-14T20:01:00+09:00'
        );
        assert(
          changed.reason === 'PROACTIVE_POLICY_CHANGED',
          'A changed policy binding must cancel queued delivery.'
        );
      });

      assert(
        stateReads === 0 &&
          markerReads === 0 &&
          mailReads === 0,
        'Managed policy cancellation must happen before delivery side effects.'
      );
    }
  );

  test(
    'missing policy binding stops preparation before state marker or mail access',
    function() {
      var stateReads = 0;
      var markerReads = 0;
      var mailReads = 0;
      var payload = buildDecisionPayload();
      delete payload.policyBinding;
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig()),
        PropertiesService: buildProperties('prod'),
        SheetRepository: {
          ensureDefaultUserState: function() {
            stateReads += 1;
            return null;
          },
          getUserState: function() {
            stateReads += 1;
            return null;
          },
          getMessageByRequestIdAndRole: function() {
            markerReads += 1;
            return null;
          }
        },
        GmailNotifier: {
          getRemainingQuota: function() {
            mailReads += 1;
            return 10;
          },
          send: function() {
            mailReads += 1;
          }
        }
      }, function() {
        var result = ProactiveMessageService.prepareDispatch(
          payload,
          '2026-07-14T20:01:00+09:00'
        );
        assert(
          result.eligible === false &&
            result.reason ===
              'PROACTIVE_POLICY_BINDING_MISSING',
          'Missing binding must return the managed no-send result.'
        );
      });
      assert(
        stateReads === 0 &&
          markerReads === 0 &&
          mailReads === 0,
        'Missing binding must stop before state, marker, or mail access.'
      );
    }
  );

  test(
    'policy-binding-only queue payload mutation fails lease identity validation',
    function() {
      var eventId =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      var leaseToken = 'a8-worker';
      var claimedPayload = buildDecisionPayload();
      var storedPayload = buildDecisionPayload({
        policyBinding: buildPolicyBinding({
          frequency: 'high'
        })
      });
      var caught = null;
      withOverrides({
        ConfigRepository: buildConfig(buildBaseConfig()),
        PropertiesService: buildProperties('prod'),
        SheetRepository: {
          getEventById: function(requestedId) {
            assert(
              requestedId === eventId,
              'Unexpected queue event lookup.'
            );
            return {
              eventId: eventId,
              eventType: 'PROACTIVE_SEND',
              payload: storedPayload,
              status: 'PROCESSING',
              lockedBy: leaseToken
            };
          }
        }
      }, function() {
        try {
          ProactiveMessageService.prepareDispatch(
            claimedPayload,
            '2026-07-14T20:01:00+09:00',
            {
              eventId: eventId,
              leaseToken: leaseToken
            }
          );
        } catch (error) {
          caught = error;
        }
      });
      assert(
        caught &&
          caught.code === 'STORAGE_DATA_CORRUPTED',
        'Policy-binding-only mutation must invalidate the queue claim.'
      );
    }
  );

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
      PropertiesService: buildProperties('prod'),
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
      PropertiesService: buildProperties('prod'),
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
        '2026-07-14T20:00:00+09:00'
      );
      var second = ProactiveMessageService.evaluateLocalConditions(
        '2026-07-14T20:00:00+09:00'
      );

      assert(first.eligible === true, 'Ceiling must enqueue at unit daytime weight.');
      assert(first.probability === 1, 'Ceiling probability must be one.');
      assert(first.sample === second.sample, 'Same slot must not reroll the sample.');
      assert(
        first.payload &&
          first.payload.requestedAt === '2026-07-14T20:00:00+09:00',
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
      PropertiesService: buildProperties('prod'),
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
        reason: 'deterministic_probability_hit',
        policyBinding: buildPolicyBinding(),
        characterRuntimeMode: 'legacy'
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
        timeWeight: 1,
        policyBinding: buildPolicyBinding(),
        characterRuntimeMode: 'legacy'
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
      PropertiesService: buildProperties('prod'),
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
        timeWeight: 1,
        policyBinding: buildPolicyBinding(),
        characterRuntimeMode: 'legacy'
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
    var live = buildLiveDeliveryFixture();
    var marker = {
      messageId: '00000000-0000-4000-8000-000000000001',
      requestId: live.payload.messageDedupeKey,
      createdAt: live.nowIso,
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
      ConfigRepository: buildConfig(buildBaseConfig({
        QUIET_START: live.quietStart,
        QUIET_END: live.quietEnd
      })),
      PropertiesService: {
        getScriptProperties: function() {
          return {
            getProperty: function(key) {
              return key === 'APP_ENV'
                ? 'prod'
                : 'owner@example.invalid';
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
            last_user_message_at:
              live.lastUserAt,
            last_proactive_at: null,
            proactive_count_date: live.targetDate,
            proactive_count: 0,
            next_proactive_check_at: null,
            quiet_until: null
          };
        },
        getUserState: function() {
          return this.ensureDefaultUserState();
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
        getRemainingQuota: function() {
          return 10;
        },
        send: function(ownerEmail, subject, body) {
          sentBodies.push(body);
        }
      }
    }, function() {
      var prepared = ProactiveMessageService.prepareDispatch(
        live.payload,
        live.now
      );
      var result = ProactiveMessageService.send(
        prepared.message
      );

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
      PropertiesService: buildProperties('prod'),
      SheetRepository: {
        getMessageByRequestIdAndRole: function() {
          return marker;
        },
        ensureDefaultUserState: function() {
          return {
            last_user_message_at:
              '2026-07-14T08:00:00+09:00',
            last_proactive_at: null,
            proactive_count_date: '2026-07-14',
            proactive_count: 0,
            next_proactive_check_at: null
          };
        },
        getUserState: function() {
          return this.ensureDefaultUserState();
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
      var result = ProactiveMessageService.prepareDispatch({
        targetDate: '2026-07-14',
        sequence: 1,
        requestedAt: '2026-07-14T12:00:00+09:00',
        decisionSlot: '1',
        messageDedupeKey:
          'PROACTIVE_MESSAGE:2026-07-14:1',
        probability: 1,
        sample: 0,
        elapsedMinutes: 300,
        timeWeight: 1,
        reason: 'deterministic_probability_hit',
        policyBinding: buildPolicyBinding(),
        characterRuntimeMode: 'legacy'
      }, '2026-07-14T12:00:00+09:00');

      assert(result.eligible === false, 'Completed marker must not send again.');
      assert(result.reason === 'ALREADY_DELIVERED', 'Completed marker must be authoritative.');
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
      PropertiesService: buildProperties('prod'),
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
        timeWeight: 1,
        policyBinding: buildPolicyBinding(),
        characterRuntimeMode: 'legacy'
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

  test('queue normalizer enforces proactive runtime mode and content-free payloads', function() {
    var base = {
      targetDate: '2026-07-14',
      sequence: 1,
      requestedAt: '2026-07-14T12:00:00+09:00',
      decisionSlot: '495744',
      messageDedupeKey: 'PROACTIVE_MESSAGE:2026-07-14:1',
      probability: 0.5,
      sample: 0.2,
      elapsedMinutes: 300,
      timeWeight: 1,
      reason: 'deterministic_probability_hit',
      policyBinding: {
        environment: 'prod',
        frequency: 'normal',
        mode: 'probability'
      },
      characterRuntimeMode: 'legacy'
    };
    var normalized = QueueService.__test.normalizePayload(
      'PROACTIVE_SEND',
      base
    );
    assert(
      normalized.characterRuntimeMode === 'legacy' &&
        normalized.characterBinding == null,
      'Legacy proactive mode was not preserved.'
    );

    [
      { patch: { characterRuntimeMode: null } },
      { patch: { policyBinding: null } },
      {
        patch: {
          policyBinding: {
            environment: 'staging',
            frequency: 'normal',
            mode: 'probability'
          }
        }
      },
      { patch: { reason: 'free_form_reason' } },
      { patch: { subject: 'queued content' } },
      { patch: { body: 'queued content' } },
      {
        patch: {
          characterRuntimeMode: 'enforced'
        }
      }
    ].forEach(function(fixture) {
      var candidate = {};
      Object.keys(base).forEach(function(key) {
        candidate[key] = base[key];
      });
      Object.keys(fixture.patch).forEach(function(key) {
        if (fixture.patch[key] == null) {
          delete candidate[key];
        } else {
          candidate[key] = fixture.patch[key];
        }
      });
      var thrown = null;
      try {
        QueueService.__test.normalizePayload(
          'PROACTIVE_SEND',
          candidate
        );
      } catch (error) {
        thrown = error;
      }
      assert(
        thrown && thrown.code === 'VALIDATION_REQUEST_INVALID',
        'Invalid proactive queue payload was accepted.'
      );
    });
  });

  return results;
}

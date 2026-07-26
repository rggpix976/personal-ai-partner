function runA12CharacterProactiveIntegrationTests() {
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

  function expectCode(callback, code) {
    var thrown = null;
    try {
      callback();
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown && thrown.code === code,
      'Expected error code ' + code + '.'
    );
    return thrown;
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

  function copy(value) {
    return value == null
      ? value
      : JSON.parse(JSON.stringify(value));
  }

  function merge(left, right) {
    var result = {};
    Object.keys(left || {}).forEach(function(key) {
      result[key] = left[key];
    });
    Object.keys(right || {}).forEach(function(key) {
      result[key] = right[key];
    });
    return result;
  }

  function makeBinding(revision) {
    var pack = CharacterPackService.getActive();
    return {
      profileSchemaVersion:
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: revision == null ? 4 : revision,
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: pack.packId,
      characterPackVersion: pack.packVersion
    };
  }

  function makePayload(overrides) {
    var payload = {
      targetDate: '2099-07-24',
      sequence: 1,
      requestedAt: '2026-07-24T09:00:00+09:00',
      decisionSlot: '12345',
      messageDedupeKey:
        'PROACTIVE_MESSAGE:2099-07-24:1',
      probability: 0.75,
      sample: 0.25,
      elapsedMinutes: 300,
      timeWeight: 1,
      reason: 'deterministic_probability_hit',
      policyBinding: {
        environment: 'prod',
        frequency: 'normal',
        mode: 'probability'
      },
      characterRuntimeMode: 'enforced',
      characterBinding: makeBinding(4)
    };
    return merge(payload, overrides);
  }

  function makeApproval(surface, source, binding) {
    binding = binding || makeBinding(4);
    return {
      surface: surface,
      source: source,
      policyVersion: binding.policyVersion,
      profileSchemaVersion: binding.profileSchemaVersion,
      profileRevision: binding.profileRevision,
      catalogVersion: binding.catalogVersion,
      characterPackId: binding.characterPackId,
      characterPackVersion: binding.characterPackVersion
    };
  }

  function makeArtifact(surface, source, payload, binding) {
    binding = binding || makeBinding(4);
    return {
      artifactId:
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      surface: surface,
      source: source,
      claimType: 'GENERAL_IMMERSION',
      category: null,
      policyVersion: binding.policyVersion,
      profileSchemaVersion: binding.profileSchemaVersion,
      profileRevision: binding.profileRevision,
      catalogVersion: binding.catalogVersion,
      characterPackId: binding.characterPackId,
      characterPackVersion: binding.characterPackVersion,
      issuedAt: '2026-07-24T12:00:00+09:00',
      expiresAt: '2026-07-24T12:05:00+09:00',
      payload: {
        subject: payload.subject,
        body: payload.body
      },
      approvalToken: 'test-only-approval-token'
    };
  }

  function makeFailedMarker(overrides) {
    var binding = makeBinding(4);
    return merge({
      messageId:
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      requestId: 'PROACTIVE_MESSAGE:2099-07-24:1',
      createdAt: '2026-07-24T11:50:00+09:00',
      role: 'system',
      messageType: 'proactive',
      text: 'Saved exact proactive body.',
      proactiveSubject: 'Saved exact proactive subject',
      status: 'failed',
      model: 'proactive-generation-model',
      inputTokens: 11,
      outputTokens: 7,
      error: {
        code: 'MAIL_SEND_FAILED'
      },
      characterApproval: makeApproval(
        'PROACTIVE_AI',
        'generated',
        binding
      )
    }, overrides);
  }

  function makeHarness(options) {
    options = options || {};
    var expectedLease =
      'queue-lease:v1:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    var otherLease =
      'queue-lease:v1:dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    var eventId =
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    var queuePayload = copy(
      options.queuePayload || makePayload()
    );
    var currentBinding =
      options.currentBinding || makeBinding(4);
    var state = merge({
      last_user_message_at:
        '2026-07-24T08:00:00+09:00',
      last_proactive_at: null,
      proactive_count_date: '2026-07-24',
      proactive_count: 0,
      next_proactive_check_at: null,
      quiet_until: null
    }, options.state);
    var marker = options.marker == null
      ? null
      : copy(options.marker);
    var values = merge({
      QUIET_START: '00:00',
      QUIET_END: '00:01',
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
      PROACTIVE_SUBJECT_TEMPLATE: 'Legacy subject',
      PROACTIVE_BODY_TEMPLATE: 'Legacy body'
    }, options.config);
    var trace = {
      approvalSurfaces: [],
      bindingChecks: 0,
      columnChecks: 0,
      configReads: [],
      contextBuilds: 0,
      eventReads: 0,
      generateCalls: 0,
      gmail: [],
      markerAppends: [],
      markerReads: 0,
      markerUpdates: [],
      rewriteCalls: 0,
      runtimeInspections: 0,
      semanticCalls: 0,
      semanticContexts: [],
      sinkCalls: 0,
      statePatches: [],
      templateCalls: 0,
      usagePatches: []
    };

    function visibleMarker(originEventId) {
      if (
        marker &&
        marker.error &&
        marker.error.code ===
          'PROACTIVE_RETRY_QUARANTINED'
      ) {
        return (
          originEventId &&
          marker.proactiveOriginEventId === originEventId
        )
          ? marker
          : null;
      }
      return marker;
    }

    function defaultApprove(coordinatorOptions) {
      trace.approvalSurfaces.push(
        coordinatorOptions.surface
      );
      var candidate;
      var source;
      if (
        coordinatorOptions.surface ===
          'PROACTIVE_RETRY'
      ) {
        assert(
          !Object.prototype.hasOwnProperty.call(
            coordinatorOptions,
            'generate'
          ),
          'Retry unexpectedly received a generate callback.'
        );
        assert(
          !Object.prototype.hasOwnProperty.call(
            coordinatorOptions,
            'rewrite'
          ),
          'Retry unexpectedly received a rewrite callback.'
        );
        candidate = copy(
          coordinatorOptions.savedPayload
        );
        source = 'legacy_revalidated';
      } else {
        candidate = coordinatorOptions.generate({
          context: coordinatorOptions.context,
          surface: coordinatorOptions.surface,
          mode: 'CHARACTER'
        });
        source = 'generated';
        if (options.forceRewrite === true) {
          var primaryDecision =
            coordinatorOptions.verifierFn({
              surface: coordinatorOptions.surface,
              claimType: 'GENERAL_IMMERSION',
              category: null,
              requiresEvidence: false,
              knownEvidenceKeys: [],
              evidenceView: [],
              textFields: [{
                path: 'subject',
                value: candidate.subject
              }, {
                path: 'body',
                value: candidate.body
              }],
              payload: candidate,
              context: coordinatorOptions.context
            });
          assert(
            primaryDecision.allowed === false,
            'Rewrite fixture did not deny the primary candidate.'
          );
          candidate = coordinatorOptions.rewrite({
            candidate: candidate,
            decision: primaryDecision,
            context: coordinatorOptions.context,
            surface: coordinatorOptions.surface
          });
          source = 'rewrite';
        }
      }
      coordinatorOptions.verifierFn({
        surface: coordinatorOptions.surface,
        claimType: 'GENERAL_IMMERSION',
        category: null,
        requiresEvidence: false,
        knownEvidenceKeys: [],
        evidenceView: [],
        textFields: [{
          path: 'subject',
          value: candidate.subject
        }, {
          path: 'body',
          value: candidate.body
        }],
        payload: candidate,
        context: coordinatorOptions.context
      });
      return {
        artifact: makeArtifact(
          coordinatorOptions.surface,
          source,
          candidate,
          coordinatorOptions.context.binding
        ),
        classifiedContext:
          coordinatorOptions.context
      };
    }

    var repository = {
      assertProactiveDeliveryColumns: function() {
        trace.columnChecks += 1;
        return true;
      },
      ensureDefaultUserState: function() {
        return state;
      },
      getUserState: function() {
        return state;
      },
      getProactiveMarkerByDedupeKey: function(
        dedupeKey,
        originEventId
      ) {
        trace.markerReads += 1;
        assert(
          dedupeKey ===
            'PROACTIVE_MESSAGE:2099-07-24:1',
          'Unexpected proactive marker dedupe key.'
        );
        return visibleMarker(originEventId);
      },
      getMessageByRequestIdAndRole: function() {
        return visibleMarker();
      },
      getEventById: function(requestedEventId) {
        trace.eventReads += 1;
        assert(
          requestedEventId === eventId,
          'Unexpected proactive event ID.'
        );
        return {
          eventId: eventId,
          eventType: 'PROACTIVE_SEND',
          status: 'PROCESSING',
          lockedBy: options.leaseValid === false
            ? otherLease
            : expectedLease,
          payload: copy(queuePayload)
        };
      },
      appendConversation: function(message) {
        trace.markerAppends.push(copy(message));
        marker = merge(copy(message), {
          error: null
        });
        return marker;
      },
      updateConversationMessage: function(
        messageId,
        patch
      ) {
        assert(
          marker && marker.messageId === messageId,
          'Unexpected proactive marker update.'
        );
        trace.markerUpdates.push(copy(patch));
        Object.keys(patch).forEach(function(key) {
          marker[key] = copy(patch[key]);
        });
        return marker;
      },
      quarantineProactiveMarker: function(
        messageId,
        originEventId
      ) {
        assert(
          marker && marker.messageId === messageId,
          'Unexpected proactive marker quarantine.'
        );
        marker.status = 'failed';
        marker.error = {
          code: 'PROACTIVE_RETRY_QUARANTINED'
        };
        marker.proactiveOriginEventId =
          originEventId || null;
        trace.markerUpdates.push({
          status: 'failed',
          error: copy(marker.error),
          proactiveOriginEventId:
            marker.proactiveOriginEventId
        });
        return marker;
      },
      updateUserState: function(patch) {
        trace.statePatches.push(copy(patch));
        Object.keys(patch).forEach(function(key) {
          state[key] = patch[key];
        });
        return state;
      },
      incrementUsageDaily: function(date, patch) {
        trace.usagePatches.push({
          date: date,
          patch: copy(patch)
        });
      }
    };

    var contextService = {
      bindingFromInspection: function(inspection) {
        return {
          profileSchemaVersion:
            inspection.profileSchemaVersion,
          profileRevision: inspection.profileRevision,
          policyVersion:
            APP_CONSTANTS.CHARACTER.POLICY_VERSION,
          catalogVersion:
            APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
          characterPackId: inspection.characterPackId,
          characterPackVersion:
            inspection.characterPackVersion
        };
      },
      build: function() {
        trace.contextBuilds += 1;
        return {
          scope: 'proactive',
          binding: copy(currentBinding)
        };
      },
      assertBindingMatchesContext: function(
        actualBinding,
        context
      ) {
        trace.bindingChecks += 1;
        if (
          JSON.stringify(actualBinding) !==
            JSON.stringify(context.binding)
        ) {
          throw createAppError(
            'CHARACTER_CONFIG_CONFLICT',
            'Proactive binding changed before dispatch.'
          );
        }
        return true;
      },
      classificationSignals: function(context) {
        assert(
          context.scope === 'proactive',
          'Unexpected proactive context scope.'
        );
        return {
          safetyRequired: false,
          adminRequest: false,
          capabilityUnavailable: false
        };
      }
    };

    var sessionFactory = {
      createSession: function() {
        return {
          generate: function() {
            trace.generateCalls += 1;
            return {
              subject: 'Generated exact subject',
              body: 'Generated exact proactive body.'
            };
          },
          rewrite: function() {
            trace.rewriteCalls += 1;
            return {
              subject: 'Rewritten subject',
              body: 'Rewritten proactive body.'
            };
          },
          verify: function(request) {
            trace.semanticCalls += 1;
            trace.semanticContexts.push(
              copy(request.context)
            );
            return {
              allowed: !(
                options.forceRewrite === true &&
                trace.semanticCalls === 1
              ),
              category:
                options.forceRewrite === true &&
                  trace.semanticCalls === 1
                  ? 'STYLE_DRIFT'
                  : null,
              reason:
                options.forceRewrite === true &&
                  trace.semanticCalls === 1
                  ? 'rewrite_required'
                  : 'approved'
            };
          },
          emitMetric: function() {
            return true;
          },
          getUsage: function() {
            return {
              apiCalls: 0,
              imageCalls: 0,
              inputTokens: 0,
              outputTokens: 0
            };
          },
          getGenerationMetadata: function(source) {
            return {
              model: source === 'rewrite'
                ? 'proactive-rewrite-model'
                : 'proactive-generation-model',
              inputTokens: 11,
              outputTokens: 7
            };
          }
        };
      }
    };

    var overrides = {
      ConfigRepository: {
        getByKey: function(key) {
          trace.configReads.push(key);
          if (
            key === 'PROACTIVE_SUBJECT_TEMPLATE' ||
            key === 'PROACTIVE_BODY_TEMPLATE'
          ) {
            trace.templateCalls += 1;
            if (options.blockTemplates !== false) {
              throw new Error(
                'An enforced route read a legacy template.'
              );
            }
          }
          return Object.prototype.hasOwnProperty.call(
            values,
            key
          )
            ? { value: values[key] }
            : null;
        }
      },
      SheetRepository: repository,
      GmailNotifier: {
        getRemainingQuota: function() {
          return 10;
        },
        send: function(
          ownerEmail,
          subject,
          body,
          mailOptions
        ) {
          trace.gmail.push({
            ownerEmail: ownerEmail,
            subject: subject,
            body: body,
            options: copy(mailOptions)
          });
          if (
            options.failGmailOnce === true &&
            trace.gmail.length === 1
          ) {
            throw createAppError(
              'MAIL_SEND_FAILED',
              'Mail delivery failed.'
            );
          }
        }
      },
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
      LockManager: {
        withScriptLock: function(
          lockName,
          callback
        ) {
          assert(
            typeof lockName === 'string' &&
              lockName !== '',
            'Proactive lock name is missing.'
          );
          return callback();
        }
      },
      CharacterProactiveContextService:
        contextService,
      CharacterProfileService: {
        inspectRuntime: function() {
          trace.runtimeInspections += 1;
          return copy(
            options.runtimeInspection || {
              state: 'legacy',
              runtimeMode: 'legacy',
              reason: 'CHARACTER_MODE_LEGACY'
            }
          );
        }
      },
      CharacterProactiveGeminiAdapter:
        sessionFactory,
      CharacterOutputCoordinator: {
        approve: defaultApprove
      },
      CharacterSinkAdapter: {
        deliver: function(delivery) {
          trace.sinkCalls += 1;
          assert(
            delivery.expectedSurface ===
              delivery.artifact.surface,
            'Sink surface changed before delivery.'
          );
          return delivery.write(
            delivery.artifact.payload,
            delivery.artifact
          );
        }
      }
    };

    return {
      eventId: eventId,
      leaseToken: expectedLease,
      overrides: overrides,
      trace: trace,
      defaultApprove: defaultApprove,
      getEventId: function() {
        return eventId;
      },
      getMarker: function() {
        return marker;
      },
      getState: function() {
        return state;
      },
      getVisibleMarker: function() {
        return visibleMarker(eventId);
      },
      setQueueEvent: function(nextEventId, nextPayload) {
        eventId = nextEventId;
        queuePayload = copy(nextPayload);
      },
      setCurrentBinding: function(nextBinding) {
        currentBinding = copy(nextBinding);
      }
    };
  }

  function queueOptions(harness) {
    return {
      eventId: harness.getEventId(),
      leaseToken: harness.leaseToken
    };
  }

  test(
    'eligibility snapshots legacy enforced and blocked runtime modes at enqueue',
    function() {
      var readyBinding = makeBinding(4);
      var readyInspection = {
        state: 'ready',
        runtimeMode: 'enforced',
        profileSchemaVersion:
          readyBinding.profileSchemaVersion,
        profileRevision: readyBinding.profileRevision,
        characterPackId: readyBinding.characterPackId,
        characterPackVersion:
          readyBinding.characterPackVersion
      };

      var disabled = makeHarness({
        config: {
          PROACTIVE_AI_GENERATION_ENABLED: false
        },
        runtimeInspection: readyInspection
      });
      var disabledResult;
      withGlobals(disabled.overrides, function() {
        disabledResult =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-24T20:00:00+09:00'
          );
      });
      assert(
        disabledResult.eligible === true &&
          disabledResult.payload.characterRuntimeMode ===
            'legacy' &&
          !Object.prototype.hasOwnProperty.call(
            disabledResult.payload,
            'characterBinding'
          ) &&
          disabled.trace.runtimeInspections === 0,
        'Disabled AI generation did not snapshot legacy mode.'
      );

      var legacy = makeHarness({
        config: {
          PROACTIVE_AI_GENERATION_ENABLED: true
        },
        runtimeInspection: {
          state: 'legacy',
          runtimeMode: 'legacy',
          reason: 'CHARACTER_MODE_LEGACY'
        }
      });
      var legacyResult;
      withGlobals(legacy.overrides, function() {
        legacyResult =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-24T20:00:00+09:00'
          );
      });
      assert(
        legacyResult.eligible === true &&
          legacyResult.payload.characterRuntimeMode ===
            'legacy' &&
          legacy.trace.runtimeInspections === 1,
        'Legacy character runtime did not snapshot legacy mode.'
      );

      var enforced = makeHarness({
        config: {
          PROACTIVE_AI_GENERATION_ENABLED: true
        },
        runtimeInspection: readyInspection
      });
      var enforcedResult;
      withGlobals(enforced.overrides, function() {
        enforcedResult =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-24T20:00:00+09:00'
          );
      });
      assert(
        enforcedResult.eligible === true &&
          enforcedResult.payload.characterRuntimeMode ===
            'enforced' &&
          JSON.stringify(
            enforcedResult.payload.characterBinding
          ) === JSON.stringify(readyBinding),
        'Ready character runtime did not snapshot its exact binding.'
      );

      var blocked = makeHarness({
        config: {
          PROACTIVE_AI_GENERATION_ENABLED: true
        },
        runtimeInspection: {
          state: 'blocked',
          runtimeMode: 'enforced',
          reason: 'PROFILE_INVALID'
        }
      });
      var blockedResult;
      withGlobals(blocked.overrides, function() {
        blockedResult =
          ProactiveMessageService.evaluateLocalConditions(
            '2026-07-24T20:00:00+09:00'
          );
      });
      assert(
        blockedResult.eligible === false &&
          blockedResult.payload === null &&
          blockedResult.reason === 'CONFIG_MISSING' &&
          blockedResult.warnings.indexOf(
            'CHARACTER_CONFIG_INVALID'
          ) !== -1,
        'Blocked character runtime still produced an enqueue payload.'
      );
    }
  );

  test(
    'send rejects a structurally valid but unissued legacy message',
    function() {
      expectCode(function() {
        ProactiveMessageService.send({
          targetDate: '2026-07-24',
          sequence: 1,
          dedupeKey:
            'PROACTIVE_MESSAGE:2026-07-24:1',
          subject: 'Unissued subject',
          body: 'Unissued body',
          sentAt: '2026-07-24T12:00:00+09:00',
          options: {}
        });
      }, 'CHARACTER_ARTIFACT_INVALID');
    }
  );

  test(
    'cloned enforced dispatch is rejected while the issued message remains one-shot',
    function() {
      var harness = makeHarness({
        currentBinding: makeBinding(4),
        blockTemplates: true
      });

      withGlobals(harness.overrides, function() {
        var prepared =
          ProactiveMessageService.prepareDispatch(
            makePayload(),
            '2026-07-24T12:00:00+09:00',
            queueOptions(harness)
          );
        var clonedMessage = copy(prepared.message);

        expectCode(function() {
          ProactiveMessageService.send(clonedMessage);
        }, 'CHARACTER_ARTIFACT_INVALID');
        assert(
          harness.trace.sinkCalls === 0 &&
            harness.trace.markerAppends.length === 0 &&
            harness.trace.gmail.length === 0,
          'Cloned dispatch reached the protected sink or delivery effects.'
        );

        var sent = ProactiveMessageService.send(
          prepared.message
        );
        assert(
          sent.sent === true &&
            sent.duplicate === false,
          'Original issued dispatch was not usable after clone rejection.'
        );
        expectCode(function() {
          ProactiveMessageService.send(prepared.message);
        }, 'CHARACTER_ARTIFACT_INVALID');
      });

      assert(
        harness.trace.sinkCalls === 1 &&
          harness.trace.markerAppends.length === 1 &&
          harness.trace.gmail.length === 1,
        'Issued enforced dispatch was not consumed exactly once.'
      );
    }
  );

  test(
    'safe enforced output delivers the exact approved pair through marker and mail',
    function() {
      var harness = makeHarness({
        currentBinding: makeBinding(4),
        blockTemplates: true
      });

      withGlobals(harness.overrides, function() {
        var prepared =
          ProactiveMessageService.prepareDispatch(
            makePayload(),
            '2026-07-24T12:00:00+09:00',
            queueOptions(harness)
          );
        assert(
          prepared.eligible === true &&
            prepared.reason === 'READY',
          'Safe enforced proactive output was not ready.'
        );
        assert(
          prepared.message.subject ===
            'Generated exact subject' &&
            prepared.message.body ===
              'Generated exact proactive body.',
          'Approved proactive pair changed during preparation.'
        );

        prepared.message.subject = 'tampered subject';
        prepared.message.body = 'tampered body';
        prepared.message.characterDelivery = null;
        var sent = ProactiveMessageService.send(
          prepared.message
        );
        assert(
          sent.sent === true &&
          sent.duplicate === false,
          'Approved proactive output was not sent once.'
        );
        expectCode(function() {
          ProactiveMessageService.send(prepared.message);
        }, 'CHARACTER_ARTIFACT_INVALID');
      });

      var marker = harness.getMarker();
      assert(
        harness.trace.markerAppends.length === 1,
        'Approved output did not create exactly one marker.'
      );
      assert(
        marker.status === 'completed' &&
          marker.proactiveSubject ===
            'Generated exact subject' &&
          marker.text ===
            'Generated exact proactive body.',
        'Marker did not retain the exact approved pair.'
      );
      assert(
        marker.characterApproval.surface ===
          'PROACTIVE_AI' &&
          marker.characterApproval.source ===
            'generated',
        'Marker approval metadata is invalid.'
      );
      assert(
        harness.trace.gmail.length === 1 &&
          harness.trace.gmail[0].subject ===
            'Generated exact subject' &&
          harness.trace.gmail[0].body ===
            'Generated exact proactive body.',
        'Mail did not receive the exact approved pair.'
      );
      assert(
        harness.trace.generateCalls === 1 &&
          harness.trace.rewriteCalls === 0 &&
          harness.trace.semanticCalls === 1 &&
          harness.trace.sinkCalls === 1,
        'Safe enforced orchestration call counts drifted.'
      );
      assert(
        harness.trace.templateCalls === 0,
        'Enforced delivery read a legacy template.'
      );
    }
  );

  test(
    'one approved rewrite delivers its exact pair and rewrite metadata',
    function() {
      var harness = makeHarness({
        currentBinding: makeBinding(4),
        blockTemplates: true,
        forceRewrite: true
      });
      withGlobals(harness.overrides, function() {
        var prepared =
          ProactiveMessageService.prepareDispatch(
            makePayload(),
            '2026-07-24T12:00:00+09:00',
            queueOptions(harness)
          );
        assert(
          prepared.message.subject ===
              'Rewritten subject' &&
            prepared.message.body ===
              'Rewritten proactive body.',
          'Approved rewrite pair changed during preparation.'
        );
        ProactiveMessageService.send(prepared.message);
      });

      var marker = harness.getMarker();
      assert(
        harness.trace.generateCalls === 1 &&
          harness.trace.rewriteCalls === 1 &&
          harness.trace.semanticCalls === 2 &&
          harness.trace.sinkCalls === 1,
        'Rewrite orchestration exceeded or skipped its bounded calls.'
      );
      assert(
        marker.status === 'completed' &&
          marker.proactiveSubject ===
            'Rewritten subject' &&
          marker.text ===
            'Rewritten proactive body.' &&
          marker.model === 'proactive-rewrite-model' &&
          marker.characterApproval.source === 'rewrite',
        'Rewrite marker lost its exact pair or metadata.'
      );
      assert(
        harness.trace.gmail.length === 1 &&
          harness.trace.gmail[0].subject ===
            'Rewritten subject' &&
          harness.trace.gmail[0].body ===
            'Rewritten proactive body.',
        'Rewrite delivery changed the approved pair.'
      );
    }
  );

  test(
    'legacy ProcessQueue dispatch fences a lease lost after preparation before delivery',
    function() {
      var legacyPayload = makePayload({
        characterRuntimeMode: 'legacy'
      });
      delete legacyPayload.characterBinding;
      var harnessOptions = {
        blockTemplates: false,
        leaseValid: true,
        queuePayload: legacyPayload,
        config: {
          PROACTIVE_AI_GENERATION_ENABLED: false,
          PROACTIVE_SUBJECT_TEMPLATE:
            'Legacy exact subject',
          PROACTIVE_BODY_TEMPLATE:
            'Legacy exact body'
        }
      };
      var harness = makeHarness(harnessOptions);
      var issuedService = ProactiveMessageService;
      var overrides = merge(harness.overrides, {
        ProactiveMessageService: {
          prepareDispatch: issuedService.prepareDispatch,
          send: function(message) {
            harnessOptions.leaseValid = false;
            return issuedService.send(message);
          }
        }
      });
      var event = {
        eventId: harness.getEventId(),
        eventType: 'PROACTIVE_SEND',
        lockedBy: harness.leaseToken,
        payload: legacyPayload
      };

      withGlobals(overrides, function() {
        var thrown = expectCode(function() {
          dispatchProactiveSend_(
            event,
            '2026-07-24T12:00:00+09:00'
          );
        }, 'QUEUE_LOCK_BUSY');
        assert(
          thrown.details &&
            thrown.details.reason ===
              'QUEUE_LEASE_MISMATCH',
          'Legacy pre-delivery fence lost its managed lease reason.'
        );
      });

      assert(
        harness.trace.eventReads === 2 &&
          harness.trace.markerAppends.length === 0 &&
          harness.getMarker() === null &&
          harness.trace.gmail.length === 0 &&
          harness.trace.sinkCalls === 0,
        'Lease-lost legacy ProcessQueue dispatch reached marker or mail.'
      );
    }
  );

  test(
    'lease lost after approval is fenced again before marker and mail',
    function() {
      var harnessOptions = {
        currentBinding: makeBinding(4),
        blockTemplates: true,
        leaseValid: true
      };
      var harness = makeHarness(harnessOptions);

      withGlobals(harness.overrides, function() {
        var prepared =
          ProactiveMessageService.prepareDispatch(
            makePayload(),
            '2026-07-24T12:00:00+09:00',
            queueOptions(harness)
          );
        harnessOptions.leaseValid = false;
        var thrown = expectCode(function() {
          ProactiveMessageService.send(prepared.message);
        }, 'QUEUE_LOCK_BUSY');
        assert(
          thrown.details &&
            thrown.details.reason === 'QUEUE_LEASE_MISMATCH',
          'Pre-sink lease fence lost its managed reason.'
        );
      });

      assert(
        harness.trace.sinkCalls === 1 &&
          harness.trace.markerAppends.length === 0 &&
          harness.getMarker() === null &&
          harness.trace.gmail.length === 0,
        'Lease-lost approved output reached marker or mail.'
      );
    }
  );

  test(
    'no approved enforced output advances only next check and performs no delivery effects',
    function() {
      var harness = makeHarness({
        currentBinding: makeBinding(4),
        blockTemplates: true
      });
      harness.overrides.CharacterOutputCoordinator = {
        approve: function(options) {
          harness.trace.approvalSurfaces.push(
            options.surface
          );
          var candidate = options.generate({
            context: options.context,
            surface: options.surface,
            mode: 'CHARACTER'
          });
          options.verifierFn({
            surface: options.surface,
            payload: candidate,
            context: options.context
          });
          throw createAppError(
            'CHARACTER_OUTPUT_BLOCKED',
            'The generated proactive output was denied.'
          );
        }
      };

      var result;
      withGlobals(harness.overrides, function() {
        result = ProactiveMessageService.prepareDispatch(
          makePayload(),
          '2026-07-24T12:00:00+09:00',
          queueOptions(harness)
        );
      });

      var state = harness.getState();
      assert(
        result.eligible === false &&
          result.reason ===
            'NO_APPROVED_PROACTIVE_OUTPUT' &&
          result.message === null,
        'Denied proactive output was not converted to managed no-send.'
      );
      assert(
        harness.trace.markerAppends.length === 0 &&
          harness.getMarker() === null &&
          harness.trace.gmail.length === 0 &&
          harness.trace.sinkCalls === 0,
        'Managed no-send produced a marker, mail, or sink effect.'
      );
      assert(
        state.proactive_count === 0 &&
          state.last_proactive_at === null,
        'Managed no-send changed sent proactive state.'
      );
      assert(
        harness.trace.statePatches.length === 1 &&
          Object.keys(
            harness.trace.statePatches[0]
          ).length === 1 &&
          Object.prototype.hasOwnProperty.call(
            harness.trace.statePatches[0],
            'next_proactive_check_at'
          ),
        'Managed no-send changed more than next eligibility.'
      );
      assert(
        harness.trace.templateCalls === 0,
        'Managed no-send used a legacy template fallback.'
      );
    }
  );

  test(
    'failed marker retry revalidates the exact pair against the current binding without generation',
    function() {
      var currentBinding = makeBinding(5);
      var harness = makeHarness({
        marker: makeFailedMarker(),
        currentBinding: currentBinding,
        blockTemplates: true
      });

      withGlobals(harness.overrides, function() {
        var prepared =
          ProactiveMessageService.prepareDispatch(
            makePayload({
              characterBinding: makeBinding(4)
            }),
            '2026-07-24T12:00:00+09:00',
            queueOptions(harness)
          );
        assert(
          prepared.eligible === true &&
            prepared.message.subject ===
              'Saved exact proactive subject' &&
            prepared.message.body ===
              'Saved exact proactive body.',
          'Retry did not prepare the exact saved pair.'
        );
        ProactiveMessageService.send(prepared.message);
      });

      var marker = harness.getMarker();
      assert(
        harness.trace.approvalSurfaces.length === 1 &&
          harness.trace.approvalSurfaces[0] ===
            'PROACTIVE_RETRY',
        'Failed marker did not use the retry surface.'
      );
      assert(
        harness.trace.generateCalls === 0 &&
          harness.trace.rewriteCalls === 0,
        'Exact retry regenerated or rewrote saved content.'
      );
      assert(
        harness.trace.semanticCalls === 1 &&
          harness.trace.semanticContexts[0]
            .binding.profileRevision === 5,
        'Retry did not semantically revalidate against the current binding.'
      );
      assert(
        harness.trace.bindingChecks === 0,
        'Retry incorrectly required the queued generation binding.'
      );
      assert(
        harness.trace.gmail.length === 1 &&
          harness.trace.gmail[0].subject ===
            'Saved exact proactive subject' &&
          harness.trace.gmail[0].body ===
            'Saved exact proactive body.',
        'Retry mail changed the saved pair.'
      );
      assert(
        marker.status === 'completed' &&
          marker.proactiveSubject ===
            'Saved exact proactive subject' &&
          marker.text ===
            'Saved exact proactive body.' &&
          marker.characterApproval.surface ===
            'PROACTIVE_RETRY' &&
          marker.characterApproval.source ===
            'legacy_revalidated' &&
          marker.characterApproval.profileRevision === 5,
        'Retry marker did not retain content and current approval metadata.'
      );
      assert(
        harness.trace.templateCalls === 0,
        'Retry read a legacy template.'
      );
    }
  );

  test(
    'mail failure preserves the approved pair for same-event current-binding retry',
    function() {
      var harness = makeHarness({
        currentBinding: makeBinding(4),
        blockTemplates: true,
        failGmailOnce: true
      });
      withGlobals(harness.overrides, function() {
        var first = ProactiveMessageService.prepareDispatch(
          makePayload(),
          '2026-07-24T12:00:00+09:00',
          queueOptions(harness)
        );
        expectCode(function() {
          ProactiveMessageService.send(first.message);
        }, 'MAIL_SEND_FAILED');
        assert(
          harness.getMarker().status === 'failed' &&
            harness.getMarker().proactiveSubject ===
              'Generated exact subject' &&
            harness.getMarker().text ===
              'Generated exact proactive body.' &&
            harness.getMarker().characterApproval.surface ===
              'PROACTIVE_AI',
          'Initial mail failure did not retain the approved pair.'
        );

        harness.setCurrentBinding(makeBinding(5));
        var retry = ProactiveMessageService.prepareDispatch(
          makePayload(),
          '2026-07-24T12:05:00+09:00',
          queueOptions(harness)
        );
        ProactiveMessageService.send(retry.message);
      });

      assert(
        harness.trace.generateCalls === 1 &&
          harness.trace.rewriteCalls === 0 &&
          harness.trace.approvalSurfaces.join(',') ===
            'PROACTIVE_AI,PROACTIVE_RETRY',
        'Transport retry regenerated or rewrote the saved pair.'
      );
      assert(
        harness.trace.gmail.length === 2 &&
          harness.trace.gmail[0].subject ===
            harness.trace.gmail[1].subject &&
          harness.trace.gmail[0].body ===
            harness.trace.gmail[1].body,
        'Transport retry changed the attempted mail pair.'
      );
      assert(
        harness.getMarker().status === 'completed' &&
          harness.getMarker().characterApproval.surface ===
            'PROACTIVE_RETRY' &&
          harness.getMarker().characterApproval.profileRevision === 5,
        'Transport retry did not complete under the current binding.'
      );
    }
  );

  test(
    'a different queue event cannot take over an active failed marker',
    function() {
      var originalEventId =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      var harness = makeHarness({
        marker: makeFailedMarker({
          proactiveOriginEventId: originalEventId
        }),
        currentBinding: makeBinding(4),
        blockTemplates: true
      });
      var result;
      withGlobals(harness.overrides, function() {
        result = ProactiveMessageService.prepareDispatch(
          makePayload(),
          '2026-07-24T12:00:00+09:00',
          queueOptions(harness)
        );
      });
      assert(
        result.eligible === false &&
          result.reason === 'DELIVERY_IN_PROGRESS' &&
          result.message === null,
        'A different event took over a failed proactive marker.'
      );
      assert(
        harness.getMarker().proactiveOriginEventId ===
            originalEventId &&
          harness.trace.contextBuilds === 0 &&
          harness.trace.generateCalls === 0 &&
          harness.trace.markerUpdates.length === 0 &&
          harness.trace.gmail.length === 0,
        'Origin-mismatched marker was mutated or delivered.'
      );
    }
  );

  test(
    'retry approval cannot normalize or rewrite the saved exact pair',
    function() {
      var binding = makeBinding(4);
      var harness = makeHarness({
        marker: makeFailedMarker(),
        currentBinding: binding,
        blockTemplates: true
      });
      harness.overrides.CharacterOutputCoordinator = {
        approve: function(options) {
          harness.trace.approvalSurfaces.push(
            options.surface
          );
          return {
            artifact: makeArtifact(
              'PROACTIVE_RETRY',
              'legacy_revalidated',
              {
                subject:
                  'Saved exact proactive subject ',
                body: 'Saved exact proactive body.'
              },
              binding
            ),
            classifiedContext: options.context
          };
        }
      };
      var result;
      withGlobals(harness.overrides, function() {
        result = ProactiveMessageService.prepareDispatch(
          makePayload(),
          '2026-07-24T12:00:00+09:00',
          queueOptions(harness)
        );
      });
      assert(
        result.eligible === false &&
          result.reason ===
            'PROACTIVE_RETRY_QUARANTINED' &&
          result.message === null,
        'A normalized retry pair remained deliverable.'
      );
      assert(
        harness.getMarker().error &&
          harness.getMarker().error.code ===
            'PROACTIVE_RETRY_QUARANTINED' &&
          harness.trace.generateCalls === 0 &&
          harness.trace.rewriteCalls === 0 &&
          harness.trace.sinkCalls === 0 &&
          harness.trace.gmail.length === 0,
        'Changed retry pair reached generation or delivery.'
      );
    }
  );

  [
    {
      name: 'denied retry',
      marker: makeFailedMarker(),
      denyRetry: true,
      expectedReason: 'NO_APPROVED_PROACTIVE_OUTPUT'
    },
    {
      name: 'retry with missing subject',
      marker: makeFailedMarker({
        proactiveSubject: null
      }),
      denyRetry: false,
      expectedReason: 'PROACTIVE_RETRY_QUARANTINED'
    },
    {
      name: 'retry with missing approval',
      marker: makeFailedMarker({
        characterApproval: null
      }),
      denyRetry: false,
      expectedReason: 'PROACTIVE_RETRY_QUARANTINED'
    }
  ].forEach(function(scenario) {
    test(
      scenario.name +
        ' is quarantined until a later eligibility event',
      function() {
        var harness = makeHarness({
          marker: scenario.marker,
          currentBinding: makeBinding(4),
          blockTemplates: true
        });
        if (scenario.denyRetry) {
          harness.overrides.CharacterOutputCoordinator = {
            approve: function(options) {
              if (
                options.surface ===
                  'PROACTIVE_RETRY'
              ) {
                harness.trace.approvalSurfaces.push(
                  options.surface
                );
                options.verifierFn({
                  surface: options.surface,
                  payload: options.savedPayload,
                  context: options.context
                });
                throw createAppError(
                  'CHARACTER_OUTPUT_BLOCKED',
                  'Saved proactive output is no longer approved.'
                );
              }
              return harness.defaultApprove(options);
            }
          };
        }

        var first;
        var sameEvent;
        var nextEvent;
        withGlobals(harness.overrides, function() {
          first =
            ProactiveMessageService.prepareDispatch(
              makePayload(),
              '2026-07-24T12:00:00+09:00',
              queueOptions(harness)
            );
          assert(
            harness.getVisibleMarker() !== null,
            'The originating event lost its quarantined marker fence.'
          );
          sameEvent =
            ProactiveMessageService.prepareDispatch(
              makePayload(),
              '2026-07-24T12:01:00+09:00',
              queueOptions(harness)
            );
          var laterPayload = makePayload({
            requestedAt:
              '2026-07-24T12:02:00+09:00',
            decisionSlot: '2'
          });
          harness.setQueueEvent(
            'ffffffff-ffff-4fff-8fff-ffffffffffff',
            laterPayload
          );
          nextEvent =
            ProactiveMessageService.prepareDispatch(
              laterPayload,
              '2026-07-24T12:02:00+09:00',
              queueOptions(harness)
            );
        });

        var marker = harness.getMarker();
        assert(
          first.eligible === false &&
            first.reason === scenario.expectedReason &&
            first.message === null,
          'Invalid retry did not complete as managed no-send.'
        );
        assert(
          marker.error &&
            marker.error.code ===
              'PROACTIVE_RETRY_QUARANTINED',
          'Invalid retry marker was not quarantined.'
        );
        assert(
          sameEvent.eligible === false &&
            sameEvent.reason ===
              'PROACTIVE_RETRY_QUARANTINED' &&
            sameEvent.message === null,
          'The originating event regenerated after quarantine.'
        );
        assert(
          nextEvent.eligible === true &&
            nextEvent.reason === 'READY' &&
            harness.trace.approvalSurfaces[
              harness.trace.approvalSurfaces.length - 1
            ] === 'PROACTIVE_AI',
          'A later eligibility event did not start fresh generation.'
        );
        assert(
          harness.trace.markerAppends.length === 0 &&
            harness.trace.gmail.length === 0 &&
            harness.trace.sinkCalls === 0,
          'Quarantine or fresh preparation performed a delivery effect.'
        );
        assert(
          harness.trace.templateCalls === 0,
          'Quarantine path used a legacy template.'
        );
      }
    );
  });

  test(
    'lease mismatch fails before marker lookup generation or mail',
    function() {
      var harness = makeHarness({
        leaseValid: false,
        currentBinding: makeBinding(4),
        blockTemplates: true
      });

      var thrown;
      withGlobals(harness.overrides, function() {
        thrown = expectCode(function() {
          ProactiveMessageService.prepareDispatch(
            makePayload(),
            '2026-07-24T12:00:00+09:00',
            queueOptions(harness)
          );
        }, 'QUEUE_LOCK_BUSY');
      });

      assert(
        thrown.details &&
          thrown.details.reason ===
            'QUEUE_LEASE_MISMATCH',
        'Lease mismatch reason was not preserved.'
      );
      assert(
        harness.trace.markerReads === 0 &&
          harness.trace.markerAppends.length === 0 &&
          harness.trace.generateCalls === 0 &&
          harness.trace.sinkCalls === 0 &&
          harness.trace.gmail.length === 0,
        'Stale worker reached a proactive side effect.'
      );
    }
  );

  test(
    'enforced preparation rejects a missing queue claim before generation',
    function() {
      var harness = makeHarness({
        currentBinding: makeBinding(4),
        blockTemplates: true
      });
      withGlobals(harness.overrides, function() {
        expectCode(function() {
          ProactiveMessageService.prepareDispatch(
            makePayload(),
            '2026-07-24T12:00:00+09:00'
          );
        }, 'CHARACTER_ARTIFACT_INVALID');
      });
      assert(
        harness.trace.eventReads === 0 &&
          harness.trace.markerReads === 0 &&
          harness.trace.generateCalls === 0 &&
          harness.trace.gmail.length === 0,
        'Missing enforced lease reached runtime or delivery work.'
      );
    }
  );

  test(
    'claimed event payload cannot be downgraded from enforced to legacy',
    function() {
      var storedLegacy = makePayload({
        characterRuntimeMode: 'legacy'
      });
      delete storedLegacy.characterBinding;
      var harness = makeHarness({
        currentBinding: makeBinding(4),
        blockTemplates: true,
        queuePayload: storedLegacy
      });
      withGlobals(harness.overrides, function() {
        expectCode(function() {
          ProactiveMessageService.prepareDispatch(
            makePayload(),
            '2026-07-24T12:00:00+09:00',
            queueOptions(harness)
          );
        }, 'STORAGE_DATA_CORRUPTED');
      });
      assert(
        harness.trace.markerReads === 0 &&
          harness.trace.generateCalls === 0 &&
          harness.trace.templateCalls === 0 &&
          harness.trace.gmail.length === 0,
        'Queue payload downgrade reached a generation or delivery path.'
      );
    }
  );

  test(
    'legacy and mode-less historical events retain template delivery behavior',
    function() {
      var harness = makeHarness({
        blockTemplates: false,
        config: {
          PROACTIVE_AI_GENERATION_ENABLED: false,
          PROACTIVE_SUBJECT_TEMPLATE:
            'Legacy exact subject',
          PROACTIVE_BODY_TEMPLATE:
            'Legacy exact body'
        }
      });
      var explicitLegacy = makePayload({
        characterRuntimeMode: 'legacy'
      });
      delete explicitLegacy.characterBinding;
      var historical = makePayload();
      delete historical.characterRuntimeMode;
      delete historical.characterBinding;

      withGlobals(harness.overrides, function() {
        var explicitPrepared =
          ProactiveMessageService.prepareDispatch(
            explicitLegacy,
            '2026-07-24T12:00:00+09:00'
          );
        var historicalPrepared =
          ProactiveMessageService.prepareDispatch(
            historical,
            '2026-07-24T12:00:00+09:00'
          );
        assert(
          explicitPrepared.eligible === true &&
            historicalPrepared.eligible === true,
          'Legacy proactive preparation was not preserved.'
        );
        assert(
          explicitPrepared.message.subject ===
            'Legacy exact subject' &&
            explicitPrepared.message.body ===
              'Legacy exact body' &&
            historicalPrepared.message.subject ===
              'Legacy exact subject' &&
            historicalPrepared.message.body ===
              'Legacy exact body',
          'Legacy or historical event stopped using configured templates.'
        );
        explicitPrepared.message.subject =
          'tampered legacy subject';
        explicitPrepared.message.body =
          'tampered legacy body';
        ProactiveMessageService.send(
          explicitPrepared.message
        );
      });

      assert(
        harness.trace.gmail.length === 1 &&
          harness.trace.gmail[0].subject ===
            'Legacy exact subject' &&
          harness.trace.gmail[0].body ===
            'Legacy exact body',
        'Legacy proactive mail behavior changed.'
      );
      assert(
        harness.trace.contextBuilds === 0 &&
          harness.trace.generateCalls === 0 &&
          harness.trace.rewriteCalls === 0 &&
          harness.trace.semanticCalls === 0 &&
          harness.trace.sinkCalls === 0,
        'Legacy event entered the enforced character path.'
      );
      assert(
        harness.getMarker().characterApproval === null &&
          harness.getMarker().proactiveSubject === null,
        'Legacy marker was incorrectly upgraded to enforced approval.'
      );
      assert(
        harness.trace.templateCalls === 4,
        'Legacy and historical events did not read both templates.'
      );
    }
  );

  test(
    'changed queued binding becomes managed no-send before the proactive sink',
    function() {
      var harness = makeHarness({
        currentBinding: makeBinding(5),
        blockTemplates: true
      });

      var result;
      withGlobals(harness.overrides, function() {
        result = ProactiveMessageService.prepareDispatch(
          makePayload({
            characterBinding: makeBinding(4)
          }),
          '2026-07-24T12:00:00+09:00',
          queueOptions(harness)
        );
      });

      assert(
        result.eligible === false &&
          result.reason === 'PROACTIVE_RUNTIME_CHANGED' &&
          result.message === null,
        'Changed binding was not converted to managed no-send.'
      );
      assert(
        harness.trace.bindingChecks === 1 &&
          harness.trace.generateCalls === 0 &&
          harness.trace.rewriteCalls === 0 &&
          harness.trace.markerAppends.length === 0 &&
          harness.trace.sinkCalls === 0 &&
          harness.trace.gmail.length === 0,
        'Changed binding reached generation or a delivery sink.'
      );
      assert(
        harness.trace.statePatches.length === 1 &&
          Object.keys(
            harness.trace.statePatches[0]
          ).length === 1 &&
          Object.prototype.hasOwnProperty.call(
            harness.trace.statePatches[0],
            'next_proactive_check_at'
          ) &&
          harness.getState().proactive_count === 0 &&
          harness.getState().last_proactive_at === null,
        'Runtime change modified state beyond next eligibility.'
      );
      assert(
        harness.trace.templateCalls === 0,
        'Binding conflict fell back to a legacy template.'
      );
    }
  );

  return results;
}

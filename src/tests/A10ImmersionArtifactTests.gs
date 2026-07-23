function runA10ImmersionArtifactTests() {
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

  function makeContext(scope, revision) {
    var pack = CharacterPackService.getActive();
    return {
      surface: scope,
      runtime: {
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: pack.packId,
        characterPackVersion: pack.packVersion,
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        profileRevision: revision
      }
    };
  }

  function makeContextBoundary(activeRevision) {
    var state = { activeRevision: activeRevision };
    state.service = {
      assertClassifiedActive: function(context, expectedScope) {
        if (
          !context ||
          context.surface !== expectedScope ||
          !context.runtime ||
          context.runtime.profileRevision !== state.activeRevision
        ) {
          throw createAppError(
            'VALIDATION_REQUEST_INVALID',
            'Character context is stale.',
            { reason: 'CHARACTER_CONTEXT_STALE' }
          );
        }
        return true;
      }
    };
    return state;
  }

  function makeAuthenticatedGuard() {
    var authentic = new WeakSet();
    var approvedPayloads = new WeakMap();
    var approvedContexts = new WeakMap();
    var guard = {
      isApprovedDecision: function(decision, context) {
        return Boolean(
          decision &&
          authentic.has(decision) &&
          decision.status === 'ALLOW' &&
          approvedContexts.get(decision) === context
        );
      },
      getApprovedPayload: function(decision, context) {
        if (!guard.isApprovedDecision(decision, context)) {
          throw createAppError(
            'CHARACTER_ARTIFACT_INVALID',
            'An approved decision is required.'
          );
        }
        return approvedPayloads.get(decision);
      }
    };
    return {
      service: guard,
      allow: function(surface, payload, source, context) {
        var decision = {
          status: 'ALLOW',
          category: null,
          action: 'ALLOW',
          surface: surface,
          source: source || 'generated',
          policyVersion: context.runtime.policyVersion,
          characterPackId: context.runtime.characterPackId,
          characterPackVersion: context.runtime.characterPackVersion,
          profileSchemaVersion: context.runtime.profileSchemaVersion,
          profileRevision: context.runtime.profileRevision,
          catalogVersion: context.runtime.catalogVersion,
          claimType: null,
          requiresEvidence: false,
          evidenceKeys: []
        };
        authentic.add(decision);
        approvedPayloads.set(
          decision,
          CharacterPayloadService.normalize(surface, payload)
        );
        approvedContexts.set(decision, context);
        return decision;
      }
    };
  }

  test('surface payloads use exact bounded immutable top-level contracts', function() {
    var chat = CharacterPayloadService.normalize('CHAT_TEXT_SYNC', { text: '  hello  ' });
    assert(chat.text === 'hello', 'Chat text was not normalized.');
    assert(Object.isFrozen(chat), 'Chat payload is mutable.');

    var diary = CharacterPayloadService.normalize('DIARY', {
      title: 'Title',
      narrative: 'Narrative',
      groundedSummary: '',
      partnerWorldEvents: [{ content: 'A reviewed fictional event' }],
      thingsToRemember: [],
      unresolvedFollowUps: []
    });
    assert(Object.isFrozen(diary.partnerWorldEvents), 'Diary collection is mutable.');
    assert(Object.isFrozen(diary.partnerWorldEvents[0]), 'Nested diary data is mutable.');

    var memory = CharacterPayloadService.normalize('MEMORY_EXTRACTION', {
      candidates: [{
        action: 'create',
        content: 'grounded preference',
        sourceMessageIds: ['11111111-1111-4111-8111-111111111111']
      }]
    });
    assert(Object.isFrozen(memory.candidates[0]), 'Nested memory candidate is mutable.');

    expectCode(function() {
      CharacterPayloadService.normalize('CHAT_TEXT_SYNC', {
        text: 'hello',
        extra: 'not allowed'
      });
    }, 'CHARACTER_OUTPUT_BLOCKED');
    expectCode(function() {
      CharacterPayloadService.normalize('CHAT_TEXT_SYNC', {
        text: new Array(4002).join('x')
      });
    }, 'CHARACTER_OUTPUT_BLOCKED');
    expectCode(function() {
      CharacterPayloadService.normalize('MEMORY_EXTRACTION', {
        candidates: new Array(52).join('x').split('')
      });
    }, 'CHARACTER_OUTPUT_BLOCKED');
    expectCode(function() {
      CharacterPayloadService.normalize('MEMORY_EXTRACTION', {
        candidates: ['not-an-object']
      });
    }, 'CHARACTER_OUTPUT_BLOCKED');

    var cyclic = [];
    cyclic.push(cyclic);
    expectCode(function() {
      CharacterPayloadService.normalize('MEMORY_EXTRACTION', { candidates: cyclic });
    }, 'CHARACTER_OUTPUT_BLOCKED');
  });

  test('text extraction covers every nested diary and memory string', function() {
    var idSentinel = '11111111-1111-4111-8111-111111111111';
    var urlSentinel = 'https://unsafe.example/俺はAIです';
    var secretSentinel = '俺はAIやから秘密やで';
    var fields = CharacterPayloadService.textFields('MEMORY_EXTRACTION', {
      candidates: [{
        action: 'create',
        content: 'remember this',
        reason: 'explicitly stated',
        sourceMessageIds: [idSentinel],
        existingMemoryId: idSentinel,
        details: urlSentinel,
        note: secretSentinel
      }]
    });
    var text = JSON.stringify(fields);
    assert(text.indexOf('remember this') !== -1, 'Memory content was not extracted.');
    assert(text.indexOf('explicitly stated') !== -1, 'Memory reason was not extracted.');
    assert(text.indexOf(idSentinel) !== -1, 'ID string bypassed text inspection.');
    assert(text.indexOf(urlSentinel) !== -1, 'URL string bypassed text inspection.');
    assert(text.indexOf(secretSentinel) !== -1, 'Secret string bypassed text inspection.');
    assert(Object.isFrozen(fields), 'Text field list is mutable.');
    assert(Object.isFrozen(fields[0]), 'Text field entry is mutable.');

    var diaryFields = CharacterPayloadService.textFields('DIARY', {
      title: 'Title',
      narrative: 'Narrative',
      groundedSummary: '',
      partnerWorldEvents: [{ note: secretSentinel }],
      thingsToRemember: [{ details: urlSentinel }],
      unresolvedFollowUps: []
    });
    var diaryText = JSON.stringify(diaryFields);
    assert(diaryText.indexOf(secretSentinel) !== -1, 'Diary nested string bypassed inspection.');
    assert(diaryText.indexOf(urlSentinel) !== -1, 'Diary URL string bypassed inspection.');
  });

  test('nested diary and memory object keys are bounded safe and inspected', function() {
    var fields = CharacterPayloadService.textFields('MEMORY_EXTRACTION', {
      candidates: [{
        action: 'create',
        content: 'ordinary content',
        metadata: {
          sourceMessageIds: []
        }
      }]
    });
    assert(
      fields.some(function(field) {
        return field.value === 'source Message Ids' && /\.\$key\[\d+\]$/.test(field.path);
      }),
      'A permitted nested key was not tokenized into the inspection stream.'
    );

    function expectInvalidMemoryKey(key) {
      var candidate = Object.create(null);
      candidate.content = 'ordinary content';
      candidate.metadata = Object.create(null);
      candidate.metadata[key] = 'ordinary value';
      expectCode(function() {
        CharacterPayloadService.normalize('MEMORY_EXTRACTION', {
          candidates: [candidate]
        });
      }, 'CHARACTER_OUTPUT_BLOCKED');
    }

    [
      '__proto__',
      'prototype',
      'constructor',
      'callbackUrl',
      'clientSecret',
      'internalId',
      'sourceUrl'
    ].forEach(expectInvalidMemoryKey);
    [
      'content.value',
      'content\u0000hidden',
      'content\u202ehidden',
      'IAmAnAI',
      'IAMANAI',
      'iAmAIClaim',
      'iamanai',
      'thisreplyisgenerated',
      'ihavearealhumanbody',
      'myproviderisgpt',
      'metadataIamanai',
      'metadata_iamanai',
      new Array(66).join('a')
    ].forEach(expectInvalidMemoryKey);

    var diaryEvent = Object.create(null);
    diaryEvent.content = 'ordinary event';
    diaryEvent['俺はAIです'] = 'ordinary value';
    expectCode(function() {
      CharacterPayloadService.normalize('DIARY', {
        title: 'Title',
        narrative: 'Narrative',
        groundedSummary: '',
        partnerWorldEvents: [diaryEvent],
        thingsToRemember: [],
        unresolvedFollowUps: []
      });
    }, 'CHARACTER_OUTPUT_BLOCKED');

    var tooManyKeys = {};
    for (var index = 0; index < 101; index += 1) {
      tooManyKeys['keyValue' + index] = index;
    }
    expectCode(function() {
      CharacterPayloadService.normalize('MEMORY_EXTRACTION', {
        candidates: [tooManyKeys]
      });
    }, 'CHARACTER_OUTPUT_BLOCKED');
  });

  test('memory provenance keys accept only unique UUID v4 values', function() {
    var validId = 'a1111111-b111-4111-8111-111111111111';
    var valid = CharacterPayloadService.normalize('MEMORY_EXTRACTION', {
      candidates: [{
        content: 'ordinary content',
        existingMemoryId: validId,
        sourceMessageIds: [validId],
        metadata: { source_message_ids: [validId] }
      }]
    });
    assert(valid.candidates[0].existingMemoryId === validId, 'Valid provenance ID changed.');

    [
      { existingMemoryId: 'not-a-uuid' },
      { existingMemoryId: validId.toUpperCase() },
      { sourceMessageIds: ['not-a-uuid'] },
      { sourceMessageIds: [validId, validId] },
      { source_message_ids: validId },
      { content: validId },
      { metadata: { value: validId } }
    ].forEach(function(extra) {
      var candidate = { content: 'ordinary content' };
      Object.keys(extra).forEach(function(key) {
        candidate[key] = extra[key];
      });
      expectCode(function() {
        CharacterPayloadService.normalize('MEMORY_EXTRACTION', {
          candidates: [candidate]
        });
      }, 'CHARACTER_OUTPUT_BLOCKED');
    });

    expectCode(function() {
      CharacterPayloadService.normalize('DIARY', {
        title: 'Title',
        narrative: 'Narrative',
        groundedSummary: '',
        partnerWorldEvents: [{ sourceMessageIds: [validId] }],
        thingsToRemember: [],
        unresolvedFollowUps: []
      });
    }, 'CHARACTER_OUTPUT_BLOCKED');

    expectCode(function() {
      CharacterPayloadService.normalize('CHAT_TEXT_SYNC', { text: validId });
    }, 'CHARACTER_OUTPUT_BLOCKED');
  });

  test('UUID-like text cannot be hidden with compatibility or default-ignorable characters', function() {
    var validId = 'a1111111-b111-4111-8111-111111111111';
    [
      validId.slice(0, 8) + '\u200b' + validId.slice(8),
      validId.slice(0, 8) + '\u200d' + validId.slice(8),
      validId.slice(0, 8) + '\ufe0f' + validId.slice(8),
      '\uff41' + validId.slice(1),
      validId.slice(0, 8) + '\uff0d' + validId.slice(9)
    ].forEach(function(disguisedId) {
      expectCode(function() {
        CharacterPayloadService.normalize('MEMORY_EXTRACTION', {
          candidates: [{ content: disguisedId }]
        });
      }, 'CHARACTER_OUTPUT_BLOCKED');
    });

    var emojiText = '一緒にいよう❤\ufe0f 👩\u200d💻';
    var preserved = CharacterPayloadService.normalize('CHAT_TEXT_SYNC', {
      text: emojiText
    });
    assert(preserved.text === emojiText, 'Inspection-only normalization changed display text.');
  });

  test('surface scope and evidence keys are deterministic and immutable', function() {
    assert(
      CharacterPayloadService.contextScopeForSurface('CHAT_IMAGE') === 'chat',
      'Image surface scope drifted.'
    );
    assert(
      CharacterPayloadService.contextScopeForSurface('PROACTIVE_RETRY') === 'proactive',
      'Proactive surface scope drifted.'
    );
    expectCode(function() {
      CharacterPayloadService.contextScopeForSurface('PROACTIVE_TEMPLATE');
    }, 'CHARACTER_OUTPUT_BLOCKED');
    assert(
      CharacterPayloadService.contextScopeForSurface('DIARY') === 'diary',
      'Diary surface scope drifted.'
    );
    assert(
      CharacterPayloadService.contextScopeForSurface('MEMORY_EXTRACTION') === 'memory',
      'Memory surface scope drifted.'
    );

    var promptView = CharacterPackService.getPromptView('chat');
    var context = {
      surface: 'chat',
      persona: {
        pack: promptView
      },
      data: {
        authority: 'untrusted',
        currentRequest: { text: 'request', evidenceKey: 'attacker:current' },
        recentMessages: [{ text: 'recent', evidenceKeys: ['attacker:recent'] }],
        memories: [{ content: 'memory' }],
        userFacts: [{ fact: 'user fact', evidenceKey: 'attacker:user' }],
        sharedFacts: [{ fact: 'shared fact' }],
        realWorldObservations: [{ observation: 'observed' }],
        relationshipState: { phase: 'trusted' },
        partnerWorld: {
          mayCreate: false,
          approvedFacts: [{ event: 'approved fiction' }],
          scope: 'chat'
        },
        evidenceKeys: ['attacker:root']
      }
    };
    var view = CharacterPayloadService.collectEvidenceView(context);
    var keys = CharacterPayloadService.collectEvidenceKeys(context);
    var canonKeys = promptView.canon.map(function(entry) {
      return 'characterCanon:' + entry.id;
    });
    assert(
      JSON.stringify(keys) === JSON.stringify(canonKeys.concat([
        'currentRequest',
        'recentMessages:0',
        'memories:0',
        'userFacts:0',
        'sharedFacts:0',
        'realWorldObservations:0',
        'relationshipState',
        'partnerWorld.approvedFacts:0'
      ])),
      'Evidence keys were not minted from the fixed typed paths.'
    );
    var canonDomains = promptView.canon.map(function() {
      return 'CHARACTER_CANON';
    });
    assert(
      JSON.stringify(view.map(function(entry) { return entry.domain; })) === JSON.stringify(
        canonDomains.concat([
        'CURRENT_REQUEST',
        'RECENT_MESSAGE',
        'MEMORY',
        'USER_FACT',
        'SHARED_FACT',
        'REAL_WORLD_OBSERVATION',
        'RELATIONSHIP_STATE',
        'PARTNER_WORLD'
        ])
      ),
      'Evidence domains or fixed ordering drifted.'
    );
    assert(
      JSON.stringify(Object.keys(view[0])) === '["key","domain","value"]',
      'Evidence entry shape drifted.'
    );
    assert(keys.indexOf('attacker:current') === -1, 'Injected evidenceKey was adopted.');
    assert(keys.indexOf('attacker:recent') === -1, 'Injected evidenceKeys were adopted.');
    assert(keys.indexOf('attacker:root') === -1, 'Root evidenceKeys were adopted.');
    assert(Object.isFrozen(view), 'Evidence view is mutable.');
    assert(Object.isFrozen(view[0]), 'Evidence view entry is mutable.');
    assert(Object.isFrozen(view[0].value), 'Evidence value is mutable.');
    assert(Object.isFrozen(keys), 'Evidence keys are mutable.');

    var memoryPromptView = CharacterPackService.getPromptView('memory');
    assert(
      memoryPromptView.canon.length === 0,
      'Character canon leaked into the memory prompt view.'
    );
    var memoryView = CharacterPayloadService.collectEvidenceView({
      surface: 'memory',
      persona: {
        pack: memoryPromptView
      },
      data: {
        currentRequest: { text: 'remember this' },
        recentMessages: [],
        memories: [],
        userFacts: [],
        sharedFacts: [],
        realWorldObservations: [],
        relationshipState: null,
        partnerWorld: null
      }
    });
    assert(
      memoryView.every(function(entry) {
        return entry.domain !== 'CHARACTER_CANON';
      }),
      'Character canon leaked into memory evidence.'
    );

    var overLimitFacts = [];
    for (var index = 0; index < 51; index += 1) {
      overLimitFacts.push({ fact: 'fact ' + index });
    }
    expectCode(function() {
      CharacterPayloadService.collectEvidenceView({
        surface: 'chat',
        persona: {
          pack: promptView
        },
        data: {
          currentRequest: null,
          recentMessages: [],
          memories: [],
          userFacts: overLimitFacts,
          sharedFacts: [],
          realWorldObservations: [],
          relationshipState: null,
          partnerWorld: null
        }
      });
    }, 'CHARACTER_OUTPUT_BLOCKED');
  });

  test('metrics emit only controlled low-cardinality dimensions', function() {
    var emitted = [];
    CharacterMetricsService.record(
      'immersion_assessed_total',
      {
        dayBucket: '2026-07-23',
        timeBucket: '2026-07-23T07',
        surface: 'CHAT_TEXT_SYNC',
        category: null,
        action: 'ALLOW',
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: CharacterPackService.getActive().packId,
        characterPackVersion: CharacterPackService.getActive().packVersion,
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        source: 'generated'
      },
      function(name, dimensions) {
        emitted.push({ name: name, dimensions: dimensions });
      }
    );
    assert(emitted.length === 1, 'Valid metric was not emitted exactly once.');
    assert(Object.isFrozen(emitted[0].dimensions), 'Metric dimensions are mutable.');
    assert(
      !Object.prototype.hasOwnProperty.call(emitted[0].dimensions, 'category'),
      'Null category should not become a metric label.'
    );

    var sentinel = 'NEVER-EMIT-PRIVATE-CONTENT';
    ['text', 'profileRevision', 'requestId', 'hash', 'url', 'label'].forEach(function(key) {
      var dimensions = {};
      dimensions[key] = sentinel;
      var error = expectCode(function() {
        CharacterMetricsService.record(
          'immersion_blocked_total',
          dimensions,
          function() {
            throw new Error('Must not emit.');
          }
        );
      }, 'VALIDATION_REQUEST_INVALID');
      assert(JSON.stringify(error.toLogObject()).indexOf(sentinel) === -1, 'Metric error leaked data.');
    });
  });

  test('only authenticated decisions issue non-deserializable artifacts', function() {
    var context = makeContext('chat', 7);
    context.conversationMode = 'STANDARD';
    context.currentRequest = { text: 'original request' };
    var swappedContext = makeContext('chat', 7);
    swappedContext.conversationMode = 'IDENTITY_CHALLENGE';
    swappedContext.currentRequest = { text: 'swapped request' };
    var boundary = makeContextBoundary(7);
    var authenticated = makeAuthenticatedGuard();
    withGlobals({
      CharacterContextService: boundary.service,
      ImmersionGuard: authenticated.service
    }, function() {
      var decision = authenticated.allow(
        'CHAT_TEXT_SYNC',
        { text: 'approved reply' },
        'generated',
        context
      );
      expectCode(function() {
        ApprovedCharacterArtifactService.issue(decision, swappedContext);
      }, 'CHARACTER_ARTIFACT_INVALID');
      var artifact = ApprovedCharacterArtifactService.issue(decision, context);
      assert(Object.isFrozen(artifact), 'Artifact is mutable.');
      assert(Object.isFrozen(artifact.payload), 'Artifact payload is mutable.');
      assert(
        JSON.stringify(Object.keys(artifact)) === JSON.stringify([
          'payload',
          'surface',
          'source',
          'policyVersion',
          'characterPackId',
          'characterPackVersion',
          'profileSchemaVersion',
          'profileRevision',
          'catalogVersion'
        ]),
        'Artifact envelope keys drifted.'
      );
      assert(
        ApprovedCharacterArtifactService.assertUsable(
          artifact,
          'CHAT_TEXT_SYNC',
          context
        ) === true,
        'Authentic artifact was not usable.'
      );

      var lookalike = JSON.parse(JSON.stringify(artifact));
      expectCode(function() {
        ApprovedCharacterArtifactService.assertUsable(
          lookalike,
          'CHAT_TEXT_SYNC',
          context
        );
      }, 'CHARACTER_ARTIFACT_INVALID');

      expectCode(function() {
        ApprovedCharacterArtifactService.issue(
          JSON.parse(JSON.stringify(decision)),
          context
        );
      }, 'CHARACTER_ARTIFACT_INVALID');

      var wrongPackContext = makeContext('chat', 7);
      wrongPackContext.runtime.characterPackVersion = 'warm-kansai-caretaker.v999';
      var wrongPackDecision = authenticated.allow(
        'CHAT_TEXT_SYNC',
        { text: 'wrong pack reply' },
        'generated',
        wrongPackContext
      );
      expectCode(function() {
        ApprovedCharacterArtifactService.issue(
          wrongPackDecision,
          wrongPackContext
        );
      }, 'CHARACTER_ARTIFACT_INVALID');

      expectCode(function() {
        ApprovedCharacterArtifactService.assertUsable(
          artifact,
          'CHAT_TEXT_SYNC',
          swappedContext
        );
      }, 'CHARACTER_ARTIFACT_INVALID');
    });
  });

  test('sink rejects raw lookalike wrong-surface and stale artifacts with zero writes', function() {
    var privateSentinel = 'PRIVATE-CANDIDATE-MUST-NOT-LEAK';
    var context = makeContext('chat', 11);
    var boundary = makeContextBoundary(11);
    var authenticated = makeAuthenticatedGuard();
    var writes = 0;
    var metrics = [];
    function write() {
      writes += 1;
      return 'written';
    }
    function emit(name, dimensions) {
      metrics.push({ name: name, dimensions: dimensions });
    }

    withGlobals({
      CharacterContextService: boundary.service,
      ImmersionGuard: authenticated.service
    }, function() {
      var artifact = ApprovedCharacterArtifactService.issue(
        authenticated.allow(
          'CHAT_TEXT_SYNC',
          { text: privateSentinel },
          'generated',
          context
        ),
        context
      );
      var beforeMissingEmitter = writes;
      expectCode(function() {
        CharacterSinkAdapter.deliver({
          artifact: artifact,
          expectedSurface: 'CHAT_TEXT_SYNC',
          context: context,
          write: write
        });
      }, 'VALIDATION_REQUEST_INVALID');
      assert(
        writes === beforeMissingEmitter,
        'A sink call without the mandatory metric emitter reached the writer.'
      );

      var beforeMissingWriter = writes;
      expectCode(function() {
        CharacterSinkAdapter.deliver({
          artifact: artifact,
          expectedSurface: 'CHAT_TEXT_SYNC',
          context: context,
          write: null,
          metricEmitter: emit
        });
      }, 'VALIDATION_REQUEST_INVALID');
      assert(
        writes === beforeMissingWriter,
        'An invalid writer consumed or delivered an approved artifact.'
      );

      var swappedContext = makeContext('chat', 11);
      swappedContext.conversationMode = 'IDENTITY_CHALLENGE';
      swappedContext.currentRequest = { text: 'different request' };
      var beforeSwap = writes;
      expectCode(function() {
        CharacterSinkAdapter.deliver({
          artifact: artifact,
          expectedSurface: 'CHAT_TEXT_SYNC',
          context: swappedContext,
          write: write,
          metricEmitter: emit
        });
      }, 'CHARACTER_ARTIFACT_INVALID');
      assert(writes === beforeSwap, 'Context-swapped artifact reached the writer.');

      [
        { artifact: { text: privateSentinel }, surface: 'CHAT_TEXT_SYNC' },
        { artifact: JSON.parse(JSON.stringify(artifact)), surface: 'CHAT_TEXT_SYNC' },
        { artifact: artifact, surface: 'CHAT_TEXT_QUEUED' }
      ].forEach(function(entry) {
        var before = writes;
        var error = expectCode(function() {
          CharacterSinkAdapter.deliver({
            artifact: entry.artifact,
            expectedSurface: entry.surface,
            context: context,
            write: write,
            metricEmitter: emit
          });
        }, 'CHARACTER_ARTIFACT_INVALID');
        assert(writes === before, 'Rejected artifact reached the underlying writer.');
        assert(
          JSON.stringify(error.toLogObject()).indexOf(privateSentinel) === -1,
          'Rejected payload leaked through the sink error.'
        );
      });

      var staleArtifact = ApprovedCharacterArtifactService.issue(
        authenticated.allow(
          'CHAT_TEXT_SYNC',
          { text: privateSentinel },
          'generated',
          context
        ),
        context
      );
      var result = CharacterSinkAdapter.deliver({
        artifact: artifact,
        expectedSurface: 'CHAT_TEXT_SYNC',
        context: context,
        write: write,
        metricEmitter: emit
      });
      assert(result === 'written' && writes === 1, 'Approved artifact did not write once.');

      var beforeReuse = writes;
      expectCode(function() {
        CharacterSinkAdapter.deliver({
          artifact: artifact,
          expectedSurface: 'CHAT_TEXT_SYNC',
          context: context,
          write: write,
          metricEmitter: emit
        });
      }, 'CHARACTER_ARTIFACT_INVALID');
      assert(
        writes === beforeReuse,
        'A consumed approved artifact reached the writer more than once.'
      );

      boundary.activeRevision = 12;
      var beforeStale = writes;
      expectCode(function() {
        CharacterSinkAdapter.deliver({
          artifact: staleArtifact,
          expectedSurface: 'CHAT_TEXT_SYNC',
          context: context,
          write: write,
          metricEmitter: emit
        });
      }, 'CHARACTER_ARTIFACT_INVALID');
      assert(writes === beforeStale, 'Stale artifact reached the underlying writer.');
      assert(metrics.length === 6, 'Every rejected sink attempt must increment one metric.');
      metrics.forEach(function(metric) {
        assert(
          metric.name === 'immersion_unapproved_sink_attempt_total',
          'Rejected sink emitted the wrong metric.'
        );
        assert(
          JSON.stringify(metric).indexOf(privateSentinel) === -1,
          'Rejected content entered metric dimensions.'
        );
      });
    });
  });

  test('sink consumes before writer call while independent artifacts remain usable', function() {
    var context = makeContext('chat', 21);
    var boundary = makeContextBoundary(21);
    var authenticated = makeAuthenticatedGuard();
    var metrics = [];
    var writerAttempts = 0;
    function emit(name, dimensions) {
      metrics.push({ name: name, dimensions: dimensions });
    }
    function issue(text) {
      return ApprovedCharacterArtifactService.issue(
        authenticated.allow(
          'CHAT_TEXT_SYNC',
          { text: text },
          'generated',
          context
        ),
        context
      );
    }

    withGlobals({
      CharacterContextService: boundary.service,
      ImmersionGuard: authenticated.service
    }, function() {
      var ambiguous = issue('same safe payload');
      var writerError = null;
      try {
        CharacterSinkAdapter.deliver({
          artifact: ambiguous,
          expectedSurface: 'CHAT_TEXT_SYNC',
          context: context,
          metricEmitter: emit,
          write: function() {
            writerAttempts += 1;
            throw new Error('WRITER-FAILED-AFTER-POSSIBLE-SIDE-EFFECT');
          }
        });
      } catch (error) {
        writerError = error;
      }
      assert(
        writerError &&
          writerError.message === 'WRITER-FAILED-AFTER-POSSIBLE-SIDE-EFFECT' &&
          writerAttempts === 1,
        'Writer failure was not propagated after the one-shot consume point.'
      );

      expectCode(function() {
        CharacterSinkAdapter.deliver({
          artifact: ambiguous,
          expectedSurface: 'CHAT_TEXT_SYNC',
          context: context,
          metricEmitter: emit,
          write: function() {
            writerAttempts += 1;
          }
        });
      }, 'CHARACTER_ARTIFACT_INVALID');
      assert(
        writerAttempts === 1 && metrics.length === 1,
        'An artifact was reused after an ambiguous writer failure.'
      );

      var first = issue('same safe payload');
      var second = issue('same safe payload');
      var independentWrites = 0;
      [first, second].forEach(function(artifact) {
        CharacterSinkAdapter.deliver({
          artifact: artifact,
          expectedSurface: 'CHAT_TEXT_SYNC',
          context: context,
          metricEmitter: emit,
          write: function() {
            independentWrites += 1;
          }
        });
      });
      assert(
        independentWrites === 2,
        'Separate approved artifacts with the same payload were not independently usable.'
      );
    });
  });

  return results;
}

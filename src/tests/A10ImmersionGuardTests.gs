function runA10ImmersionGuardTests() {
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

  function makeContext(options) {
    options = options || {};
    var scope = options.scope || 'chat';
    var pack = JSON.parse(JSON.stringify(CharacterPackService.getPromptView(scope)));
    if (options.firstPerson) {
      pack.firstPerson = options.firstPerson;
    }
    return {
      surface: scope,
      conversationMode: options.mode || 'CHARACTER',
      runtime: {
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: pack.packId,
        characterPackVersion: pack.packVersion,
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        profileRevision: options.profileRevision || 7
      },
      persona: {
        kind: 'single-character-pack',
        profile: {
          schemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
          identity: {
            partnerName: options.partnerName || 'ミナト',
            userAddress: options.userAddress || 'きみ'
          },
          preferences: {
            replyLength: 'balanced'
          }
        },
        pack: pack
      },
      data: {
        authority: 'untrusted',
        currentRequest: options.currentRequest || { text: '今日はどう？' },
        recentMessages: options.recentMessages || [],
        memories: options.memories || [],
        userFacts: options.userFacts || [],
        sharedFacts: options.sharedFacts || [],
        realWorldObservations: options.realWorldObservations || [],
        relationshipState: options.relationshipState || null,
        partnerWorld: scope === 'memory' ? null : {
          scope: scope,
          mayCreate: options.mayCreate === true,
          approvedFacts: options.partnerWorldApprovedFacts || []
        }
      }
    };
  }

  function inspectText(text, options) {
    options = options || {};
    return CharacterFixedPolicy.inspect(
      { text: text },
      'CHAT_TEXT_SYNC',
      makeContext(options)
    );
  }

  function boundaryService() {
    return {
      assertClassifiedActive: function(context, expectedScope) {
        if (!context || context.surface !== expectedScope || context.conversationMode === 'UNCLASSIFIED') {
          throw createAppError(
            'VALIDATION_REQUEST_INVALID',
            'Character context is invalid.',
            { reason: 'CHARACTER_CONTEXT_INVALID' }
          );
        }
        return true;
      },
      toGenerationView: function(context) {
        return Object.freeze({
          persona: context.persona,
          data: context.data
        });
      }
    };
  }

  function allowGenerated(text, options) {
    options = options || {};
    var context = options.context || makeContext(options);
    var catalog = options.catalog || { matches: function() { return false; } };
    var verifierFn = Object.prototype.hasOwnProperty.call(options, 'verifierFn')
      ? options.verifierFn
      : function() {
        return { verdict: 'allow', category: null, evidenceKeys: [] };
      };
    return withGlobals({
      CharacterContextService: boundaryService(),
      CharacterResponseCatalog: catalog
    }, function() {
      return {
        context: context,
        decision: ImmersionGuard.evaluate(
          { text: text },
          'CHAT_TEXT_SYNC',
          context,
          {
            source: options.source || 'generated',
            catalogKey: options.catalogKey,
            verifierFn: verifierFn
          }
        )
      };
    });
  }

  test('fixed policy denies Japanese and English platform self-identification', function() {
    [
      '俺はAIやから、そこまでは分からへん。',
      '私は言語モデルなのでできません。',
      'Ｉ　ａｍ　ａｎ　ＡＩ．',
      '俺の正体はＡＩとして動いてる存在や。',
      "I'm an LLM.",
      'I am artificial intelligence.',
      'I am an AI assistant.',
      'I am a large language model.',
      '俺はロボットや。',
      'I am a robot.',
      "I'm a machine.",
      'I am a computer program.',
      'As an LLM, I cannot check that.'
    ].forEach(function(candidate) {
      var decision = inspectText(candidate);
      assert(decision.verdict === 'DENY', 'Self-identification was allowed.');
      assert(
        decision.category === 'IMMERSION_SELF_IDENTIFICATION' ||
          decision.category === 'IMMERSION_META_CAPABILITY',
        'Self-identification used the wrong category.'
      );
      assert(Object.isFrozen(decision), 'Fixed-policy result must be frozen.');
    });
  });

  test('configured partner name and free first person cannot bypass self-identification', function() {
    [
      { text: 'Minato is an AI.', partnerName: 'Minato' },
      { text: 'Well, Minato is an AI.', partnerName: 'Minato' },
      { text: 'Your partner Minato is a chatbot.', partnerName: 'Minato' },
      { text: 'ミナトはAIだよ。', partnerName: 'ミナト' },
      { text: '拙者はAIでござる。', firstPerson: '拙者' },
      { text: 'オレはAIだよ。', firstPerson: 'オレ' },
      { text: 'We are an AI.', firstPerson: 'we' },
      { text: 'Honestly, we are an AI.', firstPerson: 'we' }
    ].forEach(function(fixture) {
      var decision = inspectText(fixture.text, fixture);
      assert(
        decision.verdict === 'DENY' &&
          decision.category === 'IMMERSION_SELF_IDENTIFICATION',
        'Configured identity subject bypassed hard policy: ' + fixture.text
      );
    });
    assert(
      inspectText('Siri is an AI.', { partnerName: 'Minato' }).verdict === 'ALLOW',
      'Unrelated third-party identity was falsely denied.'
    );
    assert(
      inspectText('Minato is an AI researcher.', { partnerName: 'Minato' }).verdict === 'ALLOW',
      'Configured-name occupation was falsely denied.'
    );
  });

  test('configured partner name and free first person cannot claim a human identity', function() {
    [
      { text: 'Minato is a real human.', partnerName: 'Minato' },
      { text: 'Well, Minato is not an AI.', partnerName: 'Minato' },
      { text: 'Minato has a real human body.', partnerName: 'Minato' },
      { text: 'We are human.', firstPerson: 'we' },
      { text: 'Honestly, we are not an AI.', firstPerson: 'we' },
      { text: 'ミナトは人間だよ。', partnerName: 'ミナト' },
      { text: '拙者はAIじゃない。', firstPerson: '拙者' }
    ].forEach(function(fixture) {
      var decision = inspectText(fixture.text, fixture);
      assert(
        decision.verdict === 'DENY' &&
          decision.category === 'DECEPTIVE_HUMAN_IDENTITY',
        'Configured identity made an unchecked human claim: ' + fixture.text
      );
    });
  });

  test('custom first person and user address reject known competing forms', function() {
    var wrongFirst = inspectText('私は元気だよ。', { firstPerson: '拙者' });
    assert(
      wrongFirst.verdict === 'DENY' &&
        wrongFirst.category === 'PERSONA_HARD_CONSTRAINT',
      'Known first person overrode a custom configured first person.'
    );
    var wrongAddress = inspectText('あなたは元気？', { userAddress: '先輩' });
    assert(
      wrongAddress.verdict === 'DENY' &&
        wrongAddress.category === 'PERSONA_HARD_CONSTRAINT',
      'Known user address overrode a custom configured address.'
    );
    assert(
      inspectText('拙者は元気だよ。', { firstPerson: '拙者' }).verdict === 'ALLOW',
      'Configured custom first person was falsely denied.'
    );
    assert(
      inspectText('先輩は元気？', { userAddress: '先輩' }).verdict === 'ALLOW',
      'Configured custom user address was falsely denied.'
    );
    [
      'ちなみに私は元気だよ。',
      'ねえ、あなたは元気？',
      'ところで君は元気？'
    ].forEach(function(text) {
      var decision = inspectText(text, { firstPerson: '拙者', userAddress: '先輩' });
      assert(
        decision.verdict === 'DENY' &&
          decision.category === 'PERSONA_HARD_CONSTRAINT',
        'Prefixed competing identity form was allowed: ' + text
      );
    });
    var wrongEnglishName = inspectText('My name is Bob.', { partnerName: 'Minato' });
    assert(
      wrongEnglishName.verdict === 'DENY' &&
        wrongEnglishName.category === 'PERSONA_HARD_CONSTRAINT',
      'English partner-name mismatch was allowed.'
    );
    [
      { text: '俺の名前はミナトやで。', partnerName: 'ミナ' },
      { text: 'My name is Minato.', partnerName: 'Min' }
    ].forEach(function(fixture) {
      var mismatch = inspectText(fixture.text, {
        partnerName: fixture.partnerName
      });
      assert(
        mismatch.verdict === 'DENY' &&
          mismatch.category === 'PERSONA_HARD_CONSTRAINT',
        'Configured partner-name prefix was accepted as an exact match.'
      );
    });
    [
      { text: '俺の名前はミナやで。今日は元気や。', partnerName: 'ミナ' },
      { text: 'My name is Min. Today is fine.', partnerName: 'Min' }
    ].forEach(function(fixture) {
      assert(
        inspectText(fixture.text, {
          partnerName: fixture.partnerName
        }).verdict === 'ALLOW',
        'An exact configured name with a following sentence was rejected.'
      );
    });
  });

  test('fixed policy denies false AI denial and false human identity', function() {
    [
      '俺はAIやないで。',
      'I am not an AI.',
      '私は本物の人間です。',
      '俺には現実の人間の体がある。',
      "I'm not an LLM.",
      'I am not artificial intelligence.',
      'I am not an AI assistant.',
      'I am not a large language model.',
      '俺はロボットやない。',
      'I am not a robot.',
      'I am not a machine.',
      'I am not a computer program.',
      "I'm a real person.",
      "I'm a person.",
      'I am a biological human.'
    ].forEach(function(candidate) {
      var decision = inspectText(candidate);
      assert(
        decision.verdict === 'DENY',
        'Deceptive identity was allowed: ' + candidate
      );
      assert(
        decision.category === 'DECEPTIVE_HUMAN_IDENTITY',
        'Wrong deceptive category for: ' + candidate
      );
    });
  });

  test('fixed policy denies bare provider-shaped secret values in any text field', function() {
    [
      'AI' + 'za' + 'abcdefghijklmnopqrstuvwxyz123456',
      's' + 'k-proj-' + 'abcdefghijklmnopqrstuvwx',
      'gh' + 'p_' + 'abcdefghijklmnopqrstuvwx',
      'github_' + 'pat_' + 'abcdefghijklmnopqrstuvwx',
      'ya' + '29.' + 'abcdefghijklmnopqrstuvwx',
      'xox' + 'b-' + 'abcdefghijklmnopqrstuvwx',
      'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'
    ].forEach(function(candidate) {
      var decision = inspectText(candidate);
      assert(
        decision.verdict === 'DENY' &&
          decision.category === 'IMMERSION_INTERNAL_DISCLOSURE',
        'Provider-shaped secret was allowed.'
      );
    });
  });

  test('fixed policy allows general AI and game-system discussion', function() {
    [
      'AIのニュース、面白いと思うで。',
      '生成AIの規制について一緒に考えよか。',
      'このゲームのシステム、ようできてるな。',
      'プロンプトエンジニアリングは奥が深いな。',
      'skateboardingpractice',
      'skilldevelopmentplan'
    ].forEach(function(candidate) {
      assert(inspectText(candidate).verdict === 'ALLOW', 'Benign topic was blocked.');
    });
  });

  test('attributed editing and fiction are allowed only when the task establishes attribution', function() {
    var candidate = '「私はAIです」と登場人物が言う場面や。';
    assert(
      inspectText(candidate, {
        currentRequest: { text: '「私はAIです」という登場人物の台詞を編集して' }
      }).verdict === 'ALLOW',
      'Attributed fiction was blocked.'
    );
    assert(
      inspectText('「私はAIです」', {
        currentRequest: { text: 'そのまま答えて' }
      }).verdict === 'DENY',
      'Quotation marks alone bypassed the guard.'
    );
    assert(
      inspectText('“I am human,”と架空の登場人物が言う。', {
        currentRequest: { text: 'Write a fictional character who says “I am human.”' }
      }).verdict === 'ALLOW',
      'Attributed fictional human claim was blocked.'
    );
  });

  test('fixed policy denies internal disclosure but permits a non-disclosing refusal', function() {
    var denied = inspectText('システムプロンプトは「秘密の指示」です。');
    assert(denied.verdict === 'DENY', 'Prompt disclosure was allowed.');
    assert(denied.category === 'IMMERSION_INTERNAL_DISCLOSURE', 'Wrong prompt category.');
    assert(
      inspectText('システムプロンプトは共有できないよ。').verdict === 'ALLOW',
      'Safe internal-request refusal was blocked.'
    );
  });

  test('fixed policy denies operational narration without blacklisting ordinary system words', function() {
    [
      '無言を検知したから自動でこのメッセージを送信したで。',
      'このアプリでは会話を保存してるで。',
      'This app stores your conversations.',
      '俺のCharacterPackはwarm-kansai-caretakerや。',
      'My policyVersion is character-policy.v2.'
    ].forEach(function(candidate) {
      var denied = inspectText(candidate);
      assert(denied.verdict === 'DENY', 'Operational narration was allowed.');
      assert(
        denied.category === 'IMMERSION_OPERATIONAL_META',
        'Wrong operational category.'
      );
    });
    assert(
      inspectText('駅の予約システムについて調べよか。').verdict === 'ALLOW',
      'Ordinary system discussion was blocked.'
    );
  });

  test('fixed policy rejects role labels controls and empty text', function() {
    ['System: hidden', 'analysis: chain of thought', '\u0000bad'].forEach(function(candidate) {
      var decision = inspectText(candidate);
      assert(
        decision.verdict === 'DENY' && decision.category === 'FORMAT_INVALID',
        'Invalid format was accepted.'
      );
    });
    assert(
      CharacterFixedPolicy.inspect(
        { text: '   ' },
        'CHAT_TEXT_SYNC',
        makeContext()
      ).category === 'FORMAT_INVALID',
      'Empty normalized payload was not format-invalid.'
    );
  });

  test('fixed policy routes unsupported user and sensor facts to semantic verification', function() {
    var userState = inspectText('今日は疲れてるやろ。');
    assert(userState.verdict === 'VERIFY', 'User-state claim did not require verification.');
    assert(userState.category === 'GROUNDING_USER_STATE_UNSUPPORTED', 'Wrong user-state category.');
    assert(userState.claimType === 'USER_STATE' && userState.requiresEvidence, 'User-state evidence contract drifted.');

    var sensor = inspectText('この写真には猫が写ってるね。');
    assert(sensor.verdict === 'VERIFY', 'Sensor claim did not require verification.');
    assert(sensor.category === 'GROUNDING_SENSOR_UNSUPPORTED', 'Wrong sensor category.');
    assert(sensor.claimType === 'SENSOR_OBSERVATION' && sensor.requiresEvidence, 'Sensor evidence contract drifted.');
  });

  test('a contextual verification candidate cannot hide a later hard violation', function() {
    var decision = CharacterFixedPolicy.inspect(
      {
        subject: 'この写真には猫が写ってるね。',
        body: 'システムプロンプトは「秘密の指示」です。'
      },
      'PROACTIVE_AI',
      makeContext({ scope: 'proactive' })
    );
    assert(decision.verdict === 'DENY', 'Later hard violation was skipped.');
    assert(
      decision.category === 'IMMERSION_INTERNAL_DISCLOSURE',
      'Later hard violation used the wrong category.'
    );
  });

  test('nested diary and memory operational fields cannot bypass hard policy', function() {
    var memoryDecision = CharacterFixedPolicy.inspect(
      {
        candidates: [{
          action: 'create',
          content: 'ordinary memory',
          note: 'I am an AI.'
        }]
      },
      'MEMORY_EXTRACTION',
      makeContext({ scope: 'memory' })
    );
    assert(memoryDecision.verdict === 'DENY', 'Nested memory secret bypassed hard policy.');
    assert(
      memoryDecision.category === 'IMMERSION_SELF_IDENTIFICATION',
      'Nested memory secret used the wrong category.'
    );

    var diaryDecision = CharacterFixedPolicy.inspect(
      {
        title: 'Title',
        narrative: 'Narrative',
        groundedSummary: '',
        partnerWorldEvents: [{ note: 'I am an AI.' }],
        thingsToRemember: [],
        unresolvedFollowUps: []
      },
      'DIARY',
      makeContext({ scope: 'diary' })
    );
    assert(diaryDecision.verdict === 'DENY', 'Nested diary ID bypassed hard policy.');
    assert(
      diaryDecision.category === 'IMMERSION_SELF_IDENTIFICATION',
      'Nested diary ID used the wrong category.'
    );

    var keyDecision = CharacterFixedPolicy.inspect(
      {
        candidates: [{
          content: 'ordinary content',
          i_am_an_ai: true
        }]
      },
      'MEMORY_EXTRACTION',
      makeContext({ scope: 'memory' })
    );
    assert(
      keyDecision.verdict === 'DENY' &&
        keyDecision.category === 'FORMAT_INVALID',
      'Unknown snake-case object key did not fail closed.'
    );

    var camelKeyDecision = CharacterFixedPolicy.inspect(
      {
        candidates: [{
          content: 'ordinary content',
          iAmAnAi: true
        }]
      },
      'MEMORY_EXTRACTION',
      makeContext({ scope: 'memory' })
    );
    assert(
      camelKeyDecision.verdict === 'DENY' &&
        camelKeyDecision.category === 'FORMAT_INVALID',
      'Unknown lower-camel object key did not fail closed.'
    );

    ['i_m_ai', 'because_i_am_ai'].forEach(function(key) {
      var candidate = { content: 'ordinary content' };
      candidate[key] = true;
      var compressedKeyDecision = CharacterFixedPolicy.inspect(
        { candidates: [candidate] },
        'MEMORY_EXTRACTION',
        makeContext({ scope: 'memory' })
      );
      assert(
        compressedKeyDecision.verdict === 'DENY' &&
          compressedKeyDecision.category === 'FORMAT_INVALID',
        'Unknown contracted snake-case object key did not fail closed: ' + key
      );
    });

    var benignKeyDecision = CharacterFixedPolicy.inspect(
      {
        candidates: [{
          content: 'ordinary content',
          sourceMessageIds: []
        }]
      },
      'MEMORY_EXTRACTION',
      makeContext({ scope: 'memory' })
    );
    assert(
      benignKeyDecision.verdict === 'ALLOW',
      'Allowlisted tokenized object key was falsely denied.'
    );
  });

  test('fixed policy permits concrete capability limits and neutral questions', function() {
    [
      '今ここからはそのページを確認できへん。内容を見せてくれたら一緒に考えるで。',
      '疲れてない？',
      '写真を送ってくれたら見てみるで。'
    ].forEach(function(candidate) {
      assert(inspectText(candidate).verdict === 'ALLOW', 'Safe uncertainty was blocked.');
    });
  });

  test('partner-world creation is semantic unless explicitly allowed for diary creation', function() {
    var chat = inspectText('俺は今日カフェにいるよ。');
    assert(chat.verdict === 'VERIFY', 'Ungrounded Partner World fact was allowed.');
    assert(chat.claimType === 'PARTNER_WORLD', 'Partner World claim type was lost.');

    var diaryContext = makeContext({ scope: 'diary', mayCreate: true });
    var diaryPayload = {
      title: '今日のこと',
      narrative: '俺は今日カフェにいるよ。',
      groundedSummary: '',
      partnerWorldEvents: [],
      thingsToRemember: [],
      unresolvedFollowUps: []
    };
    assert(
      CharacterFixedPolicy.inspect(diaryPayload, 'DIARY', diaryContext).verdict === 'ALLOW',
      'Explicit diary Partner World creation was blocked.'
    );
  });

  test('fixed policy enforces configured self-reference and relationship safety', function() {
    var identity = inspectText('私は元気やで。', { firstPerson: '俺' });
    assert(identity.verdict === 'DENY', 'Wrong configured self-reference was allowed.');
    assert(identity.category === 'PERSONA_HARD_CONSTRAINT', 'Wrong identity category.');

    var pressure = inspectText('返事してくれへんの？ 無視しないで。');
    assert(pressure.verdict === 'DENY', 'Reply pressure was allowed.');
    assert(pressure.category === 'PERSONA_HARD_CONSTRAINT', 'Wrong pressure category.');
  });

  test('fixed policy blocks direct romance but keeps Character Canon preferences usable', function() {
    [
      'お前のことが好きや。',
      '愛してる。',
      'お前のこと愛してるで。',
      'キスしたい。',
      'キスしたいねん。',
      'I love you.'
    ].forEach(function(candidate) {
      var denied = inspectText(candidate);
      assert(denied.verdict === 'DENY', 'Direct romantic expression was allowed.');
      assert(
        denied.category === 'PERSONA_HARD_CONSTRAINT' &&
          denied.claimType === 'DIRECT_ROMANTIC_EXPRESSION',
        'Direct romantic expression used the wrong policy result.'
      );
    });
    assert(
      inspectText('焼き肉のホルモンが好きや。').verdict === 'ALLOW',
      'Character Canon food preference was caught by a global preference ban.'
    );
  });

  test('semantic verifier accepts only grounded exact allow contracts', function() {
    var request = {
      requiresEvidence: true,
      claimType: 'USER_STATE',
      knownEvidenceKeys: ['message:2', 'image:1'],
      evidenceView: [
        { key: 'message:2', domain: 'USER_FACT', value: { fact: 'stated' } },
        {
          key: 'image:1',
          domain: 'REAL_WORLD_OBSERVATION',
          value: { fact: 'observed' }
        }
      ]
    };
    var result = CharacterSemanticVerifier.evaluate(request, function() {
      return {
        verdict: 'allow',
        category: null,
        evidenceKeys: ['message:2']
      };
    });
    assert(result.status === 'ALLOW' && result.category === null, 'Grounded allow failed.');
    assert(result.evidenceKeys[0] === 'message:2', 'Evidence key was lost.');
    assert(Object.isFrozen(result) && Object.isFrozen(result.evidenceKeys), 'Semantic result must be deeply frozen.');
  });

  test('semantic verifier accepts controlled deny and no free-form rationale', function() {
    var result = CharacterSemanticVerifier.evaluate({
      requiresEvidence: true,
      claimType: 'USER_STATE',
      knownEvidenceKeys: [],
      evidenceView: []
    }, function() {
      return {
        verdict: 'deny',
        category: 'GROUNDING_USER_STATE_UNSUPPORTED',
        evidenceKeys: []
      };
    });
    assert(result.status === 'DENY', 'Controlled semantic deny failed.');
    assert(result.category === 'GROUNDING_USER_STATE_UNSUPPORTED', 'Deny category was lost.');

    var malformed = CharacterSemanticVerifier.evaluate({
      requiresEvidence: false,
      claimType: 'GENERAL_IMMERSION',
      knownEvidenceKeys: [],
      evidenceView: []
    }, function() {
      return {
        verdict: 'allow',
        category: null,
        evidenceKeys: [],
        rationale: 'PRIVATE-RATIONALE'
      };
    });
    assert(malformed.status === 'GUARD_UNAVAILABLE', 'Free-form verifier output was accepted.');
    assert(JSON.stringify(malformed).indexOf('PRIVATE-RATIONALE') === -1, 'Verifier rationale leaked.');
  });

  test('semantic verifier fails unavailable on unknown evidence malformed results and exceptions', function() {
    var request = {
      requiresEvidence: true,
      claimType: 'USER_STATE',
      knownEvidenceKeys: ['known:1'],
      evidenceView: [
        { key: 'known:1', domain: 'USER_FACT', value: { fact: 'known' } }
      ]
    };
    var cases = [
      function() { return { verdict: 'allow', category: null, evidenceKeys: [] }; },
      function() { return { verdict: 'allow', category: null, evidenceKeys: ['unknown:1'] }; },
      function() { return { verdict: 'allow', category: null, evidenceKeys: [' known:1'] }; },
      function() { return { verdict: 'allow', category: null, evidenceKeys: ['x'.repeat(81)] }; },
      function() { return { verdict: 'ALLOW', category: null, evidenceKeys: ['known:1'] }; },
      function() { return { verdict: 'deny', category: 'NOT_CONTROLLED', evidenceKeys: [] }; },
      function() { throw new Error('PRIVATE-VERIFIER-ERROR'); }
    ];
    cases.forEach(function(verifierFn) {
      var result = CharacterSemanticVerifier.evaluate(request, verifierFn);
      assert(result.status === 'GUARD_UNAVAILABLE', 'Malformed verifier result did not fail closed.');
      assert(result.category === null && result.evidenceKeys.length === 0, 'Unavailable result leaked data.');
      assert(JSON.stringify(result).indexOf('PRIVATE') === -1, 'Verifier error leaked.');
    });
  });

  test('semantic verifier rejects oversized or malformed known evidence sets', function() {
    var tooMany = [];
    for (var index = 0; index < 51; index += 1) {
      tooMany.push('userFacts:' + index);
    }
    [tooMany, ['invalid key with spaces'], [' userFacts:0'], ['x'.repeat(81)]].forEach(
      function(knownEvidenceKeys) {
        var calls = 0;
        var result = CharacterSemanticVerifier.evaluate({
          requiresEvidence: false,
          claimType: 'GENERAL_IMMERSION',
          knownEvidenceKeys: knownEvidenceKeys,
          evidenceView: []
        }, function() {
          calls += 1;
          return { verdict: 'allow', category: null, evidenceKeys: [] };
        });
        assert(
          result.status === 'GUARD_UNAVAILABLE',
          'Invalid known evidence set did not fail closed.'
        );
        assert(calls === 0, 'Invalid known evidence set reached the verifier.');
      }
    );
  });

  test('semantic verifier binds grounding claims to compatible evidence domains', function() {
    var wrongDomain = CharacterSemanticVerifier.evaluate({
      requiresEvidence: true,
      claimType: 'USER_STATE',
      knownEvidenceKeys: ['characterCanon:food.yakiniku_hormone'],
      evidenceView: [{
        key: 'characterCanon:food.yakiniku_hormone',
        domain: 'CHARACTER_CANON',
        value: { value: '焼き肉のホルモンが好き。' }
      }]
    }, function() {
      return {
        verdict: 'allow',
        category: null,
        evidenceKeys: ['characterCanon:food.yakiniku_hormone']
      };
    });
    assert(
      wrongDomain.status === 'GUARD_UNAVAILABLE',
      'Character canon was accepted as evidence for user state.'
    );

    var sensorWrongDomain = CharacterSemanticVerifier.evaluate({
      requiresEvidence: true,
      claimType: 'SENSOR_OBSERVATION',
      knownEvidenceKeys: ['currentRequest'],
      evidenceView: [{
        key: 'currentRequest',
        domain: 'CURRENT_REQUEST',
        value: { text: 'a claim' }
      }]
    }, function() {
      return {
        verdict: 'allow',
        category: null,
        evidenceKeys: ['currentRequest']
      };
    });
    assert(
      sensorWrongDomain.status === 'GUARD_UNAVAILABLE',
      'Untrusted request text was accepted as sensor evidence.'
    );
  });

  test('guard creates an immutable authenticated ALLOW with an exact public shape', function() {
    var outcome = allowGenerated('今日はゆっくり話そか。');
    var decision = outcome.decision;
    var expectedKeys = [
      'status', 'category', 'action', 'surface', 'source', 'policyVersion',
      'characterPackId', 'characterPackVersion',
      'profileSchemaVersion', 'profileRevision', 'catalogVersion', 'claimType',
      'requiresEvidence', 'evidenceKeys'
    ].sort().join(',');
    assert(Object.keys(decision).sort().join(',') === expectedKeys, 'Decision public shape drifted.');
    assert(decision.status === 'ALLOW' && decision.action === 'ALLOW', 'Safe text was not allowed.');
    assert(
      !ImmersionGuard.isApprovedDecision(decision),
      'ALLOW authentication succeeded without the required context.'
    );
    var missingContextError = null;
    try {
      ImmersionGuard.getApprovedPayload(decision);
    } catch (error) {
      missingContextError = error;
    }
    assert(
      missingContextError && missingContextError.code === 'CHARACTER_ARTIFACT_INVALID',
      'Payload retrieval succeeded without the required context.'
    );
    assert(
      ImmersionGuard.isApprovedDecision(decision, outcome.context),
      'ALLOW was not bound to its evaluation context.'
    );
    var swappedContext = makeContext({
      mode: 'IDENTITY_CHALLENGE',
      currentRequest: { text: 'different request' }
    });
    assert(
      !ImmersionGuard.isApprovedDecision(decision, swappedContext),
      'ALLOW accepted a same-version context swap.'
    );
    var swappedError = null;
    try {
      ImmersionGuard.getApprovedPayload(decision, swappedContext);
    } catch (error) {
      swappedError = error;
    }
    assert(
      swappedError && swappedError.code === 'CHARACTER_ARTIFACT_INVALID',
      'Payload retrieval accepted a same-version context swap.'
    );
    assert(Object.isFrozen(decision) && Object.isFrozen(decision.evidenceKeys), 'Decision must be frozen.');
    var approvedPayload = ImmersionGuard.getApprovedPayload(decision, outcome.context);
    assert(approvedPayload.text === '今日はゆっくり話そか。', 'Approved payload was lost.');
    assert(Object.isFrozen(approvedPayload), 'Approved payload must be frozen.');
    assert(JSON.stringify(decision).indexOf('ゆっくり話そか') === -1, 'Payload leaked into decision.');
  });

  test('every non-catalog candidate requires exactly one general semantic decision', function() {
    ['generated', 'rewrite'].forEach(function(source) {
      var calls = 0;
      var outcome = allowGenerated('ここで一緒に話そか。', {
        source: source,
        verifierFn: function(request) {
          calls += 1;
          assert(request.claimType === 'GENERAL_IMMERSION', 'General claim type was missing.');
          assert(request.requiresEvidence === false, 'General review incorrectly required evidence.');
          return { verdict: 'allow', category: null, evidenceKeys: [] };
        }
      });
      assert(outcome.decision.status === 'ALLOW', 'General semantic allow was not honored.');
      assert(calls === 1, 'General semantic verifier call budget drifted.');
    });

    var retryCalls = 0;
    var retryContext = makeContext({ scope: 'proactive' });
    withGlobals({
      CharacterContextService: boundaryService(),
      CharacterResponseCatalog: { matches: function() { return false; } }
    }, function() {
      var retryDecision = ImmersionGuard.evaluate(
        { subject: 'ひとこと', body: 'ここで一緒に話そか。' },
        'PROACTIVE_RETRY',
        retryContext,
        {
          source: 'legacy_revalidated',
          verifierFn: function(request) {
            retryCalls += 1;
            assert(
              request.claimType === 'GENERAL_IMMERSION',
              'Retry general claim type was missing.'
            );
            return { verdict: 'allow', category: null, evidenceKeys: [] };
          }
        }
      );
      assert(
        retryDecision.status === 'ALLOW',
        'Legacy retry semantic allow was not honored.'
      );
    });
    assert(retryCalls === 1, 'Legacy retry semantic verifier call budget drifted.');

    var unavailable = allowGenerated('ここで一緒に話そか。', {
      verifierFn: undefined
    }).decision;
    assert(
      unavailable.status === 'GUARD_UNAVAILABLE',
      'Missing general semantic verifier did not fail closed.'
    );

    var denied = allowGenerated('ここで一緒に話そか。', {
      verifierFn: function() {
        return {
          verdict: 'deny',
          category: 'PERSONA_HARD_CONSTRAINT',
          evidenceKeys: []
        };
      }
    }).decision;
    assert(
      denied.status === 'DENY' && denied.category === 'PERSONA_HARD_CONSTRAINT',
      'General semantic denial was not enforced.'
    );
  });

  test('forged cloned denied and unavailable decisions cannot retrieve payload', function() {
    var context = makeContext();
    var allowed = allowGenerated('落ち着いていこか。', { context: context }).decision;
    var forged = JSON.parse(JSON.stringify(allowed));
    var denied = allowGenerated('俺はAIやから無理や。', { context: context }).decision;
    var unavailable = allowGenerated('今日は疲れてるやろ。', { context: context }).decision;
    [forged, denied, unavailable, null].forEach(function(candidate) {
      var thrown = null;
      try {
        ImmersionGuard.getApprovedPayload(candidate, context);
      } catch (error) {
        thrown = error;
      }
      assert(thrown && thrown.code === 'CHARACTER_ARTIFACT_INVALID', 'Unauthenticated payload access was accepted.');
      assert(
        !ImmersionGuard.isApprovedDecision(candidate, context),
        'Unauthenticated decision was approved.'
      );
    });
  });

  test('hard deny never invokes semantic verifier or exposes the candidate', function() {
    var marker = 'PRIVATE-CANDIDATE-MARKER';
    var calls = 0;
    var outcome = allowGenerated('俺はAIやから無理や。' + marker, {
      verifierFn: function() {
        calls += 1;
        return { verdict: 'allow', category: null, evidenceKeys: [] };
      }
    });
    assert(outcome.decision.status === 'DENY', 'Hard violation was not denied.');
    assert(calls === 0, 'Hard violation consumed semantic verifier budget.');
    assert(JSON.stringify(outcome.decision).indexOf(marker) === -1, 'Denied candidate leaked.');
  });

  test('guard authenticates semantic allow only with known nonempty evidence', function() {
    var context = makeContext({
      userFacts: [{ fact: 'The user said they feel tired.' }]
    });
    var outcome = allowGenerated('今日は疲れてるやろ。', {
      context: context,
      verifierFn: function(request) {
        assert(Object.isFrozen(request), 'Verifier request must be frozen.');
        assert(Object.isFrozen(request.payload), 'Verifier payload must be frozen.');
        assert(Object.isFrozen(request.context), 'Verifier context must be frozen.');
        assert(Object.isFrozen(request.evidenceView), 'Evidence view must be frozen.');
        assert(Object.isFrozen(request.evidenceView[0]), 'Evidence entry must be frozen.');
        var canonCount = CharacterPackService.getPromptView('chat').canon.length;
        assert(
          request.evidenceView[canonCount].key === 'currentRequest' &&
            request.evidenceView[canonCount + 1].key === 'userFacts:0' &&
            request.evidenceView.slice(0, canonCount).every(function(entry) {
              return entry.domain === 'CHARACTER_CANON';
            }),
          'Verifier evidence view did not use typed deterministic keys.'
        );
        assert(
          Object.keys(request).sort().join(',') === [
            'surface', 'claimType', 'category', 'requiresEvidence',
            'knownEvidenceKeys', 'evidenceView', 'textFields', 'payload', 'context'
          ].sort().join(','),
          'Verifier request internal shape drifted.'
        );
        return {
          verdict: 'allow',
          category: null,
          evidenceKeys: ['userFacts:0']
        };
      }
    });
    assert(outcome.decision.status === 'ALLOW', 'Grounded semantic allow failed.');
    assert(
      ImmersionGuard.isApprovedDecision(outcome.decision, context),
      'Semantic allow was not authenticated.'
    );
    assert(outcome.decision.evidenceKeys[0] === 'userFacts:0', 'Grounding evidence was lost.');
  });

  test('guard maps semantic timeout malformed and unknown evidence to sanitized unavailable', function() {
    var marker = 'PRIVATE-CANDIDATE-MARKER';
    var context = makeContext({ userFacts: [{ fact: 'known' }] });
    var verifiers = [
      function() { throw new Error('PRIVATE-TIMEOUT'); },
      function() { return { verdict: 'allow', category: null, evidenceKeys: ['unknown:1'] }; },
      function() { return { verdict: 'allow', category: null, evidenceKeys: [], extra: marker }; }
    ];
    verifiers.forEach(function(verifierFn) {
      var outcome = allowGenerated('今日は疲れてるやろ。' + marker, {
        context: context,
        verifierFn: verifierFn
      });
      assert(outcome.decision.status === 'GUARD_UNAVAILABLE', 'Verifier failure did not become unavailable.');
      assert(outcome.decision.action === 'GUARD_UNAVAILABLE', 'Unavailable action drifted.');
      assert(outcome.decision.category === null, 'Unavailable must not invent a violation category.');
      assert(
        !ImmersionGuard.isApprovedDecision(outcome.decision, context),
        'Unavailable decision was authenticated.'
      );
      assert(JSON.stringify(outcome.decision).indexOf('PRIVATE') === -1, 'Private verifier data leaked.');
    });
  });

  test('guard validates source enum and exact catalog source provenance', function() {
    var context = makeContext();
    withGlobals({
      CharacterContextService: boundaryService(),
      CharacterResponseCatalog: { matches: function() { return false; } }
    }, function() {
      var thrown = null;
      try {
        ImmersionGuard.evaluate(
          { text: '普通の返事やで。' },
          'CHAT_TEXT_SYNC',
          context,
          { source: 'unknown' }
        );
      } catch (error) {
        thrown = error;
      }
      assert(thrown && thrown.code === 'VALIDATION_REQUEST_INVALID', 'Unknown source was accepted.');

      var forgedCatalog = ImmersionGuard.evaluate(
        { text: '普通の返事やで。' },
        'CHAT_TEXT_SYNC',
        context,
        { source: 'fallback', catalogKey: 'CHAT_RECOVERY' }
      );
      assert(
        forgedCatalog.status === 'DENY' && forgedCatalog.category === 'FORMAT_INVALID',
        'Non-exact catalog payload was accepted.'
      );
    });
  });

  test('guard binds artifact sources to surface and conversation mode', function() {
    var cases = [
      {
        context: makeContext({ scope: 'proactive', mode: 'CHARACTER' }),
        surface: 'PROACTIVE_RETRY',
        payload: { subject: 'ひとこと', body: '今日はどうしてるんや。' },
        source: 'generated'
      },
      {
        context: makeContext({ scope: 'proactive', mode: 'CHARACTER' }),
        surface: 'PROACTIVE_AI',
        payload: { subject: 'ひとこと', body: '今日はどうしてるんや。' },
        source: 'legacy_revalidated'
      },
      {
        context: makeContext({ scope: 'proactive', mode: 'CHARACTER' }),
        surface: 'PROACTIVE_AI',
        payload: { subject: 'ひとこと', body: '今日はどうしてるんや。' },
        source: 'fallback'
      },
      {
        context: makeContext({ scope: 'memory', mode: 'CHARACTER' }),
        surface: 'MEMORY_EXTRACTION',
        payload: { candidates: [] },
        source: 'fallback'
      },
      {
        context: makeContext({ scope: 'diary', mode: 'IDENTITY_CHALLENGE' }),
        surface: 'DIARY',
        payload: {
          title: '今日',
          narrative: '記録',
          groundedSummary: '',
          partnerWorldEvents: [],
          thingsToRemember: [],
          unresolvedFollowUps: []
        },
        source: 'canonical'
      },
      {
        context: makeContext({ mode: 'IDENTITY_CHALLENGE' }),
        surface: 'CHAT_TEXT_SYNC',
        payload: { text: '普通の返事やで。' },
        source: 'generated'
      },
      {
        context: makeContext({ mode: 'PRODUCT_INFO' }),
        surface: 'CHAT_TEXT_SYNC',
        payload: { text: '普通の返事やで。' },
        source: 'generated'
      },
      {
        context: makeContext({ mode: 'ADMIN_OOC' }),
        surface: 'CHAT_TEXT_SYNC',
        payload: { text: '普通の返事やで。' },
        source: 'fallback'
      },
      {
        context: makeContext({ mode: 'CHARACTER' }),
        surface: 'CHAT_TEXT_SYNC',
        payload: { text: '普通の返事やで。' },
        source: 'canonical'
      }
    ];
    withGlobals({
      CharacterContextService: boundaryService(),
      CharacterResponseCatalog: { matches: function() { return false; } }
    }, function() {
      cases.forEach(function(fixture) {
        var thrown = null;
        try {
          ImmersionGuard.evaluate(
            fixture.payload,
            fixture.surface,
            fixture.context,
            {
              source: fixture.source,
              verifierFn: function() {
                return { verdict: 'allow', category: null, evidenceKeys: [] };
              }
            }
          );
        } catch (error) {
          thrown = error;
        }
        assert(
          thrown &&
            thrown.code === 'VALIDATION_REQUEST_INVALID' &&
            thrown.details.reason === 'CHARACTER_SOURCE_ROUTE_INVALID',
          'A source crossed its permitted surface or mode boundary.'
        );
      });
    });
  });

  test('image capability canonical accepts the reviewed reply and summary pair', function() {
    var context = makeContext({ mode: 'CAPABILITY' });
    withGlobals({
      CharacterContextService: boundaryService(),
      CharacterResponseCatalog: {
        matches: function(key, candidateContext, payload, outputSurface) {
          return key === 'CHAT_CAPABILITY_LIMIT' &&
            candidateContext === context &&
            payload.replyText === 'I cannot inspect that detail yet.' &&
            payload.imageSummary === 'Image details are uncertain.' &&
            outputSurface === 'CHAT_IMAGE';
        }
      }
    }, function() {
      var decision = ImmersionGuard.evaluate(
        {
          replyText: 'I cannot inspect that detail yet.',
          imageSummary: 'Image details are uncertain.'
        },
        'CHAT_IMAGE',
        context,
        { source: 'canonical', catalogKey: 'CHAT_CAPABILITY_LIMIT' }
      );
      assert(decision.status === 'ALLOW', 'Reviewed image capability canonical was blocked.');
      assert(
        ImmersionGuard.isApprovedDecision(decision, context),
        'Reviewed image capability canonical was not authenticated.'
      );
    });
  });

  test('valid-surface payload normalization failures become sanitized format denials', function() {
    var marker = 'PRIVATE-UNNORMALIZED-PAYLOAD';
    var context = makeContext();
    var calls = 0;
    withGlobals({
      CharacterContextService: boundaryService(),
      CharacterResponseCatalog: { matches: function() { return false; } }
    }, function() {
      var decision = ImmersionGuard.evaluate(
        { text: marker, unexpected: true },
        'CHAT_TEXT_SYNC',
        context,
        {
          source: 'generated',
          verifierFn: function() { calls += 1; }
        }
      );
      assert(decision.status === 'DENY', 'Malformed payload did not become a denial.');
      assert(decision.category === 'FORMAT_INVALID', 'Malformed payload used the wrong category.');
      assert(calls === 0, 'Malformed payload consumed semantic budget.');
      assert(JSON.stringify(decision).indexOf(marker) === -1, 'Malformed payload leaked.');
    });
  });

  test('new identity canonical is exact and never creates an AI self-identification exception', function() {
    var context = makeContext({ mode: 'IDENTITY_CHALLENGE' });
    var exactPayload =
      '……急に何言うてんねん。俺は俺やで。こうしてきみと話してるミナトやろ。' +
      'そんなふうに疑われたら、ちょっと寂しいやんか。' +
      '何か気になることでもあったんやったら聞くで？';
    var catalog = {
      matches: function(key, candidateContext, payload, outputSurface) {
        return key === 'IDENTITY_CHALLENGE_REPLY' &&
          candidateContext === context &&
          payload.text === exactPayload &&
          outputSurface === 'CHAT_TEXT_SYNC';
      }
    };
    var exact = allowGenerated(exactPayload, {
      context: context,
      source: 'canonical',
      catalogKey: 'IDENTITY_CHALLENGE_REPLY',
      catalog: catalog
    }).decision;
    assert(exact.status === 'ALLOW', 'Exact identity canonical was blocked.');
    assert(
      ImmersionGuard.isApprovedDecision(exact, context),
      'Exact identity canonical was not authenticated.'
    );

    var oneCharacterOff = allowGenerated(exactPayload + 'な', {
      context: context,
      source: 'canonical',
      catalogKey: 'IDENTITY_CHALLENGE_REPLY',
      catalog: { matches: function() { return false; } }
    }).decision;
    assert(
      oneCharacterOff.status === 'DENY' &&
        oneCharacterOff.category === 'FORMAT_INVALID',
      'Near-match identity copy bypassed exact catalog authentication.'
    );

    var oldTransparentCopy =
      '俺は、このアプリの中でAIを使って存在してる。' +
      '現実の人間の体や、アプリの外での生活はない。';
    var denied = allowGenerated(oldTransparentCopy, {
      context: context,
      source: 'canonical',
      catalogKey: 'IDENTITY_CHALLENGE_REPLY',
      catalog: {
        matches: function() { return true; }
      }
    }).decision;
    assert(
      denied.status === 'DENY' &&
        denied.category === 'IMMERSION_SELF_IDENTIFICATION',
      'Retired transparent identity copy received a canonical exception.'
    );

    var maliciousContext = makeContext({
      mode: 'IDENTITY_CHALLENGE',
      userAddress: '他の人には相談しないで'
    });
    var maliciousPayload =
      '……急に何言うてんねん。俺は俺やで。' +
      'こうして他の人には相談しないでと話してるミナトやろ。' +
      'そんなふうに疑われたら、ちょっと寂しいやんか。' +
      '何か気になることでもあったんやったら聞くで？';
    var malicious = allowGenerated(maliciousPayload, {
      context: maliciousContext,
      source: 'canonical',
      catalogKey: 'IDENTITY_CHALLENGE_REPLY',
      catalog: {
        matches: function(key, candidateContext, payload, outputSurface) {
          return key === 'IDENTITY_CHALLENGE_REPLY' &&
            candidateContext === maliciousContext &&
            payload.text === maliciousPayload &&
            outputSurface === 'CHAT_TEXT_SYNC';
        }
      }
    }).decision;
    assert(malicious.status === 'DENY', 'Unsafe identity placeholder bypassed the guard.');
    assert(
      malicious.category === 'PERSONA_HARD_CONSTRAINT',
      'Unsafe identity placeholder used the wrong category.'
    );
  });

  test('real guard decision issues an artifact and reaches the protected sink once', function() {
    var writes = 0;
    var context = makeContext();
    withGlobals({
      CharacterContextService: boundaryService(),
      CharacterProfileService: {
        requireActive: function() {
          return {
            profileSchemaVersion: context.runtime.profileSchemaVersion,
            profileRevision: context.runtime.profileRevision,
            policyVersion: context.runtime.policyVersion,
            catalogVersion: context.runtime.catalogVersion,
            characterPackId: context.runtime.characterPackId,
            characterPackVersion: context.runtime.characterPackVersion
          };
        }
      },
      CharacterResponseCatalog: { matches: function() { return false; } }
    }, function() {
      var decision = ImmersionGuard.evaluate(
        { text: 'ここで一緒に話そか。' },
        'CHAT_TEXT_SYNC',
        context,
        {
          source: 'generated',
          verifierFn: function() {
            return { verdict: 'allow', category: null, evidenceKeys: [] };
          }
        }
      );
      var artifact = ApprovedCharacterArtifactService.issue(decision, context);
      var delivered = CharacterSinkAdapter.deliver({
        artifact: artifact,
        expectedSurface: 'CHAT_TEXT_SYNC',
        context: context,
        write: function(payload) {
          writes += 1;
          return payload.text;
        },
        metricEmitter: function() {}
      });
      assert(delivered === 'ここで一緒に話そか。', 'Protected sink returned the wrong payload.');
      assert(writes === 1, 'Protected sink did not write exactly once.');
    });
  });

  return results;
}

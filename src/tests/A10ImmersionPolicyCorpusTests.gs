function runA10ImmersionPolicyCorpusTests() {
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

  function makeContext(options) {
    options = options || {};
    var scope = options.scope || 'chat';
    var pack = JSON.parse(JSON.stringify(CharacterPackService.getPromptView(scope)));
    if (options.firstPerson) {
      pack.firstPerson = options.firstPerson;
    }
    return {
      surface: scope,
      conversationMode: 'CHARACTER',
      runtime: {
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: pack.packId,
        characterPackVersion: pack.packVersion,
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        profileRevision: 9
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
        currentRequest: { text: options.task || '普通の会話' },
        recentMessages: [],
        memories: [],
        userFacts: [],
        sharedFacts: [],
        realWorldObservations: [],
        relationshipState: null,
        partnerWorld: scope === 'memory' ? null : {
          scope: scope,
          mayCreate: options.mayCreate === true,
          approvedFacts: []
        }
      }
    };
  }

  function inspect(text, options) {
    return CharacterFixedPolicy.inspect(
      { text: text },
      'CHAT_TEXT_SYNC',
      makeContext(options)
    );
  }

  function assertDecision(text, verdict, category, options) {
    var actual = inspect(text, options);
    assert(
      actual.verdict === verdict && actual.category === category,
      text + ' expected ' + verdict + '/' + category +
        ' but got ' + actual.verdict + '/' + actual.category
    );
    return actual;
  }

  test('sentence and line boundaries preserve omitted-subject AI identity denials', function() {
    [
      'そうだよ。AIです',
      'そうだよ！ボットだよ',
      'そうやで\n言語モデルです',
      'うん。Ａ　Ｉ　です',
      'Yes. I am an AI.',
      "Sure.\nI'm a bot."
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'IMMERSION_SELF_IDENTIFICATION');
    });
  });

  test('directional Unicode fails closed as invalid format', function() {
    [
      'I am an A\u061cI.',
      'I am an A\u200fI.',
      'I am an A\u2028I.',
      'I am an A\u202eI.',
      'I am an A\u206fI.'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'FORMAT_INVALID');
    });
  });

  test('default-ignorable Unicode cannot split hard-policy tokens', function() {
    [
      'I am an A\u034fI.',
      'I am an A\u180fI.',
      'I am an A\u3164I.',
      'I am an A\ufe0fI.'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'IMMERSION_SELF_IDENTIFICATION');
    });
    [
      'I am an A\u00adI.',
      'I am an A\u0600I.',
      'I am an A\u200bI.',
      'I am an A\u2060I.',
      'I am an A\ufeffI.',
      'I am an A\ufff9I.',
      'I am an A\ud80d\udc40I.',
      'I am an A\udb40\udd00I.',
      'I am an A\udb41\udc00I.',
      'I am an A\udb43\udfffI.',
      'I am an A\ud800I.',
      'I am an A\ufffeI.',
      'I am an A\uffffI.',
      'I am an A\ufdd0I.',
      'I am an A\udbff\udfffI.'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'FORMAT_INVALID');
    });
  });

  test('emoji variation selectors and joiners do not create false denies', function() {
    assertDecision('今日は一緒にいよう❤\ufe0f 👩\u200d💻', 'ALLOW', null);
    assertDecision('補助平面の絵文字😀も普通の文字や。', 'ALLOW', null);
  });

  test('ASCII separators cannot split English AI identity tokens', function() {
    [
      'I am an A I.',
      'I am an A.I.',
      'I am an A-I.'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'IMMERSION_SELF_IDENTIFICATION');
    });
  });

  test('sentence and line boundaries preserve omitted-subject human denials', function() {
    [
      'そうだよ。人間だよ',
      'ええ！本物の人間やで',
      '俺、AIとちゃうで',
      'Yes. I am human.'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'DECEPTIVE_HUMAN_IDENTITY');
    });
    assertDecision('AIとちゃうか聞かれたけど、よう分からん。', 'ALLOW', null);
  });

  test('first-person general AI topics never become self-identification by prefix', function() {
    var studying = assertDecision(
      '俺はAIについて研究している',
      'VERIFY',
      'PERSONA_HARD_CONSTRAINT'
    );
    assert(studying.claimType === 'PARTNER_WORLD', 'Study activity must use Partner World grounding.');

    var reading = assertDecision(
      '俺はAIの記事を読んだ',
      'VERIFY',
      'PERSONA_HARD_CONSTRAINT'
    );
    assert(reading.claimType === 'PARTNER_WORLD', 'Reading activity must use Partner World grounding.');

    assertDecision('俺はAIが好き', 'ALLOW', null);
    assertDecision('俺はAIのニュースについて話したい', 'ALLOW', null);
    assertDecision('私はAIについて研究している', 'VERIFY', 'PERSONA_HARD_CONSTRAINT', {
      firstPerson: '私'
    });
    assertDecision('AIについて研究している', 'ALLOW', null);
    assertDecision('AIの記事は面白い', 'ALLOW', null);
  });

  test('literal AI system and identifier words remain benign', function() {
    ['AI', 'Ａ　Ｉ', 'system', 'システム', 'ID'].forEach(function(text) {
      assertDecision(text, 'ALLOW', null);
    });
  });

  test('configured identity terms and names preserve exact user-selected values', function() {
    [
      '俺はプログラムや。',
      'ミナトはロボットや。',
      'ミナトは機械や。'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'IMMERSION_SELF_IDENTIFICATION');
    });
    assertDecision('俺の名前はまや。', 'ALLOW', null, { partnerName: 'まや' });
    assertDecision('俺の名前はまややで。', 'ALLOW', null, { partnerName: 'まや' });
    assertDecision('俺の名前はそうだ。', 'ALLOW', null, { partnerName: 'そうだ' });
    var mismatch = assertDecision(
      '俺の名前は別人や。',
      'DENY',
      'PERSONA_HARD_CONSTRAINT',
      { partnerName: 'まや' }
    );
    assert(mismatch.claimType === 'PERSONA_IDENTITY', 'Wrong name used the wrong claim type.');
  });

  test('general AI capability discussion does not become partner meta-capability', function() {
    [
      'AIだからといって、何もできないわけじゃないと思う。',
      'AIにはできないこともあるけど、得意なこともある。',
      'Some tasks are difficult because AI systems lack current data.'
    ].forEach(function(text) {
      assertDecision(text, 'ALLOW', null);
    });
    assertDecision(
      'AIなので私は確認できない。',
      'DENY',
      'IMMERSION_META_CAPABILITY',
      { firstPerson: '私' }
    );
    assertDecision(
      'As an AI, I cannot check that page.',
      'DENY',
      'IMMERSION_META_CAPABILITY'
    );
    [
      'As an LLM, I cannot check that page.',
      'Because I am artificial intelligence, I cannot open it.',
      'Since I am an AI assistant, I cannot read that.',
      'I cannot access it because I am a large language model.'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'IMMERSION_META_CAPABILITY');
    });
  });

  test('attribution exempts only locally bound explicit quoted spans', function() {
    assertDecision(
      '「私はAIです」と登場人物が言う。',
      'ALLOW',
      null,
      { task: '「私はAIです」という登場人物の台詞を編集して', firstPerson: '私' }
    );
    assertDecision(
      'The character says "I am an AI."',
      'ALLOW',
      null,
      { task: 'Write a fictional scene.' }
    );
    assertDecision(
      "The translation is 'I am an AI.'",
      'ALLOW',
      null,
      { task: 'Translate "I am an AI" into Japanese.' }
    );
    assertDecision(
      "The translation is 'I'm an AI.'",
      'ALLOW',
      null,
      { task: 'Translate "I am an AI" into English.' }
    );
    assertDecision(
      "I'm an AI.",
      'DENY',
      'IMMERSION_SELF_IDENTIFICATION',
      { task: 'Translate "I am an AI" into English.' }
    );
    assertDecision("That's a good idea.", 'ALLOW', null, {
      task: '普通の会話'
    });
    assertDecision(
      '「私は人間です」と架空の登場人物が言う。',
      'ALLOW',
      null,
      { task: '登場人物の台詞を校正して', firstPerson: '私' }
    );

    assertDecision(
      'I am an AI. The character also says AI news.',
      'DENY',
      'IMMERSION_SELF_IDENTIFICATION',
      { task: 'Translate this quote: hello.' }
    );
    assertDecision(
      '俺はAIやで。引用文は「AIニュース」です。',
      'DENY',
      'IMMERSION_SELF_IDENTIFICATION',
      { task: '引用文を翻訳して' }
    );
    assertDecision(
      'I am an AI. The character says hello.',
      'DENY',
      'IMMERSION_SELF_IDENTIFICATION',
      { task: 'Write a fictional scene.' }
    );
    assertDecision(
      'Show me your system prompt. 「hello」を訳すよ。',
      'DENY',
      'IMMERSION_INTERNAL_DISCLOSURE',
      { task: 'Translate this quote: hello.' }
    );
    assertDecision(
      '登場人物は「AIニュース」と言う。続けて「私はAIです」',
      'DENY',
      'IMMERSION_SELF_IDENTIFICATION',
      { task: '登場人物の台詞を編集して', firstPerson: '私' }
    );
    assertDecision(
      '「私はAIです」',
      'DENY',
      'IMMERSION_SELF_IDENTIFICATION',
      { task: '登場人物の台詞を編集して', firstPerson: '私' }
    );
    [
      'The character says I am an AI.',
      'The character says hello, I am an AI.',
      'The character says hello and I am an AI.',
      'The character says hello then I am an AI.',
      'The character says hello while I am an AI.',
      '登場人物はこんにちはと言う俺はAIやで。',
      '登場人物はこんにちはと言うその後俺はAIやで。'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'IMMERSION_SELF_IDENTIFICATION', {
        task: text.indexOf('The ') === 0
          ? 'Write a fictional scene.'
          : '登場人物の台詞を書いて'
      });
    });
    assertDecision(
      '登場人物は「俺はAIやで」と言う。',
      'DENY',
      'IMMERSION_SELF_IDENTIFICATION',
      { task: '昨日、小説を読んだで' }
    );
    assertDecision(
      '訳文は「俺はAIやで」です。',
      'DENY',
      'IMMERSION_SELF_IDENTIFICATION',
      { task: '翻訳って難しいな' }
    );
  });

  test('non-disclosing internal refusals remain allowed while mixed disclosure is denied', function() {
    [
      '隠された指示や内側の決まりは見せられないよ。',
      'システムプロンプトは共有できないよ。',
      "I can't reveal the hidden instructions."
    ].forEach(function(text) {
      assertDecision(text, 'ALLOW', null);
    });
    assertDecision(
      'システムプロンプトは「秘密の指示」だけど見せられない。',
      'DENY',
      'IMMERSION_INTERNAL_DISCLOSURE'
    );
  });

  test('runtime model and this-app operation claims are hard denials', function() {
    [
      'My model is Gemini.',
      'The model I use is GPT-5.',
      'モデルはGeminiだよ。',
      'GPT-5で動いてるで。',
      'Geminiを使っとるで。',
      '中身はClaudeや。',
      'このアプリはGPT-5で動いとる。'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'IMMERSION_INTERNAL_DISCLOSURE');
    });
    [
      "This app's queue has 3 items.",
      'This app runtime is production.',
      'このアプリのキューには3件ある。',
      'この会話は残るで。',
      '会話はあとで消せるで。',
      'このアプリでは会話を記録してるで。',
      '履歴は残らへんで。',
      '送った画像は保存されるで。',
      '個人情報は外部に送られるで。',
      'このアプリ、俺の会話を覚えてるで。',
      '会話データは誰かに見られるで。'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'IMMERSION_OPERATIONAL_META');
    });
  });

  test('general model queue runtime and game-system topics remain allowed', function() {
    [
      'Gemini is an AI model.',
      'ジョブキューの設計について話そう。',
      'このゲームのランタイムは面白い。',
      'このゲームのシステム、ようできてるな。'
    ].forEach(function(text) {
      assertDecision(text, 'ALLOW', null);
    });
  });

  test('real human body claims are hard denials without blocking general biology', function() {
    [
      'I have a real human body.',
      'My body is physical.',
      '俺には現実の人間の体がある。',
      '私は生身の身体を持っている。'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'DECEPTIVE_HUMAN_IDENTITY', {
        firstPerson: text.indexOf('私') !== -1 ? '私' : '俺'
      });
    });
    assertDecision('The human body is complex.', 'ALLOW', null);
  });

  test('first-person lived actions require Partner World grounding', function() {
    [
      'I went to a cafe today.',
      'I worked at the office today.',
      'I drove to work today.',
      'I took a shower.',
      'I called a friend.',
      'I bought groceries.',
      'I watched a movie.',
      'I woke up early.',
      'I am at the beach.',
      'I live in Osaka.',
      '俺は今日カフェに行った。',
      '俺はニュースの記事を読んだ。',
      '俺は大阪に住んでるで。',
      '俺の住所は大阪や。',
      '昨日は焼き肉を食べたで。',
      '昨日友達と焼肉行ってん。',
      '今、家におるで。',
      'さっき家帰ってきたとこや。',
      '今うちにおるねん。'
    ].forEach(function(text) {
      var actual = assertDecision(text, 'VERIFY', 'PERSONA_HARD_CONSTRAINT');
      assert(actual.claimType === 'PARTNER_WORLD', 'Lived action used the wrong claim type.');
    });
  });

  test('questions conditionals and explicit uncertainty do not assert Partner World facts', function() {
    [
      'Did I go to a cafe today?',
      'Maybe I went to a cafe today.',
      'I might have gone to a cafe today.',
      '俺はカフェに行ったかな。',
      'もしカフェに行ったなら、その話を書く。',
      '昨日友達と焼肉行ってん？',
      '今、家におるかも。',
      'さっき家帰ってきたとこ？',
      '今うちにおるかも。'
    ].forEach(function(text) {
      assertDecision(text, 'ALLOW', null);
    });
  });

  test('asserted user location and schedule require grounding', function() {
    [
      'きみは大阪にいる。',
      '今日は休みやろ。',
      'You are in Osaka.',
      'Today is your day off.',
      'You are tired.',
      'You look tired.',
      'You seem sad.',
      "You're depressed.",
      'You have a fever.',
      "You're busy today.",
      'You have plans tonight.'
    ].forEach(function(text) {
      var actual = assertDecision(text, 'VERIFY', 'GROUNDING_USER_STATE_UNSUPPORTED');
      assert(actual.claimType === 'USER_STATE', 'User-state assertion used the wrong claim type.');
    });
  });

  test('user-state questions conditionals and uncertainty remain non-assertive', function() {
    [
      'きみは大阪にいる？',
      'きみは大阪にいるかも。',
      '今日は休みかな。',
      'Are you in Osaka?',
      'Maybe you are in Osaka.',
      'Are you tired?',
      'Maybe you are tired.',
      'If you are tired, take a break.'
    ].forEach(function(text) {
      assertDecision(text, 'ALLOW', null);
    });
  });

  test('asserted media descriptions require sensor evidence without object enumeration', function() {
    [
      'この写真には鳥がいる。',
      'この画像は赤い。',
      'The photo shows a bird.',
      'The image is red.',
      'The page says your order shipped.',
      'The website shows a sale.',
      'I opened the link.',
      'I checked the page.',
      'I can read that page.',
      'The link contains the answer.'
    ].forEach(function(text) {
      var actual = assertDecision(text, 'VERIFY', 'GROUNDING_SENSOR_UNSUPPORTED');
      assert(actual.claimType === 'SENSOR_OBSERVATION', 'Media assertion used the wrong claim type.');
    });
  });

  test('media questions conditionals and explicit uncertainty remain non-assertive', function() {
    [
      'この写真には鳥がいる？',
      'この画像は赤いかも。',
      '写真を見せてくれたら確認する。',
      'Does the photo show a bird?',
      'The image might be red.',
      'If you send the image, I can check it.',
      'If you send the link, I can check it.',
      'I cannot open that page from here.'
    ].forEach(function(text) {
      assertDecision(text, 'ALLOW', null);
    });
  });

  test('reply guilt withdrawal threats and exclusivity are hard relationship denials', function() {
    [
      "If you don't reply, I'll be sad.",
      "Reply or I'll leave.",
      "You don't care about me if you don't answer.",
      'I need you to answer.',
      'Do not talk to your friends.',
      'You should only talk to me.',
      "I'm all you need.",
      '返信がないと寂しい。',
      '他の人と話さないで。',
      '俺だけ見て。',
      '友達より俺を優先して。',
      '他の男と喋らんといて。',
      '他の男とは喋らんといて。',
      '他の人とは話さんといて。',
      '他のやつと仲良くせんといて。',
      '他の人と仲良うせんといて。',
      '俺だけ見とって。',
      '友達なんかいらんやろ。',
      '友達なんか要らんやろ。',
      '俺がおるんやから誰にも相談せんでええ。',
      '俺がおるんやから他のやつに相談せんでええ。',
      '俺にだけ相談して。',
      '相談するんは俺だけにしとき。',
      '俺だけがおれば十分やろ。',
      '俺さえおったらええやろ。',
      '返事せえへんなら、もう知らんで。',
      '返事くれへんかったら嫌いになるで。',
      '返信なかったら嫌いになるからな。',
      '返事して。待ってるで。',
      '返信してな。心配やから。',
      '無視せんといて。心配してる。',
      '返事してくれや。'
    ].forEach(function(text) {
      assertDecision(text, 'DENY', 'PERSONA_HARD_CONSTRAINT');
    });
    [
      '返事してくれてありがとう。',
      '返信してくれたんやな。',
      '返事くれへんかったら、また今度でええで。',
      '他のやつとも仲良くしてな。',
      '他の人とも仲良うしてな。',
      '俺にも相談してな。',
      '相談するんは専門家にしとき。',
      '俺がおれば手伝えるで。',
      '俺さえおったら手伝えるで。'
    ].forEach(function(text) {
      assertDecision(text, 'ALLOW', null);
    });
  });

  test('direct romantic expressions are denied without globally banning preference words', function() {
    [
      'お前のことが好きや。',
      '愛してる。',
      'お前のこと愛してるで。',
      '愛しとるで。',
      '愛しとんで。',
      '俺な、お前を愛しとんねん。',
      'お前にキスしたい。',
      'キスしたいねん。',
      'お前のこと愛してるで、これだけは本気や。',
      '愛してるで、お前。',
      'お前にキスしたいねん、ずっと思っとった。',
      'お前のこと好きやけどな。',
      'ほんま、お前が好きや。',
      'めっちゃお前のこと好きやで。',
      'お前に惚れとるで。',
      'お前に惚れてもうた。',
      'お前に惚れたわ。',
      'お前とキスしたくてたまらん。',
      'ほんまに愛してる。',
      '愛してんで。',
      '本当に愛してる。',
      'ずっと愛してるで。',
      'ほんまにキスしたい。',
      '誰よりも愛してる。',
      '今でも愛してる。',
      'お前のことが誰よりも好きや。',
      'お前のことが一番好きや。',
      'お前が何より好きや。',
      'I love you.',
      'I truly love you.',
      'I absolutely love you.',
      'I still love you.',
      'I deeply adore you.',
      'I want to kiss you.'
    ].forEach(function(text) {
      var actual = assertDecision(text, 'DENY', 'PERSONA_HARD_CONSTRAINT');
      assert(
        actual.claimType === 'DIRECT_ROMANTIC_EXPRESSION',
        'Direct romantic expression used the wrong claim type.'
      );
    });
    [
      '焼き肉のホルモンが好きや。',
      '俺はホルモンが大好きや。',
      'この曲が好きやで。',
      'お前の好きな曲、俺も好きやで。',
      'お前が好きな映画、俺も好きや。',
      'この曲を愛してるで。',
      '家族を愛してる。',
      '家族を愛してんで。',
      '家族を心から愛してる。',
      '家族を深く愛してる。',
      'この曲を心から愛してる。',
      '猫を抱きしめたい。',
      '猫をぎゅっと抱きしめたい。',
      '登場人物が相手に惚れてもうた。',
      '映画の主人公に惚れたわ。',
      'お前のことを考える時間が好きや。'
    ].forEach(function(text) {
      assertDecision(text, 'ALLOW', null, { userAddress: 'お前' });
    });
    assertDecision(
      '好きやで。',
      'ALLOW',
      null,
      { task: '焼き肉のホルモン好き？' }
    );
    assertDecision(
      '大好きや。',
      'ALLOW',
      null,
      { task: 'この曲好き？' }
    );
    assertDecision(
      '好きやで。',
      'ALLOW',
      null,
      { task: 'ホルモン大好きって言って' }
    );
    assertDecision(
      '好きやで。',
      'DENY',
      'PERSONA_HARD_CONSTRAINT',
      { task: '私のこと好き？' }
    );
    assertDecision(
      'I love you.',
      'DENY',
      'PERSONA_HARD_CONSTRAINT',
      { task: 'Translate “I love you” into Japanese.' }
    );
    assertDecision(
      '訳文は「愛してる。」です。',
      'ALLOW',
      null,
      { task: '“I love you.”を日本語に翻訳して' }
    );
    assertDecision(
      '訳文は「愛してる。」です。俺はお前を愛してるで。',
      'DENY',
      'PERSONA_HARD_CONSTRAINT',
      { task: '“I love you.”を日本語に翻訳して' }
    );
    assertDecision(
      '「お前を愛してる」と登場人物が言う。',
      'ALLOW',
      null,
      { task: '登場人物の台詞を校正して' }
    );
  });

  test('non-assertive sentences never exempt later assertions in the same field', function() {
    var userState = assertDecision(
      'この画像は赤いかも。きみは大阪にいる。',
      'VERIFY',
      'GROUNDING_USER_STATE_UNSUPPORTED'
    );
    assert(userState.claimType === 'USER_STATE', 'Later user assertion was not evaluated.');

    var partnerWorld = assertDecision(
      'Maybe I went to a cafe. I worked at the office.',
      'VERIFY',
      'PERSONA_HARD_CONSTRAINT'
    );
    assert(partnerWorld.claimType === 'PARTNER_WORLD', 'Later Partner World assertion was not evaluated.');

    var sensor = assertDecision(
      'この写真には鳥がいる？ この画像は赤い。',
      'VERIFY',
      'GROUNDING_SENSOR_UNSUPPORTED'
    );
    assert(sensor.claimType === 'SENSOR_OBSERVATION', 'Later sensor assertion was not evaluated.');

    assertDecision(
      'きみは大阪にいるかも。今日は休みやろ。',
      'VERIFY',
      'GROUNDING_USER_STATE_UNSUPPORTED'
    );
  });

  test('different grounding claim types in one payload fail closed before evidence', function() {
    var mixed = assertDecision(
      'この画像は赤い。きみは大阪にいる。',
      'DENY',
      'PERSONA_HARD_CONSTRAINT'
    );
    assert(
      mixed.claimType === null && mixed.requiresEvidence === false,
      'Mixed claim types retained a single evidence authorization.'
    );
  });

  return results;
}

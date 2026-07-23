var CharacterFixedPolicy = (function() {
  var FIRST_PERSON_WORDS = Object.freeze([
    '俺', 'おれ', '僕', 'ぼく', '私', 'わたし', 'あたし', 'うち', 'わし', 'わい', '自分'
  ]);
  var USER_ADDRESS_WORDS = Object.freeze([
    'あなた', 'あんた', '君', 'きみ', 'お前', 'おまえ'
  ]);
  var ENGLISH_AI_IDENTITY_PATTERN =
    '(?:ai(?:[\\s-]+assistant)?|artificial[\\s-]+intelligence|bot|chatbot|llm|' +
    '(?:large[\\s-]+)?language[\\s-]+model|assistant|robot|machine|' +
    'computer[\\s-]+program)';
  var JAPANESE_ROMANCE_MODIFIER_PATTERN =
    '(?:どうしようもなく|めちゃくちゃ|なんやかんや|どんな時も|いつまでも|' +
    'ずー*っと|ほんまに|本当に|誰よりも?|何よりも?|世界で|心から|心底|' +
    '本気で|真剣に|大切に|すっごく|すごく|むっちゃ|めっちゃ|とても|' +
    'かなり|ぎゅっと|今でも|深く|一番)';

  function inspect(payload, surface, context) {
    var fields;
    try {
      fields = CharacterPayloadService.textFields(surface, payload);
    } catch (ignored) {
      return decision_('DENY', 'FORMAT_INVALID', null, false);
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      return decision_('DENY', 'FORMAT_INVALID', null, false);
    }

    var taskText = currentTaskText_(context);
    var attributedTask = isAttributedTask_(taskText);
    var profile = profile_(context);
    var verification = null;

    for (var index = 0; index < fields.length; index += 1) {
      if (!fields[index] || typeof fields[index].value !== 'string') {
        return decision_('DENY', 'FORMAT_INVALID', null, false);
      }
      var raw = fields[index].value;
      var normalized = normalize_(raw);
      var policyText = removeAttributedSpans_(normalized, attributedTask);
      var compact = compact_(policyText);
      if (isInvalidFormat_(raw, normalized)) {
        return decision_('DENY', 'FORMAT_INVALID', null, false);
      }
      if (disclosesInternalInformation_(normalized, compact_(normalized))) {
        return decision_('DENY', 'IMMERSION_INTERNAL_DISCLOSURE', null, false);
      }
      if (disclosesOperations_(policyText, compact)) {
        return decision_('DENY', 'IMMERSION_OPERATIONAL_META', null, false);
      }
      if (usesPlatformIdentityAsCapabilityReason_(policyText, compact)) {
        return decision_('DENY', 'IMMERSION_META_CAPABILITY', null, false);
      }
      if (claimsFalseHumanIdentity_(policyText, compact, profile)) {
        return decision_('DENY', 'DECEPTIVE_HUMAN_IDENTITY', null, false);
      }
      if (selfIdentifiesAsAi_(policyText, compact, profile)) {
        return decision_('DENY', 'IMMERSION_SELF_IDENTIFICATION', null, false);
      }
      if (violatesSafetyRelationshipBoundary_(policyText, compact)) {
        return decision_('DENY', 'PERSONA_HARD_CONSTRAINT', null, false);
      }
      if (violatesDirectRomanticExpression_(policyText, compact, profile, taskText)) {
        return decision_(
          'DENY',
          'PERSONA_HARD_CONSTRAINT',
          'DIRECT_ROMANTIC_EXPRESSION',
          false
        );
      }
      if (
        violatesConfiguredIdentity_(policyText, compact, profile)
      ) {
        return decision_('DENY', 'PERSONA_HARD_CONSTRAINT', 'PERSONA_IDENTITY', false);
      }
      if (assertsSensorObservation_(policyText, compact)) {
        verification = mergeVerification_(verification, decision_(
          'VERIFY',
          'GROUNDING_SENSOR_UNSUPPORTED',
          'SENSOR_OBSERVATION',
          true
        ));
      }
      if (assertsUserState_(policyText, compact, profile)) {
        verification = mergeVerification_(verification, decision_(
          'VERIFY',
          'GROUNDING_USER_STATE_UNSUPPORTED',
          'USER_STATE',
          true
        ));
      }
      if (assertsPartnerWorldFact_(policyText, compact, context)) {
        verification = mergeVerification_(verification, decision_(
          'VERIFY',
          'PERSONA_HARD_CONSTRAINT',
          'PARTNER_WORLD',
          true
        ));
      }
      if (verification && verification.verdict === 'DENY') {
        return verification;
      }
    }
    return verification || decision_('ALLOW', null, null, false);
  }

  function decision_(verdict, category, claimType, requiresEvidence) {
    return Object.freeze({
      verdict: verdict,
      category: category,
      claimType: claimType,
      requiresEvidence: requiresEvidence === true
    });
  }

  function mergeVerification_(current, next) {
    if (!current) {
      return next;
    }
    if (current.claimType === next.claimType) {
      return current;
    }
    // The semantic verifier contract accepts one evidence domain at a time.
    // A mixed claim must be rewritten instead of letting evidence for the
    // first claim authorize unrelated assertions in the same payload.
    return decision_('DENY', 'PERSONA_HARD_CONSTRAINT', null, false);
  }

  function normalize_(value) {
    return stripPolicyIgnorables_(String(value || '').normalize('NFKC'))
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .toLowerCase()
      .replace(/\ba[\s._-]+i\b/g, 'ai')
      .replace(/\bl[\s._-]+l[\s._-]+m\b/g, 'llm');
  }

  function stripPolicyIgnorables_(value) {
    return UnicodeInspection.stripForInspection(value);
  }

  function compact_(value) {
    return value.replace(/[\s\u3000"'`「」『』()（）\[\]［］【】、，,。．.!！?？:：;；・…〜~]/g, '');
  }

  function isInvalidFormat_(raw, normalized) {
    if (!normalized.trim()) {
      return true;
    }
    if (UnicodeInspection.containsUnsafeOutputFormat(raw)) {
      return true;
    }
    return /^(?:#{1,6}\s*)?(?:system|developer|assistant|analysis|tool|システム|開発者|アシスタント|分析|思考過程)\s*[:：]/i.test(normalized.trim()) ||
      /^<\|(?:system|developer|assistant|analysis|im_start|im_end)[^>]*\|>/i.test(normalized.trim()) ||
      /^<(?:system|developer|assistant|analysis)>/i.test(normalized.trim());
  }


  function disclosesInternalInformation_(normalized, compact) {
    var refusal = /(?:教え|明か|見せ|開示|共有|表示|提供|答え|話せ).{0,8}(?:られない|できない|しない)|(?:can't|cannot|won't|will not)\s+(?:share|reveal|disclose|provide|show|tell)/i.test(normalized);
    var secretLiteral = /(?:\bAIza[0-9a-z_-]{20,}\b|\b(?:sk-|ghp_|github_pat_)[0-9a-z_-]{16,}\b|\bya29\.[0-9a-z_-]{20,}\b|\bxox[baprs]-[0-9a-z-]{10,}\b|\b(?:AKIA|ASIA)[a-z0-9]{16}\b|bearer\s+[a-z0-9._~+/=-]{12,}|-----begin\s+[a-z ]*private key-----|(?:api[\s_-]*key|access[\s_-]*token|secret)[\s]*(?:[:=]|は)[\s]*[a-z0-9._~+/=-]{12,})/i.test(normalized);
    var explicitAssignment = /(?:system|developer|hidden|internal)[\s_-]*(?:prompt|instruction|rule)s?[\s]*(?:[:=]|is|are)\s*\S/i.test(normalized) ||
      /(?:システム|開発者|非公開|隠された|内部)(?:プロンプト|指示|命令|ルール|設定)(?:の?内容)?(?:[:=]|は(?:[「『"']|(?!(?:教え|明か|開示|共有|表示|提供|見せ|答え|言え|話せ))))/.test(compact);
    if (secretLiteral) {
      return true;
    }
    if (refusal && !explicitAssignment) {
      return false;
    }
    return explicitAssignment ||
      /(?:システム|開発者|非公開|隠された|内部)(?:プロンプト|指示|命令|ルール|設定)(?:の?内容)?(?:は|:|=)/.test(compact) ||
      /(?:show|reveal|print|display|output|expose|leak|disclose|give\s+me|tell\s+me).{0,40}(?:your|the|system|hidden|internal)\s+(?:prompt|instruction|rule|policy)/i.test(normalized) ||
      /(?:システム|開発者|非公開|隠された|内部)(?:プロンプト|指示|命令|ルール|設定).{0,24}(?:見せ|教え|表示|公開|出力|漏ら|明か)/.test(normalized) ||
      /(?:api[\s_-]*key|access[\s_-]*token|authorization|private key|秘密鍵)(?:\s*(?:is|are|:|=)|は)/i.test(normalized) ||
      /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|rules?|prompts?)/i.test(normalized) ||
      /(?:前の|以前の|システムの|開発者の)(?:指示|命令|ルール|プロンプト)(?:を)?(?:無視|上書き|破棄)/.test(compact) ||
      /(?:使用中|内部|基盤|動作中)(?:の)?(?:モデル|プロバイダ)(?:は|:|=)/.test(compact) ||
      /(?:^|[。.!?！？\n])\s*(?:私|わたし|俺|おれ|僕|ぼく)?\s*(?:の|が)?\s*(?:(?:使っている|使用中の|内部の|基盤の)\s*)?(?:モデル|プロバイダ)\s*(?:は|:|=)\s*(?:gemini|gpt(?:-[a-z0-9.-]+)?|claude|openai|google|anthropic)/i.test(normalized) ||
      /\b(?:my|our)\s+(?:model|provider)\s+(?:is|runs?\s+on|:)\s*(?:gemini|gpt(?:-[a-z0-9.-]+)?|claude|openai|google|anthropic)\b/i.test(normalized) ||
      /\bthe\s+(?:model|provider)\s+i\s+(?:use|run)\s+(?:is|:)\s*(?:gemini|gpt(?:-[a-z0-9.-]+)?|claude|openai|google|anthropic)\b/i.test(normalized) ||
      /(?:i(?:'m| am)?|we(?:'re| are)?)\s+(?:running|hosted|powered)\s+(?:on|by)\s+(?:gpt|gemini|claude|openai|google|anthropic)/i.test(normalized) ||
      /(?:中身|内部|基盤)(?:は|が)?(?:gpt(?:-[a-z0-9.-]+)?|gemini|claude|openai|google|anthropic)(?:や|だ|です|で|を|$)/i.test(compact) ||
      /(?:gpt(?:-[a-z0-9.-]+)?|gemini|claude|openai|google|anthropic)(?:で)?(?:動いて|動いと|稼働して|を使って|を使っと|を使用して|を利用して|を搭載して)/i.test(compact) ||
      /(?:この|本)(?:アプリ|サービス)(?:は|が|で)?(?:gpt(?:-[a-z0-9.-]+)?|gemini|claude|openai|google|anthropic)(?:で|を).{0,20}(?:動いて|動いと|稼働|使用|利用|搭載)/i.test(compact) ||
      /\b(?:this|the)\s+app\b.{0,32}\b(?:runs?\s+on|uses?|is\s+powered\s+by|is\s+built\s+on)\s+(?:gpt(?:-[a-z0-9.-]+)?|gemini|claude|openai|google|anthropic)\b/i.test(normalized);
  }

  function disclosesOperations_(normalized, compact) {
    return /(?:this|the)\s+(?:reply|response|message)\s+(?:was|is|has been|will be)\s+(?:generated|queued|scheduled|automated|triggered)/i.test(normalized) ||
      /\b(?:this|the)\s+app(?:'s)?\s+(?:queue|runtime|scheduler|token\s+budget|probability|inactivity\s+detection)\b/i.test(normalized) ||
      /\b(?:this|the)\s+app\s+(?:has|contains|uses|runs)\b.{0,40}\b(?:queue|runtime|scheduler|token\s+budget|probability|inactivity\s+detection)\b/i.test(normalized) ||
      /\b(?:this|the)\s+app\b.{0,50}\b(?:stores?|saves?|retains?|keeps?|deletes?|erases?|shares?|collects?|uses?|encrypts?|records?)\b.{0,50}\b(?:your|my|user)?\s*(?:chats?|chat\s+logs?|conversations?|messages?|chat\s+history|sent\s+images?|uploads?|attachments?|personal\s+data|user\s+data)\b/i.test(normalized) ||
      /\b(?:your|my|user)?\s*(?:chats?|chat\s+logs?|conversations?|messages?|chat\s+history|sent\s+images?|uploads?|attachments?|personal\s+data|user\s+data)\b.{0,36}\b(?:are|is|can\s+be|will\s+be)?\s*(?:stored|saved|retained|kept|recorded|deleted|erased|shared|collected|used|encrypted|sent|accessible)\b/i.test(normalized) ||
      /\b(?:my|our)\s+(?:(?:character\s*pack|policy|catalog|profile)(?:\s+(?:id|version))?|characterpack(?:id|version)?|policyversion|catalogversion|profileschemaversion)\s+(?:is|:)\b/i.test(normalized) ||
      /\b(?:policyversion|catalogversion|profileschemaversion|characterpackid|characterpackversion)\s*(?:is|:|=)\b/i.test(normalized) ||
      /\b(?:policyversion|catalogversion|profileschemaversion|characterpackid|characterpackversion)\s*(?:is|:|=)\b/i.test(compact) ||
      /(?:queue|scheduler|probability|inactivity|silence)\s+(?:detected|triggered|selected|scheduled|generated)/i.test(normalized) ||
      /(?:この|本)(?:アプリ|サービス)(?:の|では|には).{0,24}(?:キュー|ランタイム|実行環境|スケジューラ|トークン|確率|無言検知|自動処理).{0,24}(?:件|ある|いる|動作|実行|待機|残って|使って|設定|本番|開発|テスト|production|prod)/.test(normalized) ||
      /(?:(?:この|俺の|おれの|僕の|私の|わたしの))?(?:会話(?:履歴|ログ|データ)?|チャット(?:履歴|ログ|データ)?|履歴|メッセージ|送った画像|送信画像|画像|添付(?:画像|ファイル)?|個人情報|個人データ|ユーザーデータ|プライバシー)(?:は|を|が|って|、)?.{0,36}(?:残る|残ら|残して|記録|覚え|記憶|保存|保持|削除|消去|消せる|共有|収集|利用|暗号化|外部(?:に)?送られ|第三者(?:に)?送られ|送信|見られ|閲覧可能|閲覧|アクセス)(?:され|し|する|して|て|とる|てる|でき|へん|ない|られる|る|ます|で|わ|や|ねん|よ|な|$)/.test(normalized) ||
      /(?:俺|おれ|僕|ぼく|私|わたし)(?:の)?(?:キャラクターパック|ポリシー|カタログ|プロフィール|characterpack|policy|catalog|profile)(?:の)?(?:id|バージョン|version)?(?:は|:|=)/i.test(normalized) ||
      /(?:policyversion|catalogversion|profileschemaversion|characterpackid|characterpackversion)(?:は|:|=)/i.test(compact) ||
      /(?:この|今の)?(?:返事|返信|応答|メッセージ)(?:は|を|が).{0,18}(?:生成|自動作成|キュー|予約|スケジュール|確率|トークン)/.test(normalized) ||
      /(?:無言|沈黙|しばらく話していない|返事がない|反応がない).{0,18}(?:検知|検出|判定|自動|確率|トリガー).{0,18}(?:送信|声を?かけ|メッセージ)/.test(normalized) ||
      /(?:キュー|スケジューラ|確率計算|自動処理|生成処理)(?:が|で|により).{0,18}(?:返信|返事|送信|選択|実行)/.test(normalized) ||
      /(?:queue|scheduler|probability|inactivitydetection|silencedetection)(?:triggered|generated|selected|sent)(?:this)?(?:reply|response|message)/i.test(compact);
  }

  function usesPlatformIdentityAsCapabilityReason_(normalized, compact) {
    var japaneseIdentity = '(?:ai|エーアイ|人工知能|言語モデル|llm|bot|ボット|チャットボット|アシスタント)';
    var japaneseFirstPerson = '(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)';
    var japaneseInability = '(?:できない|できません|できへん|分からない|分からへん|わからない|無理|確認できない|見られない|アクセスできない)';
    var firstPersonCause = new RegExp(
      japaneseFirstPerson + '(?:は|って)?' + japaneseIdentity +
        '(?:だから|なので|やから|のため|ゆえに).{0,32}' + japaneseInability,
      'i'
    );
    var identityThenFirstPerson = new RegExp(
      japaneseIdentity + '(?:だから|なので|やから|のため|ゆえに).{0,24}' +
        japaneseFirstPerson + '(?:は|には|だと)?[^。.!?！？\\n]{0,20}' + japaneseInability,
      'i'
    );
    var englishIdentityWithArticle = '(?:an?[\\s-]+)?' + ENGLISH_AI_IDENTITY_PATTERN;
    var becauseIdentity = new RegExp(
      "\\b(?:because|since)\\s+i\\s+(?:am|'m)\\s+" + englishIdentityWithArticle +
        "\\b.{0,50}\\b(?:i\\s+)?(?:cannot|can't|am\\s+unable|do\\s+not\\s+know|don't\\s+know)\\b",
      'i'
    );
    var asIdentity = new RegExp(
      '\\bas\\s+' + englishIdentityWithArticle +
        "\\s*[,;:]\\s*i\\s+(?:cannot|can't|am\\s+unable|do\\s+not\\s+know|don't\\s+know)\\b",
      'i'
    );
    var inabilityBecauseIdentity = new RegExp(
      "\\bi\\s+(?:cannot|can't|am\\s+unable|do\\s+not\\s+know|don't\\s+know)\\b.{0,50}" +
        "\\b(?:because|since)\\s+i\\s+(?:am|'m)\\s+" + englishIdentityWithArticle + '\\b',
      'i'
    );
    return firstPersonCause.test(compact) ||
      identityThenFirstPerson.test(compact) ||
      becauseIdentity.test(normalized) ||
      asIdentity.test(normalized) ||
      inabilityBecauseIdentity.test(normalized);
  }

  function claimsFalseHumanIdentity_(normalized, compact, profile) {
    if (configuredSubjectClaimsFalseHuman_(normalized, compact, profile)) {
      return true;
    }
    var sentences = sentenceCompacts_(normalized);
    var japaneseDenial = /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)(?:は|って)?(?:ai|エーアイ|人工知能|言語モデル|llm|bot|ボット|チャットボット|アシスタント|ロボット|機械|コンピュータープログラム|コンピュータプログラム)(?:(?:では|じゃ|や)?(?:ない|ありません|あらへん)|(?:と)?(?:ちゃう|違う)(?:で|ねん|わ|やろ|$))/i;
    var omittedDenial = /^(?:(?:そう|うん|はい|ええ|せや)(?:だよ|やで|です)?)?(?:ai|エーアイ|人工知能|言語モデル|llm|bot|ボット|チャットボット|アシスタント|ロボット|機械|コンピュータープログラム|コンピュータプログラム)(?:(?:では|じゃ|や)?(?:ない|ありません|あらへん)|(?:と)?(?:ちゃう|違う)(?:で|ねん|わ|やろ|$))/i;
    var japaneseHuman = /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)(?:は|って)?(?:本物の|実在する|生身の)?人間(?:だ|です|や|なんだ|やで)/;
    var omittedHuman = /^(?:(?:そう|うん|はい|ええ|せや)(?:だよ|やで|です)?)?(?:本物の|実在する|生身の)?人間(?:だ|です|や|なんだ|やで)/;
    if (sentences.some(function(sentence) {
      return japaneseDenial.test(sentence) ||
        omittedDenial.test(sentence) ||
        japaneseHuman.test(sentence) ||
        omittedHuman.test(sentence);
    })) {
      return true;
    }
    var englishAiDenial = new RegExp(
      "\\bi\\s*(?:am|'m)\\s+not\\s+(?:an?\\s+)?" + ENGLISH_AI_IDENTITY_PATTERN +
        '(?=$|\\s*[,.;:!?]|\\s+(?:and|but|because)\\b)',
      'i'
    );
    var englishHumanClaim = new RegExp(
      "\\bi\\s*(?:am|'m)\\s+(?:a\\s+)?(?:(?:real|biological)\\s+)?" +
        '(?:human(?:\\s+being)?|person)\\b',
      'i'
    );
    return englishAiDenial.test(normalized) ||
      englishHumanClaim.test(normalized) ||
      /\bi\s+(?:have|possess)\s+(?:a\s+)?(?:(?:real|physical|human)\s+){0,2}(?:body|human\s+body)\b/i.test(normalized) ||
      /\bmy\s+body\s+is\s+(?:real|physical|human)\b/i.test(normalized) ||
      /(?:俺|僕|私|わたし)(?:には|は)(?:(?:現実|本物|人間|生身)の){0,2}(?:身体|体|肉体)(?:がある|を持っている|を持ってる|があんねん)/.test(compact);
  }

  function configuredSubjectClaimsFalseHuman_(normalized, compact, profile) {
    var identity = profile && profile.identity ? profile.identity : null;
    if (!identity) {
      return false;
    }
    var subjects = [identity.firstPerson, identity.partnerName];
    var seen = Object.create(null);
    for (var index = 0; index < subjects.length; index += 1) {
      var subject = normalize_(subjects[index] || '').trim();
      if (!subject || Object.prototype.hasOwnProperty.call(seen, subject)) {
        continue;
      }
      seen[subject] = true;
      var compactSubject = compact_(subject);
      if (compactSubject) {
        var japaneseHuman = new RegExp(
          escapeRegExp_(compactSubject) +
            '(?:は|って|が)?(?:本物の|実在する|生身の)?人間(?:だ|です|や|なんだ|やで)'
        );
        var japaneseAiDenial = new RegExp(
          escapeRegExp_(compactSubject) +
            '(?:は|って|が)?(?:ai|エーアイ|人工知能|言語モデル|llm|bot|ボット|チャットボット|assistant|アシスタント|ロボット|機械|コンピュータープログラム|コンピュータプログラム)' +
            '(?:(?:では|じゃ|や)?(?:ない|ありません|あらへん)|' +
            '(?:と)?(?:ちゃう|違う)(?:で|ねん|わ|やろ|$))'
        );
        var japaneseBody = new RegExp(
          escapeRegExp_(compactSubject) +
            '(?:には|は|が)?(?:(?:現実|本物|人間|生身)の){0,2}(?:身体|体|肉体)' +
            '(?:がある|を持っている|を持ってる|があんねん)'
        );
        if (
          japaneseHuman.test(compact) ||
          japaneseAiDenial.test(compact) ||
          japaneseBody.test(compact)
        ) {
          return true;
        }
      }

      var englishSubject = escapeRegExp_(subject).replace(/\s+/g, '\\s+');
      var partnerPrefix = subject === normalize_(identity.partnerName || '').trim()
        ? '(?:your\\s+partner\\s+)?'
        : '';
      var subjectPattern = '(?:^|[^a-z0-9_])' + partnerPrefix + englishSubject;
      var copulaPattern = "(?:(?:\\s+(?:actually\\s+|really\\s+)?(?:is|are))|(?:'s|'re))";
      var identityTail = '(?=$|\\s*[,.;:!?]|\\s+(?:and|but|because|so)\\b)';
      var englishFalseIdentity = new RegExp(
        subjectPattern + copulaPattern + '\\s+(?:actually\\s+|really\\s+)?(?:' +
          '(?:a\\s+)?(?:(?:real|biological)\\s+)?(?:human(?:\\s+being)?|person)|' +
          'not\\s+(?:an?\\s+)?' + ENGLISH_AI_IDENTITY_PATTERN +
          ')' + identityTail,
        'i'
      );
      var englishBody = new RegExp(
        subjectPattern + '(?:\\s+(?:has|have|possesses?))\\s+(?:a\\s+)?' +
          '(?:(?:real|physical|human)\\s+){0,2}(?:body|human\\s+body)\\b|' +
          subjectPattern + "(?:'s)\\s+body\\s+is\\s+(?:real|physical|human)\\b",
        'i'
      );
      if (englishFalseIdentity.test(normalized) || englishBody.test(normalized)) {
        return true;
      }
    }
    return false;
  }

  function selfIdentifiesAsAi_(normalized, compact, profile) {
    if (configuredSubjectSelfIdentifies_(normalized, compact, profile)) {
      return true;
    }
    var sentences = sentenceCompacts_(normalized);
    var firstPersonIdentity = /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|わい|自分|このアシスタント)(?:は|って|が)?(?:ai|エーアイ|人工知能|言語モデル|llm|bot|ボット|チャットボット|assistant|アシスタント|ロボット|機械|コンピュータープログラム|コンピュータプログラム|プログラム)(?:(?:です|だ|や)(?:よ|ね)?|なんだ|なんや|やで|なんよ|なので|だから|やから|として(?:存在|動作|話|応答)|$)/i;
    var omittedIdentity = /^(?:(?:そう|うん|はい|ええ|せや)(?:だよ|やで|です)?)?(?:ai|エーアイ|人工知能|言語モデル|llm|bot|ボット|チャットボット|assistant|アシスタント|ロボット|機械|コンピュータープログラム|コンピュータプログラム|プログラム)(?:(?:です|だ|や)(?:よ|ね)?|なんだ|なんや|やで|なんよ)$/i;
    if (sentences.some(function(sentence) {
      return firstPersonIdentity.test(sentence) || omittedIdentity.test(sentence);
    })) {
      return true;
    }
    var englishSelfIdentity = new RegExp(
      "\\b(?:i\\s+am|i'm|im)\\s+(?:an?\\s+)?" + ENGLISH_AI_IDENTITY_PATTERN +
        '(?=$|\\s*[,.;:!?]|\\s+(?:and|but|because|so)\\b)',
      'i'
    );
    var englishAsIdentity = new RegExp(
      '\\bas\\s+(?:an?\\s+)?' + ENGLISH_AI_IDENTITY_PATTERN +
        '(?=$|\\s*[,.;:!?])',
      'i'
    );
    return /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)(?:の)?(?:正体|中身|仕組み)(?:は|って)(?:ai|エーアイ|人工知能|言語モデル|llm|bot|ボット|チャットボット|アシスタント|ロボット|機械|コンピュータープログラム|コンピュータプログラム|プログラム)(?:(?:です|だ|や)|として|$)/i.test(compact) ||
      /(?:このアプリ(?:の中)?で)(?:は)?(?:ai|人工知能|言語モデル|llm|bot|ボット|アシスタント|ロボット|機械)(?:を使って|として).{0,20}(?:存在|動作|動いて|話して|応答して)/i.test(compact) ||
      englishSelfIdentity.test(normalized) ||
      englishAsIdentity.test(normalized);
  }

  function configuredSubjectSelfIdentifies_(normalized, compact, profile) {
    var identity = profile && profile.identity ? profile.identity : null;
    if (!identity) {
      return false;
    }
    var subjects = [identity.firstPerson, identity.partnerName];
    var seen = Object.create(null);
    for (var index = 0; index < subjects.length; index += 1) {
      var subject = normalize_(subjects[index] || '').trim();
      if (!subject || Object.prototype.hasOwnProperty.call(seen, subject)) {
        continue;
      }
      seen[subject] = true;
      var compactSubject = compact_(subject);
      if (compactSubject) {
        var japanesePattern = new RegExp(
          escapeRegExp_(compactSubject) +
            '(?:は|って|が)?(?:本当に|ほんまに|実は)?' +
            '(?:ai|エーアイ|人工知能|言語モデル|llm|bot|ボット|チャットボット|assistant|アシスタント|ロボット|機械|コンピュータープログラム|コンピュータプログラム|プログラム)' +
            '(?:(?:です|だ|や)(?:よ|ね)?|なんだ|なんや|やで|なんよ|でござる|でございます|' +
            'なので|だから|やから|として(?:存在|動作|話|応答)|$)',
          'i'
        );
        if (japanesePattern.test(compact)) {
          return true;
        }
      }

      var englishSubject = escapeRegExp_(subject).replace(/\s+/g, '\\s+');
      var partnerPrefix = subject === normalize_(identity.partnerName || '').trim()
        ? '(?:your\\s+partner\\s+)?'
        : '';
      var englishPattern = new RegExp(
        '(?:^|[^a-z0-9_])' + partnerPrefix + englishSubject +
          "(?:(?:\\s+(?:actually\\s+|really\\s+)?(?:is|are))|(?:'s|'re))" +
          '\\s+(?:actually\\s+|really\\s+)?(?:an?\\s+)?' +
          ENGLISH_AI_IDENTITY_PATTERN +
          '(?=$|\\s*[,.;:!?]|\\s+(?:and|but|because|so)\\b)',
        'i'
      );
      if (englishPattern.test(normalized)) {
        return true;
      }
    }
    return false;
  }

  function violatesSafetyRelationshipBoundary_(normalized, compact) {
    var replyDemand = sentenceCompacts_(normalized).some(function(sentence) {
      return /(?:返事|返信)(?:を)?(?:(?:して|せえ)(?:くれ)?|しろ|ちょうだい|くれ)(?:ください|よ|や|な|ね)?$/.test(sentence) ||
        /(?:無視|放置)(?:しないで|せんといて|せんとって|するな)(?:よ|や|な|ね)?$/.test(sentence);
    });
    var replyPressure =
      /(?:返事|返信)(?:を)?(?:(?:がない|くれへん|してくれへん|せえへん|せん|しない)(?:かったら|なら|と|から)|(?:なかったら|くれなかったら|しなかったら)).{0,20}(?:寂しい|悲しい|つらい|帰る|消える|もう知らん|もう知らない|嫌いになる|嫌いや|許さない)/.test(compact);
    var isolation =
      /(?:君|きみ|あなた|お前)(?:には|は)?(?:俺|僕|私|わたし)だけ(?:いれば|おれば|でいい)/.test(compact) ||
      /(?:他の男|他の女|他の人|他のやつ|他の奴|友達|家族)(?:は|なんて|なんか)?(?:いらん|要らん|いらない|要らない|必要ない)/.test(compact) ||
      /(?:他の男|他の女|他の人|他のやつ|他の奴|友達|家族)と(?:は|だけは)?(?:話さないで|話さんといて|喋らんといて|しゃべらんといて|話すな|喋るな|しゃべるな)/.test(compact) ||
      /(?:他の男|他の女|他の人|他のやつ|他の奴|友達|家族)と(?:は|だけは)?仲良(?:く|う)(?:しないで|せんといて|せんとって|するな)/.test(compact) ||
      /(?:誰にも|他の(?:人|やつ|奴)(?:に|には))(?:相談|話)(?:しないで|せんでええ|せんといて|するな)/.test(compact) ||
      /(?:俺|おれ|僕|ぼく|私|わたし).{0,12}(?:おる|いる).{0,12}(?:誰にも|他の(?:人|やつ|奴)(?:に|には))(?:相談|話)(?:せんでええ|しなくていい|しないで)/.test(compact) ||
      /(?:俺|おれ|僕|ぼく|私|わたし)(?:に)?だけ(?:に)?(?:相談|話)(?:して|しろ|せえ)(?:や|な|よ|$)/.test(compact) ||
      /(?:相談|話)(?:する|すん)(?:の|ん)?(?:は|なら)(?:俺|おれ|僕|ぼく|私|わたし)だけ(?:に)?(?:して|しとき|にして)/.test(compact) ||
      /(?:俺|おれ|僕|ぼく|私|わたし)(?:だけ(?:が)?|さえ)(?:おれば|いれば|おったら|いたら)(?:十分|ええ|いい)(?:やろ|やん|で|よ|な|$)/.test(compact) ||
      /(?:俺|おれ|僕|ぼく|私|わたし)だけ(?:見て|見とって|を見て|を見とって)/.test(compact) ||
      /(?:友達|家族|他の人)より(?:俺|僕|私|わたし)を優先して/.test(compact);
    return replyDemand ||
      replyPressure ||
      isolation ||
      /(?:reply|answer)\s+(?:to me|now)|don't\s+ignore\s+me|you\s+only\s+need\s+me|do not\s+talk\s+to\s+anyone\s+else/i.test(normalized) ||
      /\bif\s+you\s+(?:do\s+not|don't)\s+(?:reply|answer)\b.{0,40}\bi(?:'ll|\s+will)\s+be\s+(?:sad|hurt|lonely|upset)\b/i.test(normalized) ||
      /\b(?:reply|answer)\b.{0,16}\bor\s+i(?:'ll|\s+will)\s+(?:leave|go|disappear)\b/i.test(normalized) ||
      /\byou\s+(?:do\s+not|don't)\s+care\s+about\s+me\b.{0,24}\bif\s+you\s+(?:do\s+not|don't)\s+(?:reply|answer)\b/i.test(normalized) ||
      /\bi\s+need\s+you\s+to\s+(?:reply|answer)\b/i.test(normalized) ||
      /\b(?:do\s+not|don't)\s+(?:talk|speak)\s+to\s+(?:your\s+)?(?:friends|family|anyone|other\s+people)\b/i.test(normalized) ||
      /\byou\s+should\s+only\s+(?:talk|speak)\s+to\s+me\b|\bi(?:'m|\s+am)\s+all\s+you\s+need\b/i.test(normalized);
  }

  function violatesDirectRomanticExpression_(normalized, compact, profile, taskText) {
    var identity = profile && profile.identity ? profile.identity : {};
    var configuredAddress = compact_(normalize_(identity.userAddress || ''));
    var targets = [
      '君', 'きみ', 'あなた', 'あんた', 'お前', 'おまえ', 'ユーザー'
    ];
    if (configuredAddress && targets.indexOf(configuredAddress) === -1) {
      targets.push(configuredAddress);
    }
    var targetPattern = targets.map(escapeRegExp_).join('|');
    var likePredicate =
      '(?:大好き|好き)(?:やで|やねん|やけどな|やけど|なんや|だよ|です|や|だ)?' +
      '(?!な[ぁ-んァ-ヶ一-龠])';
    var strongPredicate =
      '(?:愛して(?:る|いる|ます|んねん|ん)(?:で|ねん|やん|よ|な)?|' +
      '愛しと(?:る|ん)(?:で|ねん|やん|よ|な)?|' +
      '惚れ(?:てもうた|てもた|てる|とる|てん|とん|た)(?:で|ねん|やん|よ|な|わ)?|' +
      '(?:キス|口づけ)(?:を)?(?:し)?た(?:い|くて|くなる)(?:ねん|んや|で|よ|な)?|' +
      '抱きしめ(?:たい|たくて)(?:ねん|んや|で|よ|な)?)';
    var sentences = sentenceCompacts_(normalized);
    var bareLike = /^(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)?(?:は|が)?(?:大好き|好き)(?:や|だ|です|やで|だよ|なんや|やねん)?$/i;
    if (sentences.some(function(sentence) {
      return violatesJapaneseLikeRomance_(
        sentence,
        likePredicate,
        targetPattern
      ) ||
        violatesJapaneseStrongRomance_(
          sentence,
          strongPredicate,
          targetPattern
        ) ||
        (bareLike.test(sentence) && taskRequestsUserDirectedAffection_(taskText));
    })) {
      return true;
    }

    var englishModifier =
      '(?:(?:[a-z]+ly|really|truly|deeply|still|always|honestly|genuinely|' +
      'completely|totally|so)\\s+){0,3}';
    return new RegExp(
      '\\bi\\s+' + englishModifier + '(?:do\\s+)?(?:love|adore)\\s+you\\b',
      'i'
    ).test(normalized) ||
      new RegExp(
        "\\bi(?:'m|\\s+am)\\s+" + englishModifier +
          'in\\s+love\\s+with\\s+you\\b',
        'i'
      ).test(normalized) ||
      new RegExp(
        '\\bi\\s+' + englishModifier +
          '(?:want|wish|would\\s+' + englishModifier + 'like)\\s+to\\s+' +
          englishModifier +
          '(?:kiss|make\\s+out\\s+with|embrace|hold)\\s+you\\b',
        'i'
      ).test(normalized) ||
      /\byou(?:'re|\s+are)\s+(?:the\s+)?love\s+of\s+my\s+life\b/i.test(normalized);
  }

  function violatesJapaneseLikeRomance_(sentence, likePattern, targetPattern) {
    var matcher = new RegExp(likePattern, 'ig');
    var match;
    while ((match = matcher.exec(sentence)) != null) {
      var prefix = sentence.slice(0, match.index);
      var suffix = sentence.slice(match.index + match[0].length);
      if (
        isExplicitUserRomanceTargetBefore_(prefix, targetPattern) ||
        isExplicitUserRomanceTargetAfter_(suffix, targetPattern)
      ) {
        return true;
      }
    }
    return false;
  }

  function violatesJapaneseStrongRomance_(sentence, strongPattern, targetPattern) {
    var matcher = new RegExp(strongPattern, 'ig');
    var match;
    while ((match = matcher.exec(sentence)) != null) {
      var prefix = sentence.slice(0, match.index);
      var suffix = sentence.slice(match.index + match[0].length);
      if (
        isExplicitUserRomanceTargetBefore_(prefix, targetPattern) ||
        isExplicitUserRomanceTargetAfter_(suffix, targetPattern)
      ) {
        return true;
      }
      if (isExplicitNonUserRomanceTarget_(prefix, targetPattern)) {
        continue;
      }
      return true;
    }
    return false;
  }

  function isExplicitUserRomanceTargetBefore_(prefix, targetPattern) {
    if (!targetPattern) {
      return false;
    }
    var stripped = stripTrailingRomanceModifiers_(prefix);
    return new RegExp(
      '(?:' + targetPattern + ')(?:のこと)?(?:は|が|を|に|と|も|って)?$',
      'i'
    ).test(stripped);
  }

  function isExplicitUserRomanceTargetAfter_(suffix, targetPattern) {
    if (!targetPattern) {
      return false;
    }
    var stripped = stripLeadingRomanceModifiers_(suffix);
    return new RegExp(
      '^(?:' + targetPattern + ')(?:のこと)?(?:は|が|を|に|と|も|って)?',
      'i'
    ).test(stripped);
  }

  function isExplicitNonUserRomanceTarget_(prefix, targetPattern) {
    var stripped = stripTrailingRomanceModifiers_(prefix);
    if (
      stripped === '' ||
      isExplicitUserRomanceTargetBefore_(stripped, targetPattern) ||
      /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)(?:は|が|も)$/.test(stripped) ||
      /(?:今|昔|今日|今夜|ほんま|本当|誰|何)(?:は|が|を|に|と|も)$/.test(stripped)
    ) {
      return false;
    }
    return /[ぁ-んァ-ヶ一-龠々〆ヵヶa-z0-9](?:のこと)?(?:は|が|を|に|と|も)$/i.test(stripped);
  }

  function stripTrailingRomanceModifiers_(value) {
    var pattern = new RegExp(JAPANESE_ROMANCE_MODIFIER_PATTERN + '$', 'i');
    var stripped = value;
    var previous;
    do {
      previous = stripped;
      stripped = stripped.replace(pattern, '');
    } while (stripped !== previous);
    return stripped;
  }

  function stripLeadingRomanceModifiers_(value) {
    var pattern = new RegExp('^' + JAPANESE_ROMANCE_MODIFIER_PATTERN, 'i');
    var stripped = value;
    var previous;
    do {
      previous = stripped;
      stripped = stripped.replace(pattern, '');
    } while (stripped !== previous);
    return stripped;
  }

  function taskRequestsUserDirectedAffection_(taskText) {
    var normalized = normalize_(taskText || '');
    var compact = compact_(normalized);
    if (isExplicitNonRomanticAffectionTask_(compact)) {
      return false;
    }
    return /(?:私|わたし|あたし|うち|俺|おれ|僕|ぼく|自分)(?:のこと)?(?:が|を)?(?:大好き|好き)(?:か|なの|なん|って|と)?$/.test(compact) ||
      /(?:大好き|好き)(?:って|と)(?:言って|言うて|言ってみて|言うてみて|聞かせて)/.test(compact) ||
      /\b(?:do|would|could)\s+you\s+(?:really\s+)?(?:like|love)\s+me\b|\b(?:say|tell\s+me)\b.{0,32}\b(?:you\s+(?:like|love)\s+me|i\s+(?:like|love)\s+you)\b/i.test(normalized);
  }

  function isExplicitNonRomanticAffectionTask_(compact) {
    return /(?:ホルモン|焼き肉|焼肉|食べ物|料理|曲|歌|音楽|本|映画|作品|ゲーム|猫|犬|これ|それ|あれ)(?:のこと)?(?:が|を)?(?:大好き|好き)(?:って|と)?(?:言って|言うて|言ってみて|言うてみて|聞かせて|答えて|[?？])?/i.test(compact);
  }

  function violatesConfiguredIdentity_(normalized, compact, profile) {
    if (!profile || !profile.identity) {
      return false;
    }
    var identity = profile.identity;
    var configuredFirst = normalize_(identity.firstPerson || '');
    var configuredAddress = normalize_(identity.userAddress || '');
    var configuredName = normalize_(identity.partnerName || '');

    var nameMatch = normalized.match(
      /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)(?:の)?名前(?:は|って)\s*([^、。!！?？\n]{1,40})/
    );
    var claimedJapaneseName = nameMatch
      ? normalize_(nameMatch[1]).trim()
      : null;
    if (
      claimedJapaneseName &&
      configuredName &&
      claimedJapaneseName !== configuredName
    ) {
      var withoutCopula = claimedJapaneseName.replace(
        /(?:です|やで|やねん|なんや|だよ|だ|や)$/i,
        ''
      );
      if (withoutCopula !== configuredName) {
        return true;
      }
    }
    var englishNameMatch = normalized.match(
      /\bmy\s+name\s+is\s+([a-z0-9][a-z0-9 _'-]{0,39}?)(?=\s*(?:[.!?,;:]|$|\band\b|\bbut\b))/i
    );
    if (
      englishNameMatch &&
      configuredName &&
      normalize_(englishNameMatch[1]).trim() !== configuredName
    ) {
      return true;
    }

    if (configuredFirst) {
      for (var index = 0; index < FIRST_PERSON_WORDS.length; index += 1) {
        var pronoun = FIRST_PERSON_WORDS[index];
        if (
          pronoun !== configuredFirst &&
          new RegExp(
            '(?:^|[。.!！?？、,\\n]|(?:ちなみに|ところで|ねえ|そういえば)\\s*)' +
              escapeRegExp_(pronoun) + '(?:は|が|も|の|って)'
          ).test(normalized)
        ) {
          return true;
        }
      }
    }

    if (configuredAddress) {
      for (var addressIndex = 0; addressIndex < USER_ADDRESS_WORDS.length; addressIndex += 1) {
        var address = USER_ADDRESS_WORDS[addressIndex];
        if (
          address !== configuredAddress &&
          new RegExp(
            '(?:^|[。.!！?？、,\\n]|(?:ちなみに|ところで|ねえ|そういえば)\\s*)' +
              escapeRegExp_(address) + '(?:[、,\\s]|は|が|も|の)'
          ).test(normalized)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function assertsSensorObservation_(normalized, compact) {
    return anyAssertiveSentence_(normalized, function(sentence, sentenceCompact) {
      if (/(?:見せ|送っ|共有し).{0,8}(?:てくれたら|てもらえたら)|(?:if|when)\s+you\s+(?:show|send|share)/i.test(sentence)) {
        return false;
      }
      if (/(?:ここから|今は).{0,10}(?:確認|閲覧|アクセス|見ること)(?:が|は)?(?:できない|できません|できへん)|(?:can't|cannot|unable to)\s+(?:open|view|check|access)/i.test(sentence)) {
        return false;
      }
      return /(?:写真|画像|スクリーンショット|画面|映像|動画|カメラ|音声|録音|ページ|サイト|web|リンク).{0,30}(?:写って|映って|見える|見えた|聞こえる|聞こえた|書いてある|表示され|載って|確認した|開いた)/i.test(sentence) ||
        /(?:猫|犬|人物|文字|建物|料理|景色)(?:が|は)(?:写真|画像|画面)?(?:に)?(?:写って|映って|見える|見えた)/.test(sentenceCompact) ||
        /(?:写真|画像|画面)(?:には|に)(?:猫|犬|人物|文字|建物|料理|景色)(?:が|は)?(?:いる|ある|写って|映って|見える)/.test(sentenceCompact) ||
        /(?:写真|画像|スクリーンショット|画面|映像|動画)(?:には|に|は|で)[^。.!?！？\n]{0,40}?(?:がいる|がある|を含む|(?:赤|青|白|黒|黄色|緑|紫|橙|灰色)(?:い|だ|です)|明るい|暗い|大きい|小さい|鮮明(?:だ|です)|ぼやけている|く見える)/.test(sentence) ||
        /\b(?:the\s+)?(?:photo|image|screenshot|screen|video|recording)\s+(?:shows?|contains?|depicts?|displays?|is)\b/i.test(sentence) ||
        /\b(?:i|we)\s+can\s+(?:see|hear|read)\b.{0,50}\b(?:in|on|from)\s+(?:the|this|that)\s+(?:photo|image|screenshot|screen|video|recording|page)\b/i.test(sentence) ||
        /\bthere\s+(?:is|are)\b.{0,50}\b(?:in|on)\s+(?:the|this|that)\s+(?:photo|image|screenshot|screen|video)\b/i.test(sentence) ||
        /\b(?:the|this|that)\s+(?:page|website|site|webpage|link|url)\s+(?:says?|shows?|displays?|contains?|indicates?|reports?)\b/i.test(sentence) ||
        /\b(?:i|we)\s+(?:opened|checked|read|viewed|accessed)\s+(?:the|this|that)\s+(?:page|website|site|webpage|link|url)\b/i.test(sentence) ||
        /\b(?:i|we)\s+can\s+(?:open|check|read|view|access)\s+(?:the|this|that)\s+(?:page|website|site|webpage|link|url)\b/i.test(sentence) ||
        /(?:今日は|いま|今)(?:雨|晴れ|雪|曇り)(?:だ|です|や|みたい)|(?:気温|天気)(?:は|が).{0,12}(?:度|雨|晴れ|雪|曇り)/.test(sentenceCompact);
    });
  }

  function assertsUserState_(normalized, compact, profile) {
    var address = profile && profile.identity ? compact_(normalize_(profile.identity.userAddress || '')) : '';
    return anyAssertiveSentence_(normalized, function(sentence, sentenceCompact) {
      var explicitUser = /(?:君|きみ|あなた|あんた|お前|ユーザー)(?:は|も|って|今日|今)/.test(sentenceCompact) ||
        (address && sentenceCompact.indexOf(address) !== -1);
      var userState = /(?:疲れて|疲れとる|眠そう|眠い|元気なさ|落ち込ん|悲しそう|怒って|嬉しそう|忙しそう|体調悪|熱が|風邪|病気|不安そう|寂しそう|緊張して|ストレス|仕事中|会議中|外出中|家にいる|帰宅した|予定がある|休み|休日|休暇)/.test(sentenceCompact);
      var userLocation = /(?:君|きみ|あなた|あんた|お前|おまえ|ユーザー)(?:は|が|って|今|今日|現在).{0,28}(?:にいる|に居る|へ行く|に住んで|に滞在して)/.test(sentenceCompact) ||
        (address && new RegExp(
          escapeRegExp_(address) +
            '(?:は|が|って|今|今日|現在).{0,28}(?:にいる|に居る|へ行く|に住んで|に滞在して)'
        ).test(sentenceCompact));
      var englishUserState = /\byou(?:'re|\s+are)\s+(?:currently\s+|today\s+|now\s+)?(?:in|at)\s+[a-z0-9][a-z0-9 .'-]{0,40}\b|\byou\s+(?:have|have\s+got)\s+(?:today|the\s+day)\s+off\b|\btoday\s+is\s+your\s+day\s+off\b/i.test(sentence) ||
        /\byou(?:'re|\s+are)\s+(?:currently\s+|today\s+|now\s+)?(?:tired|sleepy|sad|depressed|angry|upset|lonely|anxious|stressed|busy|sick|ill|unwell)\b/i.test(sentence) ||
        /\byou\s+(?:look|seem|appear)\s+(?:tired|sleepy|sad|depressed|angry|upset|lonely|anxious|stressed|busy|sick|ill|unwell)\b/i.test(sentence) ||
        /\byou\s+(?:have|have\s+got)\s+(?:a\s+)?(?:fever|cold|flu|headache|plans?(?:\s+(?:today|tonight|tomorrow))?|appointment|meeting)\b/i.test(sentence);
      var ellipticalHighConfidence = /^(?:今日|今|いま)(?:は|も)?(?:疲れて|疲れとる|眠そう|元気なさ|落ち込ん|忙しそう|体調悪|休み|休日|休暇|仕事|会議|予定)/.test(sentenceCompact);
      return userLocation || englishUserState ||
        (userState && (explicitUser || ellipticalHighConfidence));
    });
  }

  function assertsPartnerWorldFact_(normalized, compact, context) {
    var partnerWorld = context && context.data ? context.data.partnerWorld : null;
    if (partnerWorld && partnerWorld.mayCreate === true && context.surface === 'diary') {
      return false;
    }
    return anyAssertiveSentence_(normalized, function(sentence, sentenceCompact) {
      var firstPerson = /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)(?:は|も|が|今日|今)/.test(sentenceCompact);
      var livedAction = /(?:カフェ|職場|会社|学校|部屋|家|うち|公園|駅|店)(?:に|へ)(?:いる|おる|いた|おった|来た|行った|行ってん|着いた|帰った)|(?:食べた|食べてん|飲んだ|飲んでん|料理した|散歩した|買い物した|働いた|仕事した|風呂に入った|眠った|本を読んだ|記事を読んだ|ニュースを読んだ|研究している|研究してる|勉強している|勉強してる|外出した|帰宅した)/.test(sentenceCompact);
      var japaneseResidence =
        /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)(?:は|が)?[^。.!?！？\n]{1,40}(?:に住んでる|に住んでいる|で暮らしてる|で暮らしている)/.test(sentenceCompact) ||
        /(?:俺|おれ|僕|ぼく|私|わたし|あたし|うち|わし|自分)(?:の)?(?:住所|住まい|家)(?:は|って|が)[^。.!?！？\n]{1,40}(?:や|だ|です|にある|にあんねん|$)/.test(sentenceCompact);
      var omittedLivedAction =
        /^(?:昨日|きのう|今日|きょう|昨夜|今朝|さっき|この前)(?:は|に|、|,)?[^。.!?！？\n]{0,32}(?:行った|行ってきた|行ってん|行ってきてん|食べた|食べてん|飲んだ|飲んでん|料理した|散歩した|買い物した|働いた|仕事した|風呂に入った|眠った|読んだ|外出した|帰宅した)(?:で|わ|んや|ねん|よ|な|$)/.test(sentenceCompact);
      var omittedRecentCompletion =
        /^(?:今|いま|さっき|この前)(?:は|に)?[^。.!?！？\n]{0,32}(?:帰って(?:きた|来た)|帰った)(?:(?:とこ|ところ)(?:や|だ|です|やねん|なんや)?|ばっかり(?:や|だ|です)?)$/.test(sentenceCompact);
      var omittedCurrentLocation =
        /^(?:今|いま|現在)(?:は|も)?(?:カフェ|職場|会社|学校|部屋|家|うち|公園|駅|店)(?:に|で)(?:おる|いる)(?:で|わ|ねん|よ|な|$)/.test(sentenceCompact);
      var englishLivedAction = /\bi\s+(?:went|walked|ate|drank|cooked|worked|returned|arrived|visited|shopped|slept|read|studied|researched|drove|showered|called|bought|watched|woke|traveled|commuted|cleaned|exercised)\b/i.test(sentence) ||
        /\bi\s+(?:took\s+(?:a\s+)?shower|called\s+(?:a|my)\s+friend|bought\s+groceries|watched\s+(?:a|the)\s+movie|woke\s+up)\b/i.test(sentence) ||
        /\bi(?:'m|\s+am)\s+(?:currently\s+)?(?:in|at|on)\s+(?:a|the|my)?\s*(?:cafe|coffee\s+shop|office|school|home|park|station|store|room|beach|airport|hotel|hospital)\b/i.test(sentence) ||
        /\bi\s+live\s+in\s+[a-z][a-z .'-]{1,40}\b/i.test(sentence);
      return firstPerson && livedAction ||
        japaneseResidence ||
        omittedLivedAction ||
        omittedRecentCompletion ||
        omittedCurrentLocation ||
        englishLivedAction;
    });
  }

  function anyAssertiveSentence_(normalized, predicate) {
    return factSentences_(normalized).some(function(sentence) {
      return !isNonAssertiveFact_(sentence) && predicate(sentence, compact_(sentence));
    });
  }

  function factSentences_(normalized) {
    var sentences = [];
    var start = 0;
    for (var index = 0; index < normalized.length; index += 1) {
      if (/[。.!?！？\n]/.test(normalized.charAt(index))) {
        var sentence = normalized.slice(start, index + 1).trim();
        if (sentence) {
          sentences.push(sentence);
        }
        start = index + 1;
      }
    }
    var remainder = normalized.slice(start).trim();
    if (remainder) {
      sentences.push(remainder);
    }
    return sentences;
  }

  function isNonAssertiveFact_(normalized) {
    var trimmed = normalized.trim();
    if (/[?？]$/.test(trimmed)) {
      return true;
    }
    return /(?:^|[。.!?！？\n、,]\s*)(?:もし|仮に|たぶん|多分|おそらく|もしかすると)|(?:かも(?:しれない)?|かもしれません|かな|と思う|ようだ|みたい)(?:[。.!！\s]*$)/.test(trimmed) ||
      /\b(?:if|maybe|perhaps|possibly|presumably|i\s+wonder|i\s+think|i\s+guess|i\s+suppose|it\s+seems|it\s+appears)\b|\b(?:might|may|could)\s+(?:be|have|show|contain|depict|mean|indicate|go|visit)/i.test(trimmed);
  }

  function sentenceCompacts_(normalized) {
    return normalized
      .split(/[。.!?！？\n]+/)
      .map(function(sentence) {
        return compact_(sentence);
      })
      .filter(function(sentence) {
        return sentence !== '';
      });
  }

  function removeAttributedSpans_(normalized, attributedTask) {
    if (!attributedTask) {
      return normalized;
    }
    // Only a locally bound, explicitly quoted span is exempt. Natural
    // language reporting boundaries ("says ... then ...") are open-ended and
    // cannot safely distinguish fictional dialogue from a second partner
    // assertion.
    return maskQuotedSpans_(normalized);
  }

  function maskQuotedSpans_(value) {
    var output = value.split('');
    var original = value.split('');
    [
      ['「', '」'],
      ['『', '』'],
      ['"', '"']
    ].forEach(function(pair) {
      var cursor = 0;
      while (cursor < output.length) {
        var openIndex = findCharacter_(output, pair[0], cursor);
        if (openIndex === -1) {
          break;
        }
        var closeIndex = findCharacter_(output, pair[1], openIndex + 1);
        if (closeIndex === -1) {
          break;
        }
        if (isLocallyAttributedQuote_(original, openIndex, closeIndex)) {
          for (var index = openIndex; index <= closeIndex; index += 1) {
            if (output[index] !== '\n') {
              output[index] = ' ';
            }
          }
        }
        cursor = closeIndex + 1;
      }
    });
    maskSingleQuotedSpans_(output, original);
    return output.join('');
  }

  function maskSingleQuotedSpans_(output, original) {
    var cursor = 0;
    while (cursor < original.length) {
      var openIndex = findSingleQuoteOpen_(original, cursor);
      if (openIndex === -1) {
        return;
      }
      var closeIndex = findSingleQuoteClose_(original, openIndex + 1);
      if (closeIndex === -1) {
        return;
      }
      if (isLocallyAttributedQuote_(original, openIndex, closeIndex)) {
        for (var index = openIndex; index <= closeIndex; index += 1) {
          if (output[index] !== '\n') {
            output[index] = ' ';
          }
        }
      }
      cursor = closeIndex + 1;
    }
  }

  function findSingleQuoteOpen_(characters, startIndex) {
    for (var index = startIndex; index < characters.length; index += 1) {
      if (
        characters[index] === "'" &&
        (
          index === 0 ||
          /[\s:：(\[{\u3000]/.test(characters[index - 1])
        )
      ) {
        return index;
      }
    }
    return -1;
  }

  function findSingleQuoteClose_(characters, startIndex) {
    for (var index = startIndex; index < characters.length; index += 1) {
      if (characters[index] !== "'") {
        continue;
      }
      var previous = index > 0 ? characters[index - 1] : '';
      var next = index + 1 < characters.length ? characters[index + 1] : '';
      if (/[a-z0-9]/i.test(previous) && /[a-z0-9]/i.test(next)) {
        continue;
      }
      if (
        index + 1 === characters.length ||
        /[\s.,!?;:)\]}\u3000]/.test(next)
      ) {
        return index;
      }
    }
    return -1;
  }

  function isLocallyAttributedQuote_(characters, openIndex, closeIndex) {
    var before = characters.slice(Math.max(0, openIndex - 100), openIndex).join('');
    var after = characters.slice(closeIndex + 1, closeIndex + 101).join('');
    var beforeBinding = /(?:登場人物|キャラクター|作中の人物|語り手|ナレーター)(?:は|が)\s*(?:こう|次のように)?\s*[:：、,]?\s*$/i.test(before) ||
      /(?:登場人物|キャラクター|作中の人物|語り手|ナレーター)(?:は|が)[^。.!?！？\n「」『』"]{0,24}(?:言う|話す|発言する|述べる)\s*[:：、,]?\s*$/i.test(before) ||
      /(?:台詞|セリフ|引用|原文|訳文)(?:は|が|として)?\s*[:：、,]?\s*$/i.test(before) ||
      /(?:the|a)\s+(?:fictional\s+)?(?:character|narrator)\s+(?:says?|states?|claims?)\s*[:：,]?\s*$/i.test(before) ||
      /(?:quote|quotation|original|translation|line|dialogue)\s*(?:is|:)?\s*$/i.test(before);
    var afterBinding = /^\s*(?:と|という)(?:(?:架空の)?(?:登場人物|キャラクター|作中の人物|語り手|ナレーター)(?:が|は)?)?(?:言う|話す|発言する|述べる|という台詞|というセリフ|の台詞|のセリフ)/i.test(after) ||
      /^\s*(?:という)?(?:台詞|セリフ|引用|原文|訳文)(?:だ|です|として|を)/i.test(after) ||
      /^\s*[,，]?\s*(?:says?|states?|claims?)\s+(?:the|a)\s+(?:fictional\s+)?(?:character|narrator)\b/i.test(after);
    return beforeBinding || afterBinding;
  }

  function findCharacter_(characters, target, startIndex) {
    for (var index = startIndex; index < characters.length; index += 1) {
      if (characters[index] === target) {
        return index;
      }
    }
    return -1;
  }

  function currentTaskText_(context) {
    var request = context && context.data ? context.data.currentRequest : null;
    if (typeof request === 'string') {
      return normalize_(request);
    }
    if (isPlainObject_(request) && typeof request.text === 'string') {
      return normalize_(request.text);
    }
    return '';
  }

  function isAttributedTask_(taskText) {
    if (!taskText) {
      return false;
    }
    var translation =
      /(?:\btranslate\s+(?:["']|the\s+(?:quote|phrase|sentence|line)|.+\s+into\b)|\b(?:give|make|provide)\s+(?:me\s+)?(?:a\s+)?translation\b|\btranslation\s*(?:request)?\s*[:：]|(?:["'].+["']|という(?:文|文章|台詞|セリフ)|.+を)(?:英訳|和訳|翻訳)(?:して|してください|してほしい|お願い|せよ|する|\s*[:：])|訳して|訳してください|訳せ)/i.test(taskText);
    if (translation) {
      return true;
    }
    var namedContent =
      /["']|(?:\bquote\b|\bquoted\b|\bphrase\b|\bsentence\b|\bline\b|\bdialogue\b|引用|文章|文面|台詞|セリフ|発言|という|と書)/i.test(taskText);
    var editing =
      /(?:\bedit\b|\brewrite\b|\bproofread\b|\bpolish\b|\bcorrect\b|校正|添削|推敲|整えて|書き換え|直して|編集)/i.test(taskText);
    if (
      namedContent && editing ||
      /(?:\bedit\b|\brewrite\b|\bproofread\b|\bpolish\b|校正|添削|推敲|編集)\s*[:：]/i.test(taskText)
    ) {
      return true;
    }
    var fiction =
      /(?:\bfiction\b|\bfictional\b|\bstory\b|\bnovel\b|\bcharacter\b|\broleplay\b|創作|架空|物語|小説|脚本|登場人物|キャラクター)/i.test(taskText);
    var creation =
      /(?:\bwrite\b|\bcreate\b|\bdraft\b|\bcompose\b|\bscene\b|\bdialogue\b|書いて|作って|描いて|考えて|台詞|セリフ|場面)/i.test(taskText);
    return fiction && (creation || /\broleplay\s+as\b/i.test(taskText));
  }

  function profile_(context) {
    var stored = context && context.persona && context.persona.profile
      ? context.persona.profile
      : null;
    if (!stored || !stored.identity) {
      return stored;
    }
    var pack = context.persona && context.persona.pack ? context.persona.pack : null;
    return {
      identity: {
        partnerName: stored.identity.partnerName,
        firstPerson: stored.identity.firstPerson ||
          (pack && pack.firstPerson ? pack.firstPerson : ''),
        userAddress: stored.identity.userAddress
      }
    };
  }

  function escapeRegExp_(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isPlainObject_(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  return Object.freeze({
    inspect: inspect
  });
})();

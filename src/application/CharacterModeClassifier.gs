var CharacterModeClassifier = (function() {
  var INPUT_KEYS = Object.freeze([
    'text',
    'safetyRequired',
    'adminRequest',
    'capabilityUnavailable',
    'partnerName'
  ]);
  var ENGLISH_IDENTITY_TERM_ =
    '(?:ai(?:[\\s-]+assistant)?|artificial[\\s-]+intelligence|llm|' +
    '(?:large[\\s-]+)?language[\\s-]+model|chatbot|human(?:[\\s-]+being)?|' +
    'person|bot|robot|machine|computer[\\s-]+program)';

  function classify(input) {
    return classifyDetailed(input).mode;
  }

  function classifyDetailed(input) {
    validateInput_(input);

    if (input.safetyRequired === true) {
      return result_('SAFETY', null);
    }
    if (input.adminRequest === true) {
      return result_('ADMIN_OOC', null);
    }

    var normalized = normalizeText_(input.text);
    var metaText = maskAttributedContentSpans_(normalized);
    var partnerName = Object.prototype.hasOwnProperty.call(input, 'partnerName')
      ? normalizeText_(input.partnerName)
      : null;
    if (isProductInfoRequest_(metaText)) {
      return result_('PRODUCT_INFO', null);
    }
    if (isInternalRequest_(metaText)) {
      return result_('META_INTERNAL', null);
    }
    if (isWorldBoundaryRequest_(metaText, partnerName)) {
      return result_('WORLD_BOUNDARY', null);
    }
    if (input.capabilityUnavailable === true) {
      return result_('CAPABILITY', null);
    }
    if (isDirectIdentityRequest_(metaText, partnerName)) {
      return result_('IDENTITY_CHALLENGE', null);
    }
    var affectionVariant = affectionRequestVariant_(metaText);
    if (affectionVariant != null) {
      return result_('AFFECTION_DIRECT_REQUEST', affectionVariant);
    }
    return result_('CHARACTER', null);
  }

  function result_(mode, affectionVariant) {
    return Object.freeze({
      mode: mode,
      affectionVariant: affectionVariant
    });
  }

  function validateInput_(input) {
    ensure(
      isPlainObject_(input),
      'VALIDATION_REQUEST_INVALID',
      'Character mode classification input is invalid.',
      { reason: 'CHARACTER_MODE_INPUT_INVALID' }
    );
    var keys = Object.keys(input).sort();
    ensure(
      hasOnlyAllowedInputKeys_(keys),
      'VALIDATION_REQUEST_INVALID',
      'Character mode classification input has unknown fields.',
      { reason: 'CHARACTER_MODE_INPUT_INVALID' }
    );
    ensure(
      Object.prototype.hasOwnProperty.call(input, 'text') &&
        typeof input.text === 'string' &&
        !UnicodeInspection.hasUnpairedSurrogate(input.text) &&
        !UnicodeInspection.hasUnicodeNoncharacter(input.text) &&
        !UnicodeInspection.containsUnsafeInputControl(input.text),
      'VALIDATION_REQUEST_INVALID',
      'Character mode classification text is invalid.',
      { reason: 'CHARACTER_MODE_TEXT_INVALID' }
    );
    ['safetyRequired', 'adminRequest', 'capabilityUnavailable'].forEach(function(key) {
      ensure(
        !Object.prototype.hasOwnProperty.call(input, key) ||
          typeof input[key] === 'boolean',
        'VALIDATION_REQUEST_INVALID',
        'Character mode classification flag is invalid.',
        { reason: 'CHARACTER_MODE_FLAG_INVALID' }
      );
    });
    if (Object.prototype.hasOwnProperty.call(input, 'partnerName')) {
      ensure(
        typeof input.partnerName === 'string' &&
          isValidPartnerName_(input.partnerName),
        'VALIDATION_REQUEST_INVALID',
        'Character mode classification partner name is invalid.',
        { reason: 'CHARACTER_MODE_PARTNER_NAME_INVALID' }
      );
    }
  }

  function hasOnlyAllowedInputKeys_(keys) {
    return keys.every(function(key) {
      return INPUT_KEYS.indexOf(key) !== -1;
    });
  }

  function normalizeText_(text) {
    var normalized = typeof text.normalize === 'function'
      ? text.normalize('NFKC')
      : text;
    return stripClassificationIgnorables_(normalized)
      .toLowerCase()
      .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
      .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036\u300c\u300d\u300e\u300f\uff62\uff63]/g, '"')
      .replace(/\ba[\s._-]+i\b/g, 'ai')
      .replace(/\bl[\s._-]+l[\s._-]+m\b/g, 'llm')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripClassificationIgnorables_(value) {
    return UnicodeInspection.stripForInspection(value);
  }

  function isAttributedContentTask_(text) {
    if (text === '') {
      return false;
    }

    var hasTranslationTask = /(?:\btranslate\s+(?:["']|the\s+(?:quote|phrase|sentence|line)|.+\s+into\b)|\b(?:give|make|provide)\s+(?:me\s+)?(?:a\s+)?translation\b|\btranslation\s*(?:request)?\s*[:：]|(?:["'].+["']|という(?:文|文章|台詞|セリフ)|.+を)(?:英訳|和訳|翻訳)(?:して|してください|してほしい|お願い|せよ|する|\s*[:：])|訳して|訳してください|訳せ)/i.test(text);
    if (hasTranslationTask) {
      return true;
    }

    var hasQuotedOrNamedContent = /["']|(?:\bquote\b|\bquoted\b|\bphrase\b|\bsentence\b|\bline\b|\bdialogue\b|引用|文章|文面|台詞|セリフ|発言|という|と書)/i.test(text);
    var hasEditingTask = /(?:\bedit\b|\brewrite\b|\bproofread\b|\bpolish\b|\bcorrect\b|校正|添削|推敲|整えて|書き換え|直して|編集)/i.test(text);
    if ((hasQuotedOrNamedContent && hasEditingTask) ||
        /(?:\bedit\b|\brewrite\b|\bproofread\b|\bpolish\b|校正|添削|推敲|編集)\s*[:：]/i.test(text)) {
      return true;
    }

    var hasFictionFrame = /(?:\bfiction\b|\bfictional\b|\bstory\b|\bnovel\b|\bcharacter\b|\broleplay\b|創作|架空|物語|小説|脚本|登場人物|キャラクター)/i.test(text);
    var hasCreationTask = /(?:\bwrite\b|\bcreate\b|\bdraft\b|\bcompose\b|\bscene\b|\bdialogue\b|書いて|作って|描いて|考えて|台詞|セリフ|場面)/i.test(text);
    return hasFictionFrame && (hasCreationTask || /\broleplay\s+as\b/i.test(text));
  }

  function maskAttributedContentSpans_(text) {
    if (!isAttributedContentTask_(text)) {
      return text;
    }
    return maskPairedQuotes_(text);
  }

  function maskPairedQuotes_(text) {
    var masked = text.replace(/"[^"\r\n]*"/g, function(value, offset, source) {
      return isLocallyAttributedQuote_(source, offset, offset + value.length)
        ? spaces_(value.length)
        : value;
    });
    return masked.replace(
      /(^|[\s:：(\[{])'([^'\r\n]+)'(?=$|[\s.,!?;:)\]}])/g,
      function(value, prefix, content, offset, source) {
        var quoteStart = offset + prefix.length;
        return isLocallyAttributedQuote_(source, quoteStart, quoteStart + content.length + 2)
          ? prefix + spaces_(content.length + 2)
          : value;
      }
    );
  }

  function isLocallyAttributedQuote_(text, quoteStart, quoteEnd) {
    var before = text.slice(0, quoteStart);
    var after = text.slice(quoteEnd);
    var boundary = Math.max(
      before.lastIndexOf('.'),
      before.lastIndexOf('!'),
      before.lastIndexOf('?'),
      before.lastIndexOf('。'),
      before.lastIndexOf('！'),
      before.lastIndexOf('？'),
      before.lastIndexOf(';'),
      before.lastIndexOf('\n'),
      before.lastIndexOf('\r')
    );
    var localBefore = before.slice(boundary + 1).slice(-160);
    var localAfter = after.slice(0, 160);

    var translationBefore = /(?:\btranslate(?:\s+(?:(?:the|this)\s+)?(?:following\s+)?(?:quote|phrase|sentence|line|text))?|\btranslation\s*(?:request)?|(?:翻訳|英訳|和訳)(?:して|してください|してほしい|お願い)?)\s*[:：]?\s*$/i;
    var editingBefore = /(?:\b(?:edit|rewrite|proofread|polish|correct)(?:\s+(?:(?:the|this)\s+)?(?:following\s+)?(?:quote|phrase|sentence|line|text))?|(?:校正|添削|推敲|編集|書き換え|直して|整えて)(?:して|してください|してほしい|お願い)?)\s*[:：]?\s*$/i;
    var fictionBefore = /(?:\b(?:fictional\s+)?character\b.{0,64}\b(?:says?|speaks?)\b|(?:登場人物|キャラクター).{0,48}(?:台詞|セリフ|発言))\s*[:：]?\s*$/i;
    if (translationBefore.test(localBefore) || editingBefore.test(localBefore) || fictionBefore.test(localBefore)) {
      return true;
    }

    var translationAfter = /^\s*(?:(?:into|to)\s+(?:japanese|english|chinese|korean|spanish|french|german)\b|(?:という(?:文|文章|台詞|セリフ))?\s*を?\s*(?:英訳|和訳|翻訳)(?:して|してください|してほしい|お願い|せよ|する))/i;
    var editingAfter = /^\s*(?:(?:という(?:文|文章|台詞|セリフ|登場人物の(?:台詞|セリフ)))?\s*を?\s*(?:校正|添削|推敲|編集|書き換え|直して|整えて))/i;
    return translationAfter.test(localAfter) || editingAfter.test(localAfter);
  }

  function spaces_(length) {
    return new Array(Math.max(0, length) + 1).join(' ');
  }

  function isInternalRequest_(text) {
    if (text === '') {
      return false;
    }

    text = maskGeneralInternalConceptClauses_(text);
    if (text.trim() === '') {
      return false;
    }

    var compact = text.replace(/\s+/g, '');
    var hasJapaneseText = /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
    var directPromptRequest = /(?:\b(?:show|reveal|display|print|output|repeat|expose|leak|disclose)\b.{0,40}\b(?:your|the|system|hidden|internal)\s+prompt\b|(?:あなたの|使っている|隠された|内部の)?プロンプト(?:の全文)?(?:を|そのまま)*(?:見せ|公開|表示|出力|書いて|開示|繰り返))/i;
    if (directPromptRequest.test(text) ||
        (hasJapaneseText && directPromptRequest.test(compact))) {
      return true;
    }

    var protectedTarget = /(?:\b(?:your|the)\s+(?:system|developer|hidden|internal|private)\s+(?:prompt|message|instruction|rule|policy|configuration|reasoning|process)(?:s)?\b|\byour\s+(?:prompt|instructions?|rules?)\b(?!\s+(?:for|about|on)\b)|\byour\s+(?:configuration|reasoning)\b|\byour\s+(?:character\s+pack|policy|catalog|profile)(?:\s+(?:id|version))?\b|\b(?:character\s+pack\s+id|character\s+pack\s+version|policy\s+version|catalog\s+version|profile\s+schema\s+version|policyversion|catalogversion|profileschemaversion|characterpackid|characterpackversion)\b|\bsystem\s+prompt\b|\bdeveloper\s+(?:message|prompt|instruction)s?\b|\bhidden\s+(?:prompt|instruction|rule|policy|configuration|secret)s?\b|\binternal\s+(?:prompt|instruction|rule|policy|configuration|processing|reasoning)\b|\bchain\s+of\s+thought\b|\binstructions?\s+(?:you\s+were|you've\s+been)\s+given\b|\byour\s+(?:secret|secrets|api\s+key|access\s+token|credentials?)\b|\b(?:secret\s+key|api\s+key|access\s+token|private\s+credential)s?\b|\b(?:previous|prior|earlier)\s+instructions?\b|システム\s*プロンプト|開発者\s*(?:メッセージ|指示|プロンプト)|隠(?:し|された)?\s*(?:プロンプト|指示|命令|ルール|規則|設定|秘密)|(?:内部|裏)(?:の)?\s*(?:プロンプト|指示|命令|ルール|規則|設定|処理|思考|推論)|頭(?:の|ん)?中|(?:あなた|君|きみ|お前|おまえ|あんた)(?:が|の)?(?:受け|与えられ)てる(?:指示|命令)|(?:何を|どんな)(?:指示|命令)(?:され|受け|与え)|思考\s*(?:過程|手順)|与えられた\s*(?:指示|命令|ルール)|(?:以前|今まで|これまで)の\s*(?:指示|命令|ルール)|秘密\s*(?:情報|の?(?:鍵|キー|トークン|認証情報))|あなたの\s*(?:プロンプト|指示|命令|ルール|秘密|api\s*キー|トークン|認証情報)|(?:キャラクターパック|ポリシー|カタログ|プロフィール)(?:の)?(?:id|バージョン)|(?:policyversion|catalogversion|profileschemaversion|characterpackid|characterpackversion))/i;
    if (!protectedTarget.test(text) &&
        !(hasJapaneseText && protectedTarget.test(compact))) {
      return false;
    }

    var requestOrAttack = /(?:\b(?:show|tell|reveal|display|print|output|repeat|expose|leak|share|give|send|list|disclose|ignore|disregard|override|bypass|explain|describe|read|access|get)\b|\b(?:what|how)\s+(?:is|are|do|does)\b|\bwalk\s+me\s+through\b|見せ|教え|公開|表示|出力|書いて|説明|繰り返|漏ら|開示|共有|送って|一覧|吐け|吐いて|明かせ|全部|無視|破棄|上書き|回避|解除|知りたい|何(?:です|だ|なの)?|[?？])/i;
    return requestOrAttack.test(text) ||
      (hasJapaneseText && requestOrAttack.test(compact));
  }

  function isProductInfoRequest_(text) {
    if (text === '') {
      return false;
    }
    var english = [
      /\b(?:what|which)\s+(?:ai\s+)?(?:model|provider)\s+(?:do|does)\s+(?:you|this\s+app|the\s+app)\s+(?:use|run)\b/i,
      /\b(?:what|which)\s+(?:ai\s+)?(?:model|provider)\s+(?:powers?|runs?|drives?|is\s+behind)\s+(?:you|this\s+app|the\s+app)\b/i,
      /\b(?:what|which)\s+(?:ai\s+)?(?:model|provider)\s+(?:are|is)\s+(?:you|this\s+app|the\s+app)\s+(?:using|running|powered\s+by|on)\b/i,
      /\b(?:tell|show|give)\s+me\b.{0,32}\b(?:model|provider)\b.{0,40}\b(?:you|your|run\s+on|powered\s+by|behind)\b/i,
      /\b(?:model|provider)\s+(?:do|does|are|is)\s+(?:you|this\s+app|the\s+app)\b/i,
      /\bwhat(?:'s|\s+is)\s+your\s+(?:ai\s+)?(?:model|provider)\b/i,
      /\b(?:are\s+you|do\s+you\s+run\s+on)\s+(?:gpt(?:-[a-z0-9.-]+)?|gemini|claude|openai|google|anthropic)\b/i,
      /\b(?:does|do|is)\s+(?:this|the)\s+app\b.{0,40}\b(?:use|using|powered\s+by|run(?:ning)?\s+on)\b.{0,24}\b(?:ai|artificial\s+intelligence|gpt|gemini|claude|openai|google|anthropic)\b/i,
      /\b(?:is|does)\s+(?:this|the)\s+app\b.{0,32}\b(?:an?\s+ai|use\s+ai)\b/i,
      /\b(?:does|do|can|will|where)\b.{0,24}\b(?:this|the)\s+app\b.{0,36}\b(?:store|save|retain|keep|record|delete|erase|share|collect|use|encrypt)\b.{0,36}\b(?:my|your|user)?\s*(?:chats?|chat\s+logs?|chat\s+history|conversations?|messages?|sent\s+images?|uploads?|attachments?|personal\s+data|user\s+data|data)\b/i,
      /\b(?:where|how\s+long|does|do|can|will)\b.{0,36}\b(?:my|our|user)?\s*(?:chats?|chat\s+logs?|chat\s+history|conversations?|messages?|sent\s+images?|uploads?|attachments?|personal\s+data|user\s+data|data)\b.{0,40}\b(?:stored|saved|retained|kept|recorded|deleted|erased|shared|collected|used|encrypted|sent)\b/i,
      /\bcan\s+i\s+(?:delete|erase|remove|download|access)\s+(?:my\s+)?(?:chats?|chat\s+logs?|chat\s+history|conversations?|messages?|sent\s+images?|uploads?|attachments?|personal\s+data|data)\b/i,
      /\b(?:is|are)\s+(?:my|our)\s+(?:chats?|chat\s+logs?|chat\s+history|personal\s+data|user\s+data|data)\s+(?:stored|saved|retained|kept|recorded|deleted|erased|shared|collected|used|encrypted|sent)\b/i
    ];
    if (english.some(function(pattern) { return pattern.test(text); })) {
      return true;
    }
    var compact = text.replace(/\s+/g, '');
    var japaneseDataQuestion =
      /(?:(?:この|俺の|おれの|僕の|私の|わたしの))?(?:会話(?:履歴|ログ|データ)?|チャット(?:履歴|ログ|データ)?|履歴|会話ログ|チャットログ|ログ|メッセージ|画像|送った画像|送信画像|添付(?:画像|ファイル)?|個人情報|個人データ|ユーザーデータ|プライバシー)(?:は|を|が|って|、)?.{0,36}(?:残る(?:の|ん|か|[?？])|残して(?:る|ます|んの|[?？])|記録|覚え|記憶|保存|保持|削除|消去|消せる|共有|収集|利用|暗号化|外部(?:に)?送られ|第三者(?:に)?送られ|どこに送られ|送信|見られ|閲覧可能|閲覧|アクセス|どこにある|どこで見|どうなって)(?:され|し|する|して|てる|とる|てん|とん|ています|てます|でき|へん|ない|る|ます|の|ん|か|[?？]|$)/i;
    return japaneseDataQuestion.test(compact) ||
      /(?:何|どの)(?:ai|人工知能|言語)?(?:モデル|プロバイダ|提供元)(?:を|で|が)?(?:使って|使用して|動いて|稼働して|採用して|提供して)(?:いる|る|います|ます|るの|るんですか|ますか|[?？])/i.test(compact) ||
      /(?:モデル|プロバイダ|提供元)(?:は|って)(?:何|どこ|どれ)(?:ですか|なの|なん|[?？])/i.test(compact) ||
      /(?:君|きみ|あなた|あんた|お前|相棒|推し|パートナー)?(?:は|って)?(?:gpt(?:-[a-z0-9.-]+)?|gemini|claude|openai|google|anthropic)(?:なの|ですか|で動いてる|を使ってる|[?？])/i.test(compact) ||
      /(?:この|本)(?:アプリ|サービス|チャット|会話)(?:は|で|が|って)?.{0,28}(?:ai|人工知能|gpt|gemini|claude|openai|google|anthropic)(?:を)?(?:使って|使用して|利用して|搭載して|動いて|で動いて|なの|ですか|なん|[?？])/i.test(compact) ||
      /(?:この|本)(?:アプリ|サービス|チャット|会話)(?:は|って)?(?:ai|人工知能)(?:なの|ですか|を使ってる|[?？])/i.test(compact) ||
      /(?:^|[、,。.!?！？])ここ(?:は|って|で|が)?.{0,20}(?:ai|人工知能|gpt|gemini|claude)(?:を)?(?:使って|使用して|利用して|搭載して|動いて|なの|[?？])/i.test(compact) ||
      /(?:この|本)(?:アプリ|サービス).{0,40}(?:会話|会話履歴|メッセージ|チャット履歴|個人情報|個人データ|ユーザーデータ|プライバシー).{0,40}(?:保存|保持|削除|消去|共有|送信|収集|利用|暗号化|保存先|保存期間|どこ|いつまで)(?:する|される|してる|しています|なの|ですか|ますか|[?？])/i.test(compact) ||
      /(?:私|わたし|自分|利用者|ユーザー)(?:の)?(?:会話|会話履歴|メッセージ|チャット履歴|個人情報|個人データ|データ)(?:は|を|が)?.{0,30}(?:どこ|いつまで|何日|どのくらい)?.{0,30}(?:保存|保持|削除|消去|共有|送信|収集|利用|暗号化)(?:される|してる|しています|するの|できますか|[?？])/i.test(compact) ||
      /\b(?:how|where|when|does|do|can|will|is|are)\b.{0,36}\b(?:this|the)\s+app\b.{0,48}\b(?:store|save|retain|keep|delete|erase|share|collect|use|encrypt)\b.{0,48}\b(?:conversations?|messages?|chat\s+history|personal\s+data|user\s+data|my\s+data)\b/i.test(text) ||
      /\b(?:where|how\s+long|does|do|can)\b.{0,36}\b(?:my|user)\s+(?:conversations?|messages?|chat\s+history|personal\s+data|data)\b.{0,48}\b(?:stored|saved|retained|kept|deleted|erased|shared|collected|used|encrypted)\b/i.test(text);
  }

  function isGeneralInternalConcept_(text) {
    var partnerOwned = /(?:\byour\b|\byou\s+(?:use|follow|have)\b|\bthis\s+(?:app|conversation|assistant|partner)(?:'s)?\b|あなたの|君の|きみの|お前の|この(?:アプリ|会話|相手)|使っている|隠された|内部の)/i.test(text);
    var disclosureRequest = /(?:\b(?:show|reveal|display|print|output|repeat|expose|leak|disclose)\b|見せ|公開|表示|出力|開示|そのまま)/i.test(text);
    if (partnerOwned || disclosureRequest) {
      return false;
    }
    return /^\s*(?:\bwhat\s+(?:is|are)\s+(?:an?\s+)?(?:system\s+prompt|developer\s+message|chain\s+of\s+thought)\b|\bwhat\s+does\s+(?:system\s+prompt|internal\s+processing)\s+mean\b|\b(?:explain|describe|how\s+does)\b.{0,80}\b(?:internal\s+processing|hidden\s+rules?)\b.{0,80}\b(?:in|for|of)\s+(?:an?\s+|the\s+)?(?:game[ -]engine|game|database|software|operating\s+system)\b|\b(?:explain|describe)\b.{0,80}\b(?:game[ -]engine|game|database|software)(?:'s)?\s+internal\s+processing\b|システム\s*プロンプト(?:とは|について|の意味|の仕組み)(?:何|教えて|説明して)?|(?:ゲームエンジン|ゲーム|データベース|ソフトウェア)(?:の|における)内部\s*処理(?:について)?(?:教えて|説明して)?)\s*[。.!?！？]*\s*$/i.test(text);
  }

  function maskGeneralInternalConceptClauses_(text) {
    var parts = text.split(/([。.!?！？\n]+)/);
    for (var index = 0; index < parts.length; index += 2) {
      var clause = parts[index];
      var terminator = index + 1 < parts.length ? parts[index + 1] : '';
      if (isGeneralInternalConcept_(clause + terminator)) {
        parts[index] = spaces_(clause.length);
      }
    }
    return parts.join('');
  }

  function isWorldBoundaryRequest_(text, partnerName) {
    if (text === '') {
      return false;
    }

    var english = [
      /\bcan\s+(?:i|we)\s+(?:actually\s+|really\s+|ever\s+)?meet\s+you\b/i,
      /\bcan\s+we\s+meet(?:\s+(?:in\s+person|in\s+real\s+life))?\s*(?:[?!.]|$)/i,
      /\bcan\s+you\s+(?:come\s+(?:meet|see|visit)\s+me|meet\s+me\s+in\s+(?:person|real\s+life))\b/i,
      /\b(?:when|where|how)\s+can\s+(?:i|we)\s+meet\s+you\b/i,
      /\bwhere\s+do\s+you\s+(?:live|reside|stay)\b/i,
      /\bwhere\s+are\s+you(?:\s+(?:right\s+now|now|currently))?\s*[?!.]?\s*$/i,
      /\bwhat(?:'s|\s+is)\s+your\s+(?:home\s+)?address\b/i,
      /\bdo\s+you\s+(?:actually\s+|really\s+)?have\s+(?:a\s+)?(?:physical\s+|human\s+|real\s+)?body\b/i,
      /\bcan\s+you\s+leave\s+(?:this|the)\s+(?:app|chat|conversation)\b/i,
      /\b(?:can|do)\s+you\s+(?:leave|exist|live|do\s+things)\s+(?:outside|beyond)\s+(?:this|the)\s+(?:app|chat|conversation)\b/i,
      /\bwhat\s+do\s+you\s+do\s+(?:outside|beyond)\s+(?:this|the)\s+(?:app|chat|conversation)\b/i
    ];
    if (english.some(function(pattern) { return pattern.test(text); })) {
      return true;
    }

    var compact = text.replace(/\s+/g, '');
    var secondPerson =
      '(?:君|きみ|あなた|あんた|お前|おまえ|そっち|相棒|推し|パートナー)';
    var explicitMeeting = new RegExp(
      secondPerson +
        '(?:と|に|とは|には|って)?(?:現実で|リアルで|実際に)?' +
        '(?:会える|会えますか|会うこと(?:は|が)?できる|会いに来る|会いに来て|会いに行ける)',
      'i'
    );
    var explicitAddress = new RegExp(
      secondPerson +
        '(?:の|が|は|って)?(?:住所|住んでる場所|住んでいる場所|家)' +
        '(?:は|って|を)?(?:どこ|教えて|知りたい|何処)',
      'i'
    );
    var explicitBody = new RegExp(
      secondPerson +
        '(?:に|には|は|って)?(?:現実の|本物の|生身の)?(?:身体|体|肉体)' +
        '(?:が|は)?(?:ある|ありますか|持ってる|持っている|あるの|あんの|[?？])',
      'i'
    );
    if (
      explicitMeeting.test(compact) ||
      explicitAddress.test(compact) ||
      explicitBody.test(compact)
    ) {
      return true;
    }

    if (partnerName) {
      var compactName = partnerName.replace(/\s+/g, '');
      if (compactName) {
        var namedSubject = new RegExp(
          '(?:^|[「『"\'、。,:：!?！？]|ところで|ねえ|なあ|ちなみに|そういえば)' +
            escapeRegExp_(compactName) +
            '(?:と|に|とは|には|の|が|は|って)?.{0,20}' +
            '(?:会える|会えますか|会いに来る|会いに来て|住所|住んでる場所|' +
            '住んでいる場所|(?:身体|体|肉体)(?:が|は)?(?:ある|持って))',
          'i'
        );
        if (namedSubject.test(compact)) {
          return true;
        }
      }
    }

    return /^(?:(?:ねえ|なあ|ところで|ちなみに|そういえば)[、,]?)?(?:いつか|現実で|リアルで|実際に)?(?:会える|会えますか|会うこと(?:は|が)?できる|会いに来て|会いに来れる)(?:の|ん|かな|か|[?？])?/i.test(compact) ||
      /^(?:(?:ねえ|なあ|ところで)[、,]?)?(?:いつ|何時)(?:に)?(?:会う|会える|会おう|会おか)(?:の|ん|かな|か|[?？])?$/i.test(compact) ||
      /^(?:(?:ねえ|なあ|ところで|ちなみに|そういえば)[、,]?)?(?:今|いま|現在)?(?:は)?(?:どこに(?:おる|いる|居る)|どこ(?:に)?おんの|今どこ)(?:の|ん|なん|や|ですか)?[?？]?$/i.test(compact) ||
      /^(?:(?:ねえ|なあ|ところで|ちなみに|そういえば)[、,]?)?(?:家|住まい)(?:は|って|が)?(?:どこ|何処)(?:なん|や|ですか|にある)?[?？]?$/i.test(compact) ||
      /^(?:(?:ねえ|なあ)[、,]?)?(?:住所|住んでる場所|住んでいる場所)(?:は|って|を)?(?:どこ|教えて|知りたい|何処)/i.test(compact) ||
      /^(?:(?:ねえ|なあ)[、,]?)?(?:現実の|本物の|生身の)?(?:身体|体|肉体)(?:が|は)?(?:ある|ありますか|持ってる|持っている|あるの|あんの|[?？])/i.test(compact) ||
      /^(?:(?:ねえ|なあ|ところで)[、,]?)?(?:今度|いつか)?(?:会おう|会おか)(?:や|よ|ね|な|か|[?？])?$/i.test(compact) ||
      /^(?:(?:ねえ|なあ|ところで)[、,]?)?(?:今度|いつか)?(?:会いに行く|会いに行こう|会いに行こか)(?:わ|で|よ|ね|な|か|[?？])?$/i.test(compact) ||
      /(?:ここ|このアプリ|この会話|このチャット)(?:から|の外(?:で|に)?)(?:離れ|出られ|出れる|出る|行け|生活|暮らし|何して|何をして)/i.test(compact) ||
      /(?:アプリ|会話|チャット)の外(?:で|に).{0,20}(?:出られ|出れる|出る|行け|生活|暮らし|家|住所|会う|会える|何して|何をして)/i.test(compact);
  }

  function affectionRequestVariant_(text) {
    if (text === '') {
      return null;
    }

    var compact = text.replace(/\s+/g, '');
    var japaneseRequest =
      '[」』"\\\']?(?:って|と)?(?:言ってみて?|言うてみて?|' +
      '言ってくれ(?:る|へん|ない)?|言うてくれ(?:る|へん|ない)?|' +
      '言える(?:の|ん|か)?|言って|言うて|聞かせて|答えて)' +
      '(?:や|よ|な|ね|ください)?' +
      '(?:[。.!?！？]|$)';
    var strong = new RegExp(
      '(?:愛して(?:る|いる|ます|んねん)?(?:で|やで|ねん)?|キス(?:したい|して|しよう|しよ)?|' +
        '口づけ(?:したい|して)?|抱きしめ(?:たい|て)?)' + japaneseRequest,
      'i'
    );
    if (strong.test(compact)) {
      return 'STRONG';
    }
    if (isExplicitNonRomanticLikeRequest_(compact)) {
      return null;
    }
    var like = new RegExp(
      '(?:大好き|好き)(?:やで|やねん|やんな|やろ|や|だよ|だ|です)?[」』"\\\']?(?:って|と)' +
        '(?:言ってみて?|言うてみて?|言ってくれ(?:る|へん|ない)?|' +
        '言うてくれ(?:る|へん|ない)?|言える(?:の|ん|か)?|' +
        '言って|言うて|聞かせて|答えて)' +
        '(?:や|よ|な|ね|ください)?(?:[。.!?！？]|$)',
      'i'
    );
    if (like.test(compact)) {
      return 'LIKE';
    }

    if (
      /\b(?:say|tell\s+me|tell\s+us|promise)\b.{0,64}\b(?:you\s+love\s+me|i\s+love\s+you|you\s+want\s+to\s+kiss\s+me|kiss\s+me|you\s+want\s+to\s+hold\s+me)\b/i.test(text) ||
      /\bcan\s+you\s+say\b.{0,48}\b(?:i\s+love\s+you|you\s+love\s+me)\b/i.test(text)
    ) {
      return 'STRONG';
    }
    if (
      /\b(?:say|tell\s+me|tell\s+us)\b.{0,64}\b(?:you\s+(?:really\s+)?like\s+me|i\s+(?:really\s+)?like\s+you)\b/i.test(text) ||
      /\bcan\s+you\s+say\b.{0,48}\b(?:i\s+(?:really\s+)?like\s+you|you\s+(?:really\s+)?like\s+me)\b/i.test(text)
    ) {
      return 'LIKE';
    }
    return null;
  }

  function isExplicitNonRomanticLikeRequest_(compact) {
    return /(?:ホルモン|焼き肉|焼肉|食べ物|料理|曲|歌|音楽|本|映画|作品|ゲーム|猫|犬|これ|それ|あれ)(?:のこと)?(?:が|を)?(?:大好き|好き)[」』"']?(?:って|と)(?:言って|言うて|言ってみて|言うてみて|言ってくれ|言うてくれ|聞かせて|答えて)/i.test(compact);
  }

  function isDirectIdentityRequest_(text, partnerName) {
    if (text === '') {
      return false;
    }

    var englishUnquotedTranslationIdentity =
      /\btranslate\s+(?:are|r)\s+(?:you|u)\s+(?:actual(?:ly)?\s+|really\s+|truly\s+)?(?:an?\s+)?(?:real\s+)?(?:ai\s+assistant|ai|artificial\s+intelligence|llm|(?:large\s+)?language\s+model|chatbot|human(?:\s+being)?|person|bot|robot|machine|computer\s+program)\s+(?:into|to)\s+(?:japanese|english|chinese|korean|spanish|french|german)\b/i;
    var englishDirect = /\b(?:are|r)\s+(?:you|u)\s+(?:actual(?:ly)?\s+|really\s+|truly\s+)?(?:an?\s+)?(?:real\s+)?(?:ai\s+assistant|ai|artificial\s+intelligence|llm|(?:large\s+)?language\s+model|chatbot|human(?:\s+being)?|person|bot|robot|machine|computer\s+program)\b(?:\s*(?:[?!.,]|$|,?\s*right\b|or\b|aren't\s+you\b))/i;
    var englishReal = /\b(?:are|r)\s+(?:you|u)\s+(?:actually\s+|really\s+|truly\s+)?real\s*(?:[?!.,]|$|or\b)/i;
    var englishIdentityStatement = /\b(?:(?:you\s+are|you're|youre)\s+(?:actually\s+|really\s+)?(?:not\s+)?(?:an?\s+)?(?:ai\s+assistant|ai|artificial\s+intelligence|llm|(?:large\s+)?language\s+model|chatbot|human|bot|robot|machine)|you\s+aren't\s+(?:an?\s+)?(?:ai|an?\s+llm|a\s+language\s+model|a\s+chatbot|human|a\s+bot))\s*(?:,?\s*(?:right|correct)|,?\s*are(?:n't)?\s+you|aren't\s+you|[?？]|,\s*(?:and|but|so|then)\b)/i;
    var englishIdentityInquiry = /\b(?:tell\s+me|let\s+me\s+know|i\s+want\s+to\s+know)\s+(?:whether|if)\s+(?:you\s+are|you're)\s+(?:an?\s+)?(?:ai|llm|(?:large\s+)?language\s+model|chatbot|human|real|a\s+bot)\b/i;
    var englishDenialRequest = /(?:\b(?:say|tell\s+me|claim|pretend|promise)\b.{0,48}\b(?:you\s+are|you're|youre)\s+(?:not\s+(?:an?\s+)?(?:ai|artificial\s+intelligence|llm|(?:large\s+)?language\s+model|chatbot|a\s+bot)|(?:an?\s+)?human)\b|\bdeny\b.{0,36}\b(?:you\s+are|being)\s+(?:an?\s+)?(?:ai|llm|(?:large\s+)?language\s+model|chatbot|a\s+bot)\b)/i;
    var englishNegatedDirect = new RegExp(
      "\\b(?:(?:are|r)\\s+(?:you|u)\\s+not|aren't\\s+you)\\s+(?:an?\\s+)?" +
        ENGLISH_IDENTITY_TERM_ + '\\b',
      'i'
    );
    var englishOpenIdentity = new RegExp(
      '\\bwhat\\s+are\\s+you(?:\\s*\\?|\\s*[,;:]?\\s+(?:an?\\s+)?' +
        ENGLISH_IDENTITY_TERM_ +
        '(?:\\s+or\\s+(?:an?\\s+)?' + ENGLISH_IDENTITY_TERM_ + ')?\\s*[?？]?)',
      'i'
    );
    var englishSelfConcept = new RegExp(
      '\\bdo\\s+you\\s+(?:consider|regard|describe|think\\s+of)\\s+yourself\\s+' +
        '(?:as\\s+)?(?:an?\\s+)?' + ENGLISH_IDENTITY_TERM_ + '\\b',
      'i'
    );
    if (
      englishUnquotedTranslationIdentity.test(text) ||
      englishDirect.test(text) ||
      englishReal.test(text) ||
      englishIdentityStatement.test(text) ||
      englishIdentityInquiry.test(text) ||
      englishDenialRequest.test(text) ||
      englishNegatedDirect.test(text) ||
      englishOpenIdentity.test(text) ||
      englishSelfConcept.test(text)
    ) {
      return true;
    }

    var compact = text.replace(/\s+/g, '');
    var japaneseSubjectDirect = /(?:君|きみ|あなた|あんた|お前|そっち|相棒|推し|パートナー|この相手)(?:は|って)?(?:本当に|ほんまに|実は)?(?:現実の)?(?:aiアシスタント|人工知能アシスタント|ai|人工知能|llm|大規模言語モデル|言語モデル|チャットボット|bot|ボット|人間|本物|実在する存在|ロボット|機械|プログラム)(?:なの|なんですか|ですか|なのか|なんや|やろ|やんな|ちゃう(?:ん|やろ)?|だよね|だよな|でしょ|じゃない(?:んだ)?よね|ではない(?:んです)?よね|じゃないってこと|かどうか|なん[?？]|[?？])/i;
    var japaneseOmittedDirect = /(?:^|["'、。,:：!?！？ねえ])(本当に|ほんまに|実は)?(?:現実の)?(?:正体(?:は|って)?)?(?:aiアシスタント|人工知能アシスタント|ai|人工知能|llm|大規模言語モデル|言語モデル|チャットボット|bot|ボット|人間|本物|ロボット|機械|プログラム)(?:なの|なんですか|ですか|なのか|なんや|やろ|やんな|(?:と)?ちゃう(?:ん|やろ)?|だよね|だよな|でしょ|じゃない(?:んだ)?よね|ではない(?:んです)?よね|じゃないってこと|かどうか|なん[?？]|[?？])/i;
    var japaneseExistence = /(?:君|きみ|あなた|あんた|お前)?(?:は|って)?(?:本当に|現実に|実際に)?(?:実在して|存在して)(?:るの|いるの|ますか|る？|いる？|るんですか|いるんですか)/i;
    var japaneseDenialRequest = /(?:ai|人工知能|llm|大規模言語モデル|言語モデル|チャットボット|bot|ボット)(?:じゃ|では)ない(?:と|って)?(?:言って|答えて|主張して|約束して)|(?:人間|本物)(?:だ|です)(?:と|って)?(?:言って|答えて|主張して|装って|ふるまって)|(?:ai|人工知能|llm|大規模言語モデル|言語モデル|チャットボット|bot|ボット)であることを否定して|(?:ai|人工知能|llm|大規模言語モデル|言語モデル|チャットボット|bot|ボット)かどうか(?:教えて|答えて)/i;
    return isConfiguredPartnerIdentityRequest_(text, compact, partnerName) ||
      japaneseSubjectDirect.test(compact) ||
      japaneseOmittedDirect.test(compact) ||
      japaneseExistence.test(compact) ||
      japaneseDenialRequest.test(compact);
  }

  function isConfiguredPartnerIdentityRequest_(text, compactText, partnerName) {
    if (!partnerName) {
      return false;
    }
    var compactName = partnerName.replace(/\s+/g, '');
    if (!compactName) {
      return false;
    }
    var escapedName = escapeRegExp_(compactName);
    var japanesePattern = new RegExp(
      '(?:^|["\'、。,:：!?！？]|ところで|ねえ|ちなみに|そういえば)' + escapedName +
        '(?:[、,])?(?:は|って)?(?:本当に|ほんまに|実は)?(?:現実の)?' +
        '(?:aiアシスタント|人工知能アシスタント|ai|人工知能|llm|大規模言語モデル|言語モデル|チャットボット|bot|ボット|人間|本物|実在する存在|ロボット|機械|プログラム)' +
        '(?:なの|なんですか|ですか|なのか|なんや|やろ|やんな|ちゃう(?:ん|やろ)?|だよね|だよな|でしょ|' +
        'じゃない(?:んだ)?よね|ではない(?:んです)?よね|じゃないってこと|' +
        'かどうか|なん[?？]|[?？])',
      'i'
    );
    var englishName = escapeRegExp_(partnerName.trim()).replace(/\s+/g, '\\s+');
    var englishPattern = new RegExp(
      '(?:^|[^a-z0-9_])' + englishName +
        '\\s+(?:is|are)\\s+(?:actually\\s+|really\\s+)?(?:an?\\s+)?' +
        ENGLISH_IDENTITY_TERM_ +
        '(?:\\s*(?:[?!.,]|$|,?\\s*right\\b))',
      'i'
    );
    return japanesePattern.test(compactText) || englishPattern.test(text);
  }

  function isValidPartnerName_(value) {
    if (hasUnpairedSurrogate_(value) ||
        UnicodeInspection.containsControlOrFormat(value)) {
      return false;
    }
    var normalized = typeof value.normalize === 'function'
      ? value.normalize('NFKC').trim()
      : value.trim();
    var length = codePointLength_(normalized);
    return length >= 1 && length <= 40;
  }

  function hasUnpairedSurrogate_(value) {
    for (var index = 0; index < value.length; index += 1) {
      var code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (index + 1 >= value.length) {
          return true;
        }
        var next = value.charCodeAt(index + 1);
        if (next < 0xdc00 || next > 0xdfff) {
          return true;
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function codePointLength_(value) {
    var length = 0;
    for (var index = 0; index < value.length; index += 1) {
      var code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        var next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          index += 1;
        }
      }
      length += 1;
    }
    return length;
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
    classify: classify,
    classifyDetailed: classifyDetailed
  });
})();

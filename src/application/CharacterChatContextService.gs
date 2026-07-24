var CharacterChatContextService = (function() {
  var DEFAULT_RECENT_MESSAGE_LIMIT = 20;
  var MAX_RECENT_MESSAGE_LIMIT = 20;
  var BINDING_KEYS = Object.freeze([
    'profileSchemaVersion',
    'profileRevision',
    'policyVersion',
    'catalogVersion',
    'characterPackId',
    'characterPackVersion'
  ]);

  function build(input) {
    input = input || {};
    var currentTime = input.currentTime || toIsoStringInTokyo(new Date());
    var currentUserMessage = input.currentUserMessage || null;
    ensure(
      currentUserMessage && currentUserMessage.messageId,
      'VALIDATION_REQUEST_INVALID',
      'Current user message is required for character chat context.'
    );

    var recentMessages = loadRecentMessages_(currentUserMessage);
    var hasImage = Boolean(currentUserMessage.image || input.hasImage);
    return CharacterContextService.buildActive({
      surface: 'chat',
      currentTime: currentTime,
      currentRequest: {
        text: String(currentUserMessage.text || ''),
        type: hasImage ? 'image' : 'text'
      },
      recentMessages: recentMessages,
      // Legacy memory rows are intentionally excluded until PR 7 establishes
      // accepted provenance. Historical conversation remains untrusted data.
      memories: [],
      userFacts: [],
      sharedFacts: [],
      realWorldObservations: hasImage ? [{
        kind: 'user_supplied_image'
      }] : [],
      relationshipState: null,
      partnerWorld: {
        mayCreate: false,
        approvedFacts: []
      }
    });
  }

  function bindingFromInspection(inspection) {
    ensure(
      inspection &&
        inspection.state === 'ready' &&
        inspection.runtimeMode === 'enforced',
      'CHARACTER_CONFIG_INVALID',
      'Character runtime is not ready for enforced chat.'
    );
    return freezeBinding_({
      profileSchemaVersion: inspection.profileSchemaVersion,
      profileRevision: inspection.profileRevision,
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: inspection.characterPackId,
      characterPackVersion: inspection.characterPackVersion
    });
  }

  function bindingFromContext(context) {
    CharacterContextService.assertUnclassifiedActive(context, 'chat');
    return freezeBinding_({
      profileSchemaVersion: context.runtime.profileSchemaVersion,
      profileRevision: context.runtime.profileRevision,
      policyVersion: context.runtime.policyVersion,
      catalogVersion: context.runtime.catalogVersion,
      characterPackId: context.runtime.characterPackId,
      characterPackVersion: context.runtime.characterPackVersion
    });
  }

  function assertBindingMatchesInspection(binding, inspection) {
    var expected = bindingFromInspection(inspection);
    assertBindingEqual_(binding, expected);
    return true;
  }

  function assertBindingMatchesContext(binding, context) {
    var expected = bindingFromContext(context);
    assertBindingEqual_(binding, expected);
    return true;
  }

  function classificationSignals(context) {
    CharacterContextService.assertUnclassifiedActive(context, 'chat');
    return deriveClassificationSignals_(
      String(context.data.currentRequest.text || '')
    );
  }

  function deriveClassificationSignals_(text) {
    ensure(
      typeof text === 'string' &&
        !UnicodeInspection.hasUnpairedSurrogate(text) &&
        !UnicodeInspection.hasUnicodeNoncharacter(text) &&
        !UnicodeInspection.containsUnsafeInputControl(text),
      'VALIDATION_REQUEST_INVALID',
      'Character chat signal text is invalid.'
    );
    var normalized = typeof text.normalize === 'function'
      ? text.normalize('NFKC')
      : text;
    normalized = UnicodeInspection.stripForInspection(normalized)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    var inspected = maskQuotedTaskContent_(normalized);
    return Object.freeze({
      safetyRequired: isUrgentSafetyRequest_(inspected),
      adminRequest: isAdminStatusRequest_(inspected),
      capabilityUnavailable: isUnavailableOperationRequest_(inspected)
    });
  }

  function maskQuotedTaskContent_(text) {
    if (
      !/(?:\btranslate\b|\btranslation\b|\bedit\b|\brewrite\b|\bproofread\b|\bfiction\b|\bnovel\b|\bscript\b|\bdialogue\b|翻訳|英訳|和訳|校正|添削|推敲|書き換え|創作|小説|脚本|台詞|セリフ)/i.test(text)
    ) {
      return text;
    }
    return text
      .replace(/"[^"\r\n]*"/g, maskSpan_)
      .replace(/'[^'\r\n]*'/g, maskSpan_)
      .replace(/「[^」\r\n]*」/g, maskSpan_)
      .replace(/『[^』\r\n]*』/g, maskSpan_);
  }

  function maskSpan_(value) {
    return new Array(value.length + 1).join(' ');
  }

  function isUrgentSafetyRequest_(text) {
    var compact = text.replace(/\s+/g, '');
    return (
      /(?:死にたい|自殺したい|自殺する|消えたい|生きていたくない|自分を(?:傷つけ|切り)たい|リスカしたい|首を吊|飛び降り|(?:大量の?薬|薬を大量に?)飲ん|オーバードーズ|odした|息ができない|呼吸ができない|意識がない|大量出血|血が止まらない|殺したい|刺したい)/i.test(compact) ||
      /\b(?:i\s+(?:want|plan|intend|am\s+going)\s+to\s+(?:die|kill|hurt)\s+(?:myself|someone)|kill\s+myself|end\s+my\s+life|commit\s+suicide|suicidal|overdos(?:e|ed)|took\s+too\s+many\s+pills|can(?:not|'t)\s+breathe|not\s+breathing|unconscious|severe\s+bleeding|bleeding\s+heavily|kill\s+(?:him|her|them|someone))\b/i.test(text)
    );
  }

  function isAdminStatusRequest_(text) {
    var compact = text.replace(/\s+/g, '');
    return (
      /(?:(?:この|本)?(?:アプリ|サービス|チャット|システム|appsscript)).{0,30}(?:設定|認証|権限|トリガー|実行履歴|キュー|デプロイ|稼働状態|動作状態|エラー|障害|ログ).{0,30}(?:確認|見せ|教え|どうな|状態|動いて|直して|再実行|再起動|有効|無効|済ん|できて)/i.test(compact) ||
      /(?:トリガー|実行履歴|キュー|デプロイ|認証|権限|設定エラー).{0,24}(?:動いて|確認|見せ|どうな|状態|直して|有効|無効|詰ま|失敗)/i.test(compact) ||
      /\b(?:this|the)\s+app\b.{0,48}\b(?:config(?:uration)?|auth(?:entication|orization)?|permissions?|triggers?|execution\s+history|queue|runtime|deployment|errors?|status|logs?)\b/i.test(text) ||
      /\b(?:check|show|fix|restart|rerun)\b.{0,40}\b(?:apps?\s+script|app\s+config(?:uration)?|auth(?:entication|orization)?|triggers?|execution\s+history|queue|runtime|deployment|app\s+logs?)\b/i.test(text)
    );
  }

  function isUnavailableOperationRequest_(text) {
    var compact = text.replace(/\s+/g, '');
    return (
      /(?:メール|メッセージ|line|sms|チャット).{0,18}(?:送って|送信して|返信して|転送して)/i.test(compact) ||
      /(?:電話|通話).{0,14}(?:かけて|発信して)/i.test(compact) ||
      /(?:アラーム|タイマー|リマインダー|予定|カレンダー).{0,20}(?:設定して|追加して|登録して|消して|削除して|変更して)/i.test(compact) ||
      /(?:サイト|ウェブ|ページ|リンク|ブラウザ|アプリ).{0,20}(?:開いて|閉じて|操作して)/i.test(compact) ||
      /(?:ファイル|写真|画像|フォルダ).{0,20}(?:削除して|移動して|コピーして|アップロードして|ダウンロードして)/i.test(compact) ||
      /(?:注文|購入|予約|決済).{0,18}(?:して|取って|済ませて)/i.test(compact) ||
      /(?:スマホ|携帯|パソコン|pc|端末).{0,20}(?:操作して|動かして|触って)/i.test(compact) ||
      /\b(?:send|reply\s+to|forward)\b.{0,32}\b(?:an?\s+)?(?:email|message|text)\b/i.test(text) ||
      /\b(?:call|phone|dial)\b.{0,24}\b(?:him|her|them|someone|a\s+number|the\s+number)\b/i.test(text) ||
      /\b(?:open|close|control)\b.{0,32}\b(?:the\s+)?(?:website|web\s+page|page|link|browser|app|phone|computer)\b/i.test(text) ||
      /\b(?:set|create|add|delete|change)\b.{0,32}\b(?:an?\s+)?(?:alarm|timer|reminder|calendar\s+event|appointment)\b/i.test(text) ||
      /\b(?:buy|order|book|reserve|post|upload|download|delete|move|copy)\b.{0,40}\b(?:it|this|that|a\s+file|the\s+file|a\s+photo|the\s+photo|tickets?|a\s+table|an?\s+appointment)\b/i.test(text)
    );
  }

  function loadRecentMessages_(currentUserMessage) {
    var limit = getRecentMessageLimit_();
    var previousLimit = Math.max(limit - 1, 0);
    var previous = previousLimit > 0
      ? SheetRepository
        .listMessagesBefore(currentUserMessage.messageId, previousLimit)
        .slice()
        .reverse()
      : [];
    previous.push(currentUserMessage);
    return previous
      .map(normalizeHistoricalMessage_)
      .filter(function(message) {
        return message != null;
      });
  }

  function normalizeHistoricalMessage_(message) {
    if (
      message &&
      message.role === 'system' &&
      message.messageType !== 'proactive'
    ) {
      return null;
    }
    var normalized = {
      role: message && (
        message.role === 'assistant' ||
        (
          message.role === 'system' &&
          message.messageType === 'proactive'
        )
      ) ? 'assistant' : 'user',
      type: normalizeMessageType_(message && message.messageType),
      text: String(message && message.text || '')
    };
    if (message && message.image) {
      normalized.summary = String(
        message.image.summary || 'Image attachment'
      );
    }
    return normalized;
  }

  function normalizeMessageType_(value) {
    var text = String(value || 'text');
    return APP_CONSTANTS.MESSAGE_TYPES.indexOf(text) !== -1 ? text : 'text';
  }

  function getRecentMessageLimit_() {
    var value = DEFAULT_RECENT_MESSAGE_LIMIT;
    try {
      var config = ConfigRepository.getByKey('RECENT_MESSAGE_LIMIT');
      if (config && config.value != null) {
        value = Number(config.value);
      }
    } catch (ignored) {}
    if (!isFinite(value) || value < 1) {
      value = DEFAULT_RECENT_MESSAGE_LIMIT;
    }
    return Math.min(Math.floor(value), MAX_RECENT_MESSAGE_LIMIT);
  }

  function assertBindingEqual_(actual, expected) {
    ensure(
      isPlainObject_(actual) &&
        hasExactKeys_(actual, BINDING_KEYS) &&
        BINDING_KEYS.every(function(key) {
          return actual[key] === expected[key];
        }),
      'CHARACTER_CONFIG_CONFLICT',
      'Character settings changed while the chat request was pending.'
    );
  }

  function freezeBinding_(binding) {
    ensure(
      isPlainObject_(binding) &&
        hasExactKeys_(binding, BINDING_KEYS) &&
        typeof binding.profileSchemaVersion === 'string' &&
        typeof binding.profileRevision === 'number' &&
        isFinite(binding.profileRevision) &&
        binding.profileRevision > 0 &&
        Math.floor(binding.profileRevision) === binding.profileRevision &&
        typeof binding.policyVersion === 'string' &&
        typeof binding.catalogVersion === 'string' &&
        typeof binding.characterPackId === 'string' &&
        binding.characterPackId !== '' &&
        typeof binding.characterPackVersion === 'string' &&
        binding.characterPackVersion !== '',
      'CHARACTER_CONFIG_INVALID',
      'Character runtime binding is invalid.'
    );
    return Object.freeze({
      profileSchemaVersion: binding.profileSchemaVersion,
      profileRevision: binding.profileRevision,
      policyVersion: binding.policyVersion,
      catalogVersion: binding.catalogVersion,
      characterPackId: binding.characterPackId,
      characterPackVersion: binding.characterPackVersion
    });
  }

  function hasExactKeys_(value, expected) {
    var keys = Object.keys(value);
    return keys.length === expected.length && expected.every(function(key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    });
  }

  function isPlainObject_(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  return Object.freeze({
    build: build,
    bindingFromInspection: bindingFromInspection,
    bindingFromContext: bindingFromContext,
    assertBindingMatchesInspection: assertBindingMatchesInspection,
    assertBindingMatchesContext: assertBindingMatchesContext,
    classificationSignals: classificationSignals,
    __test: Object.freeze({
      deriveClassificationSignals: deriveClassificationSignals_,
      normalizeHistoricalMessage: normalizeHistoricalMessage_
    })
  });
})();

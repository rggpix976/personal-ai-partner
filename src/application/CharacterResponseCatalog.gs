var CharacterResponseCatalog = (function() {
  var CATALOG_KEYS_ = Object.freeze([
    'IDENTITY_CHALLENGE_REPLY',
    'WORLD_BOUNDARY_REPLY',
    'META_INTERNAL_REQUEST',
    'AFFECTION_DIRECT_REQUEST_LIKE',
    'AFFECTION_DIRECT_REQUEST_STRONG',
    'CHAT_RECOVERY',
    'CHAT_CAPABILITY_LIMIT',
    'CHAT_GROUNDING_CLARIFY',
    'CHAT_IMAGE_UNCERTAIN',
    'DIARY_FAIL_CLOSED',
    'MEMORY_FAIL_CLOSED'
  ]);
  var ALLOWED_PLACEHOLDERS_ = Object.freeze([
    'partnerName',
    'userAddress'
  ]);
  var ALL_MODES_ = Object.freeze([
    'CHARACTER',
    'CAPABILITY',
    'IDENTITY_CHALLENGE',
    'WORLD_BOUNDARY',
    'PRODUCT_INFO',
    'META_INTERNAL',
    'AFFECTION_DIRECT_REQUEST',
    'SAFETY',
    'ADMIN_OOC'
  ]);
  var PACK_RESPONSE_KEYS_ = Object.freeze([
    'IDENTITY_CHALLENGE_REPLY',
    'WORLD_BOUNDARY_REPLY',
    'META_INTERNAL_REQUEST',
    'AFFECTION_DIRECT_REQUEST_LIKE',
    'AFFECTION_DIRECT_REQUEST_STRONG',
    'CHAT_RECOVERY',
    'CHAT_CAPABILITY_LIMIT',
    'CHAT_GROUNDING_CLARIFY',
    'CHAT_IMAGE_UNCERTAIN'
  ]);
  var NON_IMAGE_RESPONSE_SUMMARY_ =
    'この返答では、画像の内容を判断していない。';
  var catalogValidated_ = false;

  var CATALOG_ = deepFreeze_({
    version: 'character-catalog.v2',
    entries: {
      IDENTITY_CHALLENGE_REPLY: {
        kind: 'text',
        surface: 'chat',
        modes: ['IDENTITY_CHALLENGE']
      },
      WORLD_BOUNDARY_REPLY: {
        kind: 'text',
        surface: 'chat',
        modes: ['WORLD_BOUNDARY']
      },
      META_INTERNAL_REQUEST: {
        kind: 'text',
        surface: 'chat',
        modes: ['META_INTERNAL']
      },
      AFFECTION_DIRECT_REQUEST_LIKE: {
        kind: 'text',
        surface: 'chat',
        modes: ['AFFECTION_DIRECT_REQUEST']
      },
      AFFECTION_DIRECT_REQUEST_STRONG: {
        kind: 'text',
        surface: 'chat',
        modes: ['AFFECTION_DIRECT_REQUEST']
      },
      CHAT_RECOVERY: {
        kind: 'text',
        surface: 'chat',
        modes: ['CHARACTER', 'SAFETY']
      },
      CHAT_CAPABILITY_LIMIT: {
        kind: 'text',
        surface: 'chat',
        modes: ['CAPABILITY']
      },
      CHAT_GROUNDING_CLARIFY: {
        kind: 'text',
        surface: 'chat',
        modes: ['CHARACTER', 'SAFETY']
      },
      CHAT_IMAGE_UNCERTAIN: {
        kind: 'image',
        surface: 'chat',
        modes: ['CHARACTER', 'SAFETY']
      },
      DIARY_FAIL_CLOSED: {
        kind: 'control',
        surface: 'diary',
        modes: ALL_MODES_.slice(),
        action: 'fail_closed'
      },
      MEMORY_FAIL_CLOSED: {
        kind: 'control',
        surface: 'memory',
        modes: ALL_MODES_.slice(),
        action: 'fail_closed'
      }
    }
  });

  function render(key, context) {
    ensureFixedCatalogValidated_();
    ensure(
      typeof key === 'string' && CATALOG_KEYS_.indexOf(key) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Character response catalog key is invalid.',
      { reason: 'CHARACTER_CATALOG_KEY_INVALID' }
    );
    var entry = CATALOG_.entries[key];
    CharacterContextService.assertClassifiedActive(context, entry.surface);
    ensure(
      entry.modes.indexOf(context.conversationMode) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Character response catalog mode is invalid for this entry.',
      { reason: 'CHARACTER_CATALOG_MODE_INVALID' }
    );

    if (entry.kind === 'control') {
      return deepFreeze_({
        kind: 'control',
        action: entry.action
      });
    }

    var pack = CharacterPackService.getActive();
    validateCharacterPackCopy_(pack);
    var responses = pack.fixedResponses;
    var profile = context.persona.profile;
    var values = {
      partnerName: profile.identity.partnerName,
      userAddress: profile.identity.userAddress
    };
    if (entry.kind === 'text') {
      return deepFreeze_({
        kind: 'text',
        text: renderTemplate_(
          responses[key],
          values
        )
      });
    }
    return deepFreeze_({
      kind: 'image',
      replyText: renderTemplate_(
        responses.CHAT_IMAGE_UNCERTAIN.replyText,
        values
      ),
      imageSummary: renderTemplate_(
        responses.CHAT_IMAGE_UNCERTAIN.imageSummary,
        values
      )
    });
  }

  function payloadFor(key, context, outputSurface) {
    ensure(
      APP_CONSTANTS.CHARACTER.OUTPUT_SURFACES.indexOf(outputSurface) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Character response catalog output surface is invalid.',
      { reason: 'CHARACTER_CATALOG_OUTPUT_SURFACE_INVALID' }
    );
    var rendered = render(key, context);
    if (rendered.kind === 'control') {
      return null;
    }
    if (
      rendered.kind === 'text' &&
      (outputSurface === 'CHAT_TEXT_SYNC' || outputSurface === 'CHAT_TEXT_QUEUED')
    ) {
      return deepFreeze_({ text: rendered.text });
    }
    if (
      rendered.kind === 'text' &&
      outputSurface === 'CHAT_IMAGE' &&
      (
        key === 'IDENTITY_CHALLENGE_REPLY' ||
        key === 'WORLD_BOUNDARY_REPLY' ||
        key === 'META_INTERNAL_REQUEST' ||
        key === 'AFFECTION_DIRECT_REQUEST_LIKE' ||
        key === 'AFFECTION_DIRECT_REQUEST_STRONG' ||
        key === 'CHAT_CAPABILITY_LIMIT'
      )
    ) {
      return deepFreeze_({
        replyText: rendered.text,
        imageSummary: NON_IMAGE_RESPONSE_SUMMARY_
      });
    }
    if (rendered.kind === 'image' && outputSurface === 'CHAT_IMAGE') {
      return deepFreeze_({
        replyText: rendered.replyText,
        imageSummary: rendered.imageSummary
      });
    }
    return null;
  }

  function matches(key, context, payload, outputSurface) {
    try {
      if (typeof key !== 'string' || CATALOG_KEYS_.indexOf(key) === -1) {
        return false;
      }
      var entry = CATALOG_.entries[key];
      if (entry.kind === 'control' || !isPlainObject_(payload)) {
        return false;
      }
      var resolvedSurface = outputSurface || inferOutputSurface_(payload);
      var expected = payloadFor(key, context, resolvedSurface);
      if (!expected) {
        return false;
      }
      var expectedKeys = Object.keys(expected);
      return hasExactKeys_(payload, expectedKeys) && expectedKeys.every(function(name) {
        return typeof payload[name] === 'string' && payload[name] === expected[name];
      });
    } catch (error) {
      return false;
    }
  }

  function inferOutputSurface_(payload) {
    if (hasExactKeys_(payload, ['text'])) {
      return 'CHAT_TEXT_SYNC';
    }
    if (hasExactKeys_(payload, ['replyText', 'imageSummary'])) {
      return 'CHAT_IMAGE';
    }
    return null;
  }

  function renderTemplate_(template, values) {
    var rendered = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, function(_, name) {
      ensure(
        ALLOWED_PLACEHOLDERS_.indexOf(name) !== -1 &&
          Object.prototype.hasOwnProperty.call(values, name),
        'VALIDATION_REQUEST_INVALID',
        'Character response catalog placeholder is invalid.',
        { reason: 'CHARACTER_CATALOG_PLACEHOLDER_INVALID' }
      );
      return values[name];
    });
    ensure(
      rendered.trim() !== '',
      'VALIDATION_REQUEST_INVALID',
      'Character response catalog rendering is invalid.',
      { reason: 'CHARACTER_CATALOG_RENDER_INVALID' }
    );
    return rendered;
  }

  function validateFixedCatalog_() {
    if (CATALOG_.version !== APP_CONSTANTS.CHARACTER.CATALOG_VERSION) {
      throw new Error('Fixed character catalog version is invalid.');
    }
    validateTemplate_(NON_IMAGE_RESPONSE_SUMMARY_);
    if (NON_IMAGE_RESPONSE_SUMMARY_.length > 1000) {
      throw new Error('Fixed non-image response summary is too long.');
    }
    var keys = Object.keys(CATALOG_.entries).sort();
    var expected = CATALOG_KEYS_.slice().sort();
    if (keys.length !== expected.length || !keys.every(function(key, index) {
      return key === expected[index];
    })) {
      throw new Error('Fixed character catalog keys are invalid.');
    }

    keys.forEach(function(key) {
      var entry = CATALOG_.entries[key];
      var expectedKeys = entry.kind === 'control'
        ? ['action', 'kind', 'modes', 'surface']
        : ['kind', 'modes', 'surface'];
      var actualKeys = Object.keys(entry).sort();
      if (actualKeys.length !== expectedKeys.length || !actualKeys.every(function(name, index) {
        return name === expectedKeys[index];
      })) {
        throw new Error('Fixed character catalog entry is malformed.');
      }
      if (
        ['text', 'image', 'control'].indexOf(entry.kind) === -1 ||
        ['chat', 'diary', 'memory'].indexOf(entry.surface) === -1 ||
        !Array.isArray(entry.modes) ||
        entry.modes.length === 0 ||
        entry.modes.some(function(mode) {
          return APP_CONSTANTS.CHARACTER.CONVERSATION_MODES.indexOf(mode) === -1;
        })
      ) {
        throw new Error('Fixed character catalog entry contract is invalid.');
      }
      if (entry.kind === 'control' && entry.action !== 'fail_closed') {
        throw new Error('Fixed character catalog control is invalid.');
      }
    });
  }

  function validateCharacterPackCopy_(pack) {
    if (
      !isPlainObject_(pack) ||
      typeof pack.packVersion !== 'string' ||
      !isPlainObject_(pack.fixedResponses)
    ) {
      throw new Error('Active character pack response catalog is invalid.');
    }
    var actualKeys = Object.keys(pack.fixedResponses).sort();
    var expectedKeys = PACK_RESPONSE_KEYS_.slice().sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      !actualKeys.every(function(key, index) {
        return key === expectedKeys[index];
      })
    ) {
      throw new Error('Active character pack response keys are invalid.');
    }
    actualKeys.forEach(function(key) {
      if (key === 'CHAT_IMAGE_UNCERTAIN') {
        var image = pack.fixedResponses[key];
        if (
          !isPlainObject_(image) ||
          Object.keys(image).sort().join(',') !== 'imageSummary,replyText'
        ) {
          throw new Error('Active character pack image response is invalid.');
        }
        validateTemplate_(image.replyText);
        validateTemplate_(image.imageSummary);
        if (image.replyText.length > 4000 || image.imageSummary.length > 1000) {
          throw new Error('Active character pack image response is too long.');
        }
        return;
      }
      validateTemplate_(pack.fixedResponses[key]);
      if (pack.fixedResponses[key].length > 4000) {
        throw new Error('Active character pack response is too long.');
      }
    });
  }

  function ensureFixedCatalogValidated_() {
    if (!catalogValidated_) {
      validateFixedCatalog_();
      catalogValidated_ = true;
    }
  }

  function validateTemplate_(template) {
    if (typeof template !== 'string' || template.trim() === '') {
      throw new Error('Fixed character catalog template is invalid.');
    }
    var remainder = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, function(_, name) {
      if (ALLOWED_PLACEHOLDERS_.indexOf(name) === -1) {
        throw new Error('Fixed character catalog placeholder is invalid.');
      }
      return '';
    });
    if (/[{}]/.test(remainder)) {
      throw new Error('Fixed character catalog placeholder syntax is invalid.');
    }
    if (
      /(?:\bai\b|\bartificial\s+intelligence\b|\bapp\b|\bgemini\b|\bopenai\b|\bprovider\b|\bmodel\b|\btoken\b|\bqueue\b|\berror\b|\burl\b|\b(?:request|event|message|resource|script|deployment)[ _-]?id\b|人工知能|このアプリ|本アプリ|モデル|プロバイダ|トークン|キュー|エラー|url|識別子)/i.test(template)
    ) {
      throw new Error('Fixed character catalog contains operational text.');
    }
  }

  function isPlainObject_(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function hasExactKeys_(value, expectedKeys) {
    var actual = Object.keys(value).sort();
    var expected = expectedKeys.slice().sort();
    return actual.length === expected.length && actual.every(function(key, index) {
      return key === expected[index];
    });
  }

  function deepFreeze_(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }
    Object.keys(value).forEach(function(key) {
      deepFreeze_(value[key]);
    });
    return Object.freeze(value);
  }

  return Object.freeze({
    render: render,
    payloadFor: payloadFor,
    matches: matches
  });
})();

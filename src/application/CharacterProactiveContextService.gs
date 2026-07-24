var CharacterProactiveContextService = (function() {
  var DEFAULT_RECENT_MESSAGE_LIMIT = 20;
  var MAX_RECENT_MESSAGE_LIMIT = 20;
  var HISTORY_QUERY_MULTIPLIER = 3;
  var BINDING_KEYS = Object.freeze([
    'profileSchemaVersion',
    'profileRevision',
    'policyVersion',
    'catalogVersion',
    'characterPackId',
    'characterPackVersion'
  ]);
  var CHAT_APPROVAL_SURFACES = Object.freeze([
    'CHAT_TEXT_SYNC',
    'CHAT_TEXT_QUEUED',
    'CHAT_IMAGE'
  ]);

  function build(input) {
    input = input || {};
    var currentTime = input.currentTime || toIsoStringInTokyo(new Date());
    ensure(
      Validators.isIsoDateTimeString(currentTime),
      'VALIDATION_REQUEST_INVALID',
      'Proactive character context time is invalid.'
    );

    var recentMessages = loadRecentMessages_();
    var acceptedMemories = loadAcceptedMemories_(
      recentMessages.map(function(message) {
        return message.text;
      }).join(' '),
      5
    );
    var partnerWorldFacts =
      typeof CharacterDiaryContextService !== 'undefined' &&
      CharacterDiaryContextService &&
      typeof CharacterDiaryContextService
        .loadApprovedPartnerWorldFactsBefore === 'function'
        ? CharacterDiaryContextService.loadApprovedPartnerWorldFactsBefore(
          String(currentTime).slice(0, 10),
          12
        )
        : [];
    return CharacterContextService.buildActive({
      surface: 'proactive',
      currentTime: currentTime,
      // A proactive turn has no user-authored current request. Eligibility,
      // queue metadata, and raw activity timestamps must not be promoted into
      // character evidence merely to give the generator a synthetic prompt.
      currentRequest: null,
      recentMessages: recentMessages,
      memories: acceptedMemories,
      userFacts: [],
      sharedFacts: [],
      realWorldObservations: [],
      relationshipState: null,
      partnerWorld: {
        mayCreate: false,
        approvedFacts: partnerWorldFacts
      }
    });
  }

  function loadAcceptedMemories_(query, limit) {
    if (
      typeof MemoryService === 'undefined' ||
      !MemoryService ||
      typeof MemoryService.findAcceptedRelevant !== 'function'
    ) {
      return [];
    }
    return (MemoryService.findAcceptedRelevant(query, limit) || [])
      .map(function(memory) {
        return {
          category: memory.category,
          normalizedKey: memory.normalizedKey,
          content: memory.content,
          confidence: memory.confidence
        };
      });
  }

  function bindingFromInspection(inspection) {
    ensure(
      inspection &&
        inspection.state === 'ready' &&
        inspection.runtimeMode === 'enforced',
      'CHARACTER_CONFIG_INVALID',
      'Character runtime is not ready for enforced proactive output.'
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
    CharacterContextService.assertUnclassifiedActive(
      context,
      'proactive'
    );
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
    assertBindingEqual_(binding, bindingFromInspection(inspection));
    return true;
  }

  function assertBindingMatchesContext(binding, context) {
    assertBindingEqual_(binding, bindingFromContext(context));
    return true;
  }

  function classificationSignals(context) {
    CharacterContextService.assertUnclassifiedActive(
      context,
      'proactive'
    );
    // There is no typed current request to classify. Exceptional chat routes
    // must not be inferred from prior untrusted conversation.
    return Object.freeze({
      safetyRequired: false,
      adminRequest: false,
      capabilityUnavailable: false
    });
  }

  function loadRecentMessages_() {
    var limit = getRecentMessageLimit_();
    var queryLimit = Math.max(
      limit,
      limit * HISTORY_QUERY_MULTIPLIER
    );
    var messages = SheetRepository.listRecentMessages(queryLimit) || [];
    return messages
      .map(normalizeHistoricalMessage_)
      .filter(function(message) {
        return message != null;
      })
      .slice(0, limit)
      .reverse();
  }

  function normalizeHistoricalMessage_(message) {
    if (!message || typeof message !== 'object') {
      return null;
    }

    var isUser = message.role === 'user';
    var isApprovedAssistant =
      message.role === 'assistant' &&
      message.status === 'completed' &&
      hasChatApproval_(message.characterApproval);
    if (!isUser && !isApprovedAssistant) {
      return null;
    }

    var type = normalizeMessageType_(message.messageType);
    if (type !== 'text' && type !== 'image') {
      return null;
    }

    var normalized = {
      role: isApprovedAssistant ? 'assistant' : 'user',
      type: type,
      text: String(message.text || '')
    };
    if (
      type === 'image' &&
      message.image &&
      hasImageApproval_(message.characterApproval) &&
      String(message.image.summary || '').trim() !== ''
    ) {
      normalized.summary = String(message.image.summary);
    }
    return normalized;
  }

  function hasChatApproval_(approval) {
    return (
      approval &&
      typeof approval === 'object' &&
      !Array.isArray(approval) &&
      CHAT_APPROVAL_SURFACES.indexOf(approval.surface) !== -1
    );
  }

  function hasImageApproval_(approval) {
    return (
      approval &&
      typeof approval === 'object' &&
      !Array.isArray(approval) &&
      approval.surface === 'CHAT_IMAGE'
    );
  }

  function normalizeMessageType_(value) {
    var type = String(value || 'text');
    return APP_CONSTANTS.MESSAGE_TYPES.indexOf(type) !== -1
      ? type
      : 'text';
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
    return Math.min(
      Math.floor(value),
      MAX_RECENT_MESSAGE_LIMIT
    );
  }

  function assertBindingEqual_(actual, expected) {
    ensure(
      isPlainObject_(actual) &&
        hasExactKeys_(actual, BINDING_KEYS) &&
        BINDING_KEYS.every(function(key) {
          return actual[key] === expected[key];
        }),
      'CHARACTER_CONFIG_CONFLICT',
      'Character settings changed while proactive output was pending.'
    );
  }

  function freezeBinding_(binding) {
    ensure(
      isPlainObject_(binding) &&
        hasExactKeys_(binding, BINDING_KEYS) &&
        typeof binding.profileSchemaVersion === 'string' &&
        typeof binding.profileRevision === 'number' &&
        Number.isSafeInteger(binding.profileRevision) &&
        binding.profileRevision > 0 &&
        typeof binding.policyVersion === 'string' &&
        typeof binding.catalogVersion === 'string' &&
        typeof binding.characterPackId === 'string' &&
        binding.characterPackId !== '' &&
        typeof binding.characterPackVersion === 'string' &&
        binding.characterPackVersion !== '',
      'CHARACTER_CONFIG_INVALID',
      'Proactive character runtime binding is invalid.'
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

  function hasExactKeys_(value, expectedKeys) {
    var keys = Object.keys(value);
    return keys.length === expectedKeys.length &&
      expectedKeys.every(function(key) {
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
      normalizeHistoricalMessage: normalizeHistoricalMessage_,
      getRecentMessageLimit: getRecentMessageLimit_
    })
  });
})();

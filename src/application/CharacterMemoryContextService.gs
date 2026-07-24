var CharacterMemoryContextService = (function() {
  var MAX_SOURCE_MESSAGES = 100;
  var MAX_ACTIVE_MEMORIES = 100;
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
  var PROACTIVE_APPROVAL_SURFACES = Object.freeze([
    'PROACTIVE_AI',
    'PROACTIVE_RETRY'
  ]);

  function build(input) {
    input = input || {};
    var currentTime = input.currentTime ||
      toIsoStringInTokyo(new Date());
    ensure(
      Validators.isIsoDateTimeString(currentTime),
      'VALIDATION_REQUEST_INVALID',
      'Memory character context time is invalid.'
    );
    var sourceMessages = (input.sourceMessages || [])
      .map(normalizeSourceMessage_)
      .filter(function(message) {
        return message != null;
      })
      .slice(-MAX_SOURCE_MESSAGES);
    ensure(
      sourceMessages.length > 0,
      'VALIDATION_REQUEST_INVALID',
      'No approved source messages were available for memory extraction.'
    );
    var acceptedMemories = loadAcceptedMemories_();

    return CharacterContextService.buildActive({
      surface: 'memory',
      currentTime: currentTime,
      currentRequest: null,
      recentMessages: sourceMessages,
      memories: acceptedMemories.slice(0, MAX_ACTIVE_MEMORIES),
      userFacts: [],
      sharedFacts: [],
      realWorldObservations: [],
      relationshipState: null,
      partnerWorld: null
    });
  }

  function loadAcceptedMemories_() {
    if (
      !SheetRepository ||
      typeof SheetRepository.listActiveMemories !== 'function'
    ) {
      return [];
    }
    return (SheetRepository.listActiveMemories() || [])
      .map(normalizeApprovedMemoryRow_)
      .filter(function(memory) {
        return memory != null;
      })
      .slice(0, MAX_ACTIVE_MEMORIES);
  }

  function isAcceptedMemoryRow(row) {
    return normalizeApprovedMemoryRow_(row) != null;
  }

  function normalizeApprovedMemoryRow_(row) {
    if (
      !row ||
      row.status !== 'active' ||
      !Validators.isUuidV4(String(row.memory_id || '')) ||
      !isUuidList_(row.memory_origin_event_ids_json) ||
      !isApproval_(row.memory_approval_json) ||
      APP_CONSTANTS.MEMORY_CATEGORIES.indexOf(row.category) === -1 ||
      typeof row.normalized_key !== 'string' ||
      row.normalized_key.trim() === '' ||
      typeof row.content !== 'string' ||
      row.content.trim() === '' ||
      !isUuidList_(row.source_message_ids_json)
    ) {
      return null;
    }
    try {
      CharacterPackService.assertActiveBinding(
        row.memory_approval_json.characterPackId,
        row.memory_approval_json.characterPackVersion
      );
    } catch (ignored) {
      return null;
    }
    return {
      memoryId: row.memory_id,
      category: row.category,
      normalizedKey: row.normalized_key,
      content: row.content,
      confidence: Number(row.confidence || 0),
      sourceMessageIds: row.source_message_ids_json.slice(),
      createdAt: row.created_at,
      lastConfirmedAt: row.last_confirmed_at
    };
  }

  function normalizeSourceMessage_(message) {
    if (
      !message ||
      !Validators.isUuidV4(String(message.messageId || ''))
    ) {
      return null;
    }
    var approval = message.characterApproval;
    var isUser = message.role === 'user';
    var isAssistant =
      message.role === 'assistant' &&
      message.status === 'completed' &&
      approval &&
      CHAT_APPROVAL_SURFACES.indexOf(approval.surface) !== -1;
    var isProactive =
      message.role === 'system' &&
      message.messageType === 'proactive' &&
      message.status === 'completed' &&
      approval &&
      PROACTIVE_APPROVAL_SURFACES.indexOf(approval.surface) !== -1;
    if (!isUser && !isAssistant && !isProactive) {
      return null;
    }
    var type = message.messageType === 'image'
      ? 'image'
      : 'text';
    var normalized = {
      messageId: String(message.messageId),
      role: isUser ? 'user' : 'assistant',
      type: type,
      text: String(message.text || '')
    };
    if (
      type === 'image' &&
      approval &&
      approval.surface === 'CHAT_IMAGE' &&
      message.image &&
      String(message.image.summary || '').trim() !== ''
    ) {
      normalized.summary = String(message.image.summary);
    }
    return normalized;
  }

  function acceptedSourceMessageIds(sourceMessages) {
    return (sourceMessages || [])
      .map(normalizeSourceMessage_)
      .filter(function(message) {
        return message != null;
      })
      .map(function(message) {
        return message.messageId;
      });
  }

  function bindingFromInspection(inspection) {
    ensure(
      inspection &&
        inspection.state === 'ready' &&
        inspection.runtimeMode === 'enforced',
      'CHARACTER_CONFIG_INVALID',
      'Character runtime is not ready for enforced memory extraction.'
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
    CharacterContextService.assertUnclassifiedActive(context, 'memory');
    return freezeBinding_({
      profileSchemaVersion: context.runtime.profileSchemaVersion,
      profileRevision: context.runtime.profileRevision,
      policyVersion: context.runtime.policyVersion,
      catalogVersion: context.runtime.catalogVersion,
      characterPackId: context.runtime.characterPackId,
      characterPackVersion: context.runtime.characterPackVersion
    });
  }

  function assertBindingMatchesContext(binding, context) {
    var expected = bindingFromContext(context);
    ensure(
      isPlainObject_(binding) &&
        hasExactKeys_(binding, BINDING_KEYS) &&
        BINDING_KEYS.every(function(key) {
          return binding[key] === expected[key];
        }),
      'CHARACTER_CONFIG_CONFLICT',
      'Character settings changed while memory extraction was pending.'
    );
    return true;
  }

  function classificationSignals(context) {
    CharacterContextService.assertUnclassifiedActive(context, 'memory');
    return Object.freeze({
      safetyRequired: false,
      adminRequest: false,
      capabilityUnavailable: false
    });
  }

  function isApproval_(value) {
    return isPlainObject_(value) &&
      hasExactKeys_(
        value,
        APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS
      ) &&
      value.surface === 'MEMORY_EXTRACTION' &&
      (value.source === 'generated' || value.source === 'rewrite') &&
      value.policyVersion ===
        APP_CONSTANTS.CHARACTER.POLICY_VERSION &&
      value.profileSchemaVersion ===
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION &&
      Number.isSafeInteger(Number(value.profileRevision)) &&
      Number(value.profileRevision) > 0 &&
      value.catalogVersion ===
        APP_CONSTANTS.CHARACTER.CATALOG_VERSION &&
      typeof value.characterPackId === 'string' &&
      typeof value.characterPackVersion === 'string';
  }

  function isUuidList_(value) {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 100
    ) {
      return false;
    }
    var seen = {};
    return value.every(function(id) {
      if (!Validators.isUuidV4(id) || seen[id]) {
        return false;
      }
      seen[id] = true;
      return true;
    });
  }

  function freezeBinding_(binding) {
    ensure(
      isPlainObject_(binding) &&
        hasExactKeys_(binding, BINDING_KEYS) &&
        typeof binding.profileSchemaVersion === 'string' &&
        Number.isSafeInteger(binding.profileRevision) &&
        binding.profileRevision > 0 &&
        typeof binding.policyVersion === 'string' &&
        typeof binding.catalogVersion === 'string' &&
        typeof binding.characterPackId === 'string' &&
        binding.characterPackId !== '' &&
        typeof binding.characterPackVersion === 'string' &&
        binding.characterPackVersion !== '',
      'CHARACTER_CONFIG_INVALID',
      'Memory character runtime binding is invalid.'
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
    var keys = Object.keys(value || {});
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
    loadAcceptedMemories: loadAcceptedMemories_,
    isAcceptedMemoryRow: isAcceptedMemoryRow,
    acceptedSourceMessageIds: acceptedSourceMessageIds,
    bindingFromInspection: bindingFromInspection,
    bindingFromContext: bindingFromContext,
    assertBindingMatchesContext: assertBindingMatchesContext,
    classificationSignals: classificationSignals,
    __test: Object.freeze({
      normalizeApprovedMemoryRow: normalizeApprovedMemoryRow_,
      normalizeSourceMessage: normalizeSourceMessage_,
      isApproval: isApproval_
    })
  });
})();

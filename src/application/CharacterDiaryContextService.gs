var CharacterDiaryContextService = (function() {
  var MAX_MESSAGES = 60;
  var MAX_PARTNER_WORLD_FACTS = 12;
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
  var PARTNER_APPROVAL_SURFACES = Object.freeze([
    'PROACTIVE_AI',
    'PROACTIVE_RETRY'
  ]);

  function build(input) {
    input = input || {};
    ensure(
      Validators.isDateString(input.diaryDate),
      'VALIDATION_REQUEST_INVALID',
      'Diary character context date is invalid.'
    );
    var currentTime = input.currentTime || toIsoStringInTokyo(new Date());
    ensure(
      Validators.isIsoDateTimeString(currentTime),
      'VALIDATION_REQUEST_INVALID',
      'Diary character context time is invalid.'
    );
    var messages = Array.isArray(input.messages)
      ? input.messages
      : SheetRepository.listMessagesByDate(input.diaryDate);
    var approvedFacts = loadApprovedPartnerWorldFacts_(
      input.diaryDate,
      input.partnerWorldFactLimit
    );

    return CharacterContextService.buildActive({
      surface: 'diary',
      currentTime: currentTime,
      currentRequest: null,
      recentMessages: messages
        .map(normalizeHistoricalMessage_)
        .filter(function(message) {
          return message != null;
        })
        .slice(-MAX_MESSAGES),
      // PR 7 owns provenance-accepted memory. Legacy memory never enters an
      // enforced diary merely because it is retrievable.
      memories: [],
      userFacts: [],
      sharedFacts: [],
      realWorldObservations: [],
      relationshipState: null,
      partnerWorld: {
        mayCreate: input.mayCreatePartnerWorld === true,
        approvedFacts: approvedFacts
      }
    });
  }

  function bindingFromInspection(inspection) {
    ensure(
      inspection &&
        inspection.state === 'ready' &&
        inspection.runtimeMode === 'enforced',
      'CHARACTER_CONFIG_INVALID',
      'Character runtime is not ready for enforced diary output.'
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
    CharacterContextService.assertUnclassifiedActive(context, 'diary');
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
      'Character settings changed while diary output was pending.'
    );
    return true;
  }

  function classificationSignals(context) {
    CharacterContextService.assertUnclassifiedActive(context, 'diary');
    return Object.freeze({
      safetyRequired: false,
      adminRequest: false,
      capabilityUnavailable: false
    });
  }

  function normalizeHistoricalMessage_(message) {
    if (!message || typeof message !== 'object') {
      return null;
    }
    var approval = message.characterApproval;
    var isUser = message.role === 'user';
    var isApprovedAssistant =
      message.role === 'assistant' &&
      message.status === 'completed' &&
      approval &&
      CHAT_APPROVAL_SURFACES.indexOf(approval.surface) !== -1;
    var isApprovedProactive =
      message.role === 'system' &&
      message.messageType === 'proactive' &&
      message.status === 'completed' &&
      approval &&
      PARTNER_APPROVAL_SURFACES.indexOf(approval.surface) !== -1;
    if (!isUser && !isApprovedAssistant && !isApprovedProactive) {
      return null;
    }
    var type = message.messageType === 'image' ? 'image' : 'text';
    var normalized = {
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

  function loadApprovedPartnerWorldFacts_(diaryDate, limit) {
    var normalizedLimit = Number(limit);
    if (!isFinite(normalizedLimit) || normalizedLimit < 1) {
      normalizedLimit = MAX_PARTNER_WORLD_FACTS;
    }
    normalizedLimit = Math.min(
      Math.floor(normalizedLimit),
      MAX_PARTNER_WORLD_FACTS
    );
    if (
      !SheetRepository ||
      typeof SheetRepository.listRecentDiarySummariesBefore !== 'function'
    ) {
      return [];
    }
    var rows = SheetRepository.listRecentDiarySummariesBefore(
      diaryDate,
      normalizedLimit
    ) || [];
    var facts = [];
    rows.forEach(function(row) {
      var provenance = normalizeApprovedDiaryRow_(row);
      if (!provenance) {
        return;
      }
      provenance.payload.partnerWorldEvents.forEach(function(content) {
        if (facts.length < MAX_PARTNER_WORLD_FACTS) {
          facts.push({
            date: String(row.summary_date),
            content: String(content)
          });
        }
      });
    });
    return facts;
  }

  function normalizeApprovedDiaryRow_(row) {
    if (
      !row ||
      row.diary_status !== 'DONE' ||
      !row.diary_payload_json ||
      !row.diary_approval_json ||
      !Validators.isUuidV4(String(row.diary_origin_event_id || ''))
    ) {
      return null;
    }
    var approval = row.diary_approval_json;
    if (
      !isPlainObject_(approval) ||
      !hasExactKeys_(approval, APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS) ||
      approval.surface !== 'DIARY' ||
      (
        approval.source !== 'generated' &&
        approval.source !== 'rewrite'
      ) ||
      approval.policyVersion !== APP_CONSTANTS.CHARACTER.POLICY_VERSION ||
      approval.profileSchemaVersion !==
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION ||
      !Number.isSafeInteger(Number(approval.profileRevision)) ||
      Number(approval.profileRevision) < 1 ||
      approval.catalogVersion !== APP_CONSTANTS.CHARACTER.CATALOG_VERSION
    ) {
      return null;
    }
    try {
      CharacterPackService.assertActiveBinding(
        approval.characterPackId,
        approval.characterPackVersion
      );
      var payload = CharacterPayloadService.normalize(
        'DIARY',
        row.diary_payload_json
      );
      if (
        !isDiaryStringList_(payload.partnerWorldEvents) ||
        !isDiaryStringList_(payload.thingsToRemember) ||
        !isDiaryStringList_(payload.unresolvedFollowUps)
      ) {
        return null;
      }
      return {
        payload: payload,
        approval: approval
      };
    } catch (ignored) {
      return null;
    }
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
      'Diary character runtime binding is invalid.'
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

  function isDiaryStringList_(value) {
    return Array.isArray(value) &&
      value.length <= 50 &&
      value.every(function(item) {
        return typeof item === 'string' &&
          item.trim() !== '' &&
          item.length <= 1000;
      });
  }

  return Object.freeze({
    build: build,
    bindingFromInspection: bindingFromInspection,
    bindingFromContext: bindingFromContext,
    assertBindingMatchesContext: assertBindingMatchesContext,
    classificationSignals: classificationSignals,
    loadApprovedPartnerWorldFactsBefore: loadApprovedPartnerWorldFacts_,
    __test: Object.freeze({
      normalizeHistoricalMessage: normalizeHistoricalMessage_,
      normalizeApprovedDiaryRow: normalizeApprovedDiaryRow_,
      loadApprovedPartnerWorldFacts: loadApprovedPartnerWorldFacts_
    })
  });
})();

var CharacterContextService = (function() {
  var UNCLASSIFIED_MODE = 'UNCLASSIFIED';
  var FORBIDDEN_AUTHORITY_KEYS = Object.freeze([
    'systempersona',
    'systemprompt',
    'developerprompt',
    'proactivemessagestyle',
    'diarystyle',
    'legacycontext',
    'legacypersona'
  ]);

  function buildActive(input) {
    input = input || {};
    var surface = String(input.surface || '');
    ensure(
      APP_CONSTANTS.CHARACTER.CONTEXT_SCOPES.indexOf(surface) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Character context surface is invalid.',
      { reason: 'CONTEXT_SURFACE_INVALID' }
    );
    var currentTime = input.currentTime || toIsoStringInTokyo(new Date());
    ensure(
      Validators.isIsoDateTimeString(currentTime),
      'VALIDATION_REQUEST_INVALID',
      'Character context time is invalid.',
      { reason: 'CONTEXT_TIME_INVALID' }
    );

    var active = CharacterProfileService.requireActive();
    var partnerWorld = normalizePartnerWorld_(input.partnerWorld, surface);
    var context = {
      schemaVersion: APP_CONSTANTS.CHARACTER.CONTEXT_SCHEMA_VERSION,
      surface: surface,
      currentTime: currentTime,
      conversationMode: UNCLASSIFIED_MODE,
      runtime: {
        policyVersion: active.policyVersion,
        catalogVersion: active.catalogVersion,
        profileSchemaVersion: active.profileSchemaVersion,
        profileRevision: active.profileRevision
      },
      persona: {
        kind: 'v1',
        profile: cloneData_(active.profile, 'profile')
      },
      data: {
        authority: 'untrusted',
        currentRequest: normalizeOptionalObject_(input.currentRequest, 'currentRequest'),
        recentMessages: normalizeArray_(input.recentMessages, 'recentMessages'),
        memories: normalizeArray_(input.memories, 'memories'),
        userFacts: normalizeArray_(input.userFacts, 'userFacts'),
        sharedFacts: normalizeArray_(input.sharedFacts, 'sharedFacts'),
        realWorldObservations: normalizeArray_(
          input.realWorldObservations,
          'realWorldObservations'
        ),
        relationshipState: normalizeOptionalObject_(
          input.relationshipState,
          'relationshipState'
        ),
        partnerWorld: partnerWorld
      }
    };
    return deepFreeze_(context);
  }

  function withConversationMode(context, mode) {
    ensure(
      APP_CONSTANTS.CHARACTER.CONVERSATION_MODES.indexOf(mode) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Character conversation mode is invalid.',
      { reason: 'CONVERSATION_MODE_INVALID' }
    );
    validateUnclassifiedContext_(context);
    var classified = cloneData_(context, 'context');
    classified.conversationMode = mode;
    return deepFreeze_(classified);
  }

  function validateUnclassifiedContext_(context) {
    ensure(
      isPlainObject_(context),
      'VALIDATION_REQUEST_INVALID',
      'Character context is invalid.',
      { reason: 'CHARACTER_CONTEXT_INVALID' }
    );
    assertExactKeys_(context, [
      'schemaVersion',
      'surface',
      'currentTime',
      'conversationMode',
      'runtime',
      'persona',
      'data'
    ]);
    assertExactKeys_(context.runtime, [
      'policyVersion',
      'catalogVersion',
      'profileSchemaVersion',
      'profileRevision'
    ]);
    assertExactKeys_(context.persona, ['kind', 'profile']);
    assertExactKeys_(context.data, [
      'authority',
      'currentRequest',
      'recentMessages',
      'memories',
      'userFacts',
      'sharedFacts',
      'realWorldObservations',
      'relationshipState',
      'partnerWorld'
    ]);
    validateDataShape_(context.data);
    ensure(
      context.schemaVersion === APP_CONSTANTS.CHARACTER.CONTEXT_SCHEMA_VERSION &&
        APP_CONSTANTS.CHARACTER.CONTEXT_SCOPES.indexOf(context.surface) !== -1 &&
        Validators.isIsoDateTimeString(context.currentTime) &&
        context.conversationMode === UNCLASSIFIED_MODE &&
        isPlainObject_(context.runtime) &&
        context.runtime.policyVersion === APP_CONSTANTS.CHARACTER.POLICY_VERSION &&
        context.runtime.catalogVersion === APP_CONSTANTS.CHARACTER.CATALOG_VERSION &&
        context.runtime.profileSchemaVersion === APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION &&
        isSafePositiveInteger_(context.runtime.profileRevision) &&
        isPlainObject_(context.persona) &&
        context.persona.kind === 'v1' &&
        isPlainObject_(context.data) &&
        context.data.authority === 'untrusted',
      'VALIDATION_REQUEST_INVALID',
      'Character context is invalid.',
      { reason: 'CHARACTER_CONTEXT_INVALID' }
    );
    if (context.surface === 'memory') {
      ensure(
        context.data.partnerWorld == null,
        'VALIDATION_REQUEST_INVALID',
        'Memory context must not contain Partner World state.',
        { reason: 'CHARACTER_CONTEXT_INVALID' }
      );
    } else {
      assertExactKeys_(context.data.partnerWorld, ['mayCreate', 'approvedFacts', 'scope']);
      ensure(
        context.data.partnerWorld.scope === context.surface &&
          typeof context.data.partnerWorld.mayCreate === 'boolean' &&
          Array.isArray(context.data.partnerWorld.approvedFacts),
        'VALIDATION_REQUEST_INVALID',
        'Partner World context is invalid.',
        { reason: 'CHARACTER_CONTEXT_INVALID' }
      );
    }
    var profileValidation = CharacterProfileService.validateV1(context.persona.profile);
    ensure(
      profileValidation.valid,
      'VALIDATION_REQUEST_INVALID',
      'Character context profile is invalid.',
      { reason: 'CHARACTER_CONTEXT_PROFILE_INVALID' }
    );
    var active = CharacterProfileService.requireActive();
    ensure(
      active.profileRevision === context.runtime.profileRevision &&
        active.profileSchemaVersion === context.runtime.profileSchemaVersion &&
        active.policyVersion === context.runtime.policyVersion &&
        active.catalogVersion === context.runtime.catalogVersion &&
        JSON.stringify(active.profile) === JSON.stringify(profileValidation.profile) &&
        JSON.stringify(context.persona.profile) === JSON.stringify(profileValidation.profile),
      'VALIDATION_REQUEST_INVALID',
      'Character context is stale or does not match the active profile.',
      { reason: 'CHARACTER_CONTEXT_STALE' }
    );
  }

  function validateDataShape_(data) {
    ensure(
      (data.currentRequest == null || isPlainObject_(data.currentRequest)) &&
        Array.isArray(data.recentMessages) &&
        Array.isArray(data.memories) &&
        Array.isArray(data.userFacts) &&
        Array.isArray(data.sharedFacts) &&
        Array.isArray(data.realWorldObservations) &&
        (data.relationshipState == null || isPlainObject_(data.relationshipState)),
      'VALIDATION_REQUEST_INVALID',
      'Character context data shape is invalid.',
      { reason: 'CHARACTER_CONTEXT_DATA_INVALID' }
    );
  }

  function normalizePartnerWorld_(value, surface) {
    if (APP_CONSTANTS.CHARACTER.PARTNER_WORLD_SCOPES.indexOf(surface) === -1) {
      ensure(
        value == null,
        'VALIDATION_REQUEST_INVALID',
        'Partner World context is not allowed for this surface.',
        { reason: 'PARTNER_WORLD_SCOPE_INVALID' }
      );
      return null;
    }
    if (value == null) {
      value = {};
    }
    ensure(
      isPlainObject_(value),
      'VALIDATION_REQUEST_INVALID',
      'Partner World context is invalid.',
      { reason: 'PARTNER_WORLD_INVALID' }
    );
    var allowedKeys = ['mayCreate', 'approvedFacts'];
    Object.keys(value).forEach(function(key) {
      ensure(
        allowedKeys.indexOf(key) !== -1,
        'VALIDATION_REQUEST_INVALID',
        'Partner World context contains an unknown field.',
        { reason: 'PARTNER_WORLD_UNKNOWN_FIELD' }
      );
    });
    var mayCreate = value.mayCreate === true;
    ensure(
      value.mayCreate == null || typeof value.mayCreate === 'boolean',
      'VALIDATION_REQUEST_INVALID',
      'Partner World creation flag is invalid.',
      { reason: 'PARTNER_WORLD_CREATION_INVALID' }
    );
    ensure(
      !mayCreate || surface === 'diary',
      'CHARACTER_CONFIG_INVALID',
      'Partner World creation is not allowed for this surface.',
      { reason: 'PARTNER_WORLD_CREATION_SCOPE_INVALID' }
    );
    return {
      mayCreate: mayCreate,
      approvedFacts: normalizeArray_(value.approvedFacts, 'partnerWorld.approvedFacts'),
      scope: surface
    };
  }

  function normalizeOptionalObject_(value, path) {
    if (value == null) {
      return null;
    }
    ensure(
      isPlainObject_(value),
      'VALIDATION_REQUEST_INVALID',
      'Character context object is invalid.',
      { reason: 'CONTEXT_OBJECT_INVALID', path: path }
    );
    return cloneData_(value, path);
  }

  function normalizeArray_(value, path) {
    if (value == null) {
      return [];
    }
    ensure(
      Array.isArray(value),
      'VALIDATION_REQUEST_INVALID',
      'Character context list is invalid.',
      { reason: 'CONTEXT_LIST_INVALID', path: path }
    );
    return cloneData_(value, path);
  }

  function cloneData_(value, path, ancestors) {
    ancestors = ancestors || [];
    if (value == null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      ensure(
        isFinite(value),
        'VALIDATION_REQUEST_INVALID',
        'Character context number is invalid.',
        { reason: 'CONTEXT_DATA_INVALID', path: path }
      );
      return value;
    }
    ensure(
      typeof value === 'object' && (Array.isArray(value) || isPlainObject_(value)),
      'VALIDATION_REQUEST_INVALID',
      'Character context data is not JSON-safe.',
      { reason: 'CONTEXT_DATA_INVALID', path: path }
    );
    ensure(
      ancestors.indexOf(value) === -1,
      'VALIDATION_REQUEST_INVALID',
      'Character context data contains a cycle.',
      { reason: 'CONTEXT_DATA_INVALID', path: path }
    );
    ancestors.push(value);
    var copy;
    if (Array.isArray(value)) {
      copy = value.map(function(item) {
        return cloneData_(item, path, ancestors);
      });
    } else {
      copy = Object.create(null);
      Object.keys(value).forEach(function(key) {
        ensure(
          !isDangerousObjectKey_(key),
          'VALIDATION_REQUEST_INVALID',
          'Character context data contains an unsafe field.',
          { reason: 'CONTEXT_DATA_INVALID', path: path }
        );
        ensure(
          !isForbiddenAuthorityKey_(key),
          'VALIDATION_REQUEST_INVALID',
          'Legacy persona authority is not allowed in character context data.',
          { reason: 'LEGACY_PERSONA_AUTHORITY_FORBIDDEN', path: path }
        );
        copy[key] = cloneData_(value[key], path, ancestors);
      });
    }
    ancestors.pop();
    return copy;
  }

  function isForbiddenAuthorityKey_(key) {
    var normalized = String(key || '')
      .normalize('NFKC')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();
    return FORBIDDEN_AUTHORITY_KEYS.indexOf(normalized) !== -1;
  }

  function isDangerousObjectKey_(key) {
    return key === '__proto__' || key === 'prototype' || key === 'constructor';
  }

  function assertExactKeys_(value, expectedKeys) {
    ensure(
      isPlainObject_(value),
      'VALIDATION_REQUEST_INVALID',
      'Character context shape is invalid.',
      { reason: 'CHARACTER_CONTEXT_SHAPE_INVALID' }
    );
    var actualKeys = Object.keys(value);
    ensure(
      actualKeys.length === expectedKeys.length && expectedKeys.every(function(key) {
        return Object.prototype.hasOwnProperty.call(value, key);
      }),
      'VALIDATION_REQUEST_INVALID',
      'Character context shape is invalid.',
      { reason: 'CHARACTER_CONTEXT_SHAPE_INVALID' }
    );
  }

  function isSafePositiveInteger_(value) {
    return typeof value === 'number' &&
      isFinite(value) &&
      Math.floor(value) === value &&
      value > 0 &&
      value <= 9007199254740991;
  }

  function isPlainObject_(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
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

  return {
    buildActive: buildActive,
    withConversationMode: withConversationMode
  };
})();

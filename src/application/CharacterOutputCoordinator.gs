var CharacterOutputCoordinator = (function() {
  var OPTION_KEYS = Object.freeze([
    'context',
    'surface',
    'classificationSignals',
    'generate',
    'rewrite',
    'savedPayload',
    'verifierFn',
    'metricEmitter'
  ]);
  var SIGNAL_KEYS = Object.freeze([
    'safetyRequired',
    'adminRequest',
    'capabilityUnavailable'
  ]);

  function approve(options) {
    validateOptions_(options);
    var context = options.context;
    var surface = options.surface;
    var signals = normalizeSignals_(options.classificationSignals);
    var expectedScope = CharacterPayloadService.contextScopeForSurface(surface);
    CharacterContextService.assertUnclassifiedActive(context, expectedScope);
    var currentText = currentRequestText_(context, surface);
    var classification = CharacterModeClassifier.classifyDetailed({
      text: currentText,
      partnerName: context && context.persona && context.persona.profile
        ? context.persona.profile.identity.partnerName
        : null,
      safetyRequired: signals.safetyRequired,
      adminRequest: signals.adminRequest,
      capabilityUnavailable: signals.capabilityUnavailable
    });
    var mode = classification.mode;
    var classified = CharacterContextService.withConversationMode(context, mode);
    CharacterContextService.assertClassifiedActive(
      classified,
      expectedScope
    );

    if (mode === 'ADMIN_OOC' || mode === 'PRODUCT_INFO') {
      return nonCharacterRoute_(mode);
    }
    if (mode === 'IDENTITY_CHALLENGE') {
      return approveCatalog_(
        'IDENTITY_CHALLENGE_REPLY',
        'canonical',
        classified,
        surface,
        options.metricEmitter
      );
    }
    if (mode === 'WORLD_BOUNDARY') {
      return approveCatalog_(
        'WORLD_BOUNDARY_REPLY',
        'canonical',
        classified,
        surface,
        options.metricEmitter
      );
    }
    if (mode === 'META_INTERNAL') {
      return approveCatalog_(
        'META_INTERNAL_REQUEST',
        'canonical',
        classified,
        surface,
        options.metricEmitter
      );
    }
    if (mode === 'AFFECTION_DIRECT_REQUEST') {
      return approveCatalog_(
        classification.affectionVariant === 'STRONG'
          ? 'AFFECTION_DIRECT_REQUEST_STRONG'
          : 'AFFECTION_DIRECT_REQUEST_LIKE',
        'canonical',
        classified,
        surface,
        options.metricEmitter
      );
    }
    if (mode === 'CAPABILITY') {
      return approveCatalog_(
        'CHAT_CAPABILITY_LIMIT',
        'canonical',
        classified,
        surface,
        options.metricEmitter
      );
    }

    var generationContext = null;
    var primaryPayload;
    if (surface === 'PROACTIVE_RETRY') {
      primaryPayload = options.savedPayload;
    } else {
      if (typeof options.generate !== 'function') {
        throw createAppError(
          'VALIDATION_REQUEST_INVALID',
          'Character output generator is invalid.',
          { reason: 'CHARACTER_GENERATOR_INVALID' }
        );
      }
      generationContext = CharacterContextService.toGenerationView(classified);
      try {
        primaryPayload = options.generate(deepFreeze_({
          context: generationContext,
          surface: surface,
          mode: mode
        }));
      } catch (ignored) {
        return fallbackOrFail_(
          classified,
          surface,
          null,
          options.metricEmitter,
          'PRIMARY_GENERATION_FAILED'
        );
      }
    }

    var primaryDecision = ImmersionGuard.evaluate(
      primaryPayload,
      surface,
      classified,
      {
        source: surface === 'PROACTIVE_RETRY'
          ? 'legacy_revalidated'
          : 'generated',
        verifierFn: options.verifierFn
      }
    );
    primaryPayload = null;
    recordDecision_(primaryDecision, classified, options.metricEmitter);
    if (primaryDecision.status === 'ALLOW') {
      return approvalResult_(
        ApprovedCharacterArtifactService.issue(primaryDecision, classified),
        classified
      );
    }

    var lastDecision = primaryDecision;
    if (
      primaryDecision.status === 'DENY' &&
      surface !== 'PROACTIVE_RETRY' &&
      typeof options.rewrite === 'function'
    ) {
      recordMetric_(
        'immersion_rewrite_attempt_total',
        classified,
        surface,
        primaryDecision.category,
        'DENY',
        'rewrite',
        options.metricEmitter
      );
      var rewritePayload = null;
      try {
        rewritePayload = options.rewrite(deepFreeze_({
          context: generationContext,
          surface: surface,
          category: primaryDecision.category
        }));
      } catch (ignoredRewrite) {
        rewritePayload = null;
      }
      if (rewritePayload != null) {
        var rewriteDecision = ImmersionGuard.evaluate(
          rewritePayload,
          surface,
          classified,
          {
            source: 'rewrite',
            verifierFn: options.verifierFn
          }
        );
        rewritePayload = null;
        recordDecision_(rewriteDecision, classified, options.metricEmitter);
        lastDecision = rewriteDecision;
        if (rewriteDecision.status === 'ALLOW') {
          recordMetric_(
            'immersion_rewrite_success_total',
            classified,
            surface,
            null,
            'ALLOW',
            'rewrite',
            options.metricEmitter
          );
          return approvalResult_(
            ApprovedCharacterArtifactService.issue(rewriteDecision, classified),
            classified
          );
        }
      }
    }

    return fallbackOrFail_(
      classified,
      surface,
      lastDecision,
      options.metricEmitter,
      'NO_APPROVED_GENERATED_OUTPUT'
    );
  }

  function approveCatalog_(key, source, context, surface, metricEmitter) {
    var payload;
    try {
      payload = CharacterResponseCatalog.payloadFor(key, context, surface);
    } catch (ignored) {
      return failClosed_(
        context,
        surface,
        metricEmitter,
        'CATALOG_NOT_AVAILABLE',
        null,
        source,
        'DENY'
      );
    }
    if (payload == null) {
      return failClosed_(
        context,
        surface,
        metricEmitter,
        'CATALOG_SURFACE_MISMATCH',
        null,
        source,
        'DENY'
      );
    }
    var decision = ImmersionGuard.evaluate(payload, surface, context, {
      source: source,
      catalogKey: key
    });
    payload = null;
    recordDecision_(decision, context, metricEmitter);
    if (decision.status !== 'ALLOW') {
      return failClosed_(
        context,
        surface,
        metricEmitter,
        'CATALOG_REJECTED',
        decision.category,
        source,
        decision.status
      );
    }
    recordMetric_(
      source === 'canonical'
        ? 'immersion_canonical_total'
        : 'immersion_fallback_total',
      context,
      surface,
      null,
      'ALLOW',
      source,
      metricEmitter
    );
    return approvalResult_(
      ApprovedCharacterArtifactService.issue(decision, context),
      context
    );
  }

  function fallbackOrFail_(context, surface, decision, metricEmitter, reason) {
    if (decision && decision.status === 'GUARD_UNAVAILABLE') {
      recordMetric_(
        'immersion_guard_unavailable_total',
        context,
        surface,
        null,
        'GUARD_UNAVAILABLE',
        decision.source,
        metricEmitter
      );
    }
    var key = fallbackKeyFor_(surface, decision);
    if (key == null) {
      return failClosed_(
        context,
        surface,
        metricEmitter,
        reason,
        decision && decision.category,
        decision && decision.source,
        decision && decision.status
      );
    }
    return approveCatalog_(key, 'fallback', context, surface, metricEmitter);
  }

  function fallbackKeyFor_(surface, decision) {
    var category = decision && decision.category;
    var claimType = decision && decision.claimType;
    if (surface === 'CHAT_IMAGE') {
      return 'CHAT_IMAGE_UNCERTAIN';
    }
    if (surface === 'CHAT_TEXT_SYNC' || surface === 'CHAT_TEXT_QUEUED') {
      if (
        category === 'GROUNDING_USER_STATE_UNSUPPORTED' ||
        claimType === 'USER_STATE'
      ) {
        return 'CHAT_GROUNDING_CLARIFY';
      }
      return 'CHAT_RECOVERY';
    }
    return null;
  }

  function recordDecision_(decision, context, metricEmitter) {
    recordMetric_(
      'immersion_assessed_total',
      context,
      decision.surface,
      decision.category,
      decision.status,
      decision.source,
      metricEmitter
    );
    if (decision.status !== 'ALLOW') {
      recordMetric_(
        'immersion_blocked_total',
        context,
        decision.surface,
        decision.category,
        decision.status,
        decision.source,
        metricEmitter
      );
    }
  }

  function failClosed_(context, surface, metricEmitter, reason, category, source, action) {
    var normalizedAction = APP_CONSTANTS.CHARACTER.GUARD_STATUSES.indexOf(action) !== -1
      ? action
      : 'DENY';
    recordMetric_(
      'immersion_fail_closed_total',
      context,
      surface,
      category,
      normalizedAction,
      source,
      metricEmitter
    );
    throw createAppError(
      'CHARACTER_OUTPUT_BLOCKED',
      'No approved character output was available.',
      {
        reason: reason,
        category: APP_CONSTANTS.CHARACTER.GUARD_CATEGORIES.indexOf(category) !== -1
          ? category
          : null
      }
    );
  }

  function recordMetric_(name, context, surface, category, action, source, emitter) {
    var dimensions = {
      dayBucket: context.currentTime.slice(0, 10),
      timeBucket: context.currentTime.slice(0, 13),
      surface: surface,
      action: action,
      policyVersion: context.runtime.policyVersion,
      catalogVersion: context.runtime.catalogVersion,
      characterPackId: context.runtime.characterPackId,
      characterPackVersion: context.runtime.characterPackVersion,
      profileSchemaVersion: context.runtime.profileSchemaVersion
    };
    if (APP_CONSTANTS.CHARACTER.GUARD_CATEGORIES.indexOf(category) !== -1) {
      dimensions.category = category;
    }
    if (APP_CONSTANTS.CHARACTER.ARTIFACT_SOURCES.indexOf(source) !== -1) {
      dimensions.source = source;
    }
    CharacterMetricsService.record(name, dimensions, emitter);
  }

  function currentRequestText_(context, surface) {
    var currentRequest = context && context.data ? context.data.currentRequest : null;
    var requiresText = surface === 'CHAT_TEXT_SYNC' || surface === 'CHAT_TEXT_QUEUED';
    if (currentRequest == null || currentRequest.text == null) {
      ensure(
        !requiresText,
        'VALIDATION_REQUEST_INVALID',
        'Character output requires current request text.',
        { reason: 'CHARACTER_CURRENT_REQUEST_TEXT_REQUIRED' }
      );
      return '';
    }
    ensure(
      typeof currentRequest.text === 'string',
      'VALIDATION_REQUEST_INVALID',
      'Character output requires current request text.',
      { reason: 'CHARACTER_CURRENT_REQUEST_TEXT_REQUIRED' }
    );
    return currentRequest.text;
  }

  function normalizeSignals_(value) {
    if (value == null) {
      value = {};
    }
    ensure(
      isPlainObject_(value) &&
        Object.keys(value).every(function(key) {
          return SIGNAL_KEYS.indexOf(key) !== -1;
        }),
      'VALIDATION_REQUEST_INVALID',
      'Character classification signals are invalid.',
      { reason: 'CHARACTER_CLASSIFICATION_SIGNALS_INVALID' }
    );
    var normalized = {};
    SIGNAL_KEYS.forEach(function(key) {
      ensure(
        value[key] == null || typeof value[key] === 'boolean',
        'VALIDATION_REQUEST_INVALID',
        'Character classification signal is invalid.',
        { reason: 'CHARACTER_CLASSIFICATION_SIGNALS_INVALID' }
      );
      normalized[key] = value[key] === true;
    });
    return normalized;
  }

  function validateOptions_(options) {
    ensure(
      isPlainObject_(options) &&
        Object.keys(options).every(function(key) {
          return OPTION_KEYS.indexOf(key) !== -1;
        }) &&
        APP_CONSTANTS.CHARACTER.OUTPUT_SURFACES.indexOf(options.surface) !== -1 &&
        typeof options.metricEmitter === 'function',
      'VALIDATION_REQUEST_INVALID',
      'Character output coordinator input is invalid.',
      { reason: 'CHARACTER_COORDINATOR_INPUT_INVALID' }
    );
    var hasSavedPayload = Object.prototype.hasOwnProperty.call(
      options,
      'savedPayload'
    );
    var retryInputValid = options.surface === 'PROACTIVE_RETRY'
      ? hasSavedPayload &&
        options.generate == null &&
        options.rewrite == null
      : !hasSavedPayload;
    ensure(
      retryInputValid,
      'VALIDATION_REQUEST_INVALID',
      'Character proactive retry input is invalid.',
      { reason: 'CHARACTER_RETRY_INPUT_INVALID' }
    );
  }

  function approvalResult_(artifact, classifiedContext) {
    return Object.freeze({
      artifact: artifact,
      classifiedContext: classifiedContext
    });
  }

  function nonCharacterRoute_(route) {
    return Object.freeze({
      kind: 'NON_CHARACTER_ROUTE',
      route: route,
      artifact: null
    });
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

  return Object.freeze({
    approve: approve
  });
})();

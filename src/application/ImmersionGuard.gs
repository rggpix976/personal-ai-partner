var ImmersionGuard = (function() {
  var APPROVED_SOURCES = Object.freeze([
    'generated', 'rewrite', 'canonical', 'fallback', 'legacy_revalidated'
  ]);
  var SOURCES_BY_SURFACE = Object.freeze({
    CHAT_TEXT_SYNC: Object.freeze(['generated', 'rewrite', 'canonical', 'fallback']),
    CHAT_TEXT_QUEUED: Object.freeze(['generated', 'rewrite', 'canonical', 'fallback']),
    CHAT_IMAGE: Object.freeze(['generated', 'rewrite', 'canonical', 'fallback']),
    PROACTIVE_AI: Object.freeze(['generated', 'rewrite']),
    PROACTIVE_RETRY: Object.freeze(['legacy_revalidated']),
    DIARY: Object.freeze(['generated', 'rewrite']),
    MEMORY_EXTRACTION: Object.freeze(['generated', 'rewrite'])
  });
  var CANONICAL_KEYS = Object.freeze([
    'IDENTITY_CHALLENGE_REPLY',
    'WORLD_BOUNDARY_REPLY',
    'META_INTERNAL_REQUEST',
    'AFFECTION_DIRECT_REQUEST_LIKE',
    'AFFECTION_DIRECT_REQUEST_STRONG',
    'CHAT_CAPABILITY_LIMIT'
  ]);
  var FALLBACK_KEYS_BY_SURFACE = Object.freeze({
    CHAT_TEXT_SYNC: Object.freeze([
      'CHAT_RECOVERY',
      'CHAT_GROUNDING_CLARIFY'
    ]),
    CHAT_TEXT_QUEUED: Object.freeze([
      'CHAT_RECOVERY',
      'CHAT_GROUNDING_CLARIFY'
    ]),
    CHAT_IMAGE: Object.freeze(['CHAT_IMAGE_UNCERTAIN']),
    PROACTIVE_AI: Object.freeze([]),
    PROACTIVE_RETRY: Object.freeze([]),
    DIARY: Object.freeze([]),
    MEMORY_EXTRACTION: Object.freeze([])
  });
  var approvedDecisions_ = new WeakSet();
  var approvedArtifacts_ = new WeakMap();

  function evaluate(payload, surface, context, options) {
    options = options || {};
    var source = options.source;
    ensure(
      APPROVED_SOURCES.indexOf(source) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Character output source is invalid.',
      { reason: 'CHARACTER_SOURCE_INVALID' }
    );

    var expectedScope = CharacterPayloadService.contextScopeForSurface(surface);
    CharacterContextService.assertClassifiedActive(context, expectedScope);
    validateSourceRoute_(source, surface, context.conversationMode);
    var normalizedPayload;
    try {
      normalizedPayload = CharacterPayloadService.normalize(surface, payload);
    } catch (ignored) {
      return makeDecision_(
        'DENY',
        'FORMAT_INVALID',
        surface,
        source,
        context,
        null,
        false,
        []
      );
    }
    var catalogValidation = validateCatalogSource_(
      source,
      options.catalogKey,
      surface,
      context,
      normalizedPayload
    );
    if (!catalogValidation.valid) {
      return makeDecision_(
        'DENY',
        'FORMAT_INVALID',
        surface,
        source,
        context,
        null,
        false,
        []
      );
    }

    var fixed = CharacterFixedPolicy.inspect(normalizedPayload, surface, context);

    if (fixed.verdict === 'DENY') {
      return makeDecision_(
        'DENY',
        fixed.category,
        surface,
        source,
        context,
        fixed.claimType,
        fixed.requiresEvidence,
        []
      );
    }
    if (fixed.verdict === 'ALLOW' && isReviewedLocalSource_(source)) {
      return approve_(
        normalizedPayload,
        surface,
        source,
        context,
        fixed,
        [],
        options.catalogKey || null
      );
    }
    if (fixed.verdict === 'ALLOW') {
      // Open-ended natural language cannot be exhaustively secured by a
      // finite regex corpus. Every free-generated, rewritten, or legacy
      // candidate therefore receives one semantic pass even when the local
      // guard finds no specific claim. Exact reviewed catalog artifacts are
      // the only local-only approval path.
      fixed = Object.freeze({
        verdict: 'VERIFY',
        category: null,
        claimType: 'GENERAL_IMMERSION',
        requiresEvidence: false
      });
    }
    if (fixed.verdict !== 'VERIFY') {
      return makeDecision_(
        'GUARD_UNAVAILABLE',
        null,
        surface,
        source,
        context,
        null,
        false,
        []
      );
    }

    var evidenceView;
    var knownEvidenceKeys;
    var textFields;
    try {
      evidenceView = CharacterPayloadService.collectEvidenceView(context);
      knownEvidenceKeys = evidenceView.map(function(entry) {
        return entry.key;
      });
      textFields = CharacterPayloadService.textFields(surface, normalizedPayload);
    } catch (ignored) {
      return makeDecision_(
        'GUARD_UNAVAILABLE',
        null,
        surface,
        source,
        context,
        fixed.claimType,
        fixed.requiresEvidence,
        []
      );
    }
    var verifierRequest = deepFreeze_({
      surface: surface,
      claimType: fixed.claimType,
      category: fixed.category,
      requiresEvidence: fixed.requiresEvidence,
      knownEvidenceKeys: knownEvidenceKeys.slice(),
      evidenceView: evidenceView,
      textFields: cloneTextFields_(textFields),
      payload: normalizedPayload,
      context: CharacterContextService.toGenerationView(context)
    });
    var semantic = CharacterSemanticVerifier.evaluate(
      verifierRequest,
      options.verifierFn
    );
    if (!hasOnlyViewEvidenceKeys_(semantic.evidenceKeys, evidenceView)) {
      return makeDecision_(
        'GUARD_UNAVAILABLE',
        null,
        surface,
        source,
        context,
        fixed.claimType,
        fixed.requiresEvidence,
        []
      );
    }
    if (semantic.status === 'ALLOW') {
      return approve_(
        normalizedPayload,
        surface,
        source,
        context,
        fixed,
        semantic.evidenceKeys,
        options.catalogKey || null
      );
    }
    if (semantic.status === 'DENY') {
      return makeDecision_(
        'DENY',
        semantic.category,
        surface,
        source,
        context,
        fixed.claimType,
        fixed.requiresEvidence,
        semantic.evidenceKeys
      );
    }
    return makeDecision_(
      'GUARD_UNAVAILABLE',
      null,
      surface,
      source,
      context,
      fixed.claimType,
      fixed.requiresEvidence,
      []
    );
  }

  function isApprovedDecision(decision, context) {
    return Boolean(
      decision &&
      typeof decision === 'object' &&
      decision.status === 'ALLOW' &&
      approvedDecisions_.has(decision) &&
      approvedArtifacts_.has(decision) &&
      approvedArtifacts_.get(decision).context === context
    );
  }

  function isReviewedLocalSource_(source) {
    return source === 'canonical' || source === 'fallback';
  }

  function validateSourceRoute_(source, surface, mode) {
    var exceptionalModes = [
      'IDENTITY_CHALLENGE',
      'WORLD_BOUNDARY',
      'META_INTERNAL',
      'AFFECTION_DIRECT_REQUEST',
      'CAPABILITY'
    ];
    var allowedBySurface = SOURCES_BY_SURFACE[surface] || [];
    var valid = allowedBySurface.indexOf(source) !== -1;
    if (!valid || mode === 'PRODUCT_INFO' || mode === 'ADMIN_OOC') {
      valid = false;
    } else if (exceptionalModes.indexOf(mode) !== -1) {
      valid = source === 'canonical';
    } else if (mode === 'CHARACTER' || mode === 'SAFETY') {
      valid = source !== 'canonical';
    }
    ensure(
      valid,
      'VALIDATION_REQUEST_INVALID',
      'Character output source is invalid for this route.',
      { reason: 'CHARACTER_SOURCE_ROUTE_INVALID' }
    );
  }

  function getApprovedPayload(decision, context) {
    if (!isApprovedDecision(decision, context)) {
      throw createAppError(
        'CHARACTER_ARTIFACT_INVALID',
        'Character artifact authentication failed.',
        { reason: 'CHARACTER_ARTIFACT_AUTHENTICATION_FAILED' }
      );
    }
    return approvedArtifacts_.get(decision).payload;
  }

  function approve_(payload, surface, source, context, fixed, evidenceKeys, catalogKey) {
    var decision = makeDecision_(
      'ALLOW',
      null,
      surface,
      source,
      context,
      fixed.claimType,
      fixed.requiresEvidence,
      evidenceKeys
    );
    var artifact = deepFreeze_({
      payload: deepFreeze_(payload),
      catalogKey: catalogKey,
      context: context
    });
    approvedDecisions_.add(decision);
    approvedArtifacts_.set(decision, artifact);
    return decision;
  }

  function makeDecision_(status, category, surface, source, context, claimType, requiresEvidence, evidenceKeys) {
    var runtime = context.runtime;
    return Object.freeze({
      status: status,
      category: category,
      action: status,
      surface: surface,
      source: source,
      policyVersion: runtime.policyVersion,
      characterPackId: runtime.characterPackId,
      characterPackVersion: runtime.characterPackVersion,
      profileSchemaVersion: runtime.profileSchemaVersion,
      profileRevision: runtime.profileRevision,
      catalogVersion: runtime.catalogVersion,
      claimType: claimType,
      requiresEvidence: requiresEvidence === true,
      evidenceKeys: Object.freeze(evidenceKeys.slice())
    });
  }

  function validateCatalogSource_(source, catalogKey, surface, context, payload) {
    if (source !== 'canonical' && source !== 'fallback') {
      return { valid: catalogKey == null, exactMatch: false };
    }
    if (typeof catalogKey !== 'string' || !catalogKey) {
      return { valid: false, exactMatch: false };
    }
    var allowedKeys = source === 'canonical'
      ? CANONICAL_KEYS
      : (FALLBACK_KEYS_BY_SURFACE[surface] || []);
    if (allowedKeys.indexOf(catalogKey) === -1) {
      return { valid: false, exactMatch: false };
    }
    var exactMatch = false;
    try {
      exactMatch = CharacterResponseCatalog.matches(
        catalogKey,
        context,
        payload,
        surface
      ) === true;
    } catch (ignored) {
      exactMatch = false;
    }
    return { valid: exactMatch, exactMatch: exactMatch };
  }

  function cloneTextFields_(fields) {
    return fields.map(function(field) {
      return {
        path: String(field.path),
        value: String(field.value)
      };
    });
  }

  function hasOnlyViewEvidenceKeys_(evidenceKeys, evidenceView) {
    if (
      !Array.isArray(evidenceKeys) ||
      evidenceKeys.length > 50 ||
      !Array.isArray(evidenceView)
    ) {
      return false;
    }
    var allowed = Object.create(null);
    var seen = Object.create(null);
    evidenceView.forEach(function(entry) {
      allowed[entry.key] = true;
    });
    return evidenceKeys.every(function(key) {
      if (
        typeof key !== 'string' ||
        key !== key.trim() ||
        !/^[A-Za-z0-9._:-]{1,80}$/.test(key) ||
        Object.prototype.hasOwnProperty.call(seen, key) ||
        !Object.prototype.hasOwnProperty.call(allowed, key)
      ) {
        return false;
      }
      seen[key] = true;
      return true;
    });
  }

  function deepFreeze_(value, ancestors) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) {
      throw createAppError(
        'CHARACTER_ARTIFACT_INVALID',
        'Character artifact is invalid.',
        { reason: 'CHARACTER_ARTIFACT_CYCLE' }
      );
    }
    ancestors.push(value);
    Object.keys(value).forEach(function(key) {
      deepFreeze_(value[key], ancestors);
    });
    ancestors.pop();
    return Object.freeze(value);
  }

  return Object.freeze({
    evaluate: evaluate,
    isApprovedDecision: isApprovedDecision,
    getApprovedPayload: getApprovedPayload
  });
})();

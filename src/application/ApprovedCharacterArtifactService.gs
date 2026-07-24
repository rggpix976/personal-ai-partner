var ApprovedCharacterArtifactService = (function() {
  var issuedArtifacts = new WeakSet();
  var issuedContexts = new WeakMap();
  var DECISION_KEYS = Object.freeze([
    'status',
    'category',
    'action',
    'surface',
    'source',
    'policyVersion',
    'characterPackId',
    'characterPackVersion',
    'profileSchemaVersion',
    'profileRevision',
    'catalogVersion',
    'claimType',
    'requiresEvidence',
    'evidenceKeys'
  ]);
  var ARTIFACT_KEYS = Object.freeze([
    'payload',
    'surface',
    'source',
    'policyVersion',
    'characterPackId',
    'characterPackVersion',
    'profileSchemaVersion',
    'profileRevision',
    'catalogVersion'
  ]);
  function issue(decision, context) {
    try {
      if (
        typeof ImmersionGuard === 'undefined' ||
        !ImmersionGuard ||
        typeof ImmersionGuard.isApprovedDecision !== 'function' ||
        typeof ImmersionGuard.getApprovedPayload !== 'function' ||
        !ImmersionGuard.isApprovedDecision(decision, context)
      ) {
        throw artifactError_();
      }
      assertExactKeys_(decision, DECISION_KEYS);
      if (
        decision.status !== 'ALLOW' ||
        decision.action !== 'ALLOW' ||
        decision.category != null ||
        APP_CONSTANTS.CHARACTER.ARTIFACT_SOURCES.indexOf(decision.source) === -1 ||
        typeof decision.requiresEvidence !== 'boolean' ||
        !Array.isArray(decision.evidenceKeys)
      ) {
        throw artifactError_();
      }

      var expectedScope = CharacterPayloadService.contextScopeForSurface(decision.surface);
      CharacterContextService.assertClassifiedActive(context, expectedScope);
      assertMetadataMatchesContext_(decision, context);

      var approvedPayload = ImmersionGuard.getApprovedPayload(decision, context);
      var normalizedPayload = CharacterPayloadService.normalize(
        decision.surface,
        approvedPayload
      );
      var artifact = {
        payload: normalizedPayload,
        surface: decision.surface,
        source: decision.source,
        policyVersion: decision.policyVersion,
        characterPackId: decision.characterPackId,
        characterPackVersion: decision.characterPackVersion,
        profileSchemaVersion: decision.profileSchemaVersion,
        profileRevision: decision.profileRevision,
        catalogVersion: decision.catalogVersion
      };
      deepFreeze_(artifact);
      issuedArtifacts.add(artifact);
      issuedContexts.set(artifact, context);
      return artifact;
    } catch (error) {
      if (error && error.code === 'CHARACTER_ARTIFACT_INVALID') {
        throw error;
      }
      throw artifactError_();
    }
  }

  function assertUsable(artifact, expectedSurface, context) {
    try {
      CharacterPayloadService.contextScopeForSurface(expectedSurface);
      if (
        !artifact ||
        typeof artifact !== 'object' ||
        !issuedArtifacts.has(artifact) ||
        issuedContexts.get(artifact) !== context
      ) {
        throw artifactError_();
      }
      assertExactKeys_(artifact, ARTIFACT_KEYS);
      if (
        !Object.isFrozen(artifact) ||
        artifact.surface !== expectedSurface ||
        APP_CONSTANTS.CHARACTER.ARTIFACT_SOURCES.indexOf(artifact.source) === -1
      ) {
        throw artifactError_();
      }

      var expectedScope = CharacterPayloadService.contextScopeForSurface(expectedSurface);
      CharacterContextService.assertClassifiedActive(context, expectedScope);
      assertMetadataMatchesContext_(artifact, context);
      assertMetadataMatchesActiveRuntime_(artifact);

      var normalizedPayload = CharacterPayloadService.normalize(
        artifact.surface,
        artifact.payload
      );
      if (JSON.stringify(normalizedPayload) !== JSON.stringify(artifact.payload)) {
        throw artifactError_();
      }
      return true;
    } catch (error) {
      if (error && error.code === 'CHARACTER_ARTIFACT_INVALID') {
        throw error;
      }
      throw artifactError_();
    }
  }

  function assertMetadataMatchesActiveRuntime_(value) {
    var active;
    try {
      active = CharacterProfileService.requireActive();
      CharacterPackService.assertActiveBinding(
        active && active.characterPackId,
        active && active.characterPackVersion
      );
    } catch (ignored) {
      throw artifactError_();
    }
    if (
      !active ||
      value.policyVersion !== active.policyVersion ||
      value.catalogVersion !== active.catalogVersion ||
      value.profileSchemaVersion !== active.profileSchemaVersion ||
      value.profileRevision !== active.profileRevision ||
      value.characterPackId !== active.characterPackId ||
      value.characterPackVersion !== active.characterPackVersion
    ) {
      throw artifactError_();
    }
  }

  function assertMetadataMatchesContext_(value, context) {
    try {
      CharacterPackService.assertActiveBinding(
        value && value.characterPackId,
        value && value.characterPackVersion
      );
    } catch (ignored) {
      throw artifactError_();
    }
    if (
      !context ||
      !context.runtime ||
      value.policyVersion !== APP_CONSTANTS.CHARACTER.POLICY_VERSION ||
      value.catalogVersion !== APP_CONSTANTS.CHARACTER.CATALOG_VERSION ||
      value.profileSchemaVersion !== APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION ||
      value.characterPackId !== context.runtime.characterPackId ||
      value.characterPackVersion !== context.runtime.characterPackVersion ||
      value.policyVersion !== context.runtime.policyVersion ||
      value.catalogVersion !== context.runtime.catalogVersion ||
      value.profileSchemaVersion !== context.runtime.profileSchemaVersion ||
      value.profileRevision !== context.runtime.profileRevision
    ) {
      throw artifactError_();
    }
  }

  function assertExactKeys_(value, expectedKeys) {
    if (!isPlainObject_(value)) {
      throw artifactError_();
    }
    var keys = Object.keys(value);
    if (
      keys.length !== expectedKeys.length ||
      !expectedKeys.every(function(key) {
        return Object.prototype.hasOwnProperty.call(value, key);
      })
    ) {
      throw artifactError_();
    }
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

  function artifactError_() {
    return createAppError(
      'CHARACTER_ARTIFACT_INVALID',
      'An approved character artifact is required.',
      { reason: 'APPROVED_ARTIFACT_REQUIRED' }
    );
  }

  return {
    issue: issue,
    assertUsable: assertUsable
  };
})();

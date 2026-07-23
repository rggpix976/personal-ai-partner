var CharacterSinkAdapter = (function() {
  var consumedArtifacts_ = new WeakSet();

  function deliver(options) {
    options = options || {};
    var artifact = options.artifact;
    var expectedSurface = options.expectedSurface;
    var context = options.context;
    if (typeof options.metricEmitter !== 'function') {
      throw createAppError(
        'VALIDATION_REQUEST_INVALID',
        'Character sink metric emitter is invalid.',
        { reason: 'CHARACTER_SINK_METRIC_EMITTER_INVALID' }
      );
    }
    if (typeof options.write !== 'function') {
      throw createAppError(
        'VALIDATION_REQUEST_INVALID',
        'Character sink writer is invalid.',
        { reason: 'CHARACTER_SINK_WRITER_INVALID' }
      );
    }

    try {
      ApprovedCharacterArtifactService.assertUsable(
        artifact,
        expectedSurface,
        context
      );
      if (consumedArtifacts_.has(artifact)) {
        throw rejectedArtifactError_();
      }
    } catch (error) {
      recordRejectedAttempt_(expectedSurface, options.metricEmitter);
      throw rejectedArtifactError_();
    }

    // Consume before invoking the writer. A writer failure is ambiguous, so
    // retry must obtain a freshly approved artifact instead of risking a
    // duplicate side effect with this one.
    consumedArtifacts_.add(artifact);
    return options.write(artifact.payload, artifact);
  }

  function recordRejectedAttempt_(expectedSurface, metricEmitter) {
    var dimensions = {
      action: 'DENY',
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: CharacterPackService.getActive().packId,
      characterPackVersion: CharacterPackService.getActive().packVersion,
      profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION
    };
    if (APP_CONSTANTS.CHARACTER.OUTPUT_SURFACES.indexOf(expectedSurface) !== -1) {
      dimensions.surface = expectedSurface;
    }
    try {
      CharacterMetricsService.record(
        'immersion_unapproved_sink_attempt_total',
        dimensions,
        metricEmitter
      );
    } catch (ignored) {
      // Metrics must never turn a fail-closed sink into a write or disclose
      // the rejected candidate through a secondary error path.
    }
  }

  function rejectedArtifactError_() {
    return createAppError(
      'CHARACTER_ARTIFACT_INVALID',
      'Character output was rejected before delivery.',
      { reason: 'APPROVED_ARTIFACT_REQUIRED' }
    );
  }

  return {
    deliver: deliver
  };
})();

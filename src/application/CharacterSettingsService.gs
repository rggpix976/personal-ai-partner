var CharacterSettingsService = (function() {
  var REQUEST_KEYS = Object.freeze([
    'expectedRevision',
    'partnerName',
    'userAddress',
    'replyLength',
    'proactiveFrequency',
    'quietStart',
    'quietEnd'
  ]);

  function getSnapshot() {
    var repositorySnapshot = CharacterConfigRepository.readSnapshot();
    var storedProfileJson = readExactConfig_(
      repositorySnapshot.profileV2,
      'json',
      'PROFILE_ENTRY_INVALID'
    );
    var profileValidation = CharacterProfileService.validateV2(storedProfileJson);
    var profile = profileValidation.valid
      ? profileValidation.profile
      : requireDefaultProfile_();
    var revision = readRevision_(repositorySnapshot.revisionV2);
    var proactiveFrequency = readExactConfig_(
      repositorySnapshot.proactiveFrequency,
      'string',
      'PROACTIVE_FREQUENCY_ENTRY_INVALID'
    );
    ensure(
      APP_CONSTANTS.CHARACTER.PROACTIVE_FREQUENCIES.indexOf(proactiveFrequency) !== -1,
      'CHARACTER_CONFIG_INVALID',
      'Stored proactive frequency is invalid.',
      { reason: 'PROACTIVE_FREQUENCY_INVALID' }
    );
    var quietStart = readTime_(
      repositorySnapshot.quietStart,
      'QUIET_START_ENTRY_INVALID'
    );
    var quietEnd = readTime_(
      repositorySnapshot.quietEnd,
      'QUIET_END_ENTRY_INVALID'
    );
    var runtime = CharacterProfileService.inspectRuntime();

    return freeze_({
      available: true,
      revision: revision,
      onboardingRequired: revision === 0,
      configurationValid: profileValidation.valid,
      editableFields: REQUEST_KEYS.slice(1),
      values: {
        partnerName: profile.identity.partnerName,
        userAddress: profile.identity.userAddress,
        replyLength: profile.preferences.replyLength,
        proactiveFrequency: proactiveFrequency,
        quietStart: quietStart,
        quietEnd: quietEnd
      },
      runtime: {
        state: runtime.state,
        mode: runtime.runtimeMode,
        profileMode: runtime.profileMode,
        ready: runtime.state === 'ready'
      }
    });
  }

  function requireDefaultProfile_() {
    var validation = CharacterProfileService.validateV2(
      APP_CONSTANTS.CHARACTER.DEFAULT_PROFILE_JSON
    );
    ensure(
      validation.valid,
      'CHARACTER_CONFIG_INVALID',
      'Default character settings are invalid.',
      { reason: 'DEFAULT_PROFILE_INVALID' }
    );
    return validation.profile;
  }

  function save(request) {
    assertExactRequest_(request);
    ensure(
      typeof request.expectedRevision === 'number' &&
        isFinite(request.expectedRevision) &&
        Math.floor(request.expectedRevision) === request.expectedRevision &&
        request.expectedRevision >= 0,
      'VALIDATION_REQUEST_INVALID',
      'Expected settings revision is invalid.'
    );
    ensure(
      APP_CONSTANTS.CHARACTER.REPLY_LENGTHS.indexOf(request.replyLength) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Reply length is invalid.'
    );
    ensure(
      APP_CONSTANTS.CHARACTER.PROACTIVE_FREQUENCIES.indexOf(
        request.proactiveFrequency
      ) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Proactive frequency is invalid.'
    );
    var quietStart = normalizeTime_(request.quietStart, 'quietStart');
    var quietEnd = normalizeTime_(request.quietEnd, 'quietEnd');
    var validation = CharacterProfileService.validateV2({
      schemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      identity: {
        partnerName: request.partnerName,
        userAddress: request.userAddress
      },
      preferences: {
        replyLength: request.replyLength
      }
    });
    if (!validation.valid) {
      throw createAppError(
        'VALIDATION_REQUEST_INVALID',
        'Character settings validation failed.',
        { reason: 'PROFILE_INVALID', errors: validation.errors }
      );
    }
    var canonicalProfileJson = JSON.stringify({
      schemaVersion: validation.profile.schemaVersion,
      identity: {
        partnerName: validation.profile.identity.partnerName,
        userAddress: validation.profile.identity.userAddress
      },
      preferences: {
        replyLength: validation.profile.preferences.replyLength
      }
    });
    CharacterConfigRepository.saveSettingsAtomically(
      canonicalProfileJson,
      request.expectedRevision,
      request.proactiveFrequency,
      quietStart,
      quietEnd,
      toIsoStringInTokyo(new Date())
    );
    return getSnapshot();
  }

  function assertExactRequest_(request) {
    ensure(
      request && typeof request === 'object' && !Array.isArray(request),
      'VALIDATION_REQUEST_INVALID',
      'Settings request is required.'
    );
    var keys = Object.keys(request).sort();
    var expected = REQUEST_KEYS.slice().sort();
    ensure(
      JSON.stringify(keys) === JSON.stringify(expected),
      'VALIDATION_REQUEST_INVALID',
      'Settings request fields are invalid.',
      { reason: 'SETTINGS_FIELDS_INVALID' }
    );
  }

  function readRevision_(entry) {
    var rawValue = readExactConfig_(
      entry,
      'int',
      'REVISION_ENTRY_INVALID'
    );
    ensure(
      /^\d+$/.test(rawValue),
      'CHARACTER_CONFIG_INVALID',
      'Stored settings revision is invalid.',
      { reason: 'REVISION_INVALID' }
    );
    var revision = Number(rawValue);
    ensure(
      isFinite(revision) &&
        Math.floor(revision) === revision &&
        revision >= 0 &&
        revision <= 9007199254740991,
      'CHARACTER_CONFIG_INVALID',
      'Stored settings revision is invalid.',
      { reason: 'REVISION_INVALID' }
    );
    return revision;
  }

  function readTime_(entry, reason) {
    return normalizeTime_(
      readExactConfig_(entry, 'time', reason),
      reason
    );
  }

  function readExactConfig_(entry, type, reason) {
    ensure(
      entry && entry.type === type,
      'CHARACTER_CONFIG_INVALID',
      'Stored character setting is missing or invalid.',
      { reason: reason }
    );
    return String(entry.rawValue == null ? '' : entry.rawValue);
  }

  function normalizeTime_(value, fieldName) {
    var text = String(value == null ? '' : value);
    var match = /^(\d{2}):(\d{2})$/.exec(text);
    ensure(
      match &&
        Number(match[1]) >= 0 &&
        Number(match[1]) <= 23 &&
        Number(match[2]) >= 0 &&
        Number(match[2]) <= 59,
      'VALIDATION_REQUEST_INVALID',
      fieldName + ' must use HH:mm in Asia/Tokyo time.'
    );
    return text;
  }

  function freeze_(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }
    Object.keys(value).forEach(function(key) {
      freeze_(value[key]);
    });
    return Object.freeze(value);
  }

  return Object.freeze({
    getSnapshot: getSnapshot,
    save: save,
    __test: Object.freeze({
      normalizeTime: normalizeTime_,
      assertExactRequest: assertExactRequest_
    })
  });
})();

var CharacterConfigRepository = (function() {
  var KEYS = Object.freeze({
    RUNTIME_MODE: 'CHARACTER_RUNTIME_MODE',
    PROFILE_MODE: 'CHARACTER_PROFILE_MODE',
    PROFILE_V1: 'CHARACTER_PROFILE_V1',
    REVISION_V1: 'CHARACTER_PROFILE_REVISION',
    PROFILE_V2: 'CHARACTER_PROFILE_V2',
    REVISION_V2: 'CHARACTER_PROFILE_V2_REVISION',
    PROACTIVE_FREQUENCY: 'PROACTIVE_FREQUENCY',
    QUIET_START: 'QUIET_START',
    QUIET_END: 'QUIET_END'
  });
  var MAX_SAFE_INTEGER = 9007199254740991;

  function readSnapshot() {
    return buildSnapshot_(SheetRepository.getRows(APP_CONSTANTS.SHEETS.CONFIG));
  }

  function buildSnapshot_(rows) {
    var wanted = {};
    Object.keys(KEYS).forEach(function(name) {
      wanted[KEYS[name]] = true;
    });
    var entries = {};
    var duplicateKeys = {};

    (rows || []).forEach(function(row, index) {
      if (!wanted[row.key]) {
        return;
      }
      if (entries[row.key]) {
        duplicateKeys[row.key] = true;
        return;
      }
      entries[row.key] = {
        key: row.key,
        rawValue: row.value == null ? '' : String(row.value),
        type: String(row.type || ''),
        updatedAt: row.updated_at || null,
        rowIndex: index + 2
      };
    });

    var profileV1 = entries[KEYS.PROFILE_V1] || null;
    var revisionV1 = entries[KEYS.REVISION_V1] || null;
    return {
      runtimeMode: entries[KEYS.RUNTIME_MODE] || null,
      profileMode: entries[KEYS.PROFILE_MODE] || null,
      profile: profileV1,
      revision: revisionV1,
      profileV1: profileV1,
      revisionV1: revisionV1,
      profileV2: entries[KEYS.PROFILE_V2] || null,
      revisionV2: entries[KEYS.REVISION_V2] || null,
      proactiveFrequency: entries[KEYS.PROACTIVE_FREQUENCY] || null,
      quietStart: entries[KEYS.QUIET_START] || null,
      quietEnd: entries[KEYS.QUIET_END] || null,
      duplicateKeys: Object.keys(duplicateKeys).sort()
    };
  }

  function saveProfileAtomically(canonicalProfileJson, expectedRevision, updatedAt) {
    return saveProfileVersionAtomically_(
      canonicalProfileJson,
      expectedRevision,
      updatedAt,
      {
        profileKey: KEYS.PROFILE_V1,
        revisionKey: KEYS.REVISION_V1,
        profileField: 'profileV1',
        revisionField: 'revisionV1',
        lockName: 'character-profile-save'
      }
    );
  }

  function saveProfileV2Atomically(canonicalProfileJson, expectedRevision, updatedAt) {
    return saveProfileVersionAtomically_(
      canonicalProfileJson,
      expectedRevision,
      updatedAt,
      {
        profileKey: KEYS.PROFILE_V2,
        revisionKey: KEYS.REVISION_V2,
        profileField: 'profileV2',
        revisionField: 'revisionV2',
        lockName: 'character-profile-v2-save'
      }
    );
  }

  function saveSettingsAtomically(
    canonicalProfileJson,
    expectedRevision,
    proactiveFrequency,
    quietStart,
    quietEnd,
    updatedAt
  ) {
    ensure(
      typeof canonicalProfileJson === 'string' && canonicalProfileJson !== '',
      'VALIDATION_REQUEST_INVALID',
      'Canonical character profile JSON is required.'
    );
    validateJsonWithoutSample_(canonicalProfileJson);
    ensure(
      isSafeNonNegativeInteger_(expectedRevision),
      'VALIDATION_REQUEST_INVALID',
      'Expected character profile revision is invalid.'
    );
    ensure(
      APP_CONSTANTS.CHARACTER.PROACTIVE_FREQUENCIES.indexOf(proactiveFrequency) !== -1,
      'VALIDATION_REQUEST_INVALID',
      'Proactive frequency is invalid.'
    );
    ensure(
      isValidTime_(quietStart) && isValidTime_(quietEnd),
      'VALIDATION_REQUEST_INVALID',
      'Quiet hours are invalid.'
    );
    var savedAt = updatedAt || toIsoStringInTokyo(new Date());
    Validators.assertIsoDateTimeString(savedAt, 'updatedAt');

    try {
      return LockManager.withScriptLock('character-settings-save', function() {
        var snapshot = buildSnapshot_(
          SheetRepository.getRows(APP_CONSTANTS.SHEETS.CONFIG)
        );
        var keys = [
          KEYS.PROFILE_V2,
          KEYS.REVISION_V2,
          KEYS.PROACTIVE_FREQUENCY,
          KEYS.QUIET_START,
          KEYS.QUIET_END
        ];
        assertNoDuplicateKeys_(snapshot, keys);
        assertEntryType_(snapshot.profileV2, 'json', 'PROFILE_ENTRY_INVALID');
        assertEntryType_(snapshot.revisionV2, 'int', 'REVISION_ENTRY_INVALID');
        assertEntryType_(
          snapshot.proactiveFrequency,
          'string',
          'PROACTIVE_FREQUENCY_ENTRY_INVALID'
        );
        assertEntryType_(snapshot.quietStart, 'time', 'QUIET_START_ENTRY_INVALID');
        assertEntryType_(snapshot.quietEnd, 'time', 'QUIET_END_ENTRY_INVALID');

        var currentRevision = parseRevision_(snapshot.revisionV2.rawValue);
        if (currentRevision !== expectedRevision) {
          throw createAppError(
            'CHARACTER_CONFIG_CONFLICT',
            'Character settings revision does not match.',
            { reason: 'REVISION_CONFLICT' }
          );
        }
        ensure(
          currentRevision < MAX_SAFE_INTEGER,
          'CHARACTER_CONFIG_INVALID',
          'Character profile revision cannot be incremented.',
          { reason: 'REVISION_EXHAUSTED' }
        );

        var nextRevision = currentRevision + 1;
        writeEntriesAtomically_([{
          entry: snapshot.profileV2,
          value: canonicalProfileJson
        }, {
          entry: snapshot.revisionV2,
          value: String(nextRevision)
        }, {
          entry: snapshot.proactiveFrequency,
          value: proactiveFrequency
        }, {
          entry: snapshot.quietStart,
          value: quietStart
        }, {
          entry: snapshot.quietEnd,
          value: quietEnd
        }], savedAt);
        SheetRepository.flush();

        var readBack = readSnapshot();
        assertNoDuplicateKeys_(readBack, keys);
        ensure(
          readBack.profileV2 &&
            readBack.profileV2.rawValue === canonicalProfileJson &&
            parseRevision_(readBack.revisionV2.rawValue) === nextRevision &&
            readBack.proactiveFrequency &&
            readBack.proactiveFrequency.rawValue === proactiveFrequency &&
            readBack.quietStart &&
            readBack.quietStart.rawValue === quietStart &&
            readBack.quietEnd &&
            readBack.quietEnd.rawValue === quietEnd,
          'STORAGE_WRITE_FAILED',
          'Character settings write verification failed.',
          { reason: 'SETTINGS_READBACK_MISMATCH' }
        );
        [
          readBack.profileV2,
          readBack.revisionV2,
          readBack.proactiveFrequency,
          readBack.quietStart,
          readBack.quietEnd
        ].forEach(function(entry) {
          ensure(
            entry.updatedAt === savedAt,
            'STORAGE_WRITE_FAILED',
            'Character settings timestamp verification failed.',
            { reason: 'SETTINGS_TIMESTAMP_MISMATCH' }
          );
        });

        return {
          revision: nextRevision,
          updatedAt: savedAt
        };
      });
    } catch (error) {
      if (error && error.code === 'QUEUE_LOCK_BUSY') {
        throw createAppError(
          'CHARACTER_CONFIG_CONFLICT',
          'Character settings are busy.',
          { reason: 'CONFIG_LOCK_BUSY' }
        );
      }
      throw error;
    }
  }

  function saveProfileVersionAtomically_(
    canonicalProfileJson,
    expectedRevision,
    updatedAt,
    version
  ) {
    ensure(
      typeof canonicalProfileJson === 'string' && canonicalProfileJson !== '',
      'VALIDATION_REQUEST_INVALID',
      'Canonical character profile JSON is required.'
    );
    validateJsonWithoutSample_(canonicalProfileJson);
    ensure(
      isSafeNonNegativeInteger_(expectedRevision),
      'VALIDATION_REQUEST_INVALID',
      'Expected character profile revision is invalid.'
    );
    var savedAt = updatedAt || toIsoStringInTokyo(new Date());
    Validators.assertIsoDateTimeString(savedAt, 'updatedAt');

    try {
      return LockManager.withScriptLock(version.lockName, function() {
        var rows = SheetRepository.getRows(APP_CONSTANTS.SHEETS.CONFIG);
        var snapshot = buildSnapshot_(rows);
        assertNoDuplicateKeys_(snapshot, [version.profileKey, version.revisionKey]);
        assertEntryType_(snapshot[version.profileField], 'json', 'PROFILE_ENTRY_INVALID');
        assertEntryType_(snapshot[version.revisionField], 'int', 'REVISION_ENTRY_INVALID');

        var currentRevision = parseRevision_(snapshot[version.revisionField].rawValue);
        if (currentRevision !== expectedRevision) {
          throw createAppError(
            'CHARACTER_CONFIG_CONFLICT',
            'Character profile revision does not match.',
            { reason: 'REVISION_CONFLICT' }
          );
        }
        ensure(
          currentRevision < MAX_SAFE_INTEGER,
          'CHARACTER_CONFIG_INVALID',
          'Character profile revision cannot be incremented.',
          { reason: 'REVISION_EXHAUSTED' }
        );

        var nextRevision = currentRevision + 1;
        writeProfileAndRevision_(
          snapshot[version.profileField],
          snapshot[version.revisionField],
          canonicalProfileJson,
          nextRevision,
          savedAt
        );
        SheetRepository.flush();

        var readBack = readSnapshot();
        assertNoDuplicateKeys_(readBack, [version.profileKey, version.revisionKey]);
        assertEntryType_(
          readBack[version.profileField],
          'json',
          'PROFILE_READBACK_INVALID'
        );
        assertEntryType_(
          readBack[version.revisionField],
          'int',
          'REVISION_READBACK_INVALID'
        );
        ensure(
          readBack[version.profileField].rawValue === canonicalProfileJson &&
            parseRevision_(readBack[version.revisionField].rawValue) === nextRevision &&
            readBack[version.profileField].updatedAt === savedAt &&
            readBack[version.revisionField].updatedAt === savedAt,
          'STORAGE_WRITE_FAILED',
          'Character profile write verification failed.',
          { reason: 'PROFILE_READBACK_MISMATCH' }
        );

        return {
          revision: nextRevision,
          updatedAt: savedAt
        };
      });
    } catch (error) {
      if (error && error.code === 'QUEUE_LOCK_BUSY') {
        throw createAppError(
          'CHARACTER_CONFIG_CONFLICT',
          'Character profile configuration is busy.',
          { reason: 'CONFIG_LOCK_BUSY' }
        );
      }
      throw error;
    }
  }

  function writeProfileAndRevision_(profileEntry, revisionEntry, profileJson, revision, updatedAt) {
    writeEntriesAtomically_([{
      entry: profileEntry,
      value: profileJson
    }, {
      entry: revisionEntry,
      value: String(revision)
    }], updatedAt);
  }

  function writeEntriesAtomically_(updates, updatedAt) {
    var sheet = SheetRepository.getSheet(APP_CONSTANTS.SHEETS.CONFIG);
    var headers = SheetRepository.getHeaders(APP_CONSTANTS.SHEETS.CONFIG);
    var valueColumn = headers.indexOf('value') + 1;
    var updatedAtColumn = headers.indexOf('updated_at') + 1;
    ensure(
      valueColumn > 0 && updatedAtColumn > 0,
      'STORAGE_DATA_CORRUPTED',
      'Config sheet is missing character profile columns.',
      { reason: 'CONFIG_COLUMNS_MISSING' }
    );

    var rowIndexes = updates.map(function(update) {
      return update.entry.rowIndex;
    });
    var firstRow = Math.min.apply(null, rowIndexes);
    var lastRow = Math.max.apply(null, rowIndexes);
    var firstColumn = Math.min(valueColumn, updatedAtColumn);
    var lastColumn = Math.max(valueColumn, updatedAtColumn);
    var range = sheet.getRange(
      firstRow,
      firstColumn,
      lastRow - firstRow + 1,
      lastColumn - firstColumn + 1
    );
    var values = range.getValues();
    var formulas = range.getFormulas();
    var valueOffset = valueColumn - firstColumn;
    var updatedAtOffset = updatedAtColumn - firstColumn;
    var savedAtDate = parseIsoToDate(updatedAt);

    for (var rowOffset = 0; rowOffset < formulas.length; rowOffset += 1) {
      for (var columnOffset = 0; columnOffset < formulas[rowOffset].length; columnOffset += 1) {
        if (formulas[rowOffset][columnOffset]) {
          values[rowOffset][columnOffset] = formulas[rowOffset][columnOffset];
        } else if (
          typeof values[rowOffset][columnOffset] === 'string' &&
          values[rowOffset][columnOffset].charAt(0) === '='
        ) {
          values[rowOffset][columnOffset] = "'" + values[rowOffset][columnOffset];
        }
      }
    }

    updates.forEach(function(update) {
      var rowOffset = update.entry.rowIndex - firstRow;
      values[rowOffset][valueOffset] = String(update.value);
      values[rowOffset][updatedAtOffset] = savedAtDate;
    });
    range.setValues(values);
  }

  function assertEntryType_(entry, expectedType, reason) {
    ensure(
      entry && entry.type === expectedType,
      'CHARACTER_CONFIG_INVALID',
      'Character configuration entry is missing or has an invalid type.',
      { reason: reason }
    );
  }

  function assertNoDuplicateKeys_(snapshot, keys) {
    var duplicates = (snapshot && snapshot.duplicateKeys) || [];
    for (var i = 0; i < keys.length; i += 1) {
      ensure(
        duplicates.indexOf(keys[i]) === -1,
        'CHARACTER_CONFIG_INVALID',
        'Duplicate character configuration entry.',
        { reason: 'DUPLICATE_CONFIG_KEY', key: keys[i] }
      );
    }
  }

  function parseRevision_(rawValue) {
    var text = String(rawValue == null ? '' : rawValue);
    ensure(
      /^\d+$/.test(text),
      'CHARACTER_CONFIG_INVALID',
      'Character profile revision is invalid.',
      { reason: 'REVISION_INVALID' }
    );
    var value = Number(text);
    ensure(
      isSafeNonNegativeInteger_(value),
      'CHARACTER_CONFIG_INVALID',
      'Character profile revision is invalid.',
      { reason: 'REVISION_INVALID' }
    );
    return value;
  }

  function isSafeNonNegativeInteger_(value) {
    return typeof value === 'number' &&
      isFinite(value) &&
      Math.floor(value) === value &&
      value >= 0 &&
      value <= MAX_SAFE_INTEGER;
  }

  function isValidTime_(value) {
    var match = /^(\d{2}):(\d{2})$/.exec(String(value == null ? '' : value));
    return Boolean(
      match &&
      Number(match[1]) >= 0 &&
      Number(match[1]) <= 23 &&
      Number(match[2]) >= 0 &&
      Number(match[2]) <= 59
    );
  }

  function validateJsonWithoutSample_(text) {
    try {
      JSON.parse(text);
    } catch (error) {
      throw createAppError(
        'VALIDATION_REQUEST_INVALID',
        'Character profile JSON is invalid.',
        { reason: 'PROFILE_JSON_INVALID' }
      );
    }
  }

  return {
    readSnapshot: readSnapshot,
    saveProfileAtomically: saveProfileAtomically,
    saveProfileV2Atomically: saveProfileV2Atomically,
    saveSettingsAtomically: saveSettingsAtomically,
    __test: {
      buildSnapshot: buildSnapshot_,
      parseRevision: parseRevision_
    }
  };
})();

var CharacterConfigRepository = (function() {
  var KEYS = Object.freeze({
    RUNTIME_MODE: 'CHARACTER_RUNTIME_MODE',
    PROFILE_MODE: 'CHARACTER_PROFILE_MODE',
    PROFILE: 'CHARACTER_PROFILE_V1',
    REVISION: 'CHARACTER_PROFILE_REVISION',
    PROACTIVE_FREQUENCY: 'PROACTIVE_FREQUENCY'
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

    return {
      runtimeMode: entries[KEYS.RUNTIME_MODE] || null,
      profileMode: entries[KEYS.PROFILE_MODE] || null,
      profile: entries[KEYS.PROFILE] || null,
      revision: entries[KEYS.REVISION] || null,
      proactiveFrequency: entries[KEYS.PROACTIVE_FREQUENCY] || null,
      duplicateKeys: Object.keys(duplicateKeys).sort()
    };
  }

  function saveProfileAtomically(canonicalProfileJson, expectedRevision, updatedAt) {
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
      return LockManager.withScriptLock('character-profile-save', function() {
        var rows = SheetRepository.getRows(APP_CONSTANTS.SHEETS.CONFIG);
        var snapshot = buildSnapshot_(rows);
        assertNoDuplicateKeys_(snapshot, [KEYS.PROFILE, KEYS.REVISION]);
        assertEntryType_(snapshot.profile, 'json', 'PROFILE_ENTRY_INVALID');
        assertEntryType_(snapshot.revision, 'int', 'REVISION_ENTRY_INVALID');

        var currentRevision = parseRevision_(snapshot.revision.rawValue);
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
          snapshot.profile,
          snapshot.revision,
          canonicalProfileJson,
          nextRevision,
          savedAt
        );
        SheetRepository.flush();

        var readBack = readSnapshot();
        assertNoDuplicateKeys_(readBack, [KEYS.PROFILE, KEYS.REVISION]);
        assertEntryType_(readBack.profile, 'json', 'PROFILE_READBACK_INVALID');
        assertEntryType_(readBack.revision, 'int', 'REVISION_READBACK_INVALID');
        ensure(
          readBack.profile.rawValue === canonicalProfileJson &&
            parseRevision_(readBack.revision.rawValue) === nextRevision &&
            readBack.profile.updatedAt === savedAt &&
            readBack.revision.updatedAt === savedAt,
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

    var firstRow = Math.min(profileEntry.rowIndex, revisionEntry.rowIndex);
    var lastRow = Math.max(profileEntry.rowIndex, revisionEntry.rowIndex);
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

    values[profileEntry.rowIndex - firstRow][valueOffset] = profileJson;
    values[profileEntry.rowIndex - firstRow][updatedAtOffset] = savedAtDate;
    values[revisionEntry.rowIndex - firstRow][valueOffset] = String(revision);
    values[revisionEntry.rowIndex - firstRow][updatedAtOffset] = savedAtDate;
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
    __test: {
      buildSnapshot: buildSnapshot_,
      parseRevision: parseRevision_
    }
  };
})();

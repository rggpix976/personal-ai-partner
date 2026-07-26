var ConfigRepository = (function() {
  function toConfigDto_(row) {
    return {
      key: row.key,
      rawValue: row.value,
      type: row.type,
      value: Validators.parseConfigValue(row.type, row.value),
      description: row.description,
      updatedAt: row.updated_at
    };
  }

  function listAll() {
    return SheetRepository.getRows(APP_CONSTANTS.SHEETS.CONFIG).map(function(row) {
      return {
        key: row.key,
        value: row.value,
        type: row.type,
        description: row.description,
        updatedAt: row.updated_at
      };
    });
  }

  function getByKey(key) {
    return getUniqueByKey(key);
  }

  function getUniqueByKey(key) {
    var rows = SheetRepository.getRows(APP_CONSTANTS.SHEETS.CONFIG)
      .filter(function(row) {
        return row.key === key;
      });
    ensure(
      rows.length <= 1,
      'STORAGE_DATA_CORRUPTED',
      'Duplicate config key.',
      { key: key }
    );
    return rows.length === 1 ? toConfigDto_(rows[0]) : null;
  }

  function upsertDefault(entry) {
    Validators.validateConfigEntry(entry);
    var existing = getByKey(entry.key);
    if (existing) {
      return existing;
    }
    var row = {
      key: entry.key,
      value: entry.value,
      type: entry.type,
      description: entry.description,
      updated_at: toIsoStringInTokyo(new Date())
    };
    var sheet = SheetRepository.getSheet(APP_CONSTANTS.SHEETS.CONFIG);
    var headers = SheetRepository.getHeaders(APP_CONSTANTS.SHEETS.CONFIG);
    var targetRow = sheet.getLastRow() + 1;
    var valueColumn = headers.indexOf('value') + 1;
    if (valueColumn > 0) {
      sheet.getRange(targetRow, valueColumn).setNumberFormat('@');
    }
    sheet.getRange(targetRow, 1, 1, headers.length).setValues([[
      row.key,
      String(row.value),
      row.type,
      row.description,
      parseIsoToDate(row.updated_at)
    ]]);
    return getByKey(entry.key);
  }

  function ensureDefaults() {
    return APP_CONSTANTS.CONFIG_DEFAULTS.map(upsertDefault);
  }

  function validateDefaultsPresent() {
    APP_CONSTANTS.CONFIG_DEFAULTS.forEach(function(entry) {
      var config = getUniqueByKey(entry.key);
      if (!config) {
        throw createAppError('CONFIG_MISSING', 'Missing default config entry.', {
          key: entry.key
        });
      }
      Validators.validateConfigEntry({
        key: config.key,
        value: config.rawValue,
        type: config.type,
        description: config.description
      });
    });
    return true;
  }

  return {
    listAll: listAll,
    getByKey: getByKey,
    getUniqueByKey: getUniqueByKey,
    upsertDefault: upsertDefault,
    ensureDefaults: ensureDefaults,
    validateDefaultsPresent: validateDefaultsPresent
  };
})();

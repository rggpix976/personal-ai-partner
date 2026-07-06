var ConfigRepository = (function() {
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
    var rows = SheetRepository.getRows(APP_CONSTANTS.SHEETS.CONFIG);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].key === key) {
        return {
          key: rows[i].key,
          rawValue: rows[i].value,
          type: rows[i].type,
          value: Validators.parseConfigValue(rows[i].type, rows[i].value),
          description: rows[i].description,
          updatedAt: rows[i].updated_at
        };
      }
    }
    return null;
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
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([[
      row.key,
      row.value,
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
      var config = getByKey(entry.key);
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
    upsertDefault: upsertDefault,
    ensureDefaults: ensureDefaults,
    validateDefaultsPresent: validateDefaultsPresent
  };
})();

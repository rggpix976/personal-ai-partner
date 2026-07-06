var Validators = (function() {
  var UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/;
  var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || value === '') {
      throw createAppError('CONFIG_MISSING', (label || 'value') + ' must be a non-empty string.');
    }
    return value;
  }

  function isUuidV4(value) {
    return typeof value === 'string' && UUID_V4_PATTERN.test(value);
  }

  function assertUuidV4(value, label) {
    if (!isUuidV4(value)) {
      throw createAppError('CONFIG_MISSING', (label || 'value') + ' must be a UUID v4.', {
        label: label,
        value: value
      });
    }
    return value;
  }

  function isIsoDateTimeString(value) {
    return typeof value === 'string' && ISO_DATE_TIME_PATTERN.test(value);
  }

  function assertIsoDateTimeString(value, label) {
    if (!isIsoDateTimeString(value)) {
      throw createAppError('CONFIG_MISSING', (label || 'value') + ' must be an ISO 8601 date-time string.', {
        label: label,
        value: value
      });
    }
    return value;
  }

  function isDateString(value) {
    return typeof value === 'string' && DATE_PATTERN.test(value);
  }

  function assertDateString(value, label) {
    if (!isDateString(value)) {
      throw createAppError('CONFIG_MISSING', (label || 'value') + ' must be a yyyy-MM-dd string.', {
        label: label,
        value: value
      });
    }
    return value;
  }

  function isTimeString(value) {
    return typeof value === 'string' && TIME_PATTERN.test(value);
  }

  function assertTimeString(value, label) {
    if (!isTimeString(value)) {
      throw createAppError('CONFIG_MISSING', (label || 'value') + ' must be an HH:mm string.', {
        label: label,
        value: value
      });
    }
    return value;
  }

  function assertEnum(value, allowedValues, label) {
    if (allowedValues.indexOf(value) === -1) {
      throw createAppError('CONFIG_MISSING', (label || 'value') + ' must be one of: ' + allowedValues.join(', '), {
        label: label,
        value: value,
        allowedValues: allowedValues
      });
    }
    return value;
  }

  function assertMimeType(value, label) {
    return assertEnum(value, APP_CONSTANTS.MIME_TYPES, label || 'mimeType');
  }

  function assertOwnerEmail(value) {
    if (typeof value !== 'string' || !EMAIL_PATTERN.test(value)) {
      throw createAppError('CONFIG_MISSING', 'OWNER_EMAIL must be a valid email address.');
    }
    return value;
  }

  function assertAppEnv(value) {
    return assertEnum(value, APP_CONSTANTS.APP_ENVS, 'APP_ENV');
  }

  function parseConfigValue(type, value) {
    assertEnum(type, APP_CONSTANTS.CONFIG_TYPES, 'config.type');
    if (value == null || value === '') {
      return null;
    }
    switch (type) {
      case 'string':
        return String(value);
      case 'int':
        if (!/^-?\d+$/.test(String(value))) {
          throw createAppError('CONFIG_MISSING', 'Config int value is invalid.', {
            type: type,
            value: value
          });
        }
        return parseInt(value, 10);
      case 'float':
        if (isNaN(Number(value))) {
          throw createAppError('CONFIG_MISSING', 'Config float value is invalid.', {
            type: type,
            value: value
          });
        }
        return Number(value);
      case 'bool':
        if (value === true || value === 'true') {
          return true;
        }
        if (value === false || value === 'false') {
          return false;
        }
        throw createAppError('CONFIG_MISSING', 'Config bool value is invalid.', {
          type: type,
          value: value
        });
      case 'time':
        return assertTimeString(String(value), 'config.value');
      case 'json':
        return JsonUtil.parse(String(value), {
          code: 'STORAGE_DATA_CORRUPTED',
          message: 'Config JSON value is invalid.'
        });
      default:
        throw createAppError('CONFIG_MISSING', 'Unsupported config type.', {
          type: type
        });
    }
  }

  function stringifyConfigValue(type, value) {
    assertEnum(type, APP_CONSTANTS.CONFIG_TYPES, 'config.type');
    if (value == null) {
      return '';
    }
    switch (type) {
      case 'json':
        return JsonUtil.stringify(value);
      case 'bool':
        return value ? 'true' : 'false';
      default:
        return String(value);
    }
  }

  function validateConfigEntry(entry) {
    assertNonEmptyString(entry.key, 'config.key');
    assertEnum(entry.type, APP_CONSTANTS.CONFIG_TYPES, 'config.type');
    parseConfigValue(entry.type, entry.value);
    assertNonEmptyString(entry.description, 'config.description');
    return true;
  }

  function validateSheetSchema(sheetName, actualHeaders) {
    var expected = getSheetSchema(sheetName).map(function(column) {
      return column.name;
    });
    if (actualHeaders.length < expected.length) {
      throw createAppError('STORAGE_DATA_CORRUPTED', 'Sheet schema is missing required columns.', {
        sheetName: sheetName,
        actualHeaders: actualHeaders,
        expectedHeaders: expected
      });
    }
    for (var i = 0; i < expected.length; i += 1) {
      if (actualHeaders[i] !== expected[i]) {
        throw createAppError('STORAGE_DATA_CORRUPTED', 'Sheet schema column order is invalid.', {
          sheetName: sheetName,
          columnIndex: i,
          actualHeader: actualHeaders[i],
          expectedHeader: expected[i]
        });
      }
    }
    return true;
  }

  function validateScriptProperties(propertyMap, phase) {
    var keys = APP_CONSTANTS.PROPERTY_KEYS;
    if (phase === 'preSetup') {
      assertNonEmptyString(propertyMap[keys.GEMINI_API_KEY], keys.GEMINI_API_KEY);
      assertOwnerEmail(propertyMap[keys.OWNER_EMAIL]);
      assertAppEnv(propertyMap[keys.APP_ENV]);
      return true;
    }
    if (phase === 'postSetup') {
      validateScriptProperties(propertyMap, 'preSetup');
      assertNonEmptyString(propertyMap[keys.SPREADSHEET_ID], keys.SPREADSHEET_ID);
      assertNonEmptyString(propertyMap[keys.DIARY_DOC_ID], keys.DIARY_DOC_ID);
      assertNonEmptyString(propertyMap[keys.TEMP_FOLDER_ID], keys.TEMP_FOLDER_ID);
      assertNonEmptyString(propertyMap[keys.BACKUP_FOLDER_ID], keys.BACKUP_FOLDER_ID);
      if (propertyMap[keys.SCHEMA_VERSION] !== APP_CONSTANTS.SCHEMA_VERSION) {
        throw createAppError('CONFIG_MISSING', 'SCHEMA_VERSION does not match the expected version.', {
          actual: propertyMap[keys.SCHEMA_VERSION],
          expected: APP_CONSTANTS.SCHEMA_VERSION
        });
      }
      return true;
    }
    if (phase === 'postDeploy') {
      validateScriptProperties(propertyMap, 'postSetup');
      assertNonEmptyString(propertyMap[keys.WEB_APP_URL], keys.WEB_APP_URL);
      return true;
    }
    throw createAppError('CONFIG_MISSING', 'Unknown validation phase.', {
      phase: phase
    });
  }

  function validateUserMessageText(text) {
    if (text != null && String(text).length > 4000) {
      throw createAppError('VALIDATION_TEXT_TOO_LONG', 'User text exceeds the 4000 character limit.');
    }
    return true;
  }

  return {
    assertNonEmptyString: assertNonEmptyString,
    isUuidV4: isUuidV4,
    assertUuidV4: assertUuidV4,
    isIsoDateTimeString: isIsoDateTimeString,
    assertIsoDateTimeString: assertIsoDateTimeString,
    isDateString: isDateString,
    assertDateString: assertDateString,
    isTimeString: isTimeString,
    assertTimeString: assertTimeString,
    assertEnum: assertEnum,
    assertMimeType: assertMimeType,
    assertOwnerEmail: assertOwnerEmail,
    assertAppEnv: assertAppEnv,
    parseConfigValue: parseConfigValue,
    stringifyConfigValue: stringifyConfigValue,
    validateConfigEntry: validateConfigEntry,
    validateSheetSchema: validateSheetSchema,
    validateScriptProperties: validateScriptProperties,
    validateUserMessageText: validateUserMessageText
  };
})();

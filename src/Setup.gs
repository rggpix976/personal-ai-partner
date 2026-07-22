function setup() {
  var correlationId = generateUuidV4();
  AppLogger.info('setup', 'Starting setup.', null, correlationId);
  validatePreSetupProperties();
  var properties = PropertiesService.getScriptProperties();
  var spreadsheet = ensurePlatformSpreadsheet_();
  ensureRequiredSheets_(spreadsheet);
  var diaryDocument = DocumentRepository.createOrOpenDiaryDocument();
  var folders = DriveTempRepository.ensureFolders();
  ConfigRepository.ensureDefaults();
  ConfigRepository.validateDefaultsPresent();
  SheetRepository.ensureDefaultUserState();
  LockManager.withScriptLock('schemaVersionWrite', function() {
    properties.setProperty(APP_CONSTANTS.PROPERTY_KEYS.SCHEMA_VERSION, APP_CONSTANTS.SCHEMA_VERSION);
  });
  validatePostSetupProperties();
  return {
    ok: true,
    spreadsheetId: spreadsheet.getId(),
    diaryDocumentId: diaryDocument.getId(),
    tempFolderId: folders.tempFolder.getId(),
    backupFolderId: folders.backupFolder.getId(),
    schemaVersion: APP_CONSTANTS.SCHEMA_VERSION
  };
}

function migrateSchema() {
  return LockManager.withScriptLock('migrateSchema', function() {
    var spreadsheet = ensurePlatformSpreadsheet_();
    var changes = [];
    Object.keys(APP_CONSTANTS.SHEET_SCHEMAS).forEach(function(sheetName) {
      changes = changes.concat(appendMissingColumns_(spreadsheet, sheetName));
    });
    ConfigRepository.ensureDefaults();
    ConfigRepository.validateDefaultsPresent();
    PropertiesService.getScriptProperties().setProperty(
      APP_CONSTANTS.PROPERTY_KEYS.SCHEMA_VERSION,
      APP_CONSTANTS.SCHEMA_VERSION
    );
    return {
      ok: true,
      schemaVersion: APP_CONSTANTS.SCHEMA_VERSION,
      changes: changes
    };
  });
}

function validatePreSetupProperties() {
  var properties = PropertiesService.getScriptProperties().getProperties();
  Validators.validateScriptProperties(properties, 'preSetup');
  return true;
}

function validatePostSetupProperties() {
  var properties = PropertiesService.getScriptProperties().getProperties();
  Validators.validateScriptProperties(properties, 'postSetup');
  var spreadsheet = SpreadsheetApp.openById(properties[APP_CONSTANTS.PROPERTY_KEYS.SPREADSHEET_ID]);
  Object.keys(APP_CONSTANTS.SHEET_SCHEMAS).forEach(function(sheetName) {
    var sheet = spreadsheet.getSheetByName(sheetName);
    ensure(sheet, 'CONFIG_MISSING', 'Missing required sheet after setup.', {
      sheetName: sheetName
    });
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    Validators.validateSheetSchema(sheetName, headers);
  });
  DocumentRepository.validateDiaryDocument(properties[APP_CONSTANTS.PROPERTY_KEYS.DIARY_DOC_ID]);
  DriveTempRepository.validateFolder(properties[APP_CONSTANTS.PROPERTY_KEYS.TEMP_FOLDER_ID]);
  DriveTempRepository.validateFolder(properties[APP_CONSTANTS.PROPERTY_KEYS.BACKUP_FOLDER_ID]);
  ConfigRepository.validateDefaultsPresent();
  ensure(SheetRepository.getUserState() != null, 'CONFIG_MISSING', 'user_state default row is missing.');
  return true;
}

function validatePostDeployProperties() {
  var properties = PropertiesService.getScriptProperties().getProperties();
  Validators.validateScriptProperties(properties, 'postDeploy');
  ensure(
    String(properties[APP_CONSTANTS.PROPERTY_KEYS.WEB_APP_URL]).indexOf('/exec') !== -1,
    'CONFIG_MISSING',
    'WEB_APP_URL must point to a deployed /exec endpoint.'
  );
  return true;
}

function runPlatformSelfTest() {
  var results = runA2PlatformTests();
  return {
    ok: results.failures.length === 0,
    passed: results.passes,
    failures: results.failures,
    checkedAt: toIsoStringInTokyo(new Date())
  };
}

function ensurePlatformSpreadsheet_() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty(APP_CONSTANTS.PROPERTY_KEYS.SPREADSHEET_ID);
  if (spreadsheetId) {
    var existing = SpreadsheetApp.openById(spreadsheetId);
    existing.setSpreadsheetTimeZone(APP_CONSTANTS.TIME_ZONE);
    return existing;
  }
  var spreadsheet = SpreadsheetApp.create('Personal AI Partner Data');
  spreadsheet.setSpreadsheetTimeZone(APP_CONSTANTS.TIME_ZONE);
  return LockManager.withScriptLock('spreadsheetPropertyWrite', function() {
    var existingId = properties.getProperty(APP_CONSTANTS.PROPERTY_KEYS.SPREADSHEET_ID);
    if (existingId) {
      var existingSpreadsheet = SpreadsheetApp.openById(existingId);
      existingSpreadsheet.setSpreadsheetTimeZone(APP_CONSTANTS.TIME_ZONE);
      return existingSpreadsheet;
    }
    properties.setProperty(APP_CONSTANTS.PROPERTY_KEYS.SPREADSHEET_ID, spreadsheet.getId());
    return spreadsheet;
  });
}

function ensureRequiredSheets_(spreadsheet) {
  Object.keys(APP_CONSTANTS.SHEET_SCHEMAS).forEach(function(sheetName) {
    ensureSheetSchema_(spreadsheet, sheetName);
  });
}

function ensureSheetSchema_(spreadsheet, sheetName) {
  var schema = getSheetSchema(sheetName);
  var sheet = spreadsheet.getSheetByName(sheetName);
  var expectedHeaders = schema.map(function(column) {
    return column.name;
  });

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  var currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Validators.validateSheetSchema(sheetName, currentHeaders.concat(expectedHeaders.slice(currentHeaders.length)));
  appendMissingColumns_(spreadsheet, sheetName);
  return sheet;
}

function appendMissingColumns_(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  var schema = getSheetSchema(sheetName);
  var expectedHeaders = schema.map(function(column) {
    return column.name;
  });
  var actualHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    .filter(function(value) {
      return value !== '';
    });
  var changes = [];
  for (var i = 0; i < expectedHeaders.length; i += 1) {
    if (actualHeaders[i] == null) {
      sheet.getRange(1, i + 1).setValue(expectedHeaders[i]);
      changes.push({
        sheetName: sheetName,
        action: 'append_column',
        columnName: expectedHeaders[i]
      });
      continue;
    }
    if (actualHeaders[i] !== expectedHeaders[i]) {
      throw createAppError('STORAGE_DATA_CORRUPTED', 'Sheet schema drift requires a change request.', {
        sheetName: sheetName,
        columnIndex: i,
        actualHeader: actualHeaders[i],
        expectedHeader: expectedHeaders[i]
      });
    }
  }
  if (changes.length > 0) {
    sheet.setFrozenRows(1);
  }
  return changes;
}

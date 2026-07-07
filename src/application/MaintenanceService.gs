var MaintenanceService = (function() {
  function runPeriodicMaintenance(now) {
    var reference = now instanceof Date ? now : (now ? parseIsoToDate(now) : new Date());
    return {
      tempCleanup: cleanupExpiredTemporaryImages(reference),
      debugCleanup: cleanupOldDebugLogs(reference)
    };
  }

  function cleanupExpiredTemporaryImages(now) {
    var ttlHours = getConfigInt_('TEMP_IMAGE_TTL_HOURS', 24);
    return DriveTempRepository.cleanupExpiredTempImages(now || new Date(), ttlHours);
  }

  function cleanupOldDebugLogs(now) {
    var retentionDays = getConfigInt_('LOG_RETENTION_DAYS', 30);
    var reference = now || new Date();
    var cutoff = new Date(reference.getTime() - retentionDays * 86400000);
    return SheetRepository.deleteDebugLogsOlderThan(toIsoStringInTokyo(cutoff));
  }

  function weeklyBackup(eventPayload) {
    var payload = eventPayload || {};
    ensure(Validators.isDateString(payload.backupDate), 'VALIDATION_REQUEST_INVALID', 'backupDate must be a yyyy-MM-dd string.');
    var properties = PropertiesService.getScriptProperties();
    var spreadsheetId = properties.getProperty(APP_CONSTANTS.PROPERTY_KEYS.SPREADSHEET_ID);
    var documentId = properties.getProperty(APP_CONSTANTS.PROPERTY_KEYS.DIARY_DOC_ID);
    ensure(spreadsheetId, 'CONFIG_MISSING', 'SPREADSHEET_ID is not configured.');
    ensure(documentId, 'CONFIG_MISSING', 'DIARY_DOC_ID is not configured.');
    var folders = DriveTempRepository.ensureFolders();
    var backupFolder = folders.backupFolder;
    var spreadsheetCopy = DriveApp.getFileById(spreadsheetId).makeCopy(
      'personal-ai-partner-sheet-backup-' + payload.backupDate,
      backupFolder
    );
    var diaryCopy = DriveApp.getFileById(documentId).makeCopy(
      'personal-ai-partner-diary-backup-' + payload.backupDate,
      backupFolder
    );
    enforceBackupRetention_(backupFolder, getConfigInt_('BACKUP_RETENTION_COUNT', 4));
    return {
      backupDate: payload.backupDate,
      spreadsheetBackupFileId: spreadsheetCopy.getId(),
      diaryBackupFileId: diaryCopy.getId()
    };
  }

  function enforceBackupRetention_(folder, retentionCount) {
    var files = folder.getFiles();
    var items = [];
    while (files.hasNext()) {
      var file = files.next();
      items.push({
        file: file,
        updatedAt: file.getLastUpdated ? file.getLastUpdated().getTime() : file.getDateCreated().getTime()
      });
    }
    items.sort(function(a, b) {
      return b.updatedAt - a.updatedAt;
    });
    items.slice(Math.max(retentionCount, 0)).forEach(function(item) {
      item.file.setTrashed(true);
    });
  }

  function getConfigInt_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? Number(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  return {
    runPeriodicMaintenance: runPeriodicMaintenance,
    cleanupExpiredTemporaryImages: cleanupExpiredTemporaryImages,
    cleanupOldDebugLogs: cleanupOldDebugLogs,
    weeklyBackup: weeklyBackup
  };
})();

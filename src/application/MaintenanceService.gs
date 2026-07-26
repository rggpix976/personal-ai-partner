var MaintenanceService = (function() {
  var BACKUP_FILE_PREFIX_ = 'personal-ai-partner-';
  var BACKUP_FILE_PATTERN_ =
    /^personal-ai-partner-(sheet|diary)-backup-(\d{4}-\d{2}-\d{2})$/;

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
    var stage = 'ENSURE_FOLDERS';
    try {
      var folders = DriveTempRepository.ensureFolders();
      var backupFolder = folders.backupFolder;
      stage = 'COPY_SPREADSHEET';
      var spreadsheetCopy = ensureBackupCopy_(
        spreadsheetId,
        backupFileName_('sheet', payload.backupDate),
        backupFolder
      );
      stage = 'COPY_DIARY';
      var diaryCopy = ensureBackupCopy_(
        documentId,
        backupFileName_('diary', payload.backupDate),
        backupFolder
      );
      stage = 'ENFORCE_RETENTION';
      enforceBackupRetention_(
        backupFolder,
        getConfigInt_('BACKUP_RETENTION_COUNT', 4)
      );
      return {
        backupDate: payload.backupDate,
        spreadsheetBackupFileId: spreadsheetCopy.getId(),
        diaryBackupFileId: diaryCopy.getId()
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw createAppError(
        'STORAGE_WRITE_FAILED',
        'Weekly backup storage operation failed.',
        { stage: stage },
        { cause: error }
      );
    }
  }

  function backupFileName_(kind, backupDate) {
    return BACKUP_FILE_PREFIX_ + kind + '-backup-' + backupDate;
  }

  function ensureBackupCopy_(sourceFileId, targetName, backupFolder) {
    var existing = backupFolder.getFilesByName(targetName);
    var newest = null;
    var newestTime = -1;
    while (existing.hasNext()) {
      var candidate = existing.next();
      var candidateTime = getFileTimestamp_(candidate);
      if (!newest || candidateTime > newestTime) {
        newest = candidate;
        newestTime = candidateTime;
      }
    }
    if (newest) {
      return newest;
    }
    return DriveApp.getFileById(sourceFileId).makeCopy(
      targetName,
      backupFolder
    );
  }

  function enforceBackupRetention_(folder, retentionCount) {
    var files = folder.getFiles();
    var snapshots = {};
    while (files.hasNext()) {
      var file = files.next();
      var name = String(file.getName ? file.getName() : '');
      var match = name.match(BACKUP_FILE_PATTERN_);
      if (!match) {
        continue;
      }
      var backupDate = match[2];
      if (!snapshots[backupDate]) {
        snapshots[backupDate] = [];
      }
      snapshots[backupDate].push(file);
    }
    var retainedDates = Object.keys(snapshots)
      .sort()
      .reverse()
      .slice(0, Math.max(Number(retentionCount) || 0, 0));
    var retained = {};
    retainedDates.forEach(function(date) {
      retained[date] = true;
    });
    Object.keys(snapshots).forEach(function(date) {
      if (retained[date]) {
        return;
      }
      snapshots[date].forEach(function(file) {
        file.setTrashed(true);
      });
    });
  }

  function getFileTimestamp_(file) {
    var timestamp = file.getLastUpdated
      ? file.getLastUpdated()
      : file.getDateCreated();
    return timestamp instanceof Date ? timestamp.getTime() : 0;
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

var DriveTempRepository = (function() {
  function getOrCreateFolder(propertyKey, folderName) {
    var properties = PropertiesService.getScriptProperties();
    var folderId = properties.getProperty(propertyKey);
    if (folderId) {
      return DriveApp.getFolderById(folderId);
    }
    var folder = DriveApp.createFolder(folderName);
    return LockManager.withScriptLock('folderPropertyWrite', function() {
      var existingId = properties.getProperty(propertyKey);
      if (existingId) {
        return DriveApp.getFolderById(existingId);
      }
      properties.setProperty(propertyKey, folder.getId());
      return folder;
    });
  }

  function ensureFolders() {
    return {
      tempFolder: getOrCreateFolder(APP_CONSTANTS.PROPERTY_KEYS.TEMP_FOLDER_ID, 'Personal AI Partner Temp'),
      backupFolder: getOrCreateFolder(APP_CONSTANTS.PROPERTY_KEYS.BACKUP_FOLDER_ID, 'Personal AI Partner Backups')
    };
  }

  function validateFolder(folderId) {
    var folder = DriveApp.getFolderById(folderId);
    ensure(folder != null, 'CONFIG_MISSING', 'Folder could not be opened.');
    return true;
  }

  return {
    getOrCreateFolder: getOrCreateFolder,
    ensureFolders: ensureFolders,
    validateFolder: validateFolder
  };
})();

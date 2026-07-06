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

  function createTempImage(input) {
    ensure(input && typeof input === 'object', 'CONFIG_MISSING', 'Temp image input is required.');
    Validators.assertMimeType(input.mimeType, 'tempImage.mimeType');
    ensure(String(input.name || '') !== '', 'CONFIG_MISSING', 'Temp image name is required.');
    ensure(String(input.base64 || '') !== '', 'CONFIG_MISSING', 'Temp image base64 is required.');

    var bytes;
    try {
      bytes = Utilities.base64Decode(input.base64);
    } catch (error) {
      try {
        bytes = Utilities.base64DecodeWebSafe(input.base64);
      } catch (webSafeError) {
        throw createAppError('VALIDATION_IMAGE_UNSUPPORTED', 'Temp image payload is not valid base64.', null, {
          cause: error
        });
      }
    }

    var blob = Utilities.newBlob(bytes, input.mimeType, input.name);
    var tempFolder = ensureFolders().tempFolder;
    var file = tempFolder.createFile(blob);
    var createdAt = input.now ? parseIsoToDate(input.now) : new Date();
    var ttlHours = Number(input.ttlHours);
    if (!isFinite(ttlHours) || ttlHours <= 0) {
      ttlHours = 24;
    }
    var expiresAt = new Date(createdAt.getTime() + ttlHours * 60 * 60 * 1000);

    return {
      tempFileId: file.getId(),
      name: input.name,
      mimeType: input.mimeType,
      expiresAt: toIsoStringInTokyo(expiresAt),
      createdTempFile: true
    };
  }

  function getTempImageData(tempFileId) {
    ensure(String(tempFileId || '') !== '', 'CONFIG_MISSING', 'tempFileId is required.');
    var file = DriveApp.getFileById(tempFileId);
    ensure(file != null, 'CONFIG_MISSING', 'Temporary image file could not be opened.');
    var blob = file.getBlob();
    var bytes = blob.getBytes();
    return {
      tempFileId: tempFileId,
      name: file.getName(),
      mimeType: blob.getContentType(),
      base64: Utilities.base64Encode(bytes),
      sizeBytes: bytes.length
    };
  }

  function trashTempImage(tempFileId) {
    ensure(String(tempFileId || '') !== '', 'CONFIG_MISSING', 'tempFileId is required.');
    var file = DriveApp.getFileById(tempFileId);
    ensure(file != null, 'CONFIG_MISSING', 'Temporary image file could not be opened.');
    file.setTrashed(true);
    return true;
  }

  return {
    getOrCreateFolder: getOrCreateFolder,
    ensureFolders: ensureFolders,
    validateFolder: validateFolder,
    createTempImage: createTempImage,
    getTempImageData: getTempImageData,
    trashTempImage: trashTempImage
  };
})();

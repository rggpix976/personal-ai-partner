var ImageArchiveRepository = (function() {
  var FOLDER_NAME = 'Personal AI Partner Image Archive';
  var MAX_IMAGE_BYTES = 4194304;

  function ensureFolder() {
    return DriveTempRepository.getOrCreateFolder(
      APP_CONSTANTS.PROPERTY_KEYS.IMAGE_ARCHIVE_FOLDER_ID,
      FOLDER_NAME
    );
  }

  function ensureArchived(preparedImage, messageId) {
    Validators.assertUuidV4(messageId, 'messageId');
    ensure(
      preparedImage && preparedImage.inlineData,
      'VALIDATION_IMAGE_UNSUPPORTED',
      'Prepared image data is required.'
    );
    Validators.assertMimeType(
      preparedImage.inlineData.mimeType,
      'preparedImage.inlineData.mimeType'
    );
    ensure(
      String(preparedImage.inlineData.data || '') !== '',
      'VALIDATION_IMAGE_UNSUPPORTED',
      'Prepared image base64 is required.'
    );

    try {
      return LockManager.withScriptLock('image-archive-' + messageId, function() {
        var folder = ensureFolder();
        var existing = DriveTempRepository.getUniqueFileDataByName(
          folder,
          messageId,
          MAX_IMAGE_BYTES
        );
        if (existing) {
          assertStoredFile_(existing, preparedImage.inlineData.mimeType);
          return {
            archived: true,
            created: false
          };
        }

        var bytes = decodeBase64_(preparedImage.inlineData.data);
        ensure(
          bytes.length <= MAX_IMAGE_BYTES,
          'VALIDATION_IMAGE_TOO_LARGE',
          'Archived image exceeds the supported byte limit.'
        );
        DriveTempRepository.createFileFromBytes(folder, {
          bytes: bytes,
          mimeType: preparedImage.inlineData.mimeType,
          name: messageId
        });
        return {
          archived: true,
          created: true
        };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw createAppError(
        'STORAGE_WRITE_FAILED',
        'Image archive write failed.',
        { stage: 'IMAGE_ARCHIVE_WRITE' },
        { cause: error }
      );
    }
  }

  function getArchivedImage(messageId, expectedMimeType) {
    Validators.assertUuidV4(messageId, 'messageId');
    Validators.assertMimeType(expectedMimeType, 'expectedMimeType');
    var folder = DriveTempRepository.getConfiguredFolder(
      APP_CONSTANTS.PROPERTY_KEYS.IMAGE_ARCHIVE_FOLDER_ID
    );
    var stored = DriveTempRepository.getUniqueFileDataByName(
      folder,
      messageId,
      MAX_IMAGE_BYTES
    );
    if (!stored) {
      return null;
    }
    assertStoredFile_(stored, expectedMimeType);
    ensure(
      stored.sizeBytes <= MAX_IMAGE_BYTES,
      'STORAGE_DATA_CORRUPTED',
      'Archived image exceeds the supported byte limit.'
    );
    return {
      mimeType: expectedMimeType,
      base64: stored.base64,
      sizeBytes: stored.sizeBytes
    };
  }

  function assertStoredFile_(stored, expectedMimeType) {
    ensure(
      stored.mimeType === expectedMimeType,
      'STORAGE_DATA_CORRUPTED',
      'Archived image MIME type does not match the conversation record.'
    );
    return true;
  }

  function decodeBase64_(value) {
    try {
      return Utilities.base64Decode(value);
    } catch (error) {
      try {
        return Utilities.base64DecodeWebSafe(value);
      } catch (webSafeError) {
        throw createAppError(
          'VALIDATION_IMAGE_UNSUPPORTED',
          'Archived image payload is not valid base64.',
          null,
          { cause: error }
        );
      }
    }
  }

  return {
    ensureFolder: ensureFolder,
    ensureArchived: ensureArchived,
    getArchivedImage: getArchivedImage,
    __test: {
      decodeBase64: decodeBase64_
    }
  };
})();

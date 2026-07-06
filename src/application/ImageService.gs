var ImageService = (function() {
  var DEFAULTS = Object.freeze({
    imageMaxBytes: 4194304,
    tempImageTtlHours: 24,
    maxSummaryChars: 150
  });

  function prepareGeminiInput(image, options) {
    options = options || {};
    validateImageMetadata(image);

    var normalizedBase64 = normalizeBase64_(image.base64 || '');
    var tempRecord = null;
    var sizeBytes = null;

    if (image.tempFileId) {
      tempRecord = DriveTempRepository.getTempImageData(image.tempFileId);
      ensure(
        tempRecord.mimeType === image.mimeType,
        'VALIDATION_IMAGE_UNSUPPORTED',
        'Temporary image MIME type does not match the request.'
      );
      if (!normalizedBase64) {
        normalizedBase64 = tempRecord.base64;
      }
      sizeBytes = tempRecord.sizeBytes;
      tempRecord.createdTempFile = false;
    }

    if (!normalizedBase64) {
      throw createAppError('VALIDATION_IMAGE_UNSUPPORTED', 'Image base64 is required.');
    }

    var bytes = decodeBase64ToBytes_(normalizedBase64);
    if (sizeBytes == null) {
      sizeBytes = bytes.length;
    }
    ensure(
      sizeBytes <= getConfigInt_('IMAGE_MAX_BYTES', DEFAULTS.imageMaxBytes),
      'VALIDATION_IMAGE_TOO_LARGE',
      'Image exceeds the configured byte limit.'
    );

    if (!tempRecord) {
      tempRecord = DriveTempRepository.createTempImage({
        name: image.name,
        mimeType: image.mimeType,
        base64: normalizedBase64,
        now: options.now || toIsoStringInTokyo(new Date()),
        ttlHours: getConfigInt_('TEMP_IMAGE_TTL_HOURS', DEFAULTS.tempImageTtlHours)
      });
    }

    return {
      inlineData: {
        mimeType: image.mimeType,
        data: normalizedBase64
      },
      queueImage: {
        tempFileId: tempRecord.tempFileId,
        name: image.name,
        mimeType: image.mimeType,
        expiresAt: tempRecord.expiresAt || buildExpiresAt_(options.now)
      },
      cleanupTarget: {
        tempFileId: tempRecord.tempFileId,
        createdByCurrentRequest: Boolean(tempRecord.createdTempFile)
      },
      createdTempFile: Boolean(tempRecord.createdTempFile),
      storedImage: {
        name: image.name,
        mimeType: image.mimeType,
        summary: buildImageSummary(image, options.requestText)
      }
    };
  }

  function validateImageMetadata(image) {
    ensure(image && typeof image === 'object', 'VALIDATION_IMAGE_UNSUPPORTED', 'image must be an object.');
    ensure(String(image.name || '') !== '', 'VALIDATION_IMAGE_UNSUPPORTED', 'image.name is required.');
    ensure(
      APP_CONSTANTS.MIME_TYPES.indexOf(image.mimeType) !== -1,
      'VALIDATION_IMAGE_UNSUPPORTED',
      'Unsupported image MIME type.'
    );
    ensure(
      String(image.base64 || '') !== '' || String(image.tempFileId || '') !== '',
      'VALIDATION_IMAGE_UNSUPPORTED',
      'Either image.base64 or image.tempFileId is required.'
    );

    if (image.base64) {
      var bytes = decodeBase64ToBytes_(normalizeBase64_(image.base64));
      ensure(
        bytes.length <= getConfigInt_('IMAGE_MAX_BYTES', DEFAULTS.imageMaxBytes),
        'VALIDATION_IMAGE_TOO_LARGE',
        'Image exceeds the configured byte limit.'
      );
    }
    return true;
  }

  function cleanupAfterSuccess(preparedImage) {
    return cleanupPreparedImage(preparedImage);
  }

  function cleanupPreparedImage(preparedImage) {
    if (!preparedImage || !preparedImage.cleanupTarget || !preparedImage.cleanupTarget.tempFileId) {
      return false;
    }
    if (!preparedImage.cleanupTarget.createdByCurrentRequest) {
      return false;
    }
    DriveTempRepository.trashTempImage(preparedImage.cleanupTarget.tempFileId);
    return true;
  }

  function buildImageSummary(image, requestText) {
    var base = String(requestText || '').trim();
    if (base) {
      return truncate_(base, DEFAULTS.maxSummaryChars);
    }
    return truncate_('Image attachment: ' + String(image.name || 'uploaded image'), DEFAULTS.maxSummaryChars);
  }

  function summarizeFromAssistantText(assistantText) {
    var text = String(assistantText || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return 'Image attachment';
    }
    return truncate_(text, DEFAULTS.maxSummaryChars);
  }

  function normalizeBase64_(value) {
    var normalized = String(value || '').trim();
    var prefixIndex = normalized.indexOf('base64,');
    if (prefixIndex !== -1) {
      normalized = normalized.slice(prefixIndex + 7);
    }
    return normalized.replace(/\s+/g, '');
  }

  function decodeBase64ToBytes_(base64) {
    try {
      return Utilities.base64Decode(base64);
    } catch (error) {
      try {
        return Utilities.base64DecodeWebSafe(base64);
      } catch (webSafeError) {
        throw createAppError('VALIDATION_IMAGE_UNSUPPORTED', 'Image payload is not valid base64.', null, {
          cause: error
        });
      }
    }
  }

  function truncate_(text, maxChars) {
    if (text.length <= maxChars) {
      return text;
    }
    if (maxChars <= 3) {
      return text.slice(0, maxChars);
    }
    return text.slice(0, maxChars - 3).replace(/\s+$/g, '') + '...';
  }

  function getConfigInt_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? Number(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function buildExpiresAt_(nowIso) {
    var base = nowIso ? parseIsoToDate(nowIso) : new Date();
    var ttlHours = getConfigInt_('TEMP_IMAGE_TTL_HOURS', DEFAULTS.tempImageTtlHours);
    return toIsoStringInTokyo(new Date(base.getTime() + ttlHours * 60 * 60 * 1000));
  }

  return {
    prepareGeminiInput: prepareGeminiInput,
    validateImageMetadata: validateImageMetadata,
    cleanupAfterSuccess: cleanupAfterSuccess,
    cleanupPreparedImage: cleanupPreparedImage,
    buildImageSummary: buildImageSummary,
    summarizeFromAssistantText: summarizeFromAssistantText,
    __test: {
      normalizeBase64: normalizeBase64_,
      truncate: truncate_
    }
  };
})();

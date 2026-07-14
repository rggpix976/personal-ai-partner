var AppLogger = (function() {
  var GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
  var AUTHORIZATION_PATTERN = /(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s]+/gi;
  var API_KEY_HEADER_PATTERN = /(x-goog-api-key["']?\s*[:=]\s*["']?)[^"',\s]+/gi;
  var NAMED_SECRET_PATTERN = /((?:GEMINI_API_KEY|apiKey|api_key|secret|token|accessToken|access_token)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi;
  var DRIVE_ID_FIELD_PATTERN = /((?:spreadsheetId|spreadsheet_id|documentId|document_id|folderId|folder_id|tempFileId|temp_file_id|backupFolderId|backup_folder_id|diaryDocId|diary_doc_id|fileId|file_id)["']?\s*[:=]\s*["']?)([A-Za-z0-9_-]{20,})/gi;
  var GOOGLE_FILE_URL_PATTERN = /(https:\/\/(?:docs|drive)\.google\.com\/[^\s"')]+\/(?:d|folders)\/)([A-Za-z0-9_-]{20,})/gi;
  var BASE64_FIELD_PATTERN = /((?:base64|imageBase64|image_base64)["']?\s*[:=]\s*["']?)(data:image\/[a-zA-Z0-9.+-]+;base64,)?([A-Za-z0-9+/=]{32,})/gi;
  var DATA_URL_BASE64_PATTERN = /(data:image\/[a-zA-Z0-9.+-]+;base64,)([A-Za-z0-9+/=]{32,})/gi;

  function getMaskedDriveId(id) {
    return '[REDACTED_DRIVE_ID:' + id.slice(-4) + ']';
  }

  function replaceIfPresent(text, secretValue, replacement) {
    if (!secretValue) {
      return text;
    }
    return text.split(secretValue).join(replacement);
  }

  function maskWithoutEmail_(value) {
    if (value == null) {
      return value;
    }
    var text = typeof value === 'string' ? value : JsonUtil.stringify(value);
    var ownerEmail = null;
    try {
      ownerEmail = PropertiesService.getScriptProperties().getProperty(APP_CONSTANTS.PROPERTY_KEYS.OWNER_EMAIL);
    } catch (ignore) {}
    var apiKey = null;
    try {
      apiKey = PropertiesService.getScriptProperties().getProperty(APP_CONSTANTS.PROPERTY_KEYS.GEMINI_API_KEY);
    } catch (ignore2) {}

    text = text.replace(AUTHORIZATION_PATTERN, '$1[REDACTED]');
    text = text.replace(API_KEY_HEADER_PATTERN, '$1[REDACTED]');
    text = text.replace(NAMED_SECRET_PATTERN, '$1[REDACTED_SECRET]');
    text = text.replace(GOOGLE_API_KEY_PATTERN, '[REDACTED_API_KEY]');
    text = text.replace(BASE64_FIELD_PATTERN, function(_, prefix, dataPrefix) {
      return prefix + (dataPrefix || '') + '[REDACTED_BASE64]';
    });
    text = text.replace(DATA_URL_BASE64_PATTERN, '$1[REDACTED_BASE64]');
    text = text.replace(DRIVE_ID_FIELD_PATTERN, function(_, prefix, id) {
      return prefix + getMaskedDriveId(id);
    });
    text = text.replace(GOOGLE_FILE_URL_PATTERN, function(_, prefix, id) {
      return prefix + getMaskedDriveId(id);
    });
    text = replaceIfPresent(text, ownerEmail, '[REDACTED_OWNER_EMAIL]');
    text = replaceIfPresent(text, apiKey, '[REDACTED_API_KEY]');
    return text;
  }

  function mask(value) {
    var masked = maskWithoutEmail_(value);
    if (masked == null) {
      return masked;
    }
    return String(masked).replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      '[REDACTED_EMAIL]'
    );
  }

  function buildPayload(level, operation, message, details, correlationId, eventId) {
    return {
      timestamp: toIsoStringInTokyo(new Date()),
      level: level,
      operation: operation,
      correlationId: correlationId || generateUuidV4(),
      eventId: eventId || null,
      message: mask(message),
      details: details == null ? null : mask(details)
    };
  }

  function write(level, operation, message, details, correlationId, eventId) {
    var payload = buildPayload(level, operation, message, details, correlationId, eventId);
    console.log(JsonUtil.stringify(payload));
    return payload;
  }

  function writeDebugLog(level, operation, message, details, correlationId, eventId) {
    var payload = write(level, operation, message, details, correlationId, eventId);
    if (typeof SheetRepository !== 'undefined' && SheetRepository.appendDebugLog) {
      try {
        SheetRepository.appendDebugLog(payload);
      } catch (error) {
        console.warn(JsonUtil.stringify({
          operation: 'AppLogger.writeDebugLog',
          message: 'Failed to persist debug log.',
          correlationId: payload.correlationId,
          error: mask(normalizeError(error).message)
        }));
      }
    }
    return payload;
  }

  function debug(operation, message, details, correlationId) {
    return write('DEBUG', operation, message, details, correlationId);
  }

  function info(operation, message, details, correlationId) {
    return write('INFO', operation, message, details, correlationId);
  }

  function warn(operation, message, details, correlationId) {
    return write('WARN', operation, message, details, correlationId);
  }

  function error(operation, err, details, correlationId) {
    var normalized = normalizeError(err);
    return write('ERROR', operation, normalized.message, {
      error: normalized.toLogObject(),
      details: details || null
    }, correlationId || normalized.correlationId);
  }

  return {
    mask: mask,
    buildPayload: buildPayload,
    write: write,
    writeDebugLog: writeDebugLog,
    debug: debug,
    info: info,
    warn: warn,
    error: error
  };
})();

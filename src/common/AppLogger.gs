var AppLogger = (function() {
  var FOLDER_ID_PATTERN = /\b[A-Za-z0-9_-]{20,}\b/g;
  var GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
  var AUTHORIZATION_PATTERN = /(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s]+/gi;
  var API_KEY_HEADER_PATTERN = /(x-goog-api-key["']?\s*[:=]\s*["']?)[^"',\s]+/gi;
  var BASE64_PATTERN = /\b(?:[A-Za-z0-9+/]{80,}={0,2})\b/g;

  function mask(value) {
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
    text = text.replace(GOOGLE_API_KEY_PATTERN, '[REDACTED_API_KEY]');
    text = text.replace(BASE64_PATTERN, '[REDACTED_BASE64]');
    text = text.replace(FOLDER_ID_PATTERN, '[REDACTED_ID]');
    if (ownerEmail) {
      text = text.split(ownerEmail).join('[REDACTED_OWNER_EMAIL]');
    }
    if (apiKey) {
      text = text.split(apiKey).join('[REDACTED_API_KEY]');
    }
    return text;
  }

  function write(level, operation, message, details, correlationId) {
    var payload = {
      timestamp: toIsoStringInTokyo(new Date()),
      level: level,
      operation: operation,
      correlationId: correlationId || generateUuidV4(),
      message: mask(message),
      details: details == null ? null : mask(details)
    };
    console.log(JsonUtil.stringify(payload));
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
    write: write,
    debug: debug,
    info: info,
    warn: warn,
    error: error
  };
})();

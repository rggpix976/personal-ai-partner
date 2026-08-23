var APP_ERROR_DEFINITIONS = Object.freeze({
  VALIDATION_REQUEST_INVALID: { userMessage: '送信内容が正しくありません。', retryable: false, retryStrategy: 'NONE', httpStatus: 400 },
  VALIDATION_TEXT_TOO_LONG: { userMessage: 'メッセージが長すぎます。', retryable: false, retryStrategy: 'NONE', httpStatus: 400 },
  VALIDATION_IMAGE_UNSUPPORTED: { userMessage: '対応していない画像形式です。', retryable: false, retryStrategy: 'NONE', httpStatus: 400 },
  VALIDATION_IMAGE_TOO_LARGE: { userMessage: '画像が大きすぎます。', retryable: false, retryStrategy: 'NONE', httpStatus: 400 },
  CONFIG_MISSING: { userMessage: '必要な設定が不足しています。', retryable: false, retryStrategy: 'NONE', httpStatus: 500 },
  CHARACTER_CONFIG_INVALID: { userMessage: '推しの設定を確認してください。', retryable: false, retryStrategy: 'NONE', httpStatus: 500 },
  CHARACTER_CONFIG_CONFLICT: { userMessage: '推しの設定が更新されています。再読み込みしてから、もう一度お試しください。', retryable: false, retryStrategy: 'NONE', httpStatus: 409 },
  CHARACTER_OUTPUT_BLOCKED: { userMessage: '返信を安全に完了できませんでした。', retryable: true, retryStrategy: 'COMMON_BACKOFF', httpStatus: 503 },
  CHARACTER_ARTIFACT_INVALID: { userMessage: '返信を安全に完了できませんでした。', retryable: false, retryStrategy: 'NONE', httpStatus: 500 },
  ACCESS_NOT_ALLOWED: { userMessage: 'このアプリへのアクセスは許可されていません。', retryable: false, retryStrategy: 'NONE', httpStatus: 403 },
  DUPLICATE_REQUEST: { userMessage: 'このリクエストはすでに処理されています。', retryable: false, retryStrategy: 'NONE', httpStatus: 409 },
  GEMINI_RATE_LIMIT: { userMessage: 'AIサービスが混み合っています。\n時間をおいて、もう一度お試しください。', retryable: true, retryStrategy: 'COMMON_BACKOFF', httpStatus: 429 },
  GEMINI_AUTH_FAILED: { userMessage: 'AIサービスの認証に失敗しました。', retryable: false, retryStrategy: 'NONE', httpStatus: 401 },
  GEMINI_MODEL_UNAVAILABLE: { userMessage: '設定されたAIモデルを利用できません。', retryable: false, retryStrategy: 'NONE', httpStatus: 503 },
  GEMINI_BAD_RESPONSE: { userMessage: 'AIサービスから正しい応答を受け取れませんでした。', retryable: true, retryStrategy: 'COMMON_BACKOFF', httpStatus: 502 },
  GEMINI_TEMPORARY_FAILURE: { userMessage: 'AIサービスを一時的に利用できません。', retryable: true, retryStrategy: 'COMMON_BACKOFF', httpStatus: 503 },
  STORAGE_WRITE_FAILED: { userMessage: 'データを保存できませんでした。', retryable: true, retryStrategy: 'COMMON_BACKOFF', httpStatus: 503 },
  STORAGE_DATA_CORRUPTED: { userMessage: '保存されているデータに問題があります。', retryable: false, retryStrategy: 'NONE', httpStatus: 500 },
  MAIL_SEND_FAILED: { userMessage: 'メールを一時的に送信できません。', retryable: true, retryStrategy: 'COMMON_BACKOFF', httpStatus: 503 },
  MAIL_QUOTA_EXHAUSTED: { userMessage: '本日分のメール送信上限に達しました。', retryable: true, retryStrategy: 'NEXT_DAILY_WINDOW', httpStatus: 429 },
  QUEUE_LOCK_BUSY: { userMessage: '別の処理を実行中です。少し待ってから、もう一度お試しください。', retryable: true, retryStrategy: 'COMMON_BACKOFF', httpStatus: 409 },
  QUEUE_DEAD: { userMessage: '処理の再試行回数が上限に達しました。', retryable: false, retryStrategy: 'NONE', httpStatus: 409 },
  UNKNOWN: { userMessage: '予期しないエラーが発生しました。', retryable: false, retryStrategy: 'NONE', httpStatus: 500 }
});

function AppError(options) {
  options = options || {};
  this.name = 'AppError';
  this.code = options.code || 'UNKNOWN';
  this.message = options.message || this.code;
  this.userMessage = options.userMessage || this.message;
  this.retryable = Boolean(options.retryable);
  this.retryStrategy = options.retryStrategy || 'NONE';
  this.httpStatus = options.httpStatus == null ? null : options.httpStatus;
  this.cause = options.cause || null;
  this.details = options.details || null;
  this.correlationId = options.correlationId || generateUuidV4();
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, AppError);
  } else {
    this.stack = new Error(this.message).stack;
  }
}

AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

AppError.prototype.toUserDto = function() {
  return {
    code: this.code,
    message: this.userMessage
  };
};

AppError.prototype.toLogObject = function() {
  return {
    name: this.name,
    code: this.code,
    message: this.message,
    userMessage: this.userMessage,
    retryable: this.retryable,
    retryStrategy: this.retryStrategy,
    httpStatus: this.httpStatus,
    details: this.details,
    correlationId: this.correlationId
  };
};

function createAppError(code, message, details, options) {
  var definition = APP_ERROR_DEFINITIONS[code] || APP_ERROR_DEFINITIONS.UNKNOWN;
  options = options || {};
  return new AppError({
    code: code,
    message: message || code,
    userMessage: options.userMessage || definition.userMessage,
    retryable: options.retryable != null ? options.retryable : definition.retryable,
    retryStrategy: options.retryStrategy || definition.retryStrategy,
    httpStatus: options.httpStatus != null ? options.httpStatus : definition.httpStatus,
    cause: options.cause || null,
    details: details || options.details || null,
    correlationId: options.correlationId || null
  });
}

function normalizeError(error, fallbackCode, fallbackMessage, details) {
  if (error instanceof AppError) {
    return error;
  }
  var code = fallbackCode || 'UNKNOWN';
  var message = fallbackMessage || (error && error.message) || code;
  return createAppError(code, message, details, { cause: error });
}

function toPersistedError(error) {
  var normalized = normalizeError(error);
  var code = /^[A-Z0-9_]+$/.test(String(normalized.code || ''))
    ? String(normalized.code)
    : 'UNKNOWN';
  var message = String(normalized.message || code);
  try {
    if (
      typeof AppLogger !== 'undefined' &&
      AppLogger &&
      typeof AppLogger.mask === 'function'
    ) {
      message = String(AppLogger.mask(message));
    }
  } catch (ignoredMaskingError) {}

  // Keep the persistence boundary safe even if logger masking is unavailable
  // or a provider embeds its request URL in a transport exception.
  message = message
    .replace(
      /([?&](?:key|api[_-]?key|token|access[_-]?token|secret)=)[^&#\s"']+/gi,
      '$1[REDACTED_SECRET]'
    )
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(
      /(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s]+/gi,
      '$1[REDACTED]'
    );
  message = message.trim();
  if (!message) {
    message = code;
  }
  return {
    code: code,
    message: message.slice(0, 1000)
  };
}

function ensure(condition, code, message, details) {
  if (!condition) {
    throw createAppError(code, message, details);
  }
}

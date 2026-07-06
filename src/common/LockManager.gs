var LockManager = (function() {
  function tryScriptLock(timeoutMs) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(timeoutMs || 5000)) {
      throw createAppError('QUEUE_LOCK_BUSY', 'Unable to acquire script lock.');
    }
    return lock;
  }

  // Use this only around short local operations such as PropertiesService
  // and Spreadsheet metadata writes. Do not call UrlFetchApp, MailApp, or
  // other external APIs inside the callback.
  function withScriptLock(operationName, callback, timeoutMs) {
    var lock = tryScriptLock(timeoutMs);
    try {
      return callback();
    } finally {
      try {
        lock.releaseLock();
      } catch (ignore) {}
    }
  }

  return {
    tryScriptLock: tryScriptLock,
    withScriptLock: withScriptLock
  };
})();

var SheetRepository = (function() {
  function getSpreadsheet() {
    var spreadsheetId = PropertiesService.getScriptProperties().getProperty(APP_CONSTANTS.PROPERTY_KEYS.SPREADSHEET_ID);
    ensure(spreadsheetId, 'CONFIG_MISSING', 'SPREADSHEET_ID is not configured.');
    return SpreadsheetApp.openById(spreadsheetId);
  }

  function getSheet(sheetName) {
    var sheet = getSpreadsheet().getSheetByName(sheetName);
    ensure(sheet, 'CONFIG_MISSING', 'Missing required sheet: ' + sheetName);
    return sheet;
  }

  function getHeaders(sheetName) {
    var sheet = getSheet(sheetName);
    return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  }

  function getRows(sheetName) {
    var sheet = getSheet(sheetName);
    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn === 0) {
      return [];
    }
    var values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
    var headers = getHeaders(sheetName);
    return values.map(function(row) {
      return fromSheetRow(sheetName, headers, row);
    });
  }

  function flush() {
    SpreadsheetApp.flush();
  }

  function findRowIndexByColumnValue(sheetName, columnName, value) {
    var headers = getHeaders(sheetName);
    var index = headers.indexOf(columnName);
    ensure(index !== -1, 'STORAGE_DATA_CORRUPTED', 'Missing sheet column: ' + columnName, {
      sheetName: sheetName
    });
    var rows = getRows(sheetName);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i][columnName] === value) {
        return i + 2;
      }
    }
    return -1;
  }

  function appendRow(sheetName, objectRow) {
    var sheet = getSheet(sheetName);
    var headers = getHeaders(sheetName);
    var values = toSheetRow(sheetName, headers, objectRow);
    var targetRow = sheet.getLastRow() + 1;
    sheet.getRange(targetRow, 1, 1, values.length).setValues([values]);
    return objectRow;
  }

  function updateRowByKey(sheetName, keyColumn, keyValue, patch) {
    var rowIndex = findRowIndexByColumnValue(sheetName, keyColumn, keyValue);
    ensure(rowIndex !== -1, 'CONFIG_MISSING', 'Target row was not found.', {
      sheetName: sheetName,
      keyColumn: keyColumn,
      keyValue: keyValue
    });
    var headers = getHeaders(sheetName);
    var sheet = getSheet(sheetName);
    var current = fromSheetRow(
      sheetName,
      headers,
      sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0]
    );
    var next = mergeObjects(current, patch);
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([toSheetRow(sheetName, headers, next)]);
    return next;
  }

  function fromSheetRow(sheetName, headers, rawRow) {
    var schema = getSheetSchema(sheetName);
    var objectRow = {};
    for (var i = 0; i < headers.length; i += 1) {
      var columnName = headers[i];
      var spec = schema[i];
      if (!spec) {
        continue;
      }
      objectRow[columnName] = parseCellValue(spec.type, rawRow[i]);
    }
    return objectRow;
  }

  function toSheetRow(sheetName, headers, objectRow) {
    var schema = getSheetSchema(sheetName);
    return headers.map(function(header, index) {
      return formatCellValue(schema[index].type, objectRow[header]);
    });
  }

  function parseCellValue(type, value) {
    if (value === '' || value == null) {
      return null;
    }
    if (type === 'json') {
      return JsonUtil.parse(String(value));
    }
    if (type === 'int' || type === 'float') {
      return Number(value);
    }
    if (type === 'bool') {
      return value === true || value === 'true';
    }
    if (type === 'datetime') {
      return value instanceof Date ? toIsoStringInTokyo(value) : String(value);
    }
    if (type === 'date') {
      return value instanceof Date ? formatDateInTokyo(value) : String(value);
    }
    return String(value);
  }

  function formatCellValue(type, value) {
    if (value == null || value === '') {
      return '';
    }
    if (type === 'json') {
      return JsonUtil.stringify(value);
    }
    if (type === 'datetime') {
      return value instanceof Date ? value : parseIsoToDate(value);
    }
    if (type === 'date') {
      return value instanceof Date ? value : parseDateStringToDate(value);
    }
    return value;
  }

  function mergeObjects(baseObject, patch) {
    var result = {};
    Object.keys(baseObject).forEach(function(key) {
      result[key] = baseObject[key];
    });
    Object.keys(patch).forEach(function(key) {
      result[key] = patch[key];
    });
    return result;
  }

  function findExistingConversationMessage(requestId, role) {
    var pair = getConversationByRequestId(requestId);
    if (role === 'user') {
      return pair.userMessage;
    }
    if (role === 'assistant') {
      return pair.assistantMessage;
    }
    return null;
  }

  function normalizeEventPatch(patch) {
    var normalized = {};
    Object.keys(patch).forEach(function(key) {
      normalized[key] = patch[key];
    });
    if (Object.prototype.hasOwnProperty.call(normalized, 'attemptCount')) {
      normalized.attempt_count = normalized.attemptCount;
      delete normalized.attemptCount;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'nextAttemptAt')) {
      normalized.next_attempt_at = normalized.nextAttemptAt;
      delete normalized.nextAttemptAt;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'lockedAt')) {
      normalized.locked_at = normalized.lockedAt;
      delete normalized.lockedAt;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'lockedBy')) {
      normalized.locked_by = normalized.lockedBy;
      delete normalized.lockedBy;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'updatedAt')) {
      normalized.updated_at = normalized.updatedAt;
      delete normalized.updatedAt;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'completedAt')) {
      normalized.completed_at = normalized.completedAt;
      delete normalized.completedAt;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'lastError')) {
      normalized.last_error_code = normalized.lastError ? normalized.lastError.code : null;
      normalized.last_error_message = normalized.lastError ? normalized.lastError.message : null;
      delete normalized.lastError;
    }
    return normalized;
  }

  function toMessageDto(row) {
    return {
      messageId: row.message_id,
      requestId: row.request_id,
      createdAt: row.created_at,
      role: row.role,
      messageType: row.message_type,
      text: row.text || '',
      image: row.image_name ? {
        name: row.image_name,
        mimeType: row.image_mime,
        summary: row.image_summary || ''
      } : null,
      status: row.status,
      model: row.model || null,
      inputTokens: row.input_tokens == null
        ? null
        : Number(row.input_tokens),
      outputTokens: row.output_tokens == null
        ? null
        : Number(row.output_tokens),
      error: row.error_code ? {
        code: row.error_code,
        message: row.error_code
      } : null
    };
  }

  function appendConversation(message) {
    Validators.assertUuidV4(message.messageId, 'message.messageId');
    Validators.assertEnum(message.role, APP_CONSTANTS.MESSAGE_ROLES, 'message.role');
    Validators.assertEnum(message.messageType, APP_CONSTANTS.MESSAGE_TYPES, 'message.messageType');
    Validators.assertEnum(message.status, APP_CONSTANTS.MESSAGE_STATUSES, 'message.status');
    if (message.requestId && (message.role === 'user' || message.role === 'assistant')) {
      var existingMessage = findExistingConversationMessage(message.requestId, message.role);
      if (existingMessage) {
        return existingMessage;
      }
    }
    var row = {
      conversation_id: message.conversationId || APP_CONSTANTS.DEFAULT_CONVERSATION_ID,
      message_id: message.messageId,
      request_id: message.requestId || null,
      created_at: message.createdAt || toIsoStringInTokyo(new Date()),
      role: message.role,
      message_type: message.messageType,
      text: message.text || '',
      image_name: message.image ? message.image.name : null,
      image_mime: message.image ? message.image.mimeType : null,
      image_summary: message.image ? message.image.summary : null,
      reply_to_message_id: message.replyToMessageId || null,
      status: message.status,
      model: message.model || null,
      input_tokens: message.inputTokens == null ? null : message.inputTokens,
      output_tokens: message.outputTokens == null ? null : message.outputTokens,
      error_code: message.error ? message.error.code : null
    };
    appendRow(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS, row);
    return toMessageDto(row);
  }

  function updateConversationMessage(messageId, patch) {
    Validators.assertUuidV4(messageId, 'messageId');
    var normalized = {};
    Object.keys(patch || {}).forEach(function(key) {
      normalized[key] = patch[key];
    });
    if (Object.prototype.hasOwnProperty.call(normalized, 'requestId')) {
      normalized.request_id = normalized.requestId;
      delete normalized.requestId;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'createdAt')) {
      normalized.created_at = normalized.createdAt;
      delete normalized.createdAt;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'messageType')) {
      normalized.message_type = normalized.messageType;
      delete normalized.messageType;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'replyToMessageId')) {
      normalized.reply_to_message_id = normalized.replyToMessageId;
      delete normalized.replyToMessageId;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'model')) {
      normalized.model = normalized.model;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'inputTokens')) {
      normalized.input_tokens = normalized.inputTokens;
      delete normalized.inputTokens;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'outputTokens')) {
      normalized.output_tokens = normalized.outputTokens;
      delete normalized.outputTokens;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'error')) {
      normalized.error_code = normalized.error ? normalized.error.code : null;
      delete normalized.error;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'image')) {
      normalized.image_name = normalized.image ? normalized.image.name : null;
      normalized.image_mime = normalized.image ? normalized.image.mimeType : null;
      normalized.image_summary = normalized.image ? normalized.image.summary : null;
      delete normalized.image;
    }
    var row = updateRowByKey(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS, 'message_id', messageId, normalized);
    return toMessageDto(row);
  }

  function listRecentMessages(limit) {
    var rows = getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS);
    return rows
      .sort(function(a, b) {
        return compareIsoDatesDescending(a.created_at, b.created_at);
      })
      .slice(0, limit)
      .map(toMessageDto);
  }

  function listMessagesBefore(messageId, limit) {
    var rows = getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS);
    var pivot = null;
    rows.forEach(function(row) {
      if (row.message_id === messageId) {
        pivot = getIsoTimeMillis(row.created_at);
      }
    });
    return rows
      .filter(function(row) {
        return pivot == null || getIsoTimeMillis(row.created_at) < pivot;
      })
      .sort(function(a, b) {
        return compareIsoDatesDescending(a.created_at, b.created_at);
      })
      .slice(0, limit)
      .map(toMessageDto);
  }

  function listMessagesByIds(messageIds) {
    var wanted = {};
    (messageIds || []).forEach(function(messageId) {
      if (Validators.isUuidV4(messageId)) {
        wanted[messageId] = true;
      }
    });
    return getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
      .filter(function(row) {
        return Boolean(wanted[row.message_id]);
      })
      .sort(function(a, b) {
        return compareIsoDatesAscending(a.created_at, b.created_at);
      })
      .map(toMessageDto);
  }

  function listMessagesByDate(summaryDate) {
    Validators.assertDateString(summaryDate, 'summaryDate');
    return getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
      .filter(function(row) {
        return row.created_at && formatDateInTokyo(parseIsoToDate(row.created_at)) === summaryDate;
      })
      .sort(function(a, b) {
        return compareIsoDatesAscending(a.created_at, b.created_at);
      })
      .map(toMessageDto);
  }

  function getConversationByRequestId(requestId) {
    var rows = getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
      .filter(function(row) {
        return row.request_id === requestId;
      });
    var result = {
      requestId: requestId,
      userMessage: null,
      assistantMessage: null
    };
    rows.forEach(function(row) {
      if (row.role === 'user') {
        result.userMessage = toMessageDto(row);
      } else if (row.role === 'assistant') {
        result.assistantMessage = toMessageDto(row);
      }
    });
    return result;
  }

  function getUserState() {
    var rows = getRows(APP_CONSTANTS.SHEETS.USER_STATE);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].singleton_id === APP_CONSTANTS.USER_STATE_SINGLETON_ID) {
        return rows[i];
      }
    }
    return null;
  }

  function ensureDefaultUserState() {
    var state = getUserState();
    if (state) {
      return state;
    }
    var row = mergeObjects(APP_CONSTANTS.USER_STATE_DEFAULTS, {
      updated_at: toIsoStringInTokyo(new Date())
    });
    appendRow(APP_CONSTANTS.SHEETS.USER_STATE, row);
    return row;
  }

  function updateUserState(patch) {
    patch.updated_at = toIsoStringInTokyo(new Date());
    return updateRowByKey(
      APP_CONSTANTS.SHEETS.USER_STATE,
      'singleton_id',
      APP_CONSTANTS.USER_STATE_SINGLETON_ID,
      patch
    );
  }

  function insertEvent(event) {
    Validators.assertUuidV4(event.eventId, 'event.eventId');
    Validators.assertEnum(event.eventType, APP_CONSTANTS.EVENT_TYPES, 'event.eventType');
    Validators.assertEnum(event.status, APP_CONSTANTS.EVENT_STATUSES, 'event.status');
    var existing = getActiveEventByDedupeKey(event.dedupeKey);
    if (existing) {
      throw createAppError('DUPLICATE_REQUEST', 'Duplicate dedupe_key is not allowed.', {
        dedupeKey: event.dedupeKey
      });
    }
    var row = {
      event_id: event.eventId,
      event_type: event.eventType,
      dedupe_key: event.dedupeKey,
      payload_json: event.payload,
      status: event.status,
      attempt_count: event.attemptCount,
      next_attempt_at: event.nextAttemptAt || null,
      locked_at: event.lockedAt || null,
      locked_by: event.lockedBy || null,
      created_at: event.createdAt,
      updated_at: event.updatedAt,
      completed_at: event.completedAt || null,
      last_error_code: event.lastError ? event.lastError.code : null,
      last_error_message: event.lastError ? event.lastError.message : null
    };
    appendRow(APP_CONSTANTS.SHEETS.EVENT_QUEUE, row);
    return event;
  }

  function appendDebugLog(entry) {
    var row = {
      log_id: generateUuidV4(),
      timestamp: entry.timestamp || toIsoStringInTokyo(new Date()),
      level: entry.level,
      operation: entry.operation,
      correlation_id: entry.correlationId || generateUuidV4(),
      event_id: entry.eventId || null,
      message: entry.message || '',
      details_json: entry.details == null ? null : entry.details
    };
    appendRow(APP_CONSTANTS.SHEETS.DEBUG_LOGS, row);
    return {
      logId: row.log_id,
      timestamp: row.timestamp,
      level: row.level,
      operation: row.operation,
      correlationId: row.correlation_id,
      eventId: row.event_id,
      message: row.message,
      details: row.details_json
    };
  }

  function toEventDto(row) {
    return {
      eventId: row.event_id,
      eventType: row.event_type,
      dedupeKey: row.dedupe_key,
      payload: row.payload_json,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      lockedAt: row.locked_at,
      lockedBy: row.locked_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      lastError: row.last_error_code ? {
        code: row.last_error_code,
        message: row.last_error_message || row.last_error_code
      } : null
    };
  }

  function selectClaimableEvents_(rows, limit, now) {
    var nowTime = now instanceof Date
      ? now.getTime()
      : getIsoTimeMillis(now);

    return (rows || [])
      .filter(function(row) {
        if (row.status === 'PENDING') {
          return !row.next_attempt_at ||
            getIsoTimeMillis(row.next_attempt_at) <= nowTime;
        }
        if (row.status === 'RETRY_WAIT') {
          return row.next_attempt_at &&
            getIsoTimeMillis(row.next_attempt_at) <= nowTime;
        }
        return false;
      })
      .sort(function(a, b) {
        return compareIsoDatesAscending(
          a.created_at,
          b.created_at
        );
      })
      .slice(0, limit)
      .map(toEventDto);
  }

  function listClaimableEvents(limit, now) {
    return selectClaimableEvents_(
      getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE),
      limit,
      now
    );
  }

  function updateEvent(eventId, patch) {
    return updateRowByKey(
      APP_CONSTANTS.SHEETS.EVENT_QUEUE,
      'event_id',
      eventId,
      normalizeEventPatch(patch)
    );
  }

  function getEventByDedupeKey(dedupeKey) {
    var rows = getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE)
      .filter(function(row) {
        return row.dedupe_key === dedupeKey;
      })
      .sort(function(a, b) {
        return compareIsoDatesDescending(a.updated_at, b.updated_at);
      });
    if (rows.length === 0) {
      return null;
    }
    return toEventDto(rows[0]);
  }

  function getActiveEventByDedupeKey(dedupeKey) {
    var rows = getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE)
      .filter(function(row) {
        return row.dedupe_key === dedupeKey &&
          (row.status === 'PENDING' || row.status === 'PROCESSING' || row.status === 'RETRY_WAIT');
      })
      .sort(function(a, b) {
        return compareIsoDatesDescending(a.updated_at, b.updated_at);
      });
    return rows.length > 0 ? toEventDto(rows[0]) : null;
  }

  function getEventById(eventId) {
    Validators.assertUuidV4(eventId, 'eventId');
    var rows = getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE).filter(function(row) {
      return row.event_id === eventId;
    });
    return rows.length > 0 ? toEventDto(rows[0]) : null;
  }

  function listEventsByType(eventType) {
    return getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE)
      .filter(function(row) {
        return row.event_type === eventType;
      })
      .sort(function(a, b) {
        return compareIsoDatesDescending(a.created_at, b.created_at);
      })
      .map(toEventDto);
  }

  function listEvents() {
    return getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE)
      .sort(function(a, b) {
        return compareIsoDatesDescending(a.created_at, b.created_at);
      })
      .map(toEventDto);
  }

  function listStaleProcessingEvents(now, staleMinutes) {
    var referenceTime = now instanceof Date ? now.getTime() : getIsoTimeMillis(now);
    var staleBefore = referenceTime - Math.max(Number(staleMinutes || 0), 0) * 60 * 1000;
    return getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE)
      .filter(function(row) {
        return row.status === 'PROCESSING' &&
          row.locked_at &&
          getIsoTimeMillis(row.locked_at) <= staleBefore;
      })
      .sort(function(a, b) {
        return compareIsoDatesAscending(a.locked_at, b.locked_at);
      })
      .map(toEventDto);
  }

  function getMessageByRequestIdAndRole(requestId, role) {
    var rows = getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS).filter(function(row) {
      return row.request_id === requestId && row.role === role;
    });
    return rows.length > 0 ? toMessageDto(rows[0]) : null;
  }

  function listMessagesAfter(messageId, limit) {
    Validators.assertUuidV4(messageId, 'messageId');
    var rows = getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS);
    var pivotTime = null;
    var pivotIndex = -1;

    rows.forEach(function(row, index) {
      if (row.message_id === messageId) {
        pivotTime = getIsoTimeMillis(row.created_at);
        pivotIndex = index;
      }
    });

    if (pivotTime == null) {
      return [];
    }

    return rows
      .map(function(row, index) {
        return {
          row: row,
          index: index,
          createdAtMillis: row.created_at
            ? getIsoTimeMillis(row.created_at)
            : 0
        };
      })
      .filter(function(entry) {
        return entry.row.created_at && (
          entry.createdAtMillis > pivotTime ||
          (
            entry.createdAtMillis === pivotTime &&
            entry.index > pivotIndex
          )
        );
      })
      .sort(function(left, right) {
        if (left.createdAtMillis !== right.createdAtMillis) {
          return left.createdAtMillis - right.createdAtMillis;
        }
        return left.index - right.index;
      })
      .slice(0, limit || rows.length)
      .map(function(entry) {
        return toMessageDto(entry.row);
      });
  }

  function getUsageDaily(usageDate) {
    Validators.assertDateString(usageDate, 'usageDate');
    var rows = getRows(APP_CONSTANTS.SHEETS.USAGE_DAILY).filter(function(row) {
      return row.usage_date === usageDate;
    });
    return rows.length > 0 ? rows[0] : null;
  }

  function upsertUsageDaily(usage) {
    Validators.assertDateString(usage.usageDate, 'usage.usageDate');
    var row = {
      usage_date: usage.usageDate,
      api_calls: Number(usage.apiCalls || 0),
      image_calls: Number(usage.imageCalls || 0),
      input_tokens: Number(usage.inputTokens || 0),
      output_tokens: Number(usage.outputTokens || 0),
      mail_recipients: Number(usage.mailRecipients || 0),
      errors: Number(usage.errors || 0),
      updated_at: usage.updatedAt || toIsoStringInTokyo(new Date())
    };
    var existingRow = findRowIndexByColumnValue(APP_CONSTANTS.SHEETS.USAGE_DAILY, 'usage_date', usage.usageDate);
    if (existingRow === -1) {
      appendRow(APP_CONSTANTS.SHEETS.USAGE_DAILY, row);
    } else {
      updateRowByKey(APP_CONSTANTS.SHEETS.USAGE_DAILY, 'usage_date', usage.usageDate, row);
    }
    return row;
  }

  function incrementUsageDaily(usageDate, patch) {
    var existing = getUsageDaily(usageDate);
    var next = {
      usageDate: usageDate,
      apiCalls: Number((existing && existing.api_calls) || 0) + Number((patch && patch.apiCalls) || 0),
      imageCalls: Number((existing && existing.image_calls) || 0) + Number((patch && patch.imageCalls) || 0),
      inputTokens: Number((existing && existing.input_tokens) || 0) + Number((patch && patch.inputTokens) || 0),
      outputTokens: Number((existing && existing.output_tokens) || 0) + Number((patch && patch.outputTokens) || 0),
      mailRecipients: Number((existing && existing.mail_recipients) || 0) + Number((patch && patch.mailRecipients) || 0),
      errors: Number((existing && existing.errors) || 0) + Number((patch && patch.errors) || 0),
      updatedAt: toIsoStringInTokyo(new Date())
    };
    return upsertUsageDaily(next);
  }

  function deleteDebugLogsOlderThan(cutoffIso) {
    var sheet = getSheet(APP_CONSTANTS.SHEETS.DEBUG_LOGS);
    var rows = getRows(APP_CONSTANTS.SHEETS.DEBUG_LOGS);
    var cutoffTime = getIsoTimeMillis(cutoffIso);
    var rowsToDelete = [];
    rows.forEach(function(row, index) {
      if (row.timestamp && getIsoTimeMillis(row.timestamp) < cutoffTime) {
        rowsToDelete.push(index + 2);
      }
    });
    rowsToDelete.sort(function(a, b) {
      return b - a;
    }).forEach(function(rowIndex) {
      sheet.deleteRow(rowIndex);
    });
    return {
      deletedCount: rowsToDelete.length,
      keptCount: rows.length - rowsToDelete.length
    };
  }

  function listActiveMemories() {
    return getRows(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES).filter(function(row) {
      return row.status === 'active';
    });
  }

  function getMemoryById(memoryId) {
    Validators.assertUuidV4(memoryId, 'memoryId');
    var rows = getRows(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES).filter(function(row) {
      return row.memory_id === memoryId;
    });
    return rows.length > 0 ? rows[0] : null;
  }

  function findActiveMemoryByNormalizedKey(normalizedKey) {
    var key = String(normalizedKey || '').trim();
    if (!key) {
      return null;
    }
    var rows = getRows(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES).filter(function(row) {
      return row.status === 'active' && row.normalized_key === key;
    });
    return rows.length > 0 ? rows[0] : null;
  }

  function upsertMemory(memory) {
    Validators.assertUuidV4(memory.memoryId, 'memory.memoryId');
    var existingRow = findRowIndexByColumnValue(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES, 'memory_id', memory.memoryId);
    var row = {
      memory_id: memory.memoryId,
      category: memory.category,
      normalized_key: memory.normalizedKey,
      content: memory.content,
      confidence: memory.confidence,
      status: memory.status,
      source_message_ids_json: memory.sourceMessageIds,
      created_at: memory.createdAt,
      last_confirmed_at: memory.lastConfirmedAt,
      supersedes_memory_id: memory.supersedesMemoryId || null,
      usage_count: memory.usageCount,
      last_used_at: memory.lastUsedAt || null
    };
    if (existingRow === -1) {
      appendRow(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES, row);
    } else {
      updateRowByKey(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES, 'memory_id', memory.memoryId, row);
    }
    return memory;
  }

  function listRecentDiarySummariesBefore(summaryDate, limit) {
    Validators.assertDateString(summaryDate, 'summaryDate');
    return selectRecentDiarySummariesBefore_(
      getRows(APP_CONSTANTS.SHEETS.DAILY_SUMMARIES),
      summaryDate,
      limit
    );
  }

  function selectRecentDiarySummariesBefore_(rows, summaryDate, limit) {
    var normalizedLimit = Number(limit || 0);
    if (!isFinite(normalizedLimit) || normalizedLimit <= 0) {
      return [];
    }
    normalizedLimit = Math.floor(normalizedLimit);

    return (rows || [])
      .filter(function(row) {
        return row.summary_date < summaryDate &&
          row.diary_status === 'DONE' &&
          String(row.summary_text || '').trim() !== '';
      })
      .sort(function(a, b) {
        if (a.summary_date === b.summary_date) {
          return 0;
        }
        return a.summary_date < b.summary_date ? 1 : -1;
      })
      .slice(0, normalizedLimit);
  }

  function getDailySummary(summaryDate) {
    Validators.assertDateString(summaryDate, 'summaryDate');
    var rows = getRows(APP_CONSTANTS.SHEETS.DAILY_SUMMARIES).filter(function(row) {
      return row.summary_date === summaryDate;
    });
    return rows.length > 0 ? rows[0] : null;
  }

  function upsertDailySummary(summary) {
    Validators.assertDateString(summary.summaryDate, 'summary.summaryDate');
    var row = {
      summary_date: summary.summaryDate,
      conversation_count: Number(summary.conversationCount || 0),
      summary_text: summary.summaryText || null,
      key_topics_json: summary.keyTopics || null,
      memory_candidate_count: Number(summary.memoryCandidateCount || 0),
      diary_status: summary.diaryStatus || 'NONE',
      diary_doc_anchor: summary.diaryDocAnchor || null,
      created_at: summary.createdAt,
      updated_at: summary.updatedAt
    };
    var existingRow = findRowIndexByColumnValue(APP_CONSTANTS.SHEETS.DAILY_SUMMARIES, 'summary_date', summary.summaryDate);
    if (existingRow === -1) {
      appendRow(APP_CONSTANTS.SHEETS.DAILY_SUMMARIES, row);
    } else {
      updateRowByKey(APP_CONSTANTS.SHEETS.DAILY_SUMMARIES, 'summary_date', summary.summaryDate, row);
    }
    return row;
  }

  return {
    getSpreadsheet: getSpreadsheet,
    getSheet: getSheet,
    getHeaders: getHeaders,
    getRows: getRows,
    flush: flush,
    appendConversation: appendConversation,
    updateConversationMessage: updateConversationMessage,
    listRecentMessages: listRecentMessages,
    listMessagesBefore: listMessagesBefore,
    listMessagesByIds: listMessagesByIds,
    listMessagesByDate: listMessagesByDate,
    listMessagesAfter: listMessagesAfter,
    getConversationByRequestId: getConversationByRequestId,
    getMessageByRequestIdAndRole: getMessageByRequestIdAndRole,
    getUserState: getUserState,
    ensureDefaultUserState: ensureDefaultUserState,
    updateUserState: updateUserState,
    insertEvent: insertEvent,
    listClaimableEvents: listClaimableEvents,
    updateEvent: updateEvent,
    getEventById: getEventById,
    getEventByDedupeKey: getEventByDedupeKey,
    getActiveEventByDedupeKey: getActiveEventByDedupeKey,
    listEvents: listEvents,
    listEventsByType: listEventsByType,
    listStaleProcessingEvents: listStaleProcessingEvents,
    appendDebugLog: appendDebugLog,
    listActiveMemories: listActiveMemories,
    getMemoryById: getMemoryById,
    findActiveMemoryByNormalizedKey: findActiveMemoryByNormalizedKey,
    upsertMemory: upsertMemory,
    listRecentDiarySummariesBefore: listRecentDiarySummariesBefore,
    getDailySummary: getDailySummary,
    upsertDailySummary: upsertDailySummary,
    getUsageDaily: getUsageDaily,
    upsertUsageDaily: upsertUsageDaily,
    incrementUsageDaily: incrementUsageDaily,
    deleteDebugLogsOlderThan: deleteDebugLogsOlderThan,
    __test: {
      selectClaimableEvents: selectClaimableEvents_,
      selectRecentDiarySummariesBefore: selectRecentDiarySummariesBefore_
    }
  };
})();

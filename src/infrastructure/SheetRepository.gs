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
    var rawRow = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
    var current = fromSheetRow(
      sheetName,
      headers,
      rawRow
    );
    var next = mergeObjects(current, patch);
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([
      toSheetRow(sheetName, headers, next, rawRow)
    ]);
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

  function toSheetRow(sheetName, headers, objectRow, existingRawRow) {
    var schema = getSheetSchema(sheetName);
    return headers.map(function(header, index) {
      if (!schema[index]) {
        return existingRawRow && index < existingRawRow.length
          ? existingRawRow[index]
          : '';
      }
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
    if (
      type === 'string' &&
      typeof value === 'string' &&
      value.charAt(0) === '='
    ) {
      return "'" + value;
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

  function assertCharacterApprovalHeaders_(headers) {
    var expected = APP_CONSTANTS.CHARACTER.APPROVAL_COLUMNS;
    var conversationHeaders = APP_CONSTANTS.SHEET_SCHEMAS[
      APP_CONSTANTS.SHEETS.CONVERSATION_LOGS
    ]
      .map(function(column) {
        return column.name;
      });
    var offset = conversationHeaders.indexOf(expected[0]);
    if (
      offset < 0 ||
      !Array.isArray(headers) ||
      headers.length < offset + expected.length
    ) {
      throw characterApprovalError_(
        'STORAGE_DATA_CORRUPTED',
        'CHARACTER_APPROVAL_COLUMNS_MISSING'
      );
    }
    for (var i = 0; i < expected.length; i += 1) {
      if (headers[offset + i] !== expected[i]) {
        throw characterApprovalError_(
          'STORAGE_DATA_CORRUPTED',
          'CHARACTER_APPROVAL_COLUMNS_INVALID'
        );
      }
    }
    return true;
  }

  function assertCharacterApprovalColumns() {
    return assertCharacterApprovalHeaders_(
      getHeaders(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
    );
  }

  function assertProactiveDeliveryHeaders_(headers) {
    assertCharacterApprovalHeaders_(headers);
    var expectedHeaders = APP_CONSTANTS.SHEET_SCHEMAS[
      APP_CONSTANTS.SHEETS.CONVERSATION_LOGS
    ].map(function(column) {
      return column.name;
    });
    var subjectIndex = expectedHeaders.indexOf('proactive_subject');
    var originEventIndex = expectedHeaders.indexOf(
      'proactive_origin_event_id'
    );
    if (
      subjectIndex < 0 ||
      originEventIndex !== subjectIndex + 1 ||
      !Array.isArray(headers) ||
      headers.length <= originEventIndex ||
      headers[subjectIndex] !== 'proactive_subject' ||
      headers[originEventIndex] !== 'proactive_origin_event_id'
    ) {
      throw characterApprovalError_(
        'STORAGE_DATA_CORRUPTED',
        'PROACTIVE_DELIVERY_COLUMNS_INVALID'
      );
    }
    return true;
  }

  function assertProactiveDeliveryColumns() {
    return assertProactiveDeliveryHeaders_(
      getHeaders(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
    );
  }

  function assertDiaryProvenanceHeaders_(headers) {
    var expectedHeaders = APP_CONSTANTS.SHEET_SCHEMAS[
      APP_CONSTANTS.SHEETS.DAILY_SUMMARIES
    ].map(function(column) {
      return column.name;
    });
    var payloadIndex = expectedHeaders.indexOf('diary_payload_json');
    var approvalIndex = expectedHeaders.indexOf('diary_approval_json');
    var originIndex = expectedHeaders.indexOf('diary_origin_event_id');
    if (
      payloadIndex < 0 ||
      approvalIndex !== payloadIndex + 1 ||
      originIndex !== approvalIndex + 1 ||
      !Array.isArray(headers) ||
      headers.length <= originIndex ||
      headers[payloadIndex] !== 'diary_payload_json' ||
      headers[approvalIndex] !== 'diary_approval_json' ||
      headers[originIndex] !== 'diary_origin_event_id'
    ) {
      throw createAppError(
        'STORAGE_DATA_CORRUPTED',
        'Diary provenance columns are invalid.',
        { reason: 'DIARY_PROVENANCE_COLUMNS_INVALID' }
      );
    }
    return true;
  }

  function assertDiaryProvenanceColumns() {
    return assertDiaryProvenanceHeaders_(
      getHeaders(APP_CONSTANTS.SHEETS.DAILY_SUMMARIES)
    );
  }

  function assertMemoryProvenanceHeaders_(headers) {
    var expectedHeaders = APP_CONSTANTS.SHEET_SCHEMAS[
      APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES
    ].map(function(column) {
      return column.name;
    });
    var approvalIndex = expectedHeaders.indexOf(
      'memory_approval_json'
    );
    var originIndex = expectedHeaders.indexOf(
      'memory_origin_event_ids_json'
    );
    if (
      approvalIndex < 0 ||
      originIndex !== approvalIndex + 1 ||
      !Array.isArray(headers) ||
      headers.length <= originIndex ||
      headers[approvalIndex] !== 'memory_approval_json' ||
      headers[originIndex] !== 'memory_origin_event_ids_json'
    ) {
      throw createAppError(
        'STORAGE_DATA_CORRUPTED',
        'Memory provenance columns are invalid.',
        { reason: 'MEMORY_PROVENANCE_COLUMNS_INVALID' }
      );
    }
    return true;
  }

  function assertMemoryProvenanceColumns() {
    return assertMemoryProvenanceHeaders_(
      getHeaders(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES)
    );
  }

  function normalizeCharacterApproval_(value, errorCode) {
    if (value == null) {
      return null;
    }
    var fields = APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS;
    if (!isPlainObject_(value)) {
      throw characterApprovalError_(errorCode, 'CHARACTER_APPROVAL_INVALID');
    }
    var keys = Object.keys(value);
    if (
      keys.length !== fields.length ||
      !fields.every(function(field) {
        return Object.prototype.hasOwnProperty.call(value, field);
      })
    ) {
      throw characterApprovalError_(errorCode, 'CHARACTER_APPROVAL_FIELDS_INVALID');
    }
    if (
      APP_CONSTANTS.CHARACTER.OUTPUT_SURFACES.indexOf(value.surface) === -1 ||
      APP_CONSTANTS.CHARACTER.ARTIFACT_SOURCES.indexOf(value.source) === -1
    ) {
      throw characterApprovalError_(errorCode, 'CHARACTER_APPROVAL_ENUM_INVALID');
    }
    if (
      value.policyVersion !== APP_CONSTANTS.CHARACTER.POLICY_VERSION ||
      value.profileSchemaVersion !== APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION ||
      value.catalogVersion !== APP_CONSTANTS.CHARACTER.CATALOG_VERSION ||
      typeof value.profileRevision !== 'number' ||
      !Number.isSafeInteger(value.profileRevision) ||
      value.profileRevision <= 0 ||
      typeof value.characterPackId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(value.characterPackId) ||
      typeof value.characterPackVersion !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{2,79}$/.test(value.characterPackVersion)
    ) {
      throw characterApprovalError_(errorCode, 'CHARACTER_APPROVAL_TYPE_INVALID');
    }
    if (
      (
        value.surface === 'PROACTIVE_AI' &&
        value.source !== 'generated' &&
        value.source !== 'rewrite'
      ) ||
      (
        value.surface === 'PROACTIVE_RETRY' &&
        value.source !== 'legacy_revalidated'
      ) ||
      (
        value.source === 'legacy_revalidated' &&
        value.surface !== 'PROACTIVE_RETRY'
      )
    ) {
      throw characterApprovalError_(
        errorCode,
        'CHARACTER_APPROVAL_SURFACE_SOURCE_INVALID'
      );
    }
    return {
      surface: value.surface,
      source: value.source,
      policyVersion: value.policyVersion,
      profileSchemaVersion: value.profileSchemaVersion,
      profileRevision: value.profileRevision,
      catalogVersion: value.catalogVersion,
      characterPackId: value.characterPackId,
      characterPackVersion: value.characterPackVersion
    };
  }

  function characterApprovalsEqual_(left, right) {
    if (left == null || right == null) {
      return left == null && right == null;
    }
    return APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS.every(function(field) {
      return left[field] === right[field];
    });
  }

  function characterApprovalToRow_(value, errorCode) {
    var approval = normalizeCharacterApproval_(value, errorCode);
    return {
      approval_surface: approval ? approval.surface : null,
      approval_source: approval ? approval.source : null,
      approval_policy_version: approval ? approval.policyVersion : null,
      approval_profile_schema_version: approval ? approval.profileSchemaVersion : null,
      approval_profile_revision: approval ? approval.profileRevision : null,
      approval_catalog_version: approval ? approval.catalogVersion : null,
      approval_character_pack_id: approval ? approval.characterPackId : null,
      approval_character_pack_version: approval ? approval.characterPackVersion : null
    };
  }

  function characterApprovalFromRow_(row) {
    var columns = APP_CONSTANTS.CHARACTER.APPROVAL_COLUMNS;
    var populatedCount = columns.filter(function(column) {
      return row[column] != null && row[column] !== '';
    }).length;
    if (populatedCount === 0) {
      return null;
    }
    if (populatedCount !== columns.length) {
      throw characterApprovalError_(
        'STORAGE_DATA_CORRUPTED',
        'CHARACTER_APPROVAL_PARTIAL'
      );
    }
    return normalizeCharacterApproval_({
      surface: row.approval_surface,
      source: row.approval_source,
      policyVersion: row.approval_policy_version,
      profileSchemaVersion: row.approval_profile_schema_version,
      profileRevision: row.approval_profile_revision,
      catalogVersion: row.approval_catalog_version,
      characterPackId: row.approval_character_pack_id,
      characterPackVersion: row.approval_character_pack_version
    }, 'STORAGE_DATA_CORRUPTED');
  }

  function isPlainObject_(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function characterApprovalError_(code, reason) {
    return createAppError(
      code,
      code === 'STORAGE_DATA_CORRUPTED'
        ? 'Stored character approval metadata is invalid.'
        : 'Character approval metadata is invalid.',
      { reason: reason }
    );
  }

  function normalizeProactiveOriginEventId_(value, errorCode) {
    if (value == null || String(value).trim() === '') {
      return null;
    }
    var normalized = String(value);
    if (!Validators.isUuidV4(normalized)) {
      throw createAppError(
        errorCode,
        errorCode === 'STORAGE_DATA_CORRUPTED'
          ? 'Stored proactive origin event is invalid.'
          : 'Proactive origin event must be a UUID v4.',
        { reason: 'PROACTIVE_ORIGIN_EVENT_ID_INVALID' }
      );
    }
    return normalized;
  }

  function buildMessageDto_(row, characterApproval) {
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
      replyToMessageId: row.reply_to_message_id || null,
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
      } : null,
      characterApproval: characterApproval
    };
  }

  function toMessageDto(row) {
    return buildMessageDto_(row, characterApprovalFromRow_(row));
  }

  function toProactiveMarkerDto_(row) {
    var characterApproval = null;
    var invalidCharacterApproval = false;
    try {
      characterApproval = characterApprovalFromRow_(row);
    } catch (error) {
      if (!error || error.code !== 'STORAGE_DATA_CORRUPTED') {
        throw error;
      }
      invalidCharacterApproval = true;
    }
    var message = buildMessageDto_(row, characterApproval);
    if (invalidCharacterApproval) {
      message.text = '';
      message.proactiveSubject = null;
    } else {
      message.proactiveSubject = row.proactive_subject == null ||
        row.proactive_subject === ''
        ? null
        : String(row.proactive_subject);
    }
    message.proactiveOriginEventId = normalizeProactiveOriginEventId_(
      row.proactive_origin_event_id,
      'STORAGE_DATA_CORRUPTED'
    );
    message.invalidCharacterApproval = invalidCharacterApproval;
    return message;
  }

  function appendConversation(message) {
    Validators.assertUuidV4(message.messageId, 'message.messageId');
    Validators.assertEnum(message.role, APP_CONSTANTS.MESSAGE_ROLES, 'message.role');
    Validators.assertEnum(message.messageType, APP_CONSTANTS.MESSAGE_TYPES, 'message.messageType');
    Validators.assertEnum(message.status, APP_CONSTANTS.MESSAGE_STATUSES, 'message.status');
    var proactiveOriginEventId = normalizeProactiveOriginEventId_(
      message.proactiveOriginEventId,
      'VALIDATION_REQUEST_INVALID'
    );
    ensure(
      proactiveOriginEventId == null ||
        (
          message.role === 'system' &&
          message.messageType === 'proactive'
        ),
      'VALIDATION_REQUEST_INVALID',
      'A proactive origin event may only be stored on a proactive marker.'
    );
    var approvalRow = characterApprovalToRow_(
      message.characterApproval,
      'VALIDATION_REQUEST_INVALID'
    );
    if (
      message.role === 'system' &&
      message.messageType === 'proactive' &&
      (
        message.characterApproval != null ||
        proactiveOriginEventId != null
      )
    ) {
      assertProactiveDeliveryColumns();
    } else if (message.characterApproval != null) {
      assertCharacterApprovalColumns();
    }
    if (message.requestId && (message.role === 'user' || message.role === 'assistant')) {
      var existingMessage = findExistingConversationMessage(message.requestId, message.role);
      if (existingMessage) {
        if (
          message.characterApproval != null &&
          !characterApprovalsEqual_(
            existingMessage.characterApproval,
            message.characterApproval
          )
        ) {
          throw characterApprovalError_(
            'STORAGE_DATA_CORRUPTED',
            'CHARACTER_APPROVAL_DEDUPE_MISMATCH'
          );
        }
        return existingMessage;
      }
    }
    var row = mergeObjects({
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
      error_code: message.error ? message.error.code : null,
      proactive_subject: message.proactiveSubject == null
        ? null
        : String(message.proactiveSubject),
      proactive_origin_event_id: proactiveOriginEventId
    }, approvalRow);
    appendRow(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS, row);
    return toMessageDto(row);
  }

  function updateConversationMessage(messageId, patch) {
    Validators.assertUuidV4(messageId, 'messageId');
    var normalized = {};
    Object.keys(patch || {}).forEach(function(key) {
      normalized[key] = patch[key];
    });
    var touchesApprovedContent =
      Object.prototype.hasOwnProperty.call(normalized, 'text') ||
      Object.prototype.hasOwnProperty.call(normalized, 'image') ||
      Object.prototype.hasOwnProperty.call(normalized, 'proactiveSubject') ||
      Object.prototype.hasOwnProperty.call(
        normalized,
        'proactiveOriginEventId'
      ) ||
      Object.prototype.hasOwnProperty.call(normalized, 'characterApproval');
    if (
      Object.prototype.hasOwnProperty.call(
        normalized,
        'proactiveOriginEventId'
      )
    ) {
      normalized.proactiveOriginEventId =
        normalizeProactiveOriginEventId_(
          normalized.proactiveOriginEventId,
          'VALIDATION_REQUEST_INVALID'
        );
    }
    if (touchesApprovedContent) {
      validateCharacterApprovalMutation_(
        messageId,
        normalized,
        Object.prototype.hasOwnProperty.call(normalized, 'characterApproval')
          ? normalizeCharacterApproval_(
            normalized.characterApproval,
            'VALIDATION_REQUEST_INVALID'
          )
          : null
      );
    }
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
    if (Object.prototype.hasOwnProperty.call(normalized, 'proactiveSubject')) {
      normalized.proactive_subject = normalized.proactiveSubject == null
        ? null
        : String(normalized.proactiveSubject);
      delete normalized.proactiveSubject;
    }
    if (
      Object.prototype.hasOwnProperty.call(
        normalized,
        'proactiveOriginEventId'
      )
    ) {
      normalized.proactive_origin_event_id =
        normalized.proactiveOriginEventId;
      delete normalized.proactiveOriginEventId;
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
    if (Object.prototype.hasOwnProperty.call(normalized, 'characterApproval')) {
      var approvalRow = characterApprovalToRow_(
        normalized.characterApproval,
        'VALIDATION_REQUEST_INVALID'
      );
      if (normalized.characterApproval != null) {
        if (
          normalized.characterApproval.surface === 'PROACTIVE_AI' ||
          normalized.characterApproval.surface === 'PROACTIVE_RETRY'
        ) {
          assertProactiveDeliveryColumns();
        } else {
          assertCharacterApprovalColumns();
        }
      }
      normalized = mergeObjects(normalized, approvalRow);
      delete normalized.characterApproval;
    }
    var row = updateRowByKey(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS, 'message_id', messageId, normalized);
    return toMessageDto(row);
  }

  function validateCharacterApprovalMutation_(messageId, patch, desiredApproval) {
    var rows = getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS);
    var currentRow = null;
    rows.forEach(function(row) {
      if (row.message_id === messageId) {
        currentRow = row;
      }
    });
    ensure(
      currentRow,
      'CONFIG_MISSING',
      'Target conversation message was not found.'
    );
    if (
      Object.prototype.hasOwnProperty.call(
        patch,
        'proactiveOriginEventId'
      )
    ) {
      var storedOriginEventId = normalizeProactiveOriginEventId_(
        currentRow.proactive_origin_event_id,
        'STORAGE_DATA_CORRUPTED'
      );
      ensure(
        currentRow.role === 'system' &&
          currentRow.message_type === 'proactive',
        'STORAGE_DATA_CORRUPTED',
        'A proactive origin event may only be stored on a proactive marker.'
      );
      ensure(
        patch.proactiveOriginEventId != null &&
          (
            storedOriginEventId == null ||
            storedOriginEventId === patch.proactiveOriginEventId
          ),
        'STORAGE_DATA_CORRUPTED',
        'A proactive origin event binding cannot be cleared or replaced.'
      );
    }
    var currentApproval = characterApprovalFromRow_(currentRow);
    if (
      currentApproval != null &&
      currentRow.role === 'system' &&
      currentRow.message_type === 'proactive' &&
      currentRow.status === 'failed' &&
      (
        currentApproval.surface === 'PROACTIVE_AI' ||
        currentApproval.surface === 'PROACTIVE_RETRY'
      ) &&
      desiredApproval != null &&
      desiredApproval.surface === 'PROACTIVE_RETRY' &&
      desiredApproval.source === 'legacy_revalidated'
    ) {
      var allowedRetryPatchKeys = [
        'createdAt',
        'status',
        'error',
        'characterApproval',
        'proactiveOriginEventId'
      ];
      var retryPatchKeys = Object.keys(patch);
      var storedOriginEventId = normalizeProactiveOriginEventId_(
        currentRow.proactive_origin_event_id,
        'STORAGE_DATA_CORRUPTED'
      );
      var retryOriginEventId = normalizeProactiveOriginEventId_(
        patch.proactiveOriginEventId,
        'STORAGE_DATA_CORRUPTED'
      );
      ensure(
        retryPatchKeys.every(function(key) {
          return allowedRetryPatchKeys.indexOf(key) !== -1;
        }) &&
          Object.prototype.hasOwnProperty.call(patch, 'status') &&
          patch.status === 'accepted' &&
          Object.prototype.hasOwnProperty.call(patch, 'error') &&
          patch.error === null &&
          Object.prototype.hasOwnProperty.call(
            patch,
            'characterApproval'
          ) &&
          Object.prototype.hasOwnProperty.call(
            patch,
            'proactiveOriginEventId'
          ) &&
          retryOriginEventId != null &&
          (
            storedOriginEventId == null ||
            storedOriginEventId === retryOriginEventId
          ),
        'STORAGE_DATA_CORRUPTED',
        'A failed proactive marker retry patch is invalid.'
      );
      return true;
    }
    var assistantExists = rows.some(function(row) {
      return (
        row.request_id === currentRow.request_id &&
        row.role === 'assistant'
      );
    });
    if (currentApproval == null) {
      if (desiredApproval == null) {
        return true;
      }
      ensure(
        !assistantExists &&
          currentRow.role === 'user' &&
          currentRow.message_type === 'image' &&
          desiredApproval.surface === 'CHAT_IMAGE' &&
          Object.prototype.hasOwnProperty.call(patch, 'image') &&
          patch.image &&
          patch.image.name === currentRow.image_name &&
          patch.image.mimeType === currentRow.image_mime &&
          (
            !Object.prototype.hasOwnProperty.call(patch, 'text') ||
            String(patch.text || '') === String(currentRow.text || '')
          ),
        'STORAGE_DATA_CORRUPTED',
        'Only an orphaned user image may receive new approval metadata.'
      );
      return true;
    }
    ensure(
      desiredApproval != null,
      'STORAGE_DATA_CORRUPTED',
      'Approved character content cannot be changed without approval metadata.'
    );

    if (assistantExists) {
      ensure(
        characterApprovalsEqual_(currentApproval, desiredApproval) &&
          approvedContentUnchanged_(currentRow, patch),
        'STORAGE_DATA_CORRUPTED',
        'Completed approved character content is immutable.'
      );
      return true;
    }

    ensure(
      currentRow.role === 'user' &&
        currentRow.message_type === 'image' &&
        currentApproval.surface === 'CHAT_IMAGE' &&
        desiredApproval.surface === 'CHAT_IMAGE' &&
        characterApprovalBindingsEqual_(currentApproval, desiredApproval),
      'STORAGE_DATA_CORRUPTED',
      'Only a matching orphaned image approval may be replaced.'
    );
    return true;
  }

  function approvedContentUnchanged_(currentRow, patch) {
    if (
      Object.prototype.hasOwnProperty.call(patch, 'text') &&
      String(patch.text || '') !== String(currentRow.text || '')
    ) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'image')) {
      var image = patch.image;
      if (
        !image ||
        image.name !== currentRow.image_name ||
        image.mimeType !== currentRow.image_mime ||
        String(image.summary || '') !== String(currentRow.image_summary || '')
      ) {
        return false;
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, 'proactiveSubject') &&
      String(patch.proactiveSubject || '') !==
        String(currentRow.proactive_subject || '')
    ) {
      return false;
    }
    return true;
  }

  function characterApprovalBindingsEqual_(left, right) {
    return [
      'surface',
      'policyVersion',
      'profileSchemaVersion',
      'profileRevision',
      'catalogVersion',
      'characterPackId',
      'characterPackVersion'
    ].every(function(field) {
      return left[field] === right[field];
    });
  }

  function isConversationRowVisible_(row) {
    return !(
      row &&
      row.role === 'system' &&
      row.message_type === 'proactive'
    ) || row.status === 'completed';
  }

  function listRecentMessages(limit) {
    var rows = getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS);
    return rows
      .filter(isConversationRowVisible_)
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
        return isConversationRowVisible_(row) && (
          pivot == null ||
          getIsoTimeMillis(row.created_at) < pivot
        );
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
        return Boolean(wanted[row.message_id]) &&
          isConversationRowVisible_(row);
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
        return isConversationRowVisible_(row) &&
          row.created_at &&
          formatDateInTokyo(parseIsoToDate(row.created_at)) === summaryDate;
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
    if (rows.length === 0) {
      return null;
    }
    ensure(
      rows.length === 1 &&
        rows[0].singleton_id === APP_CONSTANTS.USER_STATE_SINGLETON_ID,
      'STORAGE_DATA_CORRUPTED',
      'user_state must contain exactly one default singleton row.'
    );
    return rows[0];
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

  function listClaimableEventsByType(eventType, limit, now) {
    Validators.assertEnum(
      eventType,
      APP_CONSTANTS.EVENT_TYPES,
      'eventType'
    );
    return selectClaimableEvents_(
      getRows(APP_CONSTANTS.SHEETS.EVENT_QUEUE)
        .filter(function(row) {
          return row.event_type === eventType;
        }),
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

  function getProactiveMarkerByDedupeKey(dedupeKey, originEventId) {
    var normalizedOriginEventId = normalizeProactiveOriginEventId_(
      originEventId,
      'VALIDATION_REQUEST_INVALID'
    );
    var row = selectProactiveMarkerRow_(
      getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS),
      dedupeKey,
      normalizedOriginEventId
    );
    return row ? toProactiveMarkerDto_(row) : null;
  }

  function selectProactiveMarkerRow_(rows, dedupeKey, originEventId) {
    var normalizedOriginEventId = normalizeProactiveOriginEventId_(
      originEventId,
      'VALIDATION_REQUEST_INVALID'
    );
    var candidates = (rows || []).filter(function(row) {
      return (
        row.request_id === dedupeKey &&
        row.role === 'system' &&
        row.message_type === 'proactive'
      );
    });
    var completed = candidates.filter(function(row) {
      return row.status === 'completed';
    });
    if (completed.length > 0) {
      return completed[completed.length - 1];
    }
    var active = candidates.filter(function(row) {
      return row.error_code !== 'PROACTIVE_RETRY_QUARANTINED';
    });
    if (active.length > 0) {
      return active[active.length - 1];
    }
    if (normalizedOriginEventId == null) {
      return null;
    }
    var matchingQuarantine = candidates.filter(function(row) {
      return (
        row.error_code === 'PROACTIVE_RETRY_QUARANTINED' &&
        row.proactive_origin_event_id === normalizedOriginEventId
      );
    });
    return matchingQuarantine.length > 0
      ? matchingQuarantine[matchingQuarantine.length - 1]
      : null;
  }

  function quarantineProactiveMarker(messageId, originEventId) {
    Validators.assertUuidV4(messageId, 'messageId');
    var normalizedOriginEventId = normalizeProactiveOriginEventId_(
      originEventId,
      'VALIDATION_REQUEST_INVALID'
    );
    ensure(
      normalizedOriginEventId != null,
      'VALIDATION_REQUEST_INVALID',
      'A proactive quarantine requires an origin event.'
    );
    var rows = getRows(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS);
    var currentRow = null;
    rows.forEach(function(row) {
      if (row.message_id === messageId) {
        currentRow = row;
      }
    });
    ensure(
      currentRow &&
        currentRow.role === 'system' &&
        currentRow.message_type === 'proactive' &&
        currentRow.status === 'failed',
      'STORAGE_DATA_CORRUPTED',
      'Only a failed proactive marker may be quarantined.'
    );
    var storedOriginEventId = normalizeProactiveOriginEventId_(
      currentRow.proactive_origin_event_id,
      'STORAGE_DATA_CORRUPTED'
    );
    ensure(
      storedOriginEventId == null ||
        storedOriginEventId === normalizedOriginEventId,
      'STORAGE_DATA_CORRUPTED',
      'The proactive marker belongs to a different origin event.'
    );
    var updatedRow = updateRowByKey(
      APP_CONSTANTS.SHEETS.CONVERSATION_LOGS,
      'message_id',
      messageId,
      {
        status: 'failed',
        error_code: 'PROACTIVE_RETRY_QUARANTINED',
        proactive_origin_event_id: normalizedOriginEventId
      }
    );
    return toProactiveMarkerDto_(updatedRow);
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
        return isConversationRowVisible_(entry.row) &&
          entry.row.created_at && (
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
    var current = existingRow === -1
      ? null
      : getMemoryById(memory.memoryId);
    var hasOwn = Object.prototype.hasOwnProperty;
    var suppliesApproval = hasOwn.call(memory, 'memoryApproval');
    var suppliesOrigin = hasOwn.call(memory, 'memoryOriginEventId');
    ensure(
      suppliesApproval === suppliesOrigin,
      'VALIDATION_REQUEST_INVALID',
      'Memory provenance fields must be supplied together.'
    );
    var storedApproval = current
      ? current.memory_approval_json || null
      : null;
    var storedOrigins = current &&
      Array.isArray(current.memory_origin_event_ids_json)
      ? current.memory_origin_event_ids_json.slice()
      : [];
    ensure(
      storedOrigins.length <= 100 &&
        storedOrigins.every(function(eventId, index) {
          return Validators.isUuidV4(eventId) &&
            storedOrigins.indexOf(eventId) === index;
        }),
      'STORAGE_DATA_CORRUPTED',
      'Stored memory origin history is invalid.'
    );
    ensure(
      (storedApproval == null) === (storedOrigins.length === 0),
      'STORAGE_DATA_CORRUPTED',
      'Stored memory provenance is incomplete.'
    );
    if (suppliesApproval) {
      var nextApproval = normalizeCharacterApproval_(
        memory.memoryApproval,
        'VALIDATION_REQUEST_INVALID'
      );
      ensure(
        nextApproval &&
          nextApproval.surface === 'MEMORY_EXTRACTION' &&
          (
            nextApproval.source === 'generated' ||
            nextApproval.source === 'rewrite'
          ),
        'VALIDATION_REQUEST_INVALID',
        'Memory approval provenance is invalid.'
      );
      var nextOrigin = normalizeProactiveOriginEventId_(
        memory.memoryOriginEventId,
        'VALIDATION_REQUEST_INVALID'
      );
      ensure(
        nextOrigin != null,
        'VALIDATION_REQUEST_INVALID',
        'Memory origin event is required.'
      );
      ensure(
        storedOrigins.length < 100 ||
          storedOrigins.indexOf(nextOrigin) !== -1,
        'STORAGE_DATA_CORRUPTED',
        'Memory origin history exceeded its safe bound.'
      );
      if (storedOrigins.indexOf(nextOrigin) === -1) {
        storedOrigins.push(nextOrigin);
      }
      assertMemoryProvenanceColumns();
      storedApproval = nextApproval;
    } else if (current && storedApproval != null) {
      ensure(
        approvedMemoryContentUnchanged_(current, memory),
        'STORAGE_DATA_CORRUPTED',
        'Approved memory content cannot change without new approval.'
      );
    }
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
      last_used_at: memory.lastUsedAt || null,
      memory_approval_json: storedApproval,
      memory_origin_event_ids_json: storedOrigins
    };
    if (existingRow === -1) {
      appendRow(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES, row);
    } else {
      updateRowByKey(APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES, 'memory_id', memory.memoryId, row);
    }
    return memory;
  }

  function approvedMemoryContentUnchanged_(current, memory) {
    return current.category === memory.category &&
      current.normalized_key === memory.normalizedKey &&
      current.content === memory.content &&
      Number(current.confidence) === Number(memory.confidence) &&
      current.status === memory.status &&
      JSON.stringify(current.source_message_ids_json || []) ===
        JSON.stringify(memory.sourceMessageIds || []) &&
      current.created_at === memory.createdAt &&
      current.last_confirmed_at === memory.lastConfirmedAt &&
      (current.supersedes_memory_id || null) ===
        (memory.supersedesMemoryId || null);
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
    var existingRowIndex = findRowIndexByColumnValue(
      APP_CONSTANTS.SHEETS.DAILY_SUMMARIES,
      'summary_date',
      summary.summaryDate
    );
    var existingRow = existingRowIndex === -1
      ? null
      : getDailySummary(summary.summaryDate);
    var hasOwn = Object.prototype.hasOwnProperty;
    var suppliesPayload = hasOwn.call(summary, 'diaryPayload');
    var suppliesApproval = hasOwn.call(summary, 'diaryApproval');
    var suppliesOrigin = hasOwn.call(summary, 'diaryOriginEventId');
    ensure(
      suppliesPayload === suppliesApproval &&
        suppliesApproval === suppliesOrigin,
      'VALIDATION_REQUEST_INVALID',
      'Diary provenance fields must be supplied together.'
    );

    var diaryPayload = existingRow
      ? existingRow.diary_payload_json || null
      : null;
    var diaryApproval = existingRow
      ? existingRow.diary_approval_json || null
      : null;
    var diaryOriginEventId = existingRow
      ? normalizeProactiveOriginEventId_(
        existingRow.diary_origin_event_id,
        'STORAGE_DATA_CORRUPTED'
      )
      : null;

    if (suppliesPayload) {
      ensure(
        summary.diaryPayload &&
          typeof summary.diaryPayload === 'object' &&
          !Array.isArray(summary.diaryPayload),
        'VALIDATION_REQUEST_INVALID',
        'Diary payload provenance is invalid.'
      );
      var normalizedDiaryApproval = normalizeCharacterApproval_(
        summary.diaryApproval,
        'VALIDATION_REQUEST_INVALID'
      );
      ensure(
        normalizedDiaryApproval &&
          normalizedDiaryApproval.surface === 'DIARY' &&
          (
            normalizedDiaryApproval.source === 'generated' ||
            normalizedDiaryApproval.source === 'rewrite'
          ),
        'VALIDATION_REQUEST_INVALID',
        'Diary approval provenance is invalid.'
      );
      var normalizedDiaryOrigin = normalizeProactiveOriginEventId_(
        summary.diaryOriginEventId,
        'VALIDATION_REQUEST_INVALID'
      );
      ensure(
        normalizedDiaryOrigin != null,
        'VALIDATION_REQUEST_INVALID',
        'Diary origin event is required.'
      );
      if (diaryPayload != null || diaryApproval != null || diaryOriginEventId != null) {
        ensure(
          diaryPayload != null &&
            diaryApproval != null &&
            diaryOriginEventId != null &&
            JSON.stringify(diaryPayload) ===
              JSON.stringify(summary.diaryPayload) &&
            JSON.stringify(diaryApproval) ===
              JSON.stringify(normalizedDiaryApproval) &&
            diaryOriginEventId === normalizedDiaryOrigin,
          'STORAGE_DATA_CORRUPTED',
          'Approved diary provenance is immutable.'
        );
      } else {
        ensure(
          summary.diaryStatus === 'PENDING' ||
            summary.diaryStatus === 'DONE',
          'VALIDATION_REQUEST_INVALID',
          'Approved diary content must begin in a controlled lifecycle state.'
        );
        assertDiaryProvenanceColumns();
        diaryPayload = summary.diaryPayload;
        diaryApproval = normalizedDiaryApproval;
        diaryOriginEventId = normalizedDiaryOrigin;
      }
    }

    var row = {
      summary_date: summary.summaryDate,
      conversation_count: Number(summary.conversationCount || 0),
      summary_text: summary.summaryText || null,
      key_topics_json: summary.keyTopics || null,
      memory_candidate_count: Number(summary.memoryCandidateCount || 0),
      diary_status: summary.diaryStatus || 'NONE',
      diary_doc_anchor: summary.diaryDocAnchor || null,
      created_at: summary.createdAt,
      updated_at: summary.updatedAt,
      diary_payload_json: diaryPayload,
      diary_approval_json: diaryApproval,
      diary_origin_event_id: diaryOriginEventId
    };
    if (existingRowIndex === -1) {
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
    assertCharacterApprovalColumns: assertCharacterApprovalColumns,
    assertProactiveDeliveryColumns: assertProactiveDeliveryColumns,
    assertDiaryProvenanceColumns: assertDiaryProvenanceColumns,
    assertMemoryProvenanceColumns: assertMemoryProvenanceColumns,
    appendConversation: appendConversation,
    updateConversationMessage: updateConversationMessage,
    listRecentMessages: listRecentMessages,
    listMessagesBefore: listMessagesBefore,
    listMessagesByIds: listMessagesByIds,
    listMessagesByDate: listMessagesByDate,
    listMessagesAfter: listMessagesAfter,
    getConversationByRequestId: getConversationByRequestId,
    getMessageByRequestIdAndRole: getMessageByRequestIdAndRole,
    getProactiveMarkerByDedupeKey: getProactiveMarkerByDedupeKey,
    quarantineProactiveMarker: quarantineProactiveMarker,
    getUserState: getUserState,
    ensureDefaultUserState: ensureDefaultUserState,
    updateUserState: updateUserState,
    insertEvent: insertEvent,
    listClaimableEvents: listClaimableEvents,
    listClaimableEventsByType: listClaimableEventsByType,
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
      selectRecentDiarySummariesBefore: selectRecentDiarySummariesBefore_,
      assertCharacterApprovalHeaders: assertCharacterApprovalHeaders_,
      assertProactiveDeliveryHeaders: assertProactiveDeliveryHeaders_,
      assertDiaryProvenanceHeaders: assertDiaryProvenanceHeaders_,
      assertMemoryProvenanceHeaders: assertMemoryProvenanceHeaders_,
      normalizeCharacterApproval: normalizeCharacterApproval_,
      characterApprovalToRow: characterApprovalToRow_,
      characterApprovalFromRow: characterApprovalFromRow_,
      characterApprovalsEqual: characterApprovalsEqual_,
      normalizeProactiveOriginEventId:
        normalizeProactiveOriginEventId_,
      isConversationRowVisible: isConversationRowVisible_,
      selectProactiveMarkerRow: selectProactiveMarkerRow_,
      toMessageDto: toMessageDto,
      toProactiveMarkerDto: toProactiveMarkerDto_
    }
  };
})();

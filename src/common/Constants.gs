var APP_CONSTANTS = Object.freeze({
  TIME_ZONE: 'Asia/Tokyo',
  SCHEMA_VERSION: '2026.07.a2',
  DEFAULT_CONVERSATION_ID: 'default',
  USER_STATE_SINGLETON_ID: 'default',
  DAILY_MAIL_RETRY_TIME: '08:05',
  PROPERTY_KEYS: Object.freeze({
    GEMINI_API_KEY: ['GEMINI', 'API', 'KEY'].join('_'),
    OWNER_EMAIL: 'OWNER_EMAIL',
    APP_ENV: 'APP_ENV',
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    DIARY_DOC_ID: 'DIARY_DOC_ID',
    TEMP_FOLDER_ID: 'TEMP_FOLDER_ID',
    BACKUP_FOLDER_ID: 'BACKUP_FOLDER_ID',
    SCHEMA_VERSION: 'SCHEMA_VERSION',
    WEB_APP_URL: 'WEB_APP_URL'
  }),
  APP_ENVS: Object.freeze(['prod', 'test']),
  MESSAGE_ROLES: Object.freeze(['user', 'assistant', 'system']),
  MESSAGE_TYPES: Object.freeze(['text', 'image', 'proactive', 'error']),
  MESSAGE_STATUSES: Object.freeze(['accepted', 'completed', 'failed']),
  EVENT_TYPES: Object.freeze([
    'CHAT_REPLY',
    'MEMORY_EXTRACT',
    'DIARY_GENERATE',
    'PROACTIVE_SEND',
    'WEEKLY_BACKUP'
  ]),
  EVENT_STATUSES: Object.freeze([
    'PENDING',
    'PROCESSING',
    'RETRY_WAIT',
    'DONE',
    'DEAD'
  ]),
  MEMORY_CATEGORIES: Object.freeze([
    'profile',
    'preference',
    'relationship',
    'interest',
    'goal',
    'event',
    'promise',
    'other'
  ]),
  MEMORY_STATUSES: Object.freeze(['active', 'candidate', 'superseded', 'disabled']),
  DIARY_STATUSES: Object.freeze(['NONE', 'PENDING', 'DONE', 'FAILED']),
  LOG_LEVELS: Object.freeze(['DEBUG', 'INFO', 'WARN', 'ERROR']),
  MIME_TYPES: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  CONFIG_TYPES: Object.freeze(['string', 'int', 'float', 'bool', 'time', 'json']),
  SHEETS: Object.freeze({
    CONFIG: 'config',
    USER_STATE: 'user_state',
    CONVERSATION_LOGS: 'conversation_logs',
    EVENT_QUEUE: 'event_queue',
    LONG_TERM_MEMORIES: 'long_term_memories',
    DAILY_SUMMARIES: 'daily_summaries',
    USAGE_DAILY: 'usage_daily',
    DEBUG_LOGS: 'debug_logs'
  }),
  CONFIG_DEFAULTS: Object.freeze([
    { key: 'PARTNER_NAME', value: 'Partner', type: 'string', description: 'Displayed partner name' },
    { key: 'USER_NAME', value: 'You', type: 'string', description: 'Displayed user name' },
    { key: 'SYSTEM_PERSONA', value: 'Supportive, proactive, and concise personal AI partner.', type: 'string', description: 'System persona prompt' },
    { key: 'GEMINI_MODEL', value: 'gemini-2.5-flash', type: 'string', description: 'Default Gemini model name' },
    { key: 'MAX_USER_TEXT_CHARS', value: '4000', type: 'int', description: 'Maximum user text length' },
    { key: 'RECENT_MESSAGE_LIMIT', value: '20', type: 'int', description: 'Recent message context size' },
    { key: 'MEMORY_CONTEXT_LIMIT', value: '20', type: 'int', description: 'Memory context size' },
    { key: 'MEMORY_EXTRACT_INTERVAL', value: '10', type: 'int', description: 'Memory extraction interval' },
    { key: 'SILENCE_MINUTES', value: '240', type: 'int', description: 'Silence threshold for proactive messaging' },
    { key: 'PROACTIVE_COOLDOWN_MINUTES', value: '240', type: 'int', description: 'Cooldown between proactive messages' },
    { key: 'PROACTIVE_MAX_PER_DAY', value: '2', type: 'int', description: 'Daily proactive message cap' },
    { key: 'QUIET_START', value: '23:00', type: 'time', description: 'Quiet hours start' },
    { key: 'QUIET_END', value: '08:00', type: 'time', description: 'Quiet hours end' },
    { key: 'PROACTIVE_RECHECK_MINUTES', value: '60', type: 'int', description: 'Proactive recheck interval' },
    { key: 'IMAGE_MAX_BYTES', value: '4194304', type: 'int', description: 'Maximum image upload size' },
    { key: 'IMAGE_MAX_DIMENSION', value: '1600', type: 'int', description: 'Maximum image dimension' },
    { key: 'TEMP_IMAGE_TTL_HOURS', value: '24', type: 'int', description: 'Temporary image TTL' },
    { key: 'QUEUE_BATCH_SIZE', value: '3', type: 'int', description: 'Queue batch size' },
    { key: 'QUEUE_STALE_MINUTES', value: '15', type: 'int', description: 'Queue stale timeout minutes' },
    { key: 'DIARY_DUE_TIME', value: '23:30', type: 'time', description: 'Diary due time' },
    { key: 'DIARY_MIN_CHARS', value: '300', type: 'int', description: 'Minimum diary length' },
    { key: 'DIARY_MAX_CHARS', value: '800', type: 'int', description: 'Maximum diary length' },
    { key: 'LOG_RETENTION_DAYS', value: '30', type: 'int', description: 'Log retention period' },
    { key: 'BACKUP_RETENTION_COUNT', value: '4', type: 'int', description: 'Backup retention count' },
    { key: 'FREE_ONLY_MODE', value: 'true', type: 'bool', description: 'Disable paid-only features' }
  ]),
  USER_STATE_DEFAULTS: Object.freeze({
    singleton_id: 'default',
    last_user_message_at: null,
    last_assistant_message_at: null,
    last_proactive_at: null,
    proactive_count_date: null,
    proactive_count: 0,
    next_proactive_check_at: null,
    last_memory_cursor: null,
    last_diary_date: null,
    quiet_until: null,
    updated_at: null
  }),
  SHEET_SCHEMAS: Object.freeze({
    config: [
      { name: 'key', type: 'string', required: true },
      { name: 'value', type: 'string', required: true },
      { name: 'type', type: 'string', required: true },
      { name: 'description', type: 'string', required: true },
      { name: 'updated_at', type: 'datetime', required: true }
    ],
    user_state: [
      { name: 'singleton_id', type: 'string', required: true },
      { name: 'last_user_message_at', type: 'datetime', required: false },
      { name: 'last_assistant_message_at', type: 'datetime', required: false },
      { name: 'last_proactive_at', type: 'datetime', required: false },
      { name: 'proactive_count_date', type: 'date', required: false },
      { name: 'proactive_count', type: 'int', required: true },
      { name: 'next_proactive_check_at', type: 'datetime', required: false },
      { name: 'last_memory_cursor', type: 'string', required: false },
      { name: 'last_diary_date', type: 'date', required: false },
      { name: 'quiet_until', type: 'datetime', required: false },
      { name: 'updated_at', type: 'datetime', required: true }
    ],
    conversation_logs: [
      { name: 'conversation_id', type: 'string', required: true },
      { name: 'message_id', type: 'string', required: true },
      { name: 'request_id', type: 'string', required: false },
      { name: 'created_at', type: 'datetime', required: true },
      { name: 'role', type: 'string', required: true },
      { name: 'message_type', type: 'string', required: true },
      { name: 'text', type: 'string', required: false },
      { name: 'image_name', type: 'string', required: false },
      { name: 'image_mime', type: 'string', required: false },
      { name: 'image_summary', type: 'string', required: false },
      { name: 'reply_to_message_id', type: 'string', required: false },
      { name: 'status', type: 'string', required: true },
      { name: 'model', type: 'string', required: false },
      { name: 'input_tokens', type: 'int', required: false },
      { name: 'output_tokens', type: 'int', required: false },
      { name: 'error_code', type: 'string', required: false }
    ],
    event_queue: [
      { name: 'event_id', type: 'string', required: true },
      { name: 'event_type', type: 'string', required: true },
      { name: 'dedupe_key', type: 'string', required: true },
      { name: 'payload_json', type: 'json', required: true },
      { name: 'status', type: 'string', required: true },
      { name: 'attempt_count', type: 'int', required: true },
      { name: 'next_attempt_at', type: 'datetime', required: false },
      { name: 'locked_at', type: 'datetime', required: false },
      { name: 'locked_by', type: 'string', required: false },
      { name: 'created_at', type: 'datetime', required: true },
      { name: 'updated_at', type: 'datetime', required: true },
      { name: 'completed_at', type: 'datetime', required: false },
      { name: 'last_error_code', type: 'string', required: false },
      { name: 'last_error_message', type: 'string', required: false }
    ],
    long_term_memories: [
      { name: 'memory_id', type: 'string', required: true },
      { name: 'category', type: 'string', required: true },
      { name: 'normalized_key', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
      { name: 'confidence', type: 'float', required: true },
      { name: 'status', type: 'string', required: true },
      { name: 'source_message_ids_json', type: 'json', required: true },
      { name: 'created_at', type: 'datetime', required: true },
      { name: 'last_confirmed_at', type: 'datetime', required: true },
      { name: 'supersedes_memory_id', type: 'string', required: false },
      { name: 'usage_count', type: 'int', required: true },
      { name: 'last_used_at', type: 'datetime', required: false }
    ],
    daily_summaries: [
      { name: 'summary_date', type: 'date', required: true },
      { name: 'conversation_count', type: 'int', required: true },
      { name: 'summary_text', type: 'string', required: false },
      { name: 'key_topics_json', type: 'json', required: false },
      { name: 'memory_candidate_count', type: 'int', required: true },
      { name: 'diary_status', type: 'string', required: true },
      { name: 'diary_doc_anchor', type: 'string', required: false },
      { name: 'created_at', type: 'datetime', required: true },
      { name: 'updated_at', type: 'datetime', required: true }
    ],
    usage_daily: [
      { name: 'usage_date', type: 'date', required: true },
      { name: 'api_calls', type: 'int', required: true },
      { name: 'image_calls', type: 'int', required: true },
      { name: 'input_tokens', type: 'int', required: true },
      { name: 'output_tokens', type: 'int', required: true },
      { name: 'mail_recipients', type: 'int', required: true },
      { name: 'errors', type: 'int', required: true },
      { name: 'updated_at', type: 'datetime', required: true }
    ],
    debug_logs: [
      { name: 'log_id', type: 'string', required: true },
      { name: 'timestamp', type: 'datetime', required: true },
      { name: 'level', type: 'string', required: true },
      { name: 'operation', type: 'string', required: true },
      { name: 'correlation_id', type: 'string', required: true },
      { name: 'event_id', type: 'string', required: false },
      { name: 'message', type: 'string', required: true },
      { name: 'details_json', type: 'json', required: false }
    ]
  })
});

function getSheetSchema(sheetName) {
  var schema = APP_CONSTANTS.SHEET_SCHEMAS[sheetName];
  if (!schema) {
    throw createAppError('CONFIG_MISSING', 'Unknown sheet schema: ' + sheetName, {
      sheetName: sheetName
    });
  }
  return schema;
}

function generateUuidV4() {
  return Utilities.getUuid();
}

function toIsoStringInTokyo(date) {
  return Utilities.formatDate(date, APP_CONSTANTS.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss") + '+09:00';
}

function formatDateInTokyo(date) {
  return Utilities.formatDate(date, APP_CONSTANTS.TIME_ZONE, 'yyyy-MM-dd');
}

function parseIsoToDate(value) {
  return new Date(value);
}

function parseDateStringToDate(value) {
  return new Date(value + 'T00:00:00+09:00');
}

function compareIsoDatesDescending(left, right) {
  return left === right ? 0 : left > right ? -1 : 1;
}

function compareIsoDatesAscending(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

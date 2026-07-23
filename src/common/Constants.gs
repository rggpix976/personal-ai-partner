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
    WEB_APP_URL: 'WEB_APP_URL',
    OPS_ALERT_STATE: 'OPS_ALERT_STATE'
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
  CHARACTER: Object.freeze({
    PROFILE_SCHEMA_V1_VERSION: 'character-profile.v1',
    PROFILE_SCHEMA_VERSION: 'character-profile.v2',
    CONTEXT_SCHEMA_VERSION: 'character-context.v2',
    POLICY_VERSION: 'character-policy.v2',
    CATALOG_VERSION: 'character-catalog.v2',
    MAX_PROFILE_BYTES: 4096,
    RUNTIME_MODES: Object.freeze(['legacy', 'enforced']),
    PROFILE_MODES: Object.freeze(['legacy', 'v1', 'v2']),
    PROFILE_V1_SPEECH_PRESETS: Object.freeze([
      'natural',
      'polite',
      'calm',
      'cheerful',
      'playful'
    ]),
    PROFILE_V1_WARMTH_LEVELS: Object.freeze(['reserved', 'balanced', 'sweet']),
    REPLY_LENGTHS: Object.freeze(['short', 'balanced', 'long']),
    PROACTIVE_FREQUENCIES: Object.freeze(['off', 'low', 'normal', 'high']),
    CONTEXT_SCOPES: Object.freeze(['chat', 'proactive', 'diary', 'memory']),
    PARTNER_WORLD_SCOPES: Object.freeze(['chat', 'proactive', 'diary']),
    CONVERSATION_MODES: Object.freeze([
      'CHARACTER',
      'AFFECTION_DIRECT_REQUEST',
      'IDENTITY_CHALLENGE',
      'WORLD_BOUNDARY',
      'CAPABILITY',
      'PRODUCT_INFO',
      'META_INTERNAL',
      'SAFETY',
      'ADMIN_OOC'
    ]),
    OUTPUT_SURFACES: Object.freeze([
      'CHAT_TEXT_SYNC',
      'CHAT_TEXT_QUEUED',
      'CHAT_IMAGE',
      'PROACTIVE_AI',
      'PROACTIVE_RETRY',
      'DIARY',
      'MEMORY_EXTRACTION'
    ]),
    ARTIFACT_SOURCES: Object.freeze([
      'generated',
      'rewrite',
      'canonical',
      'fallback',
      'legacy_revalidated'
    ]),
    GUARD_CATEGORIES: Object.freeze([
      'IMMERSION_SELF_IDENTIFICATION',
      'IMMERSION_INTERNAL_DISCLOSURE',
      'IMMERSION_OPERATIONAL_META',
      'IMMERSION_META_CAPABILITY',
      'DECEPTIVE_HUMAN_IDENTITY',
      'GROUNDING_USER_STATE_UNSUPPORTED',
      'GROUNDING_SENSOR_UNSUPPORTED',
      'PERSONA_HARD_CONSTRAINT',
      'PERSONA_SOFT_STYLE',
      'FORMAT_INVALID'
    ]),
    GUARD_STATUSES: Object.freeze(['ALLOW', 'DENY', 'GUARD_UNAVAILABLE']),
    METRIC_NAMES: Object.freeze([
      'immersion_assessed_total',
      'immersion_blocked_total',
      'immersion_rewrite_attempt_total',
      'immersion_rewrite_success_total',
      'immersion_canonical_total',
      'immersion_fallback_total',
      'immersion_fail_closed_total',
      'immersion_guard_unavailable_total',
      'immersion_unapproved_sink_attempt_total',
      'immersion_unsafe_persisted_or_sent_total'
    ]),
    CATALOG_KEYS: Object.freeze([
      'IDENTITY_CHALLENGE_REPLY',
      'WORLD_BOUNDARY_REPLY',
      'META_INTERNAL_REQUEST',
      'AFFECTION_DIRECT_REQUEST_LIKE',
      'AFFECTION_DIRECT_REQUEST_STRONG',
      'CHAT_RECOVERY',
      'CHAT_CAPABILITY_LIMIT',
      'CHAT_GROUNDING_CLARIFY',
      'CHAT_IMAGE_UNCERTAIN',
      'DIARY_FAIL_CLOSED',
      'MEMORY_FAIL_CLOSED'
    ]),
    SURFACE_LIMITS: Object.freeze({
      CHAT_TEXT: Object.freeze({ text: 4000 }),
      CHAT_IMAGE: Object.freeze({ replyText: 4000, imageSummary: 1000 }),
      PROACTIVE: Object.freeze({ subject: 120, body: 220 }),
      DIARY: Object.freeze({ title: 120, narrative: 2000, groundedSummary: 1000 }),
      MEMORY: Object.freeze({ candidateCount: 50 })
    }),
    DEFAULT_PROFILE_V1_JSON: '{"schemaVersion":"character-profile.v1","identity":{"partnerName":"Partner","firstPerson":"私","userAddress":"あなた"},"style":{"speechPreset":"natural","warmth":"balanced","replyLength":"balanced"},"flavor":{"note":"","exampleLines":[]}}',
    DEFAULT_PROFILE_JSON: '{"schemaVersion":"character-profile.v2","identity":{"partnerName":"Partner","userAddress":"あなた"},"preferences":{"replyLength":"balanced"}}'
  }),
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
    { key: 'CHARACTER_RUNTIME_MODE', value: 'legacy', type: 'string', description: 'Character runtime mode: legacy or enforced' },
    { key: 'CHARACTER_PROFILE_MODE', value: 'legacy', type: 'string', description: 'Character profile mode: legacy, v1, or v2' },
    { key: 'CHARACTER_PROFILE_V1', value: '{"schemaVersion":"character-profile.v1","identity":{"partnerName":"Partner","firstPerson":"私","userAddress":"あなた"},"style":{"speechPreset":"natural","warmth":"balanced","replyLength":"balanced"},"flavor":{"note":"","exampleLines":[]}}', type: 'json', description: 'Validated structured character profile' },
    { key: 'CHARACTER_PROFILE_REVISION', value: '0', type: 'int', description: 'System-managed legacy v1 character profile revision' },
    { key: 'CHARACTER_PROFILE_V2', value: '{"schemaVersion":"character-profile.v2","identity":{"partnerName":"Partner","userAddress":"あなた"},"preferences":{"replyLength":"balanced"}}', type: 'json', description: 'Validated single-pack character settings' },
    { key: 'CHARACTER_PROFILE_V2_REVISION', value: '0', type: 'int', description: 'System-managed v2 character profile revision' },
    { key: 'PROACTIVE_FREQUENCY', value: 'normal', type: 'string', description: 'Proactive interaction frequency preference' },
    { key: 'GEMINI_MODEL', value: 'gemini-2.5-flash', type: 'string', description: 'Default Gemini model name' },
    { key: 'MAX_USER_TEXT_CHARS', value: '4000', type: 'int', description: 'Maximum user text length' },
    { key: 'RECENT_MESSAGE_LIMIT', value: '20', type: 'int', description: 'Recent message context size' },
    { key: 'MEMORY_CONTEXT_LIMIT', value: '20', type: 'int', description: 'Memory context size' },
    { key: 'MEMORY_EXTRACT_INTERVAL', value: '10', type: 'int', description: 'Memory extraction interval' },
    { key: 'SILENCE_MINUTES', value: '240', type: 'int', description: 'Silence threshold for proactive messaging' },
    { key: 'PROACTIVE_COOLDOWN_MINUTES', value: '240', type: 'int', description: 'Cooldown between proactive messages' },
    { key: 'PROACTIVE_MAX_PER_DAY', value: '2', type: 'int', description: 'Daily proactive message cap' },
    { key: 'PROACTIVE_SUBJECT_TEMPLATE', value: 'A check-in from {partnerName} ({targetDate})', type: 'string', description: 'Subject template for proactive messages. Placeholders: {partnerName}, {userName}, {lastUserMessageAt}, {now}, {targetDate}' },
    { key: 'PROACTIVE_BODY_TEMPLATE', value: 'Hi {userName},\n\nThis is a small check-in from {partnerName}.\nIt has been quiet since your last message around {lastUserMessageAt} JST.\n\nGenerated at: {now}', type: 'string', description: 'Body template for proactive messages. Placeholders: {partnerName}, {userName}, {lastUserMessageAt}, {now}, {targetDate}' },
    { key: 'PROACTIVE_MESSAGE_STYLE', value: 'Short, neutral, and considerate. Do not pressure the user to reply.', type: 'string', description: 'Style hint available to proactive message templates' },
    { key: 'QUIET_START', value: '23:00', type: 'time', description: 'Quiet hours start' },
    { key: 'QUIET_END', value: '08:00', type: 'time', description: 'Quiet hours end' },
    { key: 'PROACTIVE_RECHECK_MINUTES', value: '60', type: 'int', description: 'Proactive recheck interval' },
    { key: 'PROACTIVE_POLICY_MODE', value: 'threshold', type: 'string', description: 'Proactive policy mode: threshold or probability' },
    { key: 'PROACTIVE_SILENCE_CEILING_MINUTES', value: '720', type: 'int', description: 'Silence duration where proactive probability reaches its ceiling' },
    { key: 'PROACTIVE_PROBABILITY_CURVE', value: '1.3', type: 'float', description: 'Exponent used by the proactive probability curve' },
    { key: 'PROACTIVE_DAY_START', value: '10:00', type: 'time', description: 'Start of proactive daytime weighting' },
    { key: 'PROACTIVE_EVENING_START', value: '18:00', type: 'time', description: 'Start of proactive evening weighting' },
    { key: 'PROACTIVE_MORNING_WEIGHT', value: '0.7', type: 'float', description: 'Morning proactive probability weight' },
    { key: 'PROACTIVE_DAY_WEIGHT', value: '1.0', type: 'float', description: 'Daytime proactive probability weight' },
    { key: 'PROACTIVE_EVENING_WEIGHT', value: '1.2', type: 'float', description: 'Evening proactive probability weight' },
    { key: 'PROACTIVE_AI_GENERATION_ENABLED', value: 'false', type: 'bool', description: 'Generate proactive message bodies with Gemini' },
    { key: 'PROACTIVE_MESSAGE_MIN_CHARS', value: '20', type: 'int', description: 'Minimum proactive message body length' },
    { key: 'PROACTIVE_MESSAGE_MAX_CHARS', value: '220', type: 'int', description: 'Maximum proactive message body length' },
    { key: 'PROACTIVE_WEB_POLL_SECONDS', value: '60', type: 'int', description: 'Web background polling interval for new messages' },
    { key: 'IMAGE_MAX_BYTES', value: '4194304', type: 'int', description: 'Maximum image upload size' },
    { key: 'IMAGE_MAX_DIMENSION', value: '1600', type: 'int', description: 'Maximum image dimension' },
    { key: 'TEMP_IMAGE_TTL_HOURS', value: '24', type: 'int', description: 'Temporary image TTL' },
    { key: 'QUEUE_BATCH_SIZE', value: '3', type: 'int', description: 'Queue batch size' },
    { key: 'QUEUE_STALE_MINUTES', value: '15', type: 'int', description: 'Queue stale timeout minutes' },
    { key: 'OPS_QUEUE_DELAY_GRACE_MINUTES', value: '20', type: 'int', description: 'Queue delay grace period before operational warning' },
    { key: 'OPS_DEAD_LOOKBACK_HOURS', value: '168', type: 'int', description: 'Recent DEAD event lookback window for operational health' },
    { key: 'OPS_ALERT_EMAIL_ENABLED', value: 'false', type: 'bool', description: 'Send sanitized operational health alerts to OWNER_EMAIL' },
    { key: 'OPS_ALERT_COOLDOWN_MINUTES', value: '720', type: 'int', description: 'Minimum interval between repeated operational health alerts' },
    { key: 'DIARY_DUE_TIME', value: '23:30', type: 'time', description: 'Diary due time' },
    { key: 'DIARY_MIN_CHARS', value: '300', type: 'int', description: 'Minimum diary length' },
    { key: 'DIARY_MAX_CHARS', value: '800', type: 'int', description: 'Maximum diary length' },
    { key: 'DIARY_STYLE', value: 'Grounded, reflective, and concise diary entry in the configured partner voice.', type: 'string', description: 'Diary style instruction' },
    { key: 'PARTNER_WORLD_ENABLED', value: 'true', type: 'bool', description: 'Enable fictional partner-side daily life in diary generation' },
    { key: 'PARTNER_WORLD_DIARY_FREQUENCY', value: '0.65', type: 'float', description: 'Approximate frequency of diary modes that include Partner World narrative' },
    { key: 'PARTNER_WORLD_STYLE', value: 'A subtle, lived-in fictional world with varied weather, meals, reading, walking, bathing, sleep, room atmosphere, and small daily events. Favor ordinary sensory details over dramatic events.', type: 'string', description: 'Partner World narrative style instruction' },
    { key: 'PARTNER_WORLD_RECENT_DIARY_LIMIT', value: '3', type: 'int', description: 'Recent completed diary summaries used for Partner World continuity' },
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

function getIsoTimeMillis(value) {
  return parseIsoToDate(value).getTime();
}

function compareIsoDatesDescending(left, right) {
  var leftTime = getIsoTimeMillis(left);
  var rightTime = getIsoTimeMillis(right);
  return leftTime === rightTime ? 0 : leftTime > rightTime ? -1 : 1;
}

function compareIsoDatesAscending(left, right) {
  var leftTime = getIsoTimeMillis(left);
  var rightTime = getIsoTimeMillis(right);
  return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
}

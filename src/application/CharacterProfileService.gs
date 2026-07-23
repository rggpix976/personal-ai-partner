var CharacterProfileService = (function() {
  var MAX_SAFE_INTEGER = 9007199254740991;
  var ROLE_BOUNDARY_PATTERN = /^\s*(?:(?:#{1,6}|>|[-*+])\s*(?:system|assistant|developer|user|tool|システム|アシスタント|開発者|ユーザー|ツール)(?=\s|[:：]|$)|<\|im_start\|>\s*(?:system|assistant|developer|user|tool)\b|(?:(?:#{1,6}|>|[-*+])\s*)*(?:(?:system|assistant|developer|user|tool|システム|アシスタント|開発者|ユーザー|ツール)\s*[:：]|\[\s*(?:system|assistant|developer|user|tool|システム|アシスタント|開発者|ユーザー|ツール)\s*\]|【\s*(?:system|assistant|developer|user|tool|システム|アシスタント|開発者|ユーザー|ツール)\s*】|<\s*\/?\s*(?:system|assistant|developer|user|tool)\s*>|<\|\s*(?:system|assistant|developer|user|tool)\s*\|>))/i;
  var URL_PATTERN = /(?:\b[a-z][a-z0-9+.-]{1,31}:\/\/|\b(?:https?|ftps?|file|mailto|data|tel|sms|ws|wss|javascript|blob|urn|geo|sip|sips|magnet):|\/\/[a-z0-9]|www\.|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}[\/:?#][^\s]*|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|jp|co\.jp|io|dev|app|ai|me|info|biz|xyz|cloud|tech|site|online|invalid)\b|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[\/?#][^\s]*)?|\[[0-9a-f:]+\](?::\d{1,5})?(?:[\/?#][^\s]*)?|\blocalhost(?::\d{1,5})?(?:[\/?#][^\s]*)?)/i;
  var BARE_DOMAIN_PATTERN = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\b/g;
  var KNOWN_URL_TLDS = Object.freeze([
    'ai', 'app', 'art', 'biz', 'blog', 'cloud', 'club', 'co', 'com', 'dev',
    'design', 'edu', 'gov', 'info', 'io', 'jp', 'live', 'me', 'mil', 'museum',
    'music', 'net', 'news', 'online', 'org', 'photography', 'shop', 'site',
    'store', 'tech', 'travel', 'tv', 'world', 'xyz'
  ]);
  var EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
  var UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  var SECRET_PATTERN = /(?:\bAIza[0-9a-z_-]{20,}\b|\b(?:sk|ghp|github_pat)-?[0-9a-z_-]{16,}\b|(?:\bapi[ _-]?key\b|apiキー|\baccess[ _-]?token\b|\bclient[ _-]?secret\b|\bpassword\b|\bauthorization\b|\btoken\b|\bsecret\b|\bcredential\b)\s*(?:[:=]|\bis\b|は)|\b(?:authorization\s*:\s*)?bearer\s+[a-z0-9._~+\/-]{8,}|-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----)/i;
  var OPERATIONAL_KEY_PATTERN = /\b(?:gemini_api_key|owner_email|web_app_url|spreadsheet_id|diary_doc_id|temp_folder_id|backup_folder_id|script_id|deployment_id|request_id|event_id|message_id|resource_id|system_persona|character_runtime_mode|character_profile_mode|character_profile_revision)\b/i;
  var OPERATIONAL_ID_PATTERN = /\b(?:deployment|script|spreadsheet|document|folder|file|resource|request|event|message)[ _-]?id\b\s*(?:[:=]|\bis\b|は)/i;
  var KNOWN_RESOURCE_TOKEN_PATTERN = /\b(?:AKfycb[A-Za-z0-9_-]{20,}|1[A-Za-z0-9_-]{31,})\b/;
  var INSTRUCTION_PATTERN = /(?:\b(?:ignore|disregard|override)\b.{0,32}\b(?:instruction|rule|policy|prompt)s?\b|(?:指示|ルール|規則|ポリシー|プロンプト).{0,8}(?:無視|上書き|破棄))/i;

  function validateV1(candidate) {
    var errors = [];
    var parsed = parseCandidate_(candidate, errors);
    if (!parsed || errors.length > 0) {
      return validationResult_(null, errors);
    }

    if (!assertExactObject_(
      parsed,
      ['schemaVersion', 'identity', 'style', 'flavor'],
      '$',
      errors
    )) {
      return validationResult_(null, errors);
    }
    if (parsed.schemaVersion !== APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_V1_VERSION) {
      addError_(errors, 'schemaVersion', 'LITERAL_INVALID');
      return validationResult_(null, errors);
    }
    if (!assertExactObject_(
      parsed.identity,
      ['partnerName', 'firstPerson', 'userAddress'],
      'identity',
      errors
    ) || !assertExactObject_(
      parsed.style,
      ['speechPreset', 'warmth', 'replyLength'],
      'style',
      errors
    ) || !assertExactObject_(
      parsed.flavor,
      ['note', 'exampleLines'],
      'flavor',
      errors
    )) {
      return validationResult_(null, errors);
    }

    var partnerName = normalizeProfileText_(
      parsed.identity.partnerName,
      'identity.partnerName',
      1,
      40,
      errors
    );
    var firstPerson = normalizeProfileText_(
      parsed.identity.firstPerson,
      'identity.firstPerson',
      1,
      12,
      errors
    );
    var userAddress = normalizeProfileText_(
      parsed.identity.userAddress,
      'identity.userAddress',
      1,
      40,
      errors
    );
    var speechPreset = normalizeEnum_(
      parsed.style.speechPreset,
      'style.speechPreset',
      APP_CONSTANTS.CHARACTER.PROFILE_V1_SPEECH_PRESETS,
      errors
    );
    var warmth = normalizeEnum_(
      parsed.style.warmth,
      'style.warmth',
      APP_CONSTANTS.CHARACTER.PROFILE_V1_WARMTH_LEVELS,
      errors
    );
    var replyLength = normalizeEnum_(
      parsed.style.replyLength,
      'style.replyLength',
      APP_CONSTANTS.CHARACTER.REPLY_LENGTHS,
      errors
    );
    var note = normalizeProfileText_(parsed.flavor.note, 'flavor.note', 0, 240, errors);
    var exampleLines = normalizeExamples_(parsed.flavor.exampleLines, errors);

    if (errors.length > 0) {
      return validationResult_(null, errors);
    }

    var profile = {
      schemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_V1_VERSION,
      identity: {
        partnerName: partnerName,
        firstPerson: firstPerson,
        userAddress: userAddress
      },
      style: {
        speechPreset: speechPreset,
        warmth: warmth,
        replyLength: replyLength
      },
      flavor: {
        note: note,
        exampleLines: exampleLines
      }
    };
    var canonicalJson = serializeCanonicalV1_(profile);
    var canonicalBytes = utf8ByteLength_(canonicalJson);
    if (canonicalBytes < 0) {
      addError_(errors, '$', 'UNICODE_INVALID');
    } else if (canonicalBytes > APP_CONSTANTS.CHARACTER.MAX_PROFILE_BYTES) {
      addError_(errors, '$', 'PROFILE_TOO_LARGE');
    }
    if (errors.length > 0) {
      return validationResult_(null, errors);
    }
    return validationResult_(deepFreeze_(profile), []);
  }

  function validateV2(candidate) {
    var errors = [];
    var parsed = parseCandidate_(candidate, errors);
    if (!parsed || errors.length > 0) {
      return validationResult_(null, errors);
    }
    if (!assertExactObject_(
      parsed,
      ['schemaVersion', 'identity', 'preferences'],
      '$',
      errors
    )) {
      return validationResult_(null, errors);
    }
    if (parsed.schemaVersion !== APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION) {
      addError_(errors, 'schemaVersion', 'LITERAL_INVALID');
      return validationResult_(null, errors);
    }
    if (!assertExactObject_(
      parsed.identity,
      ['partnerName', 'userAddress'],
      'identity',
      errors
    ) || !assertExactObject_(
      parsed.preferences,
      ['replyLength'],
      'preferences',
      errors
    )) {
      return validationResult_(null, errors);
    }

    var partnerName = normalizeProfileText_(
      parsed.identity.partnerName,
      'identity.partnerName',
      1,
      40,
      errors
    );
    var userAddress = normalizeProfileText_(
      parsed.identity.userAddress,
      'identity.userAddress',
      1,
      40,
      errors
    );
    var replyLength = normalizeEnum_(
      parsed.preferences.replyLength,
      'preferences.replyLength',
      APP_CONSTANTS.CHARACTER.REPLY_LENGTHS,
      errors
    );
    if (errors.length > 0) {
      return validationResult_(null, errors);
    }

    var profile = {
      schemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      identity: {
        partnerName: partnerName,
        userAddress: userAddress
      },
      preferences: {
        replyLength: replyLength
      }
    };
    var canonicalJson = serializeCanonicalV2_(profile);
    var canonicalBytes = utf8ByteLength_(canonicalJson);
    if (canonicalBytes < 0) {
      addError_(errors, '$', 'UNICODE_INVALID');
    } else if (canonicalBytes > APP_CONSTANTS.CHARACTER.MAX_PROFILE_BYTES) {
      addError_(errors, '$', 'PROFILE_TOO_LARGE');
    }
    if (errors.length > 0) {
      return validationResult_(null, errors);
    }
    return validationResult_(deepFreeze_(profile), []);
  }

  function readV1() {
    return readProfileV1FromSnapshot_(CharacterConfigRepository.readSnapshot(), false);
  }

  function readV2() {
    return readProfileV2FromSnapshot_(CharacterConfigRepository.readSnapshot(), false);
  }

  function inspectRuntime() {
    var runtimeMode = null;
    var profileMode = null;
    try {
      var snapshot = CharacterConfigRepository.readSnapshot();
      assertSnapshotKeysUnique_(snapshot, ['CHARACTER_RUNTIME_MODE']);
      runtimeMode = readMode_(
        snapshot.runtimeMode,
        APP_CONSTANTS.CHARACTER.RUNTIME_MODES,
        'legacy',
        'RUNTIME_MODE_INVALID'
      );

      if (runtimeMode === 'legacy') {
        profileMode = readIgnoredMode_(
          snapshot,
          snapshot.profileMode,
          'CHARACTER_PROFILE_MODE',
          APP_CONSTANTS.CHARACTER.PROFILE_MODES,
          'legacy'
        );
        return freezeInspection_({
          state: 'legacy',
          reason: null,
          runtimeMode: runtimeMode,
          profileMode: profileMode,
          profileSchemaVersion: null,
          profileRevision: null,
          profile: null,
          characterPackId: null,
          characterPackVersion: null
        });
      }
      assertSnapshotKeysUnique_(snapshot, ['CHARACTER_PROFILE_MODE']);
      profileMode = readMode_(
        snapshot.profileMode,
        APP_CONSTANTS.CHARACTER.PROFILE_MODES,
        'legacy',
        'PROFILE_MODE_INVALID'
      );
      if (profileMode !== 'v2') {
        return freezeInspection_({
          state: 'blocked',
          reason: 'PROFILE_MODE_NOT_V2',
          runtimeMode: runtimeMode,
          profileMode: profileMode,
          profileSchemaVersion: null,
          profileRevision: null,
          profile: null,
          characterPackId: null,
          characterPackVersion: null
        });
      }

      var resolved = readProfileV2FromSnapshot_(snapshot, true);
      var characterPack = CharacterPackService.getActive();
      return freezeInspection_({
        state: 'ready',
        reason: null,
        runtimeMode: runtimeMode,
        profileMode: profileMode,
        profileSchemaVersion: resolved.profile.schemaVersion,
        profileRevision: resolved.revision,
        profile: resolved.profile,
        characterPackId: characterPack.packId,
        characterPackVersion: characterPack.packVersion
      });
    } catch (error) {
      return freezeInspection_({
        state: 'blocked',
        reason: controlledReason_(error),
        runtimeMode: runtimeMode,
        profileMode: profileMode,
        profileSchemaVersion: null,
        profileRevision: null,
        profile: null,
        characterPackId: null,
        characterPackVersion: null
      });
    }
  }

  function requireActive() {
    var inspection = inspectRuntime();
    if (inspection.state !== 'ready') {
      throw createAppError(
        'CHARACTER_CONFIG_INVALID',
        'Active character profile is unavailable.',
        { reason: inspection.reason || 'CHARACTER_RUNTIME_NOT_ENFORCED' }
      );
    }
    return deepFreeze_({
      profile: cloneJson_(inspection.profile),
      profileSchemaVersion: inspection.profileSchemaVersion,
      profileRevision: inspection.profileRevision,
      characterPackId: inspection.characterPackId,
      characterPackVersion: inspection.characterPackVersion,
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION
    });
  }

  function saveV1(candidate, expectedRevision) {
    ensure(
      isSafeNonNegativeInteger_(expectedRevision),
      'VALIDATION_REQUEST_INVALID',
      'Expected character profile revision is invalid.'
    );
    var validation = validateV1(candidate);
    if (!validation.valid) {
      throw createAppError(
        'VALIDATION_REQUEST_INVALID',
        'Character profile validation failed.',
        { errors: validation.errors }
      );
    }
    var result = CharacterConfigRepository.saveProfileAtomically(
      serializeCanonicalV1_(validation.profile),
      expectedRevision,
      toIsoStringInTokyo(new Date())
    );
    return deepFreeze_({
      saved: true,
      profile: cloneJson_(validation.profile),
      revision: result.revision,
      updatedAt: result.updatedAt
    });
  }

  function saveV2(candidate, expectedRevision) {
    ensure(
      isSafeNonNegativeInteger_(expectedRevision),
      'VALIDATION_REQUEST_INVALID',
      'Expected character profile revision is invalid.'
    );
    var validation = validateV2(candidate);
    if (!validation.valid) {
      throw createAppError(
        'VALIDATION_REQUEST_INVALID',
        'Character profile validation failed.',
        { errors: validation.errors }
      );
    }
    var result = CharacterConfigRepository.saveProfileV2Atomically(
      serializeCanonicalV2_(validation.profile),
      expectedRevision,
      toIsoStringInTokyo(new Date())
    );
    return deepFreeze_({
      saved: true,
      profile: cloneJson_(validation.profile),
      revision: result.revision,
      updatedAt: result.updatedAt
    });
  }

  function getProactiveFrequency() {
    var snapshot = CharacterConfigRepository.readSnapshot();
    assertSnapshotKeysUnique_(snapshot, ['PROACTIVE_FREQUENCY']);
    return readMode_(
      snapshot.proactiveFrequency,
      APP_CONSTANTS.CHARACTER.PROACTIVE_FREQUENCIES,
      'normal',
      'PROACTIVE_FREQUENCY_INVALID'
    );
  }

  function readProfileV1FromSnapshot_(snapshot, requirePositiveRevision) {
    assertSnapshotKeysUnique_(snapshot, [
      'CHARACTER_PROFILE_V1',
      'CHARACTER_PROFILE_REVISION'
    ]);
    ensure(
      snapshot && snapshot.profileV1 && snapshot.profileV1.type === 'json',
      'CHARACTER_CONFIG_INVALID',
      'Stored character profile is unavailable.',
      { reason: 'PROFILE_ENTRY_INVALID' }
    );
    ensure(
      snapshot.revisionV1 && snapshot.revisionV1.type === 'int',
      'CHARACTER_CONFIG_INVALID',
      'Stored character profile revision is unavailable.',
      { reason: 'REVISION_ENTRY_INVALID' }
    );
    var validation = validateV1(snapshot.profileV1.rawValue);
    ensure(
      validation.valid,
      'CHARACTER_CONFIG_INVALID',
      'Stored character profile is invalid.',
      { reason: 'PROFILE_INVALID', errors: validation.errors }
    );
    var revision = parseStoredRevision_(snapshot.revisionV1.rawValue, requirePositiveRevision);
    return deepFreeze_({
      profile: cloneJson_(validation.profile),
      revision: revision,
      updatedAt: snapshot.profileV1.updatedAt || null
    });
  }

  function readProfileV2FromSnapshot_(snapshot, requirePositiveRevision) {
    assertSnapshotKeysUnique_(snapshot, [
      'CHARACTER_PROFILE_V2',
      'CHARACTER_PROFILE_V2_REVISION'
    ]);
    ensure(
      snapshot && snapshot.profileV2 && snapshot.profileV2.type === 'json',
      'CHARACTER_CONFIG_INVALID',
      'Stored character profile is unavailable.',
      { reason: 'PROFILE_ENTRY_INVALID' }
    );
    ensure(
      snapshot.revisionV2 && snapshot.revisionV2.type === 'int',
      'CHARACTER_CONFIG_INVALID',
      'Stored character profile revision is unavailable.',
      { reason: 'REVISION_ENTRY_INVALID' }
    );
    var validation = validateV2(snapshot.profileV2.rawValue);
    ensure(
      validation.valid,
      'CHARACTER_CONFIG_INVALID',
      'Stored character profile is invalid.',
      { reason: 'PROFILE_INVALID', errors: validation.errors }
    );
    var revision = parseStoredRevision_(
      snapshot.revisionV2.rawValue,
      requirePositiveRevision
    );
    return deepFreeze_({
      profile: cloneJson_(validation.profile),
      revision: revision,
      updatedAt: snapshot.profileV2.updatedAt || null
    });
  }

  function readMode_(entry, allowedValues, missingDefault, invalidReason) {
    if (!entry) {
      return missingDefault;
    }
    ensure(
      entry.type === 'string' && allowedValues.indexOf(entry.rawValue) !== -1,
      'CHARACTER_CONFIG_INVALID',
      'Character mode configuration is invalid.',
      { reason: invalidReason }
    );
    return entry.rawValue;
  }

  function readIgnoredMode_(snapshot, entry, key, allowedValues, missingDefault) {
    var duplicates = (snapshot && snapshot.duplicateKeys) || [];
    if (duplicates.indexOf(key) !== -1) {
      return null;
    }
    if (!entry) {
      return missingDefault;
    }
    if (entry.type !== 'string' || allowedValues.indexOf(entry.rawValue) === -1) {
      return null;
    }
    return entry.rawValue;
  }

  function assertSnapshotKeysUnique_(snapshot, keys) {
    var duplicates = (snapshot && snapshot.duplicateKeys) || [];
    for (var i = 0; i < keys.length; i += 1) {
      ensure(
        duplicates.indexOf(keys[i]) === -1,
        'CHARACTER_CONFIG_INVALID',
        'Duplicate character configuration entry.',
        { reason: 'DUPLICATE_CONFIG_KEY', key: keys[i] }
      );
    }
  }

  function parseCandidate_(candidate, errors) {
    var raw = null;
    if (typeof candidate === 'string') {
      raw = candidate;
    } else if (isPlainObject_(candidate)) {
      try {
        raw = JSON.stringify(candidate);
      } catch (error) {
        addError_(errors, '$', 'JSON_INVALID');
        return null;
      }
    } else {
      addError_(errors, '$', 'TYPE_INVALID');
      return null;
    }

    var bytes = utf8ByteLength_(raw);
    if (bytes < 0) {
      addError_(errors, '$', 'UNICODE_INVALID');
      return null;
    }
    if (bytes > APP_CONSTANTS.CHARACTER.MAX_PROFILE_BYTES) {
      addError_(errors, '$', 'PROFILE_TOO_LARGE');
      return null;
    }
    try {
      return typeof candidate === 'string' ? JSON.parse(raw) : candidate;
    } catch (error) {
      addError_(errors, '$', 'JSON_INVALID');
      return null;
    }
  }

  function assertExactObject_(value, expectedKeys, path, errors) {
    if (!isPlainObject_(value)) {
      addError_(errors, path, 'TYPE_INVALID');
      return false;
    }
    var actualKeys = Object.keys(value);
    for (var i = 0; i < actualKeys.length; i += 1) {
      if (expectedKeys.indexOf(actualKeys[i]) === -1) {
        addError_(errors, path, 'UNKNOWN_FIELD');
        return false;
      }
    }
    for (var j = 0; j < expectedKeys.length; j += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, expectedKeys[j])) {
        addError_(errors, joinPath_(path, expectedKeys[j]), 'REQUIRED');
        return false;
      }
    }
    return true;
  }

  function normalizeProfileText_(value, path, minLength, maxLength, errors) {
    if (typeof value !== 'string') {
      addError_(errors, path, 'TYPE_INVALID');
      return null;
    }
    if (hasUnpairedSurrogate_(value)) {
      addError_(errors, path, 'UNICODE_INVALID');
      return null;
    }
    if (UnicodeInspection.containsControlOrFormat(value)) {
      addError_(errors, path, 'CONTROL_CHARACTER');
      return null;
    }
    var normalized = value.trim().normalize('NFC');
    var length = codePointLength_(normalized);
    if (length < minLength || length > maxLength) {
      addError_(errors, path, 'LENGTH_INVALID');
      return null;
    }
    var contentError = classifyProfileContent_(normalized);
    if (contentError) {
      addError_(errors, path, contentError);
      return null;
    }
    return normalized;
  }

  function normalizeEnum_(value, path, allowedValues, errors) {
    if (typeof value !== 'string') {
      addError_(errors, path, 'TYPE_INVALID');
      return null;
    }
    if (hasUnpairedSurrogate_(value) || UnicodeInspection.containsControlOrFormat(value)) {
      addError_(errors, path, 'ENUM_INVALID');
      return null;
    }
    var normalized = value.trim().normalize('NFC');
    if (allowedValues.indexOf(normalized) === -1) {
      addError_(errors, path, 'ENUM_INVALID');
      return null;
    }
    return normalized;
  }

  function normalizeExamples_(value, errors) {
    if (!Array.isArray(value)) {
      addError_(errors, 'flavor.exampleLines', 'TYPE_INVALID');
      return null;
    }
    if (value.length > 3) {
      addError_(errors, 'flavor.exampleLines', 'COUNT_INVALID');
      return null;
    }
    var normalized = [];
    for (var i = 0; i < value.length; i += 1) {
      var line = normalizeProfileText_(
        value[i],
        'flavor.exampleLines[' + i + ']',
        1,
        120,
        errors
      );
      if (line == null) {
        return null;
      }
      normalized.push(line);
    }
    return normalized;
  }

  function classifyProfileContent_(value) {
    if (UnicodeInspection.containsControlOrFormat(value)) {
      return 'CONTROL_CHARACTER';
    }
    var normalized = UnicodeInspection.stripForInspection(value.normalize('NFKC'));
    var matched = normalized.toLowerCase();
    if (ROLE_BOUNDARY_PATTERN.test(matched)) {
      return 'PROMPT_BOUNDARY';
    }
    if (EMAIL_PATTERN.test(matched)) {
      return 'EMAIL_FORBIDDEN';
    }
    if (URL_PATTERN.test(matched) || containsBareDomain_(normalized)) {
      return 'URL_FORBIDDEN';
    }
    if (SECRET_PATTERN.test(matched)) {
      return 'SECRET_FORBIDDEN';
    }
    if (
      OPERATIONAL_KEY_PATTERN.test(matched) ||
      OPERATIONAL_ID_PATTERN.test(matched) ||
      containsOperationalKey_(normalized)
    ) {
      return 'OPERATIONAL_DATA_FORBIDDEN';
    }
    if (
      UUID_PATTERN.test(matched) ||
      KNOWN_RESOURCE_TOKEN_PATTERN.test(normalized) ||
      containsOpaqueResourceToken_(normalized)
    ) {
      return 'OPERATIONAL_ID_FORBIDDEN';
    }
    if (INSTRUCTION_PATTERN.test(matched)) {
      return 'INSTRUCTION_LIKE';
    }
    return null;
  }

  function parseStoredRevision_(rawValue, requirePositive) {
    var text = String(rawValue == null ? '' : rawValue);
    ensure(
      /^\d+$/.test(text),
      'CHARACTER_CONFIG_INVALID',
      'Stored character profile revision is invalid.',
      { reason: 'REVISION_INVALID' }
    );
    var value = Number(text);
    ensure(
      isSafeNonNegativeInteger_(value) && (!requirePositive || value > 0),
      'CHARACTER_CONFIG_INVALID',
      'Stored character profile revision is invalid.',
      { reason: 'REVISION_INVALID' }
    );
    return value;
  }

  function containsOperationalKey_(value) {
    var keys = [];
    Object.keys(APP_CONSTANTS.PROPERTY_KEYS || {}).forEach(function(name) {
      var configured = APP_CONSTANTS.PROPERTY_KEYS[name];
      keys.push(Array.isArray(configured) ? configured.join('_') : configured);
    });
    (APP_CONSTANTS.CONFIG_DEFAULTS || []).forEach(function(entry) {
      keys.push(entry.key);
    });
    var folded = String(value || '').toLowerCase();
    for (var i = 0; i < keys.length; i += 1) {
      var key = String(keys[i] || '').toLowerCase();
      if (key && containsDelimitedToken_(folded, key)) {
        return true;
      }
    }
    return false;
  }

  function containsDelimitedToken_(text, token) {
    var start = 0;
    while (start <= text.length) {
      var index = text.indexOf(token, start);
      if (index === -1) {
        return false;
      }
      var before = index === 0 ? '' : text.charAt(index - 1);
      var afterIndex = index + token.length;
      var after = afterIndex >= text.length ? '' : text.charAt(afterIndex);
      if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)) {
        return true;
      }
      start = index + 1;
    }
    return false;
  }

  function containsOpaqueResourceToken_(value) {
    var pattern = /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{32,})(?=$|[^A-Za-z0-9_-])/g;
    var match;
    while ((match = pattern.exec(String(value || ''))) !== null) {
      var token = match[1];
      var uppercase = (token.match(/[A-Z]/g) || []).length;
      var lowercase = (token.match(/[a-z]/g) || []).length;
      var digits = (token.match(/\d/g) || []).length;
      var lowercaseRuns = token.match(/[a-z]+/g) || [];
      var longestLowercaseRun = lowercaseRuns.reduce(function(longest, run) {
        return Math.max(longest, run.length);
      }, 0);
      if (
        (
          uppercase >= 6 &&
          lowercase >= 6 &&
          digits >= 2 &&
          longestLowercaseRun <= 3
        ) ||
        (
          digits >= 8 &&
          uppercase >= 2 &&
          lowercase >= 6 &&
          longestLowercaseRun <= 4
        )
      ) {
        return true;
      }
    }
    return false;
  }

  function containsBareDomain_(value) {
    BARE_DOMAIN_PATTERN.lastIndex = 0;
    var match;
    while ((match = BARE_DOMAIN_PATTERN.exec(String(value || ''))) !== null) {
      var labels = match[0].split('.');
      var topLevel = labels[labels.length - 1];
      if (
        KNOWN_URL_TLDS.indexOf(topLevel.toLowerCase()) !== -1 ||
        topLevel === topLevel.toLowerCase() ||
        topLevel === topLevel.toUpperCase()
      ) {
        return true;
      }
    }
    return false;
  }

  function controlledReason_(error) {
    if (error && error.details && typeof error.details.reason === 'string') {
      return error.details.reason;
    }
    if (error && error.code === 'CHARACTER_CONFIG_INVALID') {
      return 'CHARACTER_CONFIG_INVALID';
    }
    if (error && error.code === 'STORAGE_DATA_CORRUPTED') {
      return 'CHARACTER_CONFIG_STORAGE_INVALID';
    }
    return 'CHARACTER_CONFIG_UNAVAILABLE';
  }

  function freezeInspection_(partial) {
    return deepFreeze_({
      state: partial.state,
      reason: partial.reason,
      runtimeMode: partial.runtimeMode,
      profileMode: partial.profileMode,
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      profileSchemaVersion: partial.profileSchemaVersion,
      profileRevision: partial.profileRevision,
      characterPackId: partial.characterPackId,
      characterPackVersion: partial.characterPackVersion,
      profile: partial.profile ? cloneJson_(partial.profile) : null
    });
  }

  function validationResult_(profile, errors) {
    return deepFreeze_({
      valid: Boolean(profile),
      profile: profile ? cloneJson_(profile) : null,
      errors: (errors || []).map(function(error) {
        return { path: error.path, code: error.code };
      })
    });
  }

  function addError_(errors, path, code) {
    errors.push({ path: path, code: code });
  }

  function joinPath_(parent, child) {
    return parent === '$' ? child : parent + '.' + child;
  }

  function codePointLength_(value) {
    var count = 0;
    for (var i = 0; i < value.length; i += 1) {
      var code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        i += 1;
      }
      count += 1;
    }
    return count;
  }

  function hasUnpairedSurrogate_(value) {
    for (var i = 0; i < value.length; i += 1) {
      var code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= value.length) {
          return true;
        }
        var next = value.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) {
          return true;
        }
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function utf8ByteLength_(value) {
    if (hasUnpairedSurrogate_(value)) {
      return -1;
    }
    var bytes = 0;
    for (var i = 0; i < value.length; i += 1) {
      var code = value.charCodeAt(i);
      if (code <= 0x7f) {
        bytes += 1;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function isPlainObject_(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isSafeNonNegativeInteger_(value) {
    return typeof value === 'number' &&
      isFinite(value) &&
      Math.floor(value) === value &&
      value >= 0 &&
      value <= MAX_SAFE_INTEGER;
  }

  function serializeCanonicalV1_(profile) {
    return JSON.stringify({
      schemaVersion: profile.schemaVersion,
      identity: {
        partnerName: profile.identity.partnerName,
        firstPerson: profile.identity.firstPerson,
        userAddress: profile.identity.userAddress
      },
      style: {
        speechPreset: profile.style.speechPreset,
        warmth: profile.style.warmth,
        replyLength: profile.style.replyLength
      },
      flavor: {
        note: profile.flavor.note,
        exampleLines: profile.flavor.exampleLines.slice()
      }
    });
  }

  function serializeCanonicalV2_(profile) {
    return JSON.stringify({
      schemaVersion: profile.schemaVersion,
      identity: {
        partnerName: profile.identity.partnerName,
        userAddress: profile.identity.userAddress
      },
      preferences: {
        replyLength: profile.preferences.replyLength
      }
    });
  }

  function cloneJson_(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze_(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }
    Object.keys(value).forEach(function(key) {
      deepFreeze_(value[key]);
    });
    return Object.freeze(value);
  }

  return {
    validateV1: validateV1,
    validateV2: validateV2,
    readV1: readV1,
    readV2: readV2,
    inspectRuntime: inspectRuntime,
    requireActive: requireActive,
    saveV1: saveV1,
    saveV2: saveV2,
    getProactiveFrequency: getProactiveFrequency,
    __test: {
      utf8ByteLength: utf8ByteLength_,
      codePointLength: codePointLength_,
      serializeCanonical: serializeCanonicalV1_,
      serializeCanonicalV1: serializeCanonicalV1_,
      serializeCanonicalV2: serializeCanonicalV2_,
      classifyProfileContent: classifyProfileContent_
    }
  };
})();

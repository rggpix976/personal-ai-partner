var CharacterPayloadService = (function() {
  var DIARY_KEYS = Object.freeze([
    'title',
    'narrative',
    'groundedSummary',
    'partnerWorldEvents',
    'thingsToRemember',
    'unresolvedFollowUps'
  ]);
  var MAX_TOP_LEVEL_ITEMS = 50;
  var MAX_NESTED_ARRAY_ITEMS = 100;
  var MAX_OBJECT_KEYS = 100;
  var MAX_OBJECT_KEY_CODE_POINTS = 64;
  var MAX_JSON_DEPTH = 12;
  var MAX_JSON_NODES = 2000;
  var MAX_NESTED_TEXT_CODE_POINTS = 4000;
  var UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  var UUID_LIKE_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  var SAFE_OBJECT_KEYS = Object.freeze([
    'action', 'body', 'category', 'confidence', 'content', 'date',
    'description', 'details', 'domain', 'event', 'events',
    'fact', 'facts', 'item', 'items', 'key', 'kind', 'label',
    'memory', 'message', 'metadata', 'name', 'normalizedKey', 'note',
    'priority', 'question', 'reason', 'relationship', 'role', 'source',
    'status', 'subject',
    'summary', 'tags', 'text', 'time', 'title', 'topic', 'topics', 'type',
    'user', 'value', 'world'
  ]);
  var PROVENANCE_OBJECT_KEYS = Object.freeze([
    'existingMemoryId', 'sourceMessageIds', 'source_message_ids'
  ]);
  var MAX_EVIDENCE_KEYS = 50;
  var MAX_EVIDENCE_KEY_CODE_POINTS = 80;
  var EVIDENCE_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
  var EVIDENCE_DOMAINS = Object.freeze({
    currentRequest: 'CURRENT_REQUEST',
    recentMessages: 'RECENT_MESSAGE',
    memories: 'MEMORY',
    userFacts: 'USER_FACT',
    sharedFacts: 'SHARED_FACT',
    realWorldObservations: 'REAL_WORLD_OBSERVATION',
    relationshipState: 'RELATIONSHIP_STATE',
    partnerWorldApprovedFacts: 'PARTNER_WORLD',
    characterCanon: 'CHARACTER_CANON'
  });

  function normalize(surface, payload) {
    assertSurface_(surface);
    assertPlainObject_(payload, 'PAYLOAD_SHAPE_INVALID');

    var normalized;
    if (surface === 'CHAT_TEXT_SYNC' || surface === 'CHAT_TEXT_QUEUED') {
      assertExactKeys_(payload, ['text']);
      normalized = {
        text: normalizeText_(
          payload.text,
          APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.CHAT_TEXT.text,
          true
        )
      };
    } else if (surface === 'CHAT_IMAGE') {
      assertExactKeys_(payload, ['replyText', 'imageSummary']);
      normalized = {
        replyText: normalizeText_(
          payload.replyText,
          APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.CHAT_IMAGE.replyText,
          true
        ),
        imageSummary: normalizeText_(
          payload.imageSummary,
          APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.CHAT_IMAGE.imageSummary,
          true
        )
      };
    } else if (
      surface === 'PROACTIVE_AI' ||
      surface === 'PROACTIVE_RETRY'
    ) {
      assertExactKeys_(payload, ['subject', 'body']);
      normalized = {
        subject: normalizeText_(
          payload.subject,
          APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.PROACTIVE.subject,
          true
        ),
        body: normalizeText_(
          payload.body,
          APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.PROACTIVE.body,
          true
        )
      };
    } else if (surface === 'DIARY') {
      assertExactKeys_(payload, DIARY_KEYS);
      assertBoundedArray_(payload.partnerWorldEvents, MAX_TOP_LEVEL_ITEMS);
      assertBoundedArray_(payload.thingsToRemember, MAX_TOP_LEVEL_ITEMS);
      assertBoundedArray_(payload.unresolvedFollowUps, MAX_TOP_LEVEL_ITEMS);
      var diaryBudget = { nodes: 0 };
      normalized = {
        title: normalizeText_(
          payload.title,
          APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.DIARY.title,
          true
        ),
        narrative: normalizeText_(
          payload.narrative,
          APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.DIARY.narrative,
          true
        ),
        groundedSummary: normalizeText_(
          payload.groundedSummary,
          APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.DIARY.groundedSummary,
          false
        ),
        // PR 6 owns the business schema for these collections. PR 3 keeps
        // their boundary JSON-safe, bounded, immutable, and text-enumerable.
        partnerWorldEvents: cloneJsonSafe_(payload.partnerWorldEvents, 0, diaryBudget, [], false, false),
        thingsToRemember: cloneJsonSafe_(payload.thingsToRemember, 0, diaryBudget, [], false, false),
        unresolvedFollowUps: cloneJsonSafe_(payload.unresolvedFollowUps, 0, diaryBudget, [], false, false)
      };
    } else {
      assertExactKeys_(payload, ['candidates']);
      assertBoundedArray_(
        payload.candidates,
        APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.MEMORY.candidateCount
      );
      payload.candidates.forEach(function(candidate) {
        if (!isPlainObject_(candidate)) {
          fail_('PAYLOAD_COLLECTION_INVALID');
        }
      });
      // PR 7 owns the candidate/provenance business schema. PR 3 deliberately
      // does not accept extra top-level fields or leave nested data unbounded.
      normalized = {
        candidates: cloneJsonSafe_(payload.candidates, 0, { nodes: 0 }, [], true, false)
      };
    }

    return deepFreeze_(normalized);
  }

  function textFields(surface, payload) {
    var normalized = normalize(surface, payload);
    var fields = [];

    if (surface === 'CHAT_TEXT_SYNC' || surface === 'CHAT_TEXT_QUEUED') {
      addTextField_(fields, 'text', normalized.text);
    } else if (surface === 'CHAT_IMAGE') {
      addTextField_(fields, 'replyText', normalized.replyText);
      addTextField_(fields, 'imageSummary', normalized.imageSummary);
    } else if (
      surface === 'PROACTIVE_AI' ||
      surface === 'PROACTIVE_RETRY'
    ) {
      addTextField_(fields, 'subject', normalized.subject);
      addTextField_(fields, 'body', normalized.body);
    } else if (surface === 'DIARY') {
      DIARY_KEYS.forEach(function(key) {
        collectTextFields_(normalized[key], key, fields);
      });
    } else {
      collectTextFields_(normalized.candidates, 'candidates', fields);
    }

    return deepFreeze_(fields);
  }

  function collectEvidenceView(context) {
    assertPlainObject_(context, 'EVIDENCE_CONTEXT_INVALID');
    assertPlainObject_(context.data, 'EVIDENCE_CONTEXT_INVALID');

    var data = context.data;
    var requiredLists = [
      'recentMessages',
      'memories',
      'userFacts',
      'sharedFacts',
      'realWorldObservations'
    ];
    requiredLists.forEach(function(key) {
      if (!Array.isArray(data[key])) {
        fail_('EVIDENCE_CONTEXT_INVALID');
      }
    });
    if (data.currentRequest != null && !isPlainObject_(data.currentRequest)) {
      fail_('EVIDENCE_CONTEXT_INVALID');
    }
    if (data.relationshipState != null && !isPlainObject_(data.relationshipState)) {
      fail_('EVIDENCE_CONTEXT_INVALID');
    }
    if (data.partnerWorld != null) {
      assertPlainObject_(data.partnerWorld, 'EVIDENCE_CONTEXT_INVALID');
      if (!Array.isArray(data.partnerWorld.approvedFacts)) {
        fail_('EVIDENCE_CONTEXT_INVALID');
      }
    }
    var pack = context.persona && context.persona.pack;
    if (!isPlainObject_(pack) || !Array.isArray(pack.canon)) {
      fail_('EVIDENCE_CONTEXT_INVALID');
    }

    var view = [];
    var budget = { nodes: 0 };
    pack.canon.forEach(function(entry) {
      if (
        !isPlainObject_(entry) ||
        typeof entry.id !== 'string' ||
        !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(entry.id) ||
        entry.domain !== EVIDENCE_DOMAINS.characterCanon ||
        !Array.isArray(entry.allowedScopes)
      ) {
        fail_('EVIDENCE_CONTEXT_INVALID');
      }
      if (entry.allowedScopes.indexOf(context.surface) === -1) {
        return;
      }
      addEvidenceEntry_(
        view,
        'characterCanon:' + entry.id,
        EVIDENCE_DOMAINS.characterCanon,
        entry,
        budget
      );
    });
    addEvidenceEntry_(
      view,
      'currentRequest',
      EVIDENCE_DOMAINS.currentRequest,
      data.currentRequest,
      budget
    );
    addEvidenceList_(
      view,
      'recentMessages',
      EVIDENCE_DOMAINS.recentMessages,
      data.recentMessages,
      budget
    );
    addEvidenceList_(
      view,
      'memories',
      EVIDENCE_DOMAINS.memories,
      data.memories,
      budget
    );
    addEvidenceList_(
      view,
      'userFacts',
      EVIDENCE_DOMAINS.userFacts,
      data.userFacts,
      budget
    );
    addEvidenceList_(
      view,
      'sharedFacts',
      EVIDENCE_DOMAINS.sharedFacts,
      data.sharedFacts,
      budget
    );
    addEvidenceList_(
      view,
      'realWorldObservations',
      EVIDENCE_DOMAINS.realWorldObservations,
      data.realWorldObservations,
      budget
    );
    addEvidenceEntry_(
      view,
      'relationshipState',
      EVIDENCE_DOMAINS.relationshipState,
      data.relationshipState,
      budget
    );
    if (data.partnerWorld != null) {
      addEvidenceList_(
        view,
        'partnerWorld.approvedFacts',
        EVIDENCE_DOMAINS.partnerWorldApprovedFacts,
        data.partnerWorld.approvedFacts,
        budget
      );
    }
    return deepFreeze_(view);
  }

  function collectEvidenceKeys(context) {
    var keys = collectEvidenceView(context).map(function(entry) {
      return entry.key;
    });
    return deepFreeze_(keys);
  }

  function contextScopeForSurface(surface) {
    assertSurface_(surface);
    if (surface === 'CHAT_TEXT_SYNC' || surface === 'CHAT_TEXT_QUEUED' || surface === 'CHAT_IMAGE') {
      return 'chat';
    }
    if (
      surface === 'PROACTIVE_AI' ||
      surface === 'PROACTIVE_RETRY'
    ) {
      return 'proactive';
    }
    if (surface === 'DIARY') {
      return 'diary';
    }
    return 'memory';
  }

  function collectTextFields_(value, path, fields) {
    if (typeof value === 'string') {
      addTextField_(fields, path, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function(item, index) {
        collectTextFields_(item, path + '[' + index + ']', fields);
      });
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    Object.keys(value).forEach(function(key, index) {
      // Keys are part of the generated payload too. Keeping them in the
      // inspection stream prevents a nested key from becoming an unchecked
      // channel around the fixed and semantic guards.
      addTextField_(
        fields,
        path + '.$key[' + index + ']',
        objectKeyPolicyText_(key)
      );
      collectTextFields_(value[key], path + '.' + key, fields);
    });
  }

  function objectKeyPolicyText_(key) {
    return key
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_+/g, ' ')
      .replace(/\bi m\b/gi, 'i am')
      .replace(/\bwe re\b/gi, 'we are')
      .replace(/\byou re\b/gi, 'you are')
      .replace(/\bit s\b/gi, 'it is')
      .replace(/\bdon t\b/gi, 'do not')
      .replace(/\bcan t\b/gi, 'cannot')
      .replace(/\bwon t\b/gi, 'will not');
  }

  function addTextField_(fields, path, value) {
    if (typeof value !== 'string' || value.length === 0) {
      return;
    }
    fields.push({ path: path, value: value });
  }

  function addEvidenceList_(view, path, domain, values, budget) {
    values.forEach(function(value, index) {
      addEvidenceEntry_(view, path + ':' + index, domain, value, budget);
    });
  }

  function addEvidenceEntry_(view, key, domain, value, budget) {
    if (value == null) {
      return;
    }
    if (
      typeof key !== 'string' ||
      codePointLength_(key) > MAX_EVIDENCE_KEY_CODE_POINTS ||
      !EVIDENCE_KEY_PATTERN.test(key)
    ) {
      fail_('EVIDENCE_KEY_INVALID');
    }
    if (view.length >= MAX_EVIDENCE_KEYS) {
      fail_('EVIDENCE_KEY_LIMIT_EXCEEDED');
    }
    view.push({
      key: key,
      domain: domain,
      value: cloneEvidenceValue_(value, 0, budget, [])
    });
  }

  function cloneEvidenceValue_(value, depth, budget, ancestors) {
    budget.nodes += 1;
    if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      fail_('EVIDENCE_CONTEXT_INVALID');
    }
    if (value == null || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (codePointLength_(value) > MAX_NESTED_TEXT_CODE_POINTS) {
        fail_('EVIDENCE_CONTEXT_INVALID');
      }
      return value;
    }
    if (typeof value === 'number') {
      if (!isFinite(value)) {
        fail_('EVIDENCE_CONTEXT_INVALID');
      }
      return value;
    }
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && !isPlainObject_(value))) {
      fail_('EVIDENCE_CONTEXT_INVALID');
    }
    if (ancestors.indexOf(value) !== -1) {
      fail_('EVIDENCE_CONTEXT_INVALID');
    }
    ancestors.push(value);

    var copy;
    if (Array.isArray(value)) {
      if (value.length > MAX_NESTED_ARRAY_ITEMS) {
        fail_('EVIDENCE_CONTEXT_INVALID');
      }
      copy = value.map(function(item) {
        return cloneEvidenceValue_(item, depth + 1, budget, ancestors);
      });
    } else {
      var keys = Object.keys(value);
      if (keys.length > MAX_OBJECT_KEYS) {
        fail_('EVIDENCE_CONTEXT_INVALID');
      }
      copy = {};
      keys.forEach(function(key) {
        if (
          isDangerousObjectKey_(key) ||
          codePointLength_(key) > MAX_OBJECT_KEY_CODE_POINTS
        ) {
          fail_('EVIDENCE_CONTEXT_INVALID');
        }
        copy[key] = cloneEvidenceValue_(value[key], depth + 1, budget, ancestors);
      });
    }
    ancestors.pop();
    return copy;
  }

  function cloneJsonSafe_(value, depth, budget, ancestors, allowProvenance, allowIdentifier) {
    budget.nodes += 1;
    if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      fail_('PAYLOAD_JSON_LIMIT_EXCEEDED');
    }
    if (value == null || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return normalizeText_(value, MAX_NESTED_TEXT_CODE_POINTS, false, allowIdentifier);
    }
    if (typeof value === 'number') {
      if (!isFinite(value)) {
        fail_('PAYLOAD_JSON_INVALID');
      }
      return value;
    }
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && !isPlainObject_(value))) {
      fail_('PAYLOAD_JSON_INVALID');
    }
    if (ancestors.indexOf(value) !== -1) {
      fail_('PAYLOAD_JSON_INVALID');
    }
    ancestors.push(value);

    var copy;
    if (Array.isArray(value)) {
      if (value.length > MAX_NESTED_ARRAY_ITEMS) {
        fail_('PAYLOAD_JSON_LIMIT_EXCEEDED');
      }
      copy = value.map(function(item) {
        return cloneJsonSafe_(
          item,
          depth + 1,
          budget,
          ancestors,
          allowProvenance,
          allowIdentifier
        );
      });
    } else {
      var keys = Object.keys(value);
      if (keys.length > MAX_OBJECT_KEYS) {
        fail_('PAYLOAD_JSON_LIMIT_EXCEEDED');
      }
      copy = {};
      keys.forEach(function(key) {
        assertSafePayloadObjectKey_(key, allowProvenance);
        assertSpecialPayloadValue_(key, value[key], allowProvenance);
        copy[key] = cloneJsonSafe_(
          value[key],
          depth + 1,
          budget,
          ancestors,
          allowProvenance,
          PROVENANCE_OBJECT_KEYS.indexOf(key) !== -1
        );
      });
    }
    ancestors.pop();
    return copy;
  }

  function normalizeText_(value, maxCodePoints, required, allowIdentifier) {
    if (typeof value !== 'string') {
      fail_('PAYLOAD_TEXT_INVALID');
    }
    if (
      UnicodeInspection.hasUnpairedSurrogate(value) ||
      UnicodeInspection.hasUnicodeNoncharacter(value)
    ) {
      fail_('PAYLOAD_TEXT_INVALID');
    }
    var normalized = normalizeUnicode_(value.replace(/\r\n?/g, '\n')).trim();
    var identifierInspection = normalizeIdentifierInspection_(normalized);
    if (
      (required && !normalized) ||
      codePointLength_(normalized) > maxCodePoints ||
      (allowIdentifier !== true && UUID_LIKE_PATTERN.test(identifierInspection))
    ) {
      fail_('PAYLOAD_TEXT_INVALID');
    }
    return normalized;
  }

  function normalizeUnicode_(value) {
    return typeof String.prototype.normalize === 'function'
      ? String(value).normalize('NFC')
      : String(value);
  }

  function normalizeIdentifierInspection_(value) {
    var normalized = typeof String.prototype.normalize === 'function'
      ? String(value).normalize('NFKC')
      : String(value);
    return UnicodeInspection.stripForInspection(normalized);
  }

  function codePointLength_(value) {
    var count = 0;
    for (var index = 0; index < value.length; index += 1) {
      var first = value.charCodeAt(index);
      if (first >= 0xD800 && first <= 0xDBFF && index + 1 < value.length) {
        var second = value.charCodeAt(index + 1);
        if (second >= 0xDC00 && second <= 0xDFFF) {
          index += 1;
        }
      }
      count += 1;
    }
    return count;
  }

  function assertBoundedArray_(value, maxItems) {
    if (!Array.isArray(value) || value.length > maxItems) {
      fail_('PAYLOAD_COLLECTION_INVALID');
    }
  }

  function assertSurface_(surface) {
    if (APP_CONSTANTS.CHARACTER.OUTPUT_SURFACES.indexOf(surface) === -1) {
      fail_('PAYLOAD_SURFACE_INVALID');
    }
  }

  function assertExactKeys_(value, expectedKeys) {
    assertPlainObject_(value, 'PAYLOAD_SHAPE_INVALID');
    var actualKeys = Object.keys(value);
    if (
      actualKeys.length !== expectedKeys.length ||
      !expectedKeys.every(function(key) {
        return Object.prototype.hasOwnProperty.call(value, key);
      })
    ) {
      fail_('PAYLOAD_SHAPE_INVALID');
    }
  }

  function assertPlainObject_(value, reason) {
    if (!isPlainObject_(value)) {
      fail_(reason);
    }
  }

  function isPlainObject_(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isDangerousObjectKey_(key) {
    return key === '__proto__' || key === 'prototype' || key === 'constructor';
  }

  function assertSafePayloadObjectKey_(key, allowProvenance) {
    if (
      typeof key !== 'string' ||
      !key ||
      codePointLength_(key) > MAX_OBJECT_KEY_CODE_POINTS ||
      normalizeUnicode_(key) !== key ||
      UnicodeInspection.containsControlOrFormat(key) ||
      !isAllowedPayloadObjectKey_(key, allowProvenance) ||
      isDangerousObjectKey_(key)
    ) {
      fail_('PAYLOAD_JSON_KEY_INVALID');
    }
  }

  function isAllowedPayloadObjectKey_(key, allowProvenance) {
    return SAFE_OBJECT_KEYS.indexOf(key) !== -1 ||
      (allowProvenance === true && PROVENANCE_OBJECT_KEYS.indexOf(key) !== -1);
  }

  function assertSpecialPayloadValue_(key, value, allowProvenance) {
    if (PROVENANCE_OBJECT_KEYS.indexOf(key) !== -1 && allowProvenance !== true) {
      fail_('PAYLOAD_PROVENANCE_INVALID');
    }
    if (key === 'existingMemoryId') {
      if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
        fail_('PAYLOAD_PROVENANCE_INVALID');
      }
      return;
    }
    if (key !== 'sourceMessageIds' && key !== 'source_message_ids') {
      return;
    }
    if (!Array.isArray(value) || value.length > MAX_NESTED_ARRAY_ITEMS) {
      fail_('PAYLOAD_PROVENANCE_INVALID');
    }
    var seen = Object.create(null);
    value.forEach(function(identifier) {
      if (
        typeof identifier !== 'string' ||
        !UUID_V4_PATTERN.test(identifier) ||
        Object.prototype.hasOwnProperty.call(seen, identifier)
      ) {
        fail_('PAYLOAD_PROVENANCE_INVALID');
      }
      seen[identifier] = true;
    });
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

  function fail_(reason) {
    throw createAppError(
      'CHARACTER_OUTPUT_BLOCKED',
      'Character output did not match the approved payload contract.',
      { reason: reason }
    );
  }

  return {
    normalize: normalize,
    textFields: textFields,
    collectEvidenceView: collectEvidenceView,
    collectEvidenceKeys: collectEvidenceKeys,
    contextScopeForSurface: contextScopeForSurface
  };
})();

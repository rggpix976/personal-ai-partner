var CharacterSemanticVerifier = (function() {
  var STATUSES = Object.freeze(['ALLOW', 'DENY', 'GUARD_UNAVAILABLE']);
  var EVIDENCE_DOMAINS = Object.freeze([
    'CHARACTER_CANON',
    'CURRENT_REQUEST',
    'RECENT_MESSAGE',
    'MEMORY',
    'USER_FACT',
    'SHARED_FACT',
    'REAL_WORLD_OBSERVATION',
    'RELATIONSHIP_STATE',
    'PARTNER_WORLD'
  ]);
  var CLAIM_EVIDENCE_DOMAINS = Object.freeze({
    USER_STATE: Object.freeze([
      'CURRENT_REQUEST',
      'RECENT_MESSAGE',
      'MEMORY',
      'USER_FACT',
      'SHARED_FACT',
      'REAL_WORLD_OBSERVATION'
    ]),
    SENSOR_OBSERVATION: Object.freeze(['REAL_WORLD_OBSERVATION']),
    PARTNER_WORLD: Object.freeze(['PARTNER_WORLD'])
  });

  function evaluate(request, verifierFn) {
    var unavailable = result_('GUARD_UNAVAILABLE', null, []);
    if (!isPlainObject_(request) || typeof verifierFn !== 'function') {
      return unavailable;
    }

    var knownEvidenceKeys = normalizeKnownEvidenceKeys_(request.knownEvidenceKeys);
    var evidenceDomains = indexEvidenceDomains_(
      request.evidenceView,
      knownEvidenceKeys
    );
    if (
      knownEvidenceKeys == null ||
      evidenceDomains == null ||
      typeof request.requiresEvidence !== 'boolean'
    ) {
      return unavailable;
    }

    var rawResult;
    try {
      rawResult = verifierFn(request);
    } catch (ignored) {
      return unavailable;
    }

    if (!hasExactKeys_(rawResult, ['verdict', 'category', 'evidenceKeys'])) {
      return unavailable;
    }
    if (rawResult.verdict !== 'allow' && rawResult.verdict !== 'deny') {
      return unavailable;
    }

    var evidenceKeys = normalizeVerdictEvidenceKeys_(rawResult.evidenceKeys);
    if (evidenceKeys == null || !allKnown_(evidenceKeys, knownEvidenceKeys)) {
      return unavailable;
    }

    if (rawResult.verdict === 'allow') {
      if (rawResult.category !== null) {
        return unavailable;
      }
      if (request.requiresEvidence && evidenceKeys.length === 0) {
        return unavailable;
      }
      if (
        request.requiresEvidence &&
        !evidenceMatchesClaim_(
          request.claimType,
          evidenceKeys,
          evidenceDomains
        )
      ) {
        return unavailable;
      }
      return result_('ALLOW', null, evidenceKeys);
    }

    if (!isControlledCategory_(rawResult.category)) {
      return unavailable;
    }
    return result_('DENY', rawResult.category, evidenceKeys);
  }

  function result_(status, category, evidenceKeys) {
    if (STATUSES.indexOf(status) === -1) {
      status = 'GUARD_UNAVAILABLE';
      category = null;
      evidenceKeys = [];
    }
    return Object.freeze({
      status: status,
      category: category,
      evidenceKeys: Object.freeze(evidenceKeys.slice())
    });
  }

  function normalizeKnownEvidenceKeys_(value) {
    if (!Array.isArray(value) || value.length > 50) {
      return null;
    }
    var seen = Object.create(null);
    var normalized = [];
    for (var index = 0; index < value.length; index += 1) {
      if (
        typeof value[index] !== 'string' ||
        value[index] !== value[index].trim() ||
        !/^[A-Za-z0-9._:-]{1,80}$/.test(value[index])
      ) {
        return null;
      }
      var item = value[index];
      if (
        Object.prototype.hasOwnProperty.call(seen, item)
      ) {
        return null;
      }
      seen[item] = true;
      normalized.push(item);
    }
    normalized.sort();
    return normalized;
  }

  function normalizeVerdictEvidenceKeys_(value) {
    if (!Array.isArray(value) || value.length > 50) {
      return null;
    }
    var seen = Object.create(null);
    var normalized = [];
    for (var index = 0; index < value.length; index += 1) {
      if (
        typeof value[index] !== 'string' ||
        value[index] !== value[index].trim() ||
        !/^[A-Za-z0-9._:-]{1,80}$/.test(value[index]) ||
        Object.prototype.hasOwnProperty.call(seen, value[index])
      ) {
        return null;
      }
      seen[value[index]] = true;
      normalized.push(value[index]);
    }
    normalized.sort();
    return normalized;
  }

  function allKnown_(evidenceKeys, knownEvidenceKeys) {
    var known = Object.create(null);
    knownEvidenceKeys.forEach(function(key) {
      known[key] = true;
    });
    return evidenceKeys.every(function(key) {
      return Object.prototype.hasOwnProperty.call(known, key);
    });
  }

  function indexEvidenceDomains_(evidenceView, knownEvidenceKeys) {
    if (
      !Array.isArray(knownEvidenceKeys) ||
      !Array.isArray(evidenceView) ||
      evidenceView.length !== knownEvidenceKeys.length ||
      evidenceView.length > 50
    ) {
      return null;
    }
    var known = Object.create(null);
    knownEvidenceKeys.forEach(function(key) {
      known[key] = true;
    });
    var domains = Object.create(null);
    for (var index = 0; index < evidenceView.length; index += 1) {
      var entry = evidenceView[index];
      if (
        !hasExactKeys_(entry, ['key', 'domain', 'value']) ||
        typeof entry.key !== 'string' ||
        !Object.prototype.hasOwnProperty.call(known, entry.key) ||
        Object.prototype.hasOwnProperty.call(domains, entry.key) ||
        EVIDENCE_DOMAINS.indexOf(entry.domain) === -1
      ) {
        return null;
      }
      domains[entry.key] = entry.domain;
    }
    return domains;
  }

  function evidenceMatchesClaim_(claimType, evidenceKeys, evidenceDomains) {
    var allowed = CLAIM_EVIDENCE_DOMAINS[claimType];
    if (!allowed) {
      return false;
    }
    return evidenceKeys.every(function(key) {
      return allowed.indexOf(evidenceDomains[key]) !== -1;
    });
  }

  function isControlledCategory_(value) {
    return typeof value === 'string' &&
      APP_CONSTANTS.CHARACTER.GUARD_CATEGORIES.indexOf(value) !== -1;
  }

  function hasExactKeys_(value, expectedKeys) {
    if (!isPlainObject_(value)) {
      return false;
    }
    var actualKeys = Object.keys(value);
    return actualKeys.length === expectedKeys.length && expectedKeys.every(function(key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    });
  }

  function isPlainObject_(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  return Object.freeze({
    evaluate: evaluate
  });
})();

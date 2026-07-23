var CharacterMetricsService = (function() {
  var DIMENSION_KEYS = Object.freeze([
    'dayBucket',
    'timeBucket',
    'surface',
    'category',
    'action',
    'policyVersion',
    'catalogVersion',
    'characterPackId',
    'characterPackVersion',
    'profileSchemaVersion',
    'source'
  ]);
  function record(name, dimensions, emitFn) {
    if (APP_CONSTANTS.CHARACTER.METRIC_NAMES.indexOf(name) === -1) {
      fail_('METRIC_NAME_INVALID');
    }
    if (typeof emitFn !== 'function') {
      fail_('METRIC_EMITTER_INVALID');
    }
    var normalized = normalizeDimensions_(dimensions == null ? {} : dimensions);
    try {
      return emitFn(name, normalized);
    } catch (error) {
      throw createAppError(
        'UNKNOWN',
        'Character metric emission failed.',
        { reason: 'METRIC_EMITTER_FAILED' }
      );
    }
  }

  function normalizeDimensions_(dimensions) {
    if (!isPlainObject_(dimensions)) {
      fail_('METRIC_DIMENSIONS_INVALID');
    }
    var normalized = {};
    Object.keys(dimensions).forEach(function(key) {
      if (DIMENSION_KEYS.indexOf(key) === -1) {
        fail_('METRIC_DIMENSION_FORBIDDEN');
      }
      var value = dimensions[key];
      if (key === 'category' && value == null) {
        return;
      }
      if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (key === 'dayBucket' && !isDayBucket_(value)) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (key === 'timeBucket' && !isTimeBucket_(value)) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (key === 'surface' && APP_CONSTANTS.CHARACTER.OUTPUT_SURFACES.indexOf(value) === -1) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (key === 'category' && APP_CONSTANTS.CHARACTER.GUARD_CATEGORIES.indexOf(value) === -1) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (key === 'action' && APP_CONSTANTS.CHARACTER.GUARD_STATUSES.indexOf(value) === -1) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (
        key === 'policyVersion' &&
        value !== APP_CONSTANTS.CHARACTER.POLICY_VERSION
      ) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (
        key === 'catalogVersion' &&
        value !== APP_CONSTANTS.CHARACTER.CATALOG_VERSION
      ) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (
        key === 'profileSchemaVersion' &&
        value !== APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION
      ) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (
        key === 'characterPackId' &&
        (
          typeof CharacterPackService === 'undefined' ||
          CharacterPackService.getActive().packId !== value
        )
      ) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (
        key === 'characterPackVersion' &&
        (
          typeof CharacterPackService === 'undefined' ||
          CharacterPackService.getActive().packVersion !== value
        )
      ) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      if (key === 'source' && APP_CONSTANTS.CHARACTER.ARTIFACT_SOURCES.indexOf(value) === -1) {
        fail_('METRIC_DIMENSION_VALUE_INVALID');
      }
      normalized[key] = value;
    });
    return deepFreeze_(normalized);
  }

  function isDayBucket_(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      return false;
    }
    var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1]) &&
      date.getUTCMonth() === Number(match[2]) - 1 &&
      date.getUTCDate() === Number(match[3]);
  }

  function isTimeBucket_(value) {
    var match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3])$/.exec(value);
    return Boolean(match && isDayBucket_(match[1]));
  }

  function isPlainObject_(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
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
      'VALIDATION_REQUEST_INVALID',
      'Character metric data is invalid.',
      { reason: reason }
    );
  }

  return {
    record: record
  };
})();

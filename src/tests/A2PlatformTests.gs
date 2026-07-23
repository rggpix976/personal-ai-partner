function runA2PlatformTests() {
  var results = {
    passes: [],
    failures: []
  };

  function pass(name) {
    results.passes.push(name);
  }

  function fail(name, error) {
    results.failures.push({
      name: name,
      message: error && error.message ? error.message : String(error)
    });
  }

  function test(name, callback) {
    try {
      callback();
      pass(name);
    } catch (error) {
      fail(name, error);
    }
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed.');
    }
  }

  function expectThrows(name, callback, expectedCode) {
    test(name, function() {
      var thrown = null;
      try {
        callback();
      } catch (error) {
        thrown = error;
      }
      assert(thrown != null, 'Expected callback to throw.');
      if (expectedCode) {
        assert(thrown.code === expectedCode, 'Expected code ' + expectedCode + ' but got ' + thrown.code);
      }
    });
  }

  test('validators uuid v4', function() {
    assert(Validators.isUuidV4('11111111-1111-4111-8111-111111111111'), 'UUID should validate.');
    assert(!Validators.isUuidV4('11111111-1111-3111-8111-111111111111'), 'UUID v3 should not validate.');
  });

  test('validators config parsing', function() {
    assert(Validators.parseConfigValue('int', '42') === 42, 'int parse failed');
    assert(Validators.parseConfigValue('float', '1.5') === 1.5, 'float parse failed');
    assert(Validators.parseConfigValue('bool', 'true') === true, 'bool parse failed');
    assert(Validators.parseConfigValue('time', '08:05') === '08:05', 'time parse failed');
    assert(Validators.parseConfigValue('json', '{"ok":true}').ok === true, 'json parse failed');
  });

  expectThrows('validators config invalid bool', function() {
    Validators.parseConfigValue('bool', 'yes');
  }, 'CONFIG_MISSING');

  test('json parse success', function() {
    assert(JsonUtil.parse('{"a":1}').a === 1, 'JSON parse should succeed.');
  });

  expectThrows('json parse failure', function() {
    JsonUtil.parse('{bad');
  }, 'STORAGE_DATA_CORRUPTED');

  test('retry policy common backoff', function() {
    var now = new Date('2026-07-06T10:00:00+09:00');
    var decision = RetryPolicy.getRetryDecision(
      createAppError('GEMINI_RATE_LIMIT', 'Rate limited.'),
      3,
      now
    );
    assert(decision.action === 'RETRY_WAIT', 'Expected retry wait.');
    assert(toIsoStringInTokyo(decision.nextAttemptAt) === '2026-07-06T10:30:00+09:00', 'Expected 30 minute backoff.');
  });

  test('retry policy mail quota', function() {
    var now = new Date('2026-07-06T10:00:00+09:00');
    var decision = RetryPolicy.getRetryDecision(
      createAppError('MAIL_QUOTA_EXHAUSTED', 'Quota exhausted.'),
      1,
      now,
      { eventType: 'PROACTIVE_SEND', payload: { targetDate: '2026-07-07' } }
    );
    assert(decision.action === 'RETRY_WAIT', 'Expected next daily window.');
    assert(toIsoStringInTokyo(decision.nextAttemptAt) === '2026-07-07T08:05:00+09:00', 'Expected daily retry window.');
  });

  test('sheet schema validation', function() {
    Validators.validateSheetSchema('config', ['key', 'value', 'type', 'description', 'updated_at']);
  });

  test('iso date comparisons use time order', function() {
    assert(compareIsoDatesAscending('2026-07-06T09:00:00+09:00', '2026-07-06T10:00:00+09:00') < 0, 'Ascending compare should use time order.');
    assert(compareIsoDatesDescending('2026-07-06T10:00:00+09:00', '2026-07-06T09:00:00+09:00') < 0, 'Descending compare should use time order.');
    assert(getIsoTimeMillis('2026-07-06T10:00:00+09:00') > getIsoTimeMillis('2026-07-06T09:00:00+09:00'), 'Millis helper should parse ISO timestamps.');
  });

  expectThrows('sheet schema validation failure', function() {
    Validators.validateSheetSchema('config', ['value', 'key', 'type', 'description', 'updated_at']);
  }, 'STORAGE_DATA_CORRUPTED');

  test('log masking', function() {
    var masked = AppLogger.mask(
      'Authorization: Bearer token123 ' +
      'x-goog-api-key: demo-key ' +
      'owner@example.com ' +
      'requestId=11111111-1111-4111-8111-111111111111 ' +
      'messageId=22222222-2222-4222-8222-222222222222 ' +
      'fileId=1AbCdEfGhIjKlMnOpQrStUvWxYz123456 ' +
      'base64=data:image/png;base64,Zm9vYmFyYmF6cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4'
    );
    assert(masked.indexOf('Bearer token123') === -1, 'Authorization token should be masked.');
    assert(masked.indexOf('demo-key') === -1, 'Header API key should be masked.');
    assert(masked.indexOf('owner@example.com') === -1, 'Owner email should be masked.');
    assert(masked.indexOf('11111111-1111-4111-8111-111111111111') !== -1, 'requestId should remain visible.');
    assert(masked.indexOf('22222222-2222-4222-8222-222222222222') !== -1, 'messageId should remain visible.');
    assert(masked.indexOf('[REDACTED_DRIVE_ID:3456]') !== -1, 'Drive ID should keep suffix.');
    assert(masked.indexOf('[REDACTED_BASE64]') !== -1, 'Base64 should be masked.');
    assert(
      AppLogger.mask(null) === null,
      'Null log values should remain null.'
    );
  });

  test('debug log payload builder', function() {
    var payload = AppLogger.buildPayload(
      'INFO',
      'testOperation',
      'ok',
      { fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz123456' },
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444'
    );
    assert(payload.correlationId === '33333333-3333-4333-8333-333333333333', 'correlationId should be preserved.');
    assert(payload.eventId === '44444444-4444-4444-8444-444444444444', 'eventId should be preserved.');
    assert(String(payload.details).indexOf('[REDACTED_DRIVE_ID:3456]') !== -1, 'Drive ID in details should be masked.');
  });

  test('sheet repository selects recent completed diary summaries', function() {
    var rows = [{
      summary_date: '2026-07-01',
      diary_status: 'DONE',
      summary_text: 'Old completed diary.'
    }, {
      summary_date: '2026-07-03',
      diary_status: 'DONE',
      summary_text: 'Most recent completed diary.'
    }, {
      summary_date: '2026-07-02',
      diary_status: 'PENDING',
      summary_text: 'Pending diary.'
    }, {
      summary_date: '2026-07-04',
      diary_status: 'DONE',
      summary_text: 'Target-date diary.'
    }, {
      summary_date: '2026-06-30',
      diary_status: 'DONE',
      summary_text: '   '
    }];

    var selected = SheetRepository.__test.selectRecentDiarySummariesBefore(
      rows,
      '2026-07-04',
      2
    );

    assert(selected.length === 2, 'Only two eligible summaries should be returned.');
    assert(selected[0].summary_date === '2026-07-03', 'Newest eligible summary should be first.');
    assert(selected[1].summary_date === '2026-07-01', 'Older eligible summary should be second.');
    assert(
      SheetRepository.__test.selectRecentDiarySummariesBefore(rows, '2026-07-04', 0).length === 0,
      'Non-positive limits should return no summaries.'
    );
  });
  test('config default metadata validation', function() {
    APP_CONSTANTS.CONFIG_DEFAULTS.forEach(function(entry) {
      Validators.validateConfigEntry(entry);
    });
  });

  test('character foundation defaults are legacy and structurally valid', function() {
    assert(APP_CONSTANTS.SCHEMA_VERSION === '2026.07.a2', 'Dormant config must not force a deployment version split.');
    var entries = {};
    APP_CONSTANTS.CONFIG_DEFAULTS.forEach(function(entry) {
      entries[entry.key] = entry;
    });
    assert(entries.CHARACTER_RUNTIME_MODE.value === 'legacy', 'Runtime must default to legacy.');
    assert(entries.CHARACTER_RUNTIME_MODE.type === 'string', 'Runtime mode type is invalid.');
    assert(entries.CHARACTER_PROFILE_MODE.value === 'legacy', 'Profile must default to legacy.');
    assert(entries.CHARACTER_PROFILE_V1.type === 'json', 'Profile config type is invalid.');
    assert(
      entries.CHARACTER_PROFILE_V1.value === APP_CONSTANTS.CHARACTER.DEFAULT_PROFILE_V1_JSON,
      'Dormant v1 profile default and canonical fixture must stay identical.'
    );
    assert(
      CharacterProfileService.validateV1(entries.CHARACTER_PROFILE_V1.value).valid,
      'Dormant v1 profile should validate.'
    );
    assert(entries.CHARACTER_PROFILE_REVISION.value === '0', 'Revision must start at zero.');
    assert(entries.CHARACTER_PROFILE_REVISION.type === 'int', 'Revision type is invalid.');
    assert(entries.CHARACTER_PROFILE_V2.type === 'json', 'V2 profile config type is invalid.');
    assert(
      entries.CHARACTER_PROFILE_V2.value === APP_CONSTANTS.CHARACTER.DEFAULT_PROFILE_JSON,
      'Active profile default and canonical fixture must stay identical.'
    );
    assert(
      CharacterProfileService.validateV2(entries.CHARACTER_PROFILE_V2.value).valid,
      'Default v2 profile should validate.'
    );
    assert(
      entries.CHARACTER_PROFILE_V2_REVISION.value === '0',
      'V2 revision must start at zero.'
    );
    assert(
      entries.CHARACTER_PROFILE_V2_REVISION.type === 'int',
      'V2 revision type is invalid.'
    );
    assert(entries.PROACTIVE_FREQUENCY.value === 'normal', 'Frequency must default to normal.');
    assert(
      /^character-policy\.v\d+$/.test(APP_CONSTANTS.CHARACTER.POLICY_VERSION),
      'Policy version is invalid.'
    );
    assert(
      /^character-catalog\.v\d+$/.test(APP_CONSTANTS.CHARACTER.CATALOG_VERSION),
      'Catalog version is invalid.'
    );
  });

  return results;
}

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

  expectThrows('sheet schema validation failure', function() {
    Validators.validateSheetSchema('config', ['value', 'key', 'type', 'description', 'updated_at']);
  }, 'STORAGE_DATA_CORRUPTED');

  test('log masking', function() {
    var masked = AppLogger.mask('Authorization: Bearer token123 x-goog-api-key: demo-key owner@example.com Zm9vYmFyYmF6cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4cXV4');
    assert(masked.indexOf('Bearer token123') === -1, 'Authorization token should be masked.');
    assert(masked.indexOf('demo-key') === -1, 'Header API key should be masked.');
  });

  test('config default metadata validation', function() {
    APP_CONSTANTS.CONFIG_DEFAULTS.forEach(function(entry) {
      Validators.validateConfigEntry(entry);
    });
  });

  return results;
}

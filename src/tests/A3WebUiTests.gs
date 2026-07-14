function runA3WebUiTests() {
  var results = {
    passes: [],
    failures: []
  };

  function test(name, callback) {
    try {
      callback();
      results.passes.push(name);
    } catch (error) {
      results.failures.push({
        name: name,
        message: error && error.message ? error.message : String(error)
      });
    }
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed.');
    }
  }


  function withOverrides(overrides, callback) {
    var originalValues = {};
    Object.keys(overrides).forEach(function(key) {
      originalValues[key] = this[key];
      this[key] = overrides[key];
    }, this);
    try {
      callback();
    } finally {
      Object.keys(overrides).forEach(function(key) {
        this[key] = originalValues[key];
      }, this);
    }
  }

  test('web controller exposes global wrappers', function() {
    assert(typeof doGet === 'function', 'doGet should exist.');
    assert(typeof getInitialState === 'function', 'getInitialState should exist.');
    assert(typeof loadMessages === 'function', 'loadMessages should exist.');
    assert(typeof loadNewMessages === 'function', 'loadNewMessages should exist.');
    assert(typeof sendChat === 'function', 'sendChat should exist.');
    assert(typeof getRequestStatus === 'function', 'getRequestStatus should exist.');
  });

  test('web controller safe bootstrap json escaping', function() {
    var escaped = WebController.__test.toSafeInlineJson({
      text: '</script><b>unsafe</b>'
    });
    assert(escaped.indexOf('</script>') === -1, 'Inline JSON must escape closing script tags.');
    assert(escaped.indexOf('\\u003c') !== -1, 'Inline JSON should escape angle brackets.');
  });

  test('web controller computes pending retry seconds', function() {
    var now = new Date();
    var future = new Date(now.getTime() + 9000);
    var seconds = WebController.__test.computeRetryAfterSeconds({
      nextAttemptAt: future.toISOString()
    });
    assert(seconds >= 1, 'Retry delay should be positive.');
  });

  test('web controller clamps proactive background polling interval', function() {
    assert(
      WebController.__test.normalizePollSeconds(1) === 15,
      'Polling must not run more often than every 15 seconds.'
    );
    assert(
      WebController.__test.normalizePollSeconds(60) === 60,
      'Configured polling interval should be preserved.'
    );
    assert(
      WebController.__test.normalizePollSeconds(999) === 300,
      'Polling interval must be capped at 300 seconds.'
    );
  });

  test('web controller returns new messages after the cursor', function() {
    withOverrides({
      SheetRepository: {
        listMessagesAfter: function(messageId, limit) {
          assert(
            messageId === '11111111-1111-4111-8111-111111111111',
            'The cursor must be passed to the repository.'
          );
          assert(limit === 3, 'The controller must request one look-ahead row.');
          return [{
            messageId: '22222222-2222-4222-8222-222222222222',
            createdAt: '2026-07-14T10:00:00+09:00',
            role: 'system',
            messageType: 'proactive',
            text: 'First'
          }, {
            messageId: '33333333-3333-4333-8333-333333333333',
            createdAt: '2026-07-14T10:01:00+09:00',
            role: 'assistant',
            messageType: 'text',
            text: 'Second'
          }, {
            messageId: '44444444-4444-4444-8444-444444444444',
            createdAt: '2026-07-14T10:02:00+09:00',
            role: 'system',
            messageType: 'proactive',
            text: 'Look-ahead'
          }];
        }
      }
    }, function() {
      var result = WebController.__test.listNewMessagePage(
        '11111111-1111-4111-8111-111111111111',
        2
      );
      assert(result.messages.length === 2, 'The requested page size must be respected.');
      assert(result.hasMore === true, 'Look-ahead rows must set hasMore.');
      assert(
        result.nextAfterMessageId ===
          '33333333-3333-4333-8333-333333333333',
        'The next cursor must be the last returned message.'
      );
    });
  });

  return results;
}

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

  test('web controller exposes global wrappers', function() {
    assert(typeof doGet === 'function', 'doGet should exist.');
    assert(typeof getInitialState === 'function', 'getInitialState should exist.');
    assert(typeof loadMessages === 'function', 'loadMessages should exist.');
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

  return results;
}

function runAllSelfTests() {
  var suiteNames = [
    'runA2PlatformTests',
    'runA3WebUiTests',
    'runA4ChatGeminiTests',
    'runA5MemoryDiaryTests',
    'runA6QueueSchedulerTests',
    'runA7StaticSelfTest',
    'runA7IntegrationSelfTest',
    'runA8ProactiveConversationTests',
    'runA9CharacterProfileTests'
  ];
  var summary = {
    ok: true,
    suites: [],
    totalPasses: 0,
    totalFailures: 0,
    checkedAt: toIsoStringInTokyo(new Date())
  };

  suiteNames.forEach(function(name) {
    var suite = runSelfTestSuiteByName_(name);
    summary.suites.push(suite);
    summary.totalPasses += suite.passes.length;
    summary.totalFailures += suite.failures.length;
    if (suite.failures.length > 0) {
      summary.ok = false;
    }
  });

  return summary;
}

function runSelfTestSuiteByName_(name) {
  var fn = null;
  if (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function') {
    fn = globalThis[name];
  }
  if (!fn && typeof this !== 'undefined' && typeof this[name] === 'function') {
    fn = this[name];
  }
  if (!fn) {
    return {
      name: name,
      skipped: true,
      passes: [],
      failures: [{
        name: name,
        message: 'Self-test suite is not defined.'
      }]
    };
  }

  try {
    var result = fn();
    return {
      name: name,
      skipped: false,
      passes: result && Array.isArray(result.passes) ? result.passes : [],
      failures: result && Array.isArray(result.failures) ? result.failures : []
    };
  } catch (error) {
    return {
      name: name,
      skipped: false,
      passes: [],
      failures: [{
        name: name,
        message: error && error.message ? error.message : String(error)
      }]
    };
  }
}

function runAllSelfTestsAndLog() {
  var summary = runAllSelfTests();
  var report = {
    ok: summary.ok,
    totalPasses: summary.totalPasses,
    totalFailures: summary.totalFailures,
    checkedAt: summary.checkedAt,
    suites: summary.suites.map(function(suite) {
      return {
        name: suite.name,
        skipped: suite.skipped,
        passCount: suite.passes.length,
        failures: suite.failures
      };
    })
  };

  console.log('SELF_TEST_RESULT ' + JSON.stringify(report));

  if (!summary.ok) {
    throw new Error(
      'Self-tests failed: ' +
        summary.totalFailures +
        ' failure(s). See SELF_TEST_RESULT in the execution log.'
    );
  }

  return summary;
}

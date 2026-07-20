function runA7IntegrationSelfTest() {
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

  test('queue retry policy preserves mail quota daily deferral', function() {
    var decision = RetryPolicy.getRetryDecision(
      createAppError('MAIL_QUOTA_EXHAUSTED', 'quota exhausted'),
      1,
      new Date('2026-07-05T10:00:00+09:00'),
      {
        eventType: 'PROACTIVE_SEND',
        payload: {
          targetDate: '2026-07-05'
        }
      }
    );
    assert(decision.action === 'RETRY_WAIT' || decision.action === 'DONE', 'Mail quota must not use common short retry.');
    if (decision.action === 'RETRY_WAIT') {
      assert(
        toIsoStringInTokyo(decision.nextAttemptAt).indexOf('08:05:00+09:00') !== -1,
        'Mail quota retry should target the daily recovery window.'
      );
    }
  });

  test('queue dispatch dependencies are wired', function() {
    assert(typeof ChatService.processQueuedReply === 'function', 'Queued chat retry path is missing.');
    assert(typeof MemoryService.extract === 'function', 'Memory extraction dispatch target is missing.');
    assert(typeof DiaryService.generate === 'function', 'Diary generation dispatch target is missing.');
    assert(typeof ProactiveMessageService.send === 'function', 'Proactive send dispatch target is missing.');
    assert(typeof MaintenanceService.weeklyBackup === 'function', 'Weekly backup dispatch target is missing.');
  });

  test('scheduler dependencies are wired', function() {
    assert(typeof MemoryService.enqueueExtraction === 'function', 'Memory enqueue target is missing.');
    assert(typeof DiaryService.enqueue === 'function', 'Diary enqueue target is missing.');
    assert(typeof ProactiveMessageService.evaluateLocalConditions === 'function', 'Proactive evaluation target is missing.');
    assert(typeof QueueService.enqueue === 'function', 'Queue enqueue target is missing.');
    assert(typeof OperationalHealthService.run === 'function', 'Operational health target is missing.');
  });

  test('A7 local self-tests are non-live checks', function() {
    assert(typeof runA7StaticSelfTest === 'function', 'A7 static self-test is missing.');
    assert(typeof runA7IntegrationSelfTest === 'function', 'A7 integration self-test is missing.');
    assert(typeof runAllSelfTests === 'function', 'A7 aggregate test runner is missing.');
  });

  return results;
}

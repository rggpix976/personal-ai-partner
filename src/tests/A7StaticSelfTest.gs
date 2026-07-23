function runA7StaticSelfTest() {
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

  function hasFunction(objectName, functionName) {
    var obj = globalThis[objectName];
    return obj && typeof obj[functionName] === 'function';
  }

  test('public web API globals are present', function() {
    assert(typeof doGet === 'function', 'doGet is missing.');
    assert(typeof getInitialState === 'function', 'getInitialState is missing.');
    assert(typeof loadMessages === 'function', 'loadMessages is missing.');
    assert(typeof loadNewMessages === 'function', 'loadNewMessages is missing.');
    assert(typeof sendChat === 'function', 'sendChat is missing.');
    assert(typeof getRequestStatus === 'function', 'getRequestStatus is missing.');
  });

  test('operational job globals are present', function() {
    assert(typeof processQueueJob === 'function', 'processQueueJob is missing.');
    assert(typeof schedulerJob === 'function', 'schedulerJob is missing.');
    assert(typeof installTriggers === 'function', 'installTriggers is missing.');
    assert(typeof deleteProjectTriggers === 'function', 'deleteProjectTriggers is missing.');
    assert(typeof listProjectTriggers === 'function', 'listProjectTriggers is missing.');
    assert(typeof runOperationalHealthCheck === 'function', 'runOperationalHealthCheck is missing.');
    assert(typeof assessDeadQueueEvent === 'function', 'assessDeadQueueEvent is missing.');
    assert(typeof requeueDeadChatReply === 'function', 'requeueDeadChatReply is missing.');
    assert(typeof assessDeadDiaryGeneration === 'function', 'assessDeadDiaryGeneration is missing.');
    assert(typeof repairDeadDiaryGeneration === 'function', 'repairDeadDiaryGeneration is missing.');
    assert(typeof assessCompletedDiaryGeneration === 'function', 'assessCompletedDiaryGeneration is missing.');
    assert(typeof reconcileCompletedDiaryGeneration === 'function', 'reconcileCompletedDiaryGeneration is missing.');
    assert(typeof repairDiaryGenerationBacklog === 'function', 'repairDiaryGenerationBacklog is missing.');
    assert(typeof resumeDiaryNarrativeLengthRetries === 'function', 'resumeDiaryNarrativeLengthRetries is missing.');
  });

  test('setup validation globals are present', function() {
    assert(typeof setup === 'function', 'setup is missing.');
    assert(typeof validatePreSetupProperties === 'function', 'validatePreSetupProperties is missing.');
    assert(typeof validatePostSetupProperties === 'function', 'validatePostSetupProperties is missing.');
    assert(typeof validatePostDeployProperties === 'function', 'validatePostDeployProperties is missing.');
  });

  test('A1 event constants are present', function() {
    var eventTypes = APP_CONSTANTS.EVENT_TYPES;
    var statuses = APP_CONSTANTS.EVENT_STATUSES;
    ['CHAT_REPLY', 'MEMORY_EXTRACT', 'DIARY_GENERATE', 'PROACTIVE_SEND', 'WEEKLY_BACKUP'].forEach(function(type) {
      assert(eventTypes.indexOf(type) !== -1, 'Missing event type: ' + type);
    });
    ['PENDING', 'PROCESSING', 'RETRY_WAIT', 'DONE', 'DEAD'].forEach(function(status) {
      assert(statuses.indexOf(status) !== -1, 'Missing event status: ' + status);
    });
  });

  test('core services expose A1 methods', function() {
    assert(hasFunction('QueueService', 'enqueue'), 'QueueService.enqueue is missing.');
    assert(hasFunction('QueueService', 'claimBatch'), 'QueueService.claimBatch is missing.');
    assert(hasFunction('QueueService', 'markDone'), 'QueueService.markDone is missing.');
    assert(hasFunction('QueueService', 'markRetry'), 'QueueService.markRetry is missing.');
    assert(hasFunction('QueueService', 'markDead'), 'QueueService.markDead is missing.');
    assert(hasFunction('QueueService', 'recoverStale'), 'QueueService.recoverStale is missing.');
    assert(hasFunction('QueueService', 'expediteDiaryNarrativeLengthRetries'), 'QueueService.expediteDiaryNarrativeLengthRetries is missing.');
    assert(hasFunction('QueueService', 'requeueDeadAsNewEvent'), 'QueueService.requeueDeadAsNewEvent is missing.');
    assert(hasFunction('QueueService', 'requeueDeadDiaryAsNewEvent'), 'QueueService.requeueDeadDiaryAsNewEvent is missing.');
    assert(hasFunction('QueueService', 'assessDeadEventRecovery'), 'QueueService.assessDeadEventRecovery is missing.');
    assert(hasFunction('OperationalHealthService', 'inspect'), 'OperationalHealthService.inspect is missing.');
    assert(hasFunction('OperationalHealthService', 'run'), 'OperationalHealthService.run is missing.');
    assert(hasFunction('MemoryService', 'extract'), 'MemoryService.extract is missing.');
    assert(hasFunction('MemoryService', 'findRelevant'), 'MemoryService.findRelevant is missing.');
    assert(hasFunction('DiaryService', 'generate'), 'DiaryService.generate is missing.');
    assert(hasFunction('DiaryService', 'getLifecycleState'), 'DiaryService.getLifecycleState is missing.');
    assert(hasFunction('DiaryService', 'markFailed'), 'DiaryService.markFailed is missing.');
    assert(hasFunction('DiaryService', 'assessDeadGeneration'), 'DiaryService.assessDeadGeneration is missing.');
    assert(hasFunction('DiaryService', 'repairDeadGeneration'), 'DiaryService.repairDeadGeneration is missing.');
    assert(hasFunction('DiaryService', 'assessCompletedGeneration'), 'DiaryService.assessCompletedGeneration is missing.');
    assert(hasFunction('DiaryService', 'reconcileCompletedGeneration'), 'DiaryService.reconcileCompletedGeneration is missing.');
    assert(hasFunction('DiaryService', 'repairGenerationBacklog'), 'DiaryService.repairGenerationBacklog is missing.');
    assert(hasFunction('ProactiveMessageService', 'evaluateLocalConditions'), 'ProactiveMessageService.evaluateLocalConditions is missing.');
    assert(hasFunction('ProactiveMessageService', 'send'), 'ProactiveMessageService.send is missing.');
    assert(hasFunction('CharacterProfileService', 'validateV1'), 'CharacterProfileService.validateV1 is missing.');
    assert(hasFunction('CharacterProfileService', 'validateV2'), 'CharacterProfileService.validateV2 is missing.');
    assert(hasFunction('CharacterProfileService', 'readV2'), 'CharacterProfileService.readV2 is missing.');
    assert(hasFunction('CharacterProfileService', 'inspectRuntime'), 'CharacterProfileService.inspectRuntime is missing.');
    assert(hasFunction('CharacterProfileService', 'requireActive'), 'CharacterProfileService.requireActive is missing.');
    assert(hasFunction('CharacterProfileService', 'saveV1'), 'CharacterProfileService.saveV1 is missing.');
    assert(hasFunction('CharacterProfileService', 'saveV2'), 'CharacterProfileService.saveV2 is missing.');
    assert(hasFunction('CharacterPackService', 'getActive'), 'CharacterPackService.getActive is missing.');
    assert(hasFunction('CharacterPackService', 'getPromptView'), 'CharacterPackService.getPromptView is missing.');
    assert(hasFunction('CharacterPackService', 'assertActiveBinding'), 'CharacterPackService.assertActiveBinding is missing.');
    assert(hasFunction('CharacterContextService', 'buildActive'), 'CharacterContextService.buildActive is missing.');
    assert(hasFunction('CharacterContextService', 'withConversationMode'), 'CharacterContextService.withConversationMode is missing.');
  });

  test('infrastructure service boundaries are present', function() {
    assert(hasFunction('GeminiClient', 'generateText'), 'GeminiClient.generateText is missing.');
    assert(hasFunction('GeminiClient', 'generateWithImage'), 'GeminiClient.generateWithImage is missing.');
    assert(hasFunction('GeminiClient', 'generateStructured'), 'GeminiClient.generateStructured is missing.');
    assert(hasFunction('GmailNotifier', 'send'), 'GmailNotifier.send is missing.');
    assert(hasFunction('GmailNotifier', 'getRemainingQuota'), 'GmailNotifier.getRemainingQuota is missing.');
    assert(hasFunction('SheetRepository', 'insertEvent'), 'SheetRepository.insertEvent is missing.');
    assert(hasFunction('DriveTempRepository', 'cleanupExpiredTempImages'), 'DriveTempRepository.cleanupExpiredTempImages is missing.');
    assert(hasFunction('DocumentRepository', 'appendDiaryEntry'), 'DocumentRepository.appendDiaryEntry is missing.');
    assert(hasFunction('DocumentRepository', 'countDiaryEntryAnchors'), 'DocumentRepository.countDiaryEntryAnchors is missing.');
    assert(hasFunction('CharacterConfigRepository', 'readSnapshot'), 'CharacterConfigRepository.readSnapshot is missing.');
    assert(hasFunction('CharacterConfigRepository', 'saveProfileAtomically'), 'CharacterConfigRepository.saveProfileAtomically is missing.');
  });

  return results;
}

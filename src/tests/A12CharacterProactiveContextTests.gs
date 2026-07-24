function runA12CharacterProactiveContextTests() {
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
        message: error && error.message
          ? error.message
          : String(error)
      });
    }
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed.');
    }
  }

  function withGlobals(overrides, callback) {
    var originals = {};
    Object.keys(overrides).forEach(function(name) {
      originals[name] = globalThis[name];
      globalThis[name] = overrides[name];
    });
    try {
      return callback();
    } finally {
      Object.keys(overrides).forEach(function(name) {
        globalThis[name] = originals[name];
      });
    }
  }

  function chatApproval(surface) {
    return {
      surface: surface || 'CHAT_TEXT_SYNC',
      source: 'generated',
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      profileSchemaVersion:
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 4,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: CharacterPackService.getActive().packId,
      characterPackVersion:
        CharacterPackService.getActive().packVersion
    };
  }

  test('proactive context keeps only user and approved completed assistant history', function() {
    var captured = null;
    var messages = [{
      messageId: '11111111-1111-4111-8111-111111111111',
      requestId: '21111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-24T12:07:00+09:00',
      role: 'system',
      messageType: 'proactive',
      text: 'delivery marker must not enter context',
      status: 'completed',
      characterApproval: chatApproval()
    }, {
      messageId: '12222222-2222-4222-8222-222222222222',
      requestId: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-07-24T12:06:00+09:00',
      role: 'assistant',
      messageType: 'text',
      text: 'approved assistant',
      status: 'completed',
      model: 'private-model-name',
      characterApproval: chatApproval('CHAT_TEXT_QUEUED')
    }, {
      messageId: '13333333-3333-4333-8333-333333333333',
      createdAt: '2026-07-24T12:05:00+09:00',
      role: 'assistant',
      messageType: 'text',
      text: 'legacy unapproved assistant',
      status: 'completed',
      characterApproval: null
    }, {
      messageId: '14444444-4444-4444-8444-444444444444',
      createdAt: '2026-07-24T12:04:00+09:00',
      role: 'assistant',
      messageType: 'text',
      text: 'not completed assistant',
      status: 'accepted',
      characterApproval: chatApproval()
    }, {
      messageId: '15555555-5555-4555-8555-555555555555',
      createdAt: '2026-07-24T12:03:00+09:00',
      role: 'user',
      messageType: 'image',
      text: 'user image',
      status: 'accepted',
      image: {
        name: 'private-file-name.png',
        mimeType: 'image/png',
        summary: 'a supplied garden image'
      },
      characterApproval: chatApproval('CHAT_IMAGE')
    }, {
      messageId: '16666666-6666-4666-8666-666666666666',
      createdAt: '2026-07-24T12:02:00+09:00',
      role: 'system',
      messageType: 'error',
      text: 'internal queue error',
      status: 'failed'
    }, {
      messageId: '17777777-7777-4777-8777-777777777777',
      createdAt: '2026-07-24T12:01:00+09:00',
      role: 'user',
      messageType: 'text',
      text: 'older user message',
      status: 'accepted'
    }];

    withGlobals({
      CharacterContextService: {
        buildActive: function(input) {
          captured = input;
          return {
            issued: true,
            input: input
          };
        }
      },
      SheetRepository: {
        listRecentMessages: function(limit) {
          assert(limit === 12, 'History query limit was not bounded.');
          return messages;
        }
      },
      ConfigRepository: {
        getByKey: function(key) {
          assert(key === 'RECENT_MESSAGE_LIMIT', 'Unexpected config read.');
          return { value: 4 };
        }
      }
    }, function() {
      var result = CharacterProactiveContextService.build({
        currentTime: '2026-07-24T12:10:00+09:00'
      });
      assert(result.issued === true, 'Context result was not returned.');
    });

    assert(captured.surface === 'proactive', 'Context scope must be proactive.');
    assert(captured.currentRequest === null, 'Proactive currentRequest must be null.');
    assert(captured.memories.length === 0, 'Legacy memory entered proactive context.');
    assert(captured.userFacts.length === 0, 'Unintegrated user facts must remain empty.');
    assert(captured.sharedFacts.length === 0, 'Unintegrated shared facts must remain empty.');
    assert(
      captured.realWorldObservations.length === 0,
      'Historical images must not become live observations.'
    );
    assert(
      captured.partnerWorld.mayCreate === false &&
        captured.partnerWorld.approvedFacts.length === 0,
      'Proactive context must not create Partner World facts.'
    );
    assert(
      captured.recentMessages.length === 3,
      'History filter retained an unapproved or operational row.'
    );
    assert(
      captured.recentMessages[0].text === 'older user message' &&
        captured.recentMessages[1].text === 'user image' &&
        captured.recentMessages[2].text === 'approved assistant',
      'Filtered proactive history is not chronological.'
    );
    assert(
      captured.recentMessages[1].summary ===
        'a supplied garden image',
      'User image summary was not retained as untrusted history.'
    );

    var serialized = JSON.stringify(captured.recentMessages);
    [
      '11111111-1111-4111-8111-111111111111',
      'private-model-name',
      'private-file-name.png',
      'delivery marker must not enter context',
      'legacy unapproved assistant',
      'not completed assistant',
      'internal queue error',
      '2026-07-24T12:01:00+09:00'
    ].forEach(function(forbidden) {
      assert(
        serialized.indexOf(forbidden) === -1,
        'Operational or unapproved history leaked: ' + forbidden
      );
    });
  });

  test('history normalization rejects every system row and unapproved assistant row', function() {
    var normalize =
      CharacterProactiveContextService.__test
        .normalizeHistoricalMessage;
    assert(
      normalize({
        role: 'system',
        messageType: 'proactive',
        text: 'partner-looking marker',
        status: 'completed',
        characterApproval: chatApproval()
      }) === null,
      'A proactive delivery marker entered history.'
    );
    assert(
      normalize({
        role: 'assistant',
        messageType: 'text',
        text: 'legacy assistant',
        status: 'completed',
        characterApproval: null
      }) === null,
      'An unapproved assistant row entered history.'
    );
    assert(
      normalize({
        role: 'assistant',
        messageType: 'text',
        text: 'pending assistant',
        status: 'accepted',
        characterApproval: chatApproval()
      }) === null,
      'A non-completed assistant row entered history.'
    );
    var approved = normalize({
      role: 'assistant',
      messageType: 'text',
      text: 'approved assistant',
      status: 'completed',
      characterApproval: chatApproval()
    });
    assert(
      approved &&
        approved.role === 'assistant' &&
        approved.text === 'approved assistant',
      'An approved completed assistant row was lost.'
    );
  });

  test('image summary requires CHAT_IMAGE approval for user and assistant rows', function() {
    var normalize =
      CharacterProactiveContextService.__test
        .normalizeHistoricalMessage;
    var unapprovedUser = normalize({
      role: 'user',
      messageType: 'image',
      text: 'user supplied an image',
      status: 'accepted',
      image: {
        summary: 'PRIVATE_UNAPPROVED_IMAGE_SUMMARY'
      },
      characterApproval: null
    });
    assert(
      unapprovedUser &&
        unapprovedUser.text === 'user supplied an image',
      'User-authored image turn was removed with its unapproved summary.'
    );
    assert(
      !Object.prototype.hasOwnProperty.call(
        unapprovedUser,
        'summary'
      ),
      'Unapproved user image summary entered proactive context.'
    );

    var wrongSurfaceUser = normalize({
      role: 'user',
      messageType: 'image',
      text: 'user supplied an image',
      status: 'accepted',
      image: {
        summary: 'PRIVATE_TEXT_APPROVED_USER_IMAGE_SUMMARY'
      },
      characterApproval: chatApproval('CHAT_TEXT_SYNC')
    });
    assert(
      wrongSurfaceUser &&
        !Object.prototype.hasOwnProperty.call(
          wrongSurfaceUser,
          'summary'
        ),
      'CHAT_TEXT approval authorized a user image summary.'
    );

    var approvedUser = normalize({
      role: 'user',
      messageType: 'image',
      text: 'user supplied an image',
      status: 'accepted',
      image: {
        summary: 'approved image summary'
      },
      characterApproval: chatApproval('CHAT_IMAGE')
    });
    assert(
      approvedUser.summary === 'approved image summary',
      'Approved user image summary was not retained.'
    );

    var wrongSurfaceAssistant = normalize({
      role: 'assistant',
      messageType: 'image',
      text: 'approved assistant image reply',
      status: 'completed',
      image: {
        summary: 'PRIVATE_TEXT_APPROVED_ASSISTANT_IMAGE_SUMMARY'
      },
      characterApproval: chatApproval('CHAT_TEXT_QUEUED')
    });
    assert(
      wrongSurfaceAssistant &&
        wrongSurfaceAssistant.text ===
          'approved assistant image reply' &&
        !Object.prototype.hasOwnProperty.call(
          wrongSurfaceAssistant,
          'summary'
        ),
      'CHAT_TEXT approval authorized an assistant image summary.'
    );

    var unapprovedAssistant = normalize({
      role: 'assistant',
      messageType: 'image',
      text: 'unapproved assistant image reply',
      status: 'completed',
      image: {
        summary: 'PRIVATE_UNAPPROVED_ASSISTANT_IMAGE_SUMMARY'
      },
      characterApproval: null
    });
    assert(
      unapprovedAssistant === null,
      'An unapproved assistant image row entered proactive context.'
    );

    var approvedAssistant = normalize({
      role: 'assistant',
      messageType: 'image',
      text: 'approved assistant image reply',
      status: 'completed',
      image: {
        summary: 'approved assistant image summary'
      },
      characterApproval: chatApproval('CHAT_IMAGE')
    });
    assert(
      approvedAssistant &&
        approvedAssistant.summary ===
          'approved assistant image summary',
      'CHAT_IMAGE-approved assistant summary was not retained.'
    );
  });

  test('proactive classification signals are fixed false values', function() {
    var asserted = null;
    withGlobals({
      CharacterContextService: {
        assertUnclassifiedActive: function(context, scope) {
          asserted = {
            context: context,
            scope: scope
          };
          return true;
        }
      }
    }, function() {
      var context = { issued: true };
      var signals =
        CharacterProactiveContextService.classificationSignals(
          context
        );
      assert(asserted.context === context, 'Context capability was not checked.');
      assert(asserted.scope === 'proactive', 'Wrong classification scope.');
      assert(
        signals.safetyRequired === false &&
          signals.adminRequest === false &&
          signals.capabilityUnavailable === false,
        'Prior conversation influenced proactive classification signals.'
      );
      assert(Object.isFrozen(signals), 'Signals must be immutable.');
    });
  });

  test('proactive runtime binding is exact frozen and detects drift', function() {
    var pack = CharacterPackService.getActive();
    var inspection = {
      state: 'ready',
      runtimeMode: 'enforced',
      profileSchemaVersion:
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 8,
      characterPackId: pack.packId,
      characterPackVersion: pack.packVersion
    };
    var binding =
      CharacterProactiveContextService.bindingFromInspection(
        inspection
      );
    assert(Object.isFrozen(binding), 'Binding must be frozen.');
    assert(binding.profileRevision === 8, 'Binding revision was lost.');

    CharacterProactiveContextService
      .assertBindingMatchesInspection(binding, inspection);

    var changed = {};
    Object.keys(inspection).forEach(function(key) {
      changed[key] = inspection[key];
    });
    changed.profileRevision = 9;
    var thrown = null;
    try {
      CharacterProactiveContextService
        .assertBindingMatchesInspection(binding, changed);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown && thrown.code === 'CHARACTER_CONFIG_CONFLICT',
      'Binding drift did not fail closed.'
    );
  });

  return results;
}

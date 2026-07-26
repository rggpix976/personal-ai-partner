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

  test('post-deploy validation accepts only the exact deployed Web App URL', function() {
    var url =
      'https://script.google.com/macros/s/AKfycbw_test-123/exec';
    assert(
      assertPostDeployWebAppUrl_(url, url) === true,
      'The exact deployed Web App URL should validate.'
    );
  });

  test('post-deploy validation normalizes the editor development URL', function() {
    assert(
      assertPostDeployWebAppUrl_(
        'https://script.google.com/macros/s/AKfycbw_test-123/exec',
        'https://script.google.com/macros/s/AKfycbw_test-123/dev'
      ) === true,
      'The same Web App development URL should validate in the editor.'
    );
  });

  expectThrows(
    'post-deploy validation rejects a library or unrelated exec URL',
    function() {
      assertPostDeployWebAppUrl_(
        'https://example.com/not-a-web-app/exec',
        'https://script.google.com/macros/s/AKfycbw_test-123/exec'
      );
    },
    'CONFIG_MISSING'
  );

  expectThrows(
    'post-deploy validation rejects a configured development URL',
    function() {
      assertPostDeployWebAppUrl_(
        'https://script.google.com/macros/s/AKfycbw_test-123/dev',
        'https://script.google.com/macros/s/AKfycbw_test-123/dev'
      );
    },
    'CONFIG_MISSING'
  );

  expectThrows(
    'post-deploy validation rejects a different deployed Web App URL',
    function() {
      assertPostDeployWebAppUrl_(
        'https://script.google.com/macros/s/AKfycbw_first/exec',
        'https://script.google.com/macros/s/AKfycbw_second/exec'
      );
    },
    'CONFIG_MISSING'
  );

  test('config lookup fails closed for duplicate primary keys', function() {
    var originalSheetRepository = SheetRepository;
    SheetRepository = {
      getRows: function() {
        return [
          {
            key: 'QUEUE_BATCH_SIZE',
            value: '3',
            type: 'int',
            description: 'first',
            updated_at: '2026-07-26T10:00:00+09:00'
          },
          {
            key: 'QUEUE_BATCH_SIZE',
            value: '9',
            type: 'int',
            description: 'duplicate',
            updated_at: '2026-07-26T10:01:00+09:00'
          }
        ];
      }
    };
    try {
      var thrown = null;
      try {
        ConfigRepository.getByKey('QUEUE_BATCH_SIZE');
      } catch (error) {
        thrown = error;
      }
      assert(
        thrown && thrown.code === 'STORAGE_DATA_CORRUPTED',
        'Duplicate config primary keys must stop runtime reads.'
      );
    } finally {
      SheetRepository = originalSheetRepository;
    }
  });

  test('conversation approval columns are an additive ordered schema block', function() {
    var schemaHeaders = getSheetSchema(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
      .map(function(column) {
        return column.name;
      });
    var approvalColumns = APP_CONSTANTS.CHARACTER.APPROVAL_COLUMNS;
    var approvalOffset = schemaHeaders.indexOf(approvalColumns[0]);
    assert(
      JSON.stringify(
        schemaHeaders.slice(
          approvalOffset,
          approvalOffset + approvalColumns.length
        )
      ) ===
        JSON.stringify(approvalColumns),
      'Character approval columns must remain one exact ordered block.'
    );
    assert(
      schemaHeaders[approvalOffset + approvalColumns.length] ===
        'proactive_subject',
      'Proactive subject must be the additive column after approval metadata.'
    );
    assert(
      schemaHeaders[approvalOffset + approvalColumns.length + 1] ===
        'proactive_origin_event_id',
      'Proactive origin event must follow the proactive subject.'
    );
    assert(
      SheetRepository.__test.assertCharacterApprovalHeaders(schemaHeaders) === true,
      'Current conversation_logs headers should support approved writes.'
    );
    assert(
      SheetRepository.__test.assertCharacterApprovalHeaders(
        schemaHeaders.concat(['future_additive_column'])
      ) === true,
      'Future trailing columns must not break rollback to the PR4 approval writer.'
    );
    assert(
      SheetRepository.__test.assertProactiveDeliveryHeaders(
        schemaHeaders
      ) === true,
      'Current conversation_logs headers should support proactive delivery.'
    );
    assert(
      SheetRepository.__test.assertProactiveDeliveryHeaders(
        schemaHeaders.concat(['future_additive_column'])
      ) === true,
      'Future trailing columns must preserve proactive delivery compatibility.'
    );
  });

  expectThrows(
    'proactive delivery columns reject a missing origin column',
    function() {
      var headers = getSheetSchema(
        APP_CONSTANTS.SHEETS.CONVERSATION_LOGS
      ).map(function(column) {
        return column.name;
      }).filter(function(name) {
        return name !== 'proactive_origin_event_id';
      });
      SheetRepository.__test.assertProactiveDeliveryHeaders(
        headers
      );
    },
    'STORAGE_DATA_CORRUPTED'
  );

  expectThrows(
    'proactive delivery columns reject reversed tail order',
    function() {
      var headers = getSheetSchema(
        APP_CONSTANTS.SHEETS.CONVERSATION_LOGS
      ).map(function(column) {
        return column.name;
      });
      var subjectIndex = headers.indexOf('proactive_subject');
      headers[subjectIndex] = 'proactive_origin_event_id';
      headers[subjectIndex + 1] = 'proactive_subject';
      SheetRepository.__test.assertProactiveDeliveryHeaders(
        headers
      );
    },
    'STORAGE_DATA_CORRUPTED'
  );

  test('conversation row writes tolerate future additive columns', function() {
    var originalPropertiesService = PropertiesService;
    var hadSpreadsheetApp = Object.prototype.hasOwnProperty.call(
      globalThis,
      'SpreadsheetApp'
    );
    var originalSpreadsheetApp = hadSpreadsheetApp
      ? globalThis.SpreadsheetApp
      : null;
    var headers = getSheetSchema(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
      .map(function(column) {
        return column.name;
      })
      .concat(['future_additive_column']);
    var rows = [headers.slice()];
    var sheet = {
      getLastColumn: function() {
        return headers.length;
      },
      getLastRow: function() {
        return rows.length;
      },
      getRange: function(row, column, rowCount, columnCount) {
        return {
          getValues: function() {
            var values = [];
            for (var rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
              var source = rows[row - 1 + rowOffset] || [];
              var resultRow = [];
              for (var columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
                var value = source[column - 1 + columnOffset];
                resultRow.push(value == null ? '' : value);
              }
              values.push(resultRow);
            }
            return values;
          },
          setValues: function(values) {
            for (var rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
              var targetIndex = row - 1 + rowOffset;
              if (!rows[targetIndex]) {
                rows[targetIndex] = [];
              }
              for (var columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
                rows[targetIndex][column - 1 + columnOffset] = values[rowOffset][columnOffset];
              }
            }
          }
        };
      }
    };
    PropertiesService = {
      getScriptProperties: function() {
        return {
          getProperty: function() {
            return 'test-spreadsheet';
          }
        };
      }
    };
    globalThis.SpreadsheetApp = {
      openById: function() {
        return {
          getSheetByName: function() {
            return sheet;
          }
        };
      }
    };
    try {
      SheetRepository.appendConversation({
        messageId: '11111111-1111-4111-8111-111111111111',
        requestId: '22222222-2222-4222-8222-222222222222',
        createdAt: '2026-07-24T09:00:00+09:00',
        role: 'assistant',
        messageType: 'text',
        text: 'before',
        status: 'completed'
      });
      SheetRepository.appendConversation({
        messageId: '10101010-1010-4010-8010-101010101010',
        requestId: '20202020-2020-4020-8020-202020202020',
        createdAt: '2026-07-24T09:00:30+09:00',
        role: 'user',
        messageType: 'text',
        text: '=HYPERLINK("https://example.invalid","unsafe")',
        status: 'accepted'
      });
      assert(
        rows[1][headers.length - 1] === '',
        'Append must leave an unknown future column empty.'
      );
      assert(
        rows[2][headers.indexOf('text')] ===
          '\'=HYPERLINK("https://example.invalid","unsafe")',
        'Formula-like conversation text must be written as a literal string.'
      );

      rows[1][headers.length - 1] = 'future-value';
      var updated = SheetRepository.updateConversationMessage(
        '11111111-1111-4111-8111-111111111111',
        { text: 'after' }
      );
      assert(updated.text === 'after', 'Update must still return the known-column change.');
      assert(
        rows[1][headers.indexOf('text')] === 'after',
        'Update must still write known columns.'
      );
      assert(
        rows[1][headers.length - 1] === 'future-value',
        'Update must preserve an unknown future cell.'
      );

      var imageRequestId = '55555555-5555-4555-8555-555555555555';
      var imageMessageId = '66666666-6666-4666-8666-666666666666';
      var firstApproval = {
        surface: 'CHAT_IMAGE',
        source: 'generated',
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        profileRevision: 3,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: 'warm-kansai-caretaker',
        characterPackVersion: 'warm-kansai-caretaker.v1'
      };
      var forgedApproval = JSON.parse(JSON.stringify(firstApproval));
      forgedApproval.surface = 'CHAT_TEXT_SYNC';
      var forgedApprovalError = null;
      try {
        SheetRepository.updateConversationMessage(
          '11111111-1111-4111-8111-111111111111',
          {
            text: 'after',
            characterApproval: forgedApproval
          }
        );
      } catch (error) {
        forgedApprovalError = error;
      }
      assert(
        forgedApprovalError &&
          forgedApprovalError.code === 'STORAGE_DATA_CORRUPTED',
        'Approval metadata must not be attached to an arbitrary stored row.'
      );
      SheetRepository.appendConversation({
        messageId: imageMessageId,
        requestId: imageRequestId,
        createdAt: '2026-07-24T09:01:00+09:00',
        role: 'user',
        messageType: 'image',
        text: 'これ見て',
        image: {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          summary: 'upload'
        },
        status: 'accepted'
      });
      SheetRepository.updateConversationMessage(imageMessageId, {
        image: {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          summary: 'first approved summary'
        },
        characterApproval: firstApproval
      });
      var replacementApproval = JSON.parse(JSON.stringify(firstApproval));
      replacementApproval.source = 'rewrite';
      var repaired = SheetRepository.updateConversationMessage(imageMessageId, {
        image: {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          summary: 'replacement approved summary'
        },
        characterApproval: replacementApproval
      });
      assert(
        repaired.image.summary === 'replacement approved summary',
        'Matching orphaned image approval should be repairable.'
      );
      SheetRepository.appendConversation({
        messageId: '77777777-7777-4777-8777-777777777777',
        requestId: imageRequestId,
        createdAt: '2026-07-24T09:01:01+09:00',
        role: 'assistant',
        messageType: 'text',
        text: '見えてるで。',
        replyToMessageId: imageMessageId,
        status: 'completed',
        characterApproval: replacementApproval
      });
      var immutableError = null;
      try {
        SheetRepository.updateConversationMessage(imageMessageId, {
          image: {
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            summary: 'tampered after completion'
          },
          characterApproval: replacementApproval
        });
      } catch (error) {
        immutableError = error;
      }
      assert(
        immutableError && immutableError.code === 'STORAGE_DATA_CORRUPTED',
        'Completed approved image content must be immutable.'
      );

      var proactiveMessageId =
        '88888888-8888-4888-8888-888888888888';
      var proactiveOriginEventId =
        '99999999-9999-4999-8999-999999999999';
      var proactiveDedupeKey =
        'PROACTIVE_MESSAGE:2026-07-24:1';
      var proactiveApproval = {
        surface: 'PROACTIVE_AI',
        source: 'generated',
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        profileRevision: 3,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: 'warm-kansai-caretaker',
        characterPackVersion: 'warm-kansai-caretaker.v1'
      };
      SheetRepository.appendConversation({
        messageId: proactiveMessageId,
        requestId: proactiveDedupeKey,
        createdAt: '2026-07-24T09:02:00+09:00',
        role: 'system',
        messageType: 'proactive',
        text: 'approved proactive body',
        proactiveSubject: 'approved proactive subject',
        proactiveOriginEventId: proactiveOriginEventId,
        status: 'failed',
        characterApproval: proactiveApproval
      });
      assert(
        rows[rows.length - 1][
          headers.indexOf('proactive_origin_event_id')
        ] === proactiveOriginEventId,
        'Append did not persist the proactive origin event.'
      );
      var retryApproval = JSON.parse(
        JSON.stringify(proactiveApproval)
      );
      retryApproval.surface = 'PROACTIVE_RETRY';
      retryApproval.source = 'legacy_revalidated';
      retryApproval.profileRevision = 4;
      var rebound = SheetRepository.updateConversationMessage(
        proactiveMessageId,
        {
          createdAt: '2026-07-24T09:03:00+09:00',
          status: 'accepted',
          error: null,
          characterApproval: retryApproval,
          proactiveOriginEventId: proactiveOriginEventId
        }
      );
      assert(
        rebound.characterApproval.surface === 'PROACTIVE_RETRY' &&
          rebound.characterApproval.profileRevision === 4,
        'Failed proactive marker did not accept current exact-pair reapproval.'
      );

      SheetRepository.updateConversationMessage(
        proactiveMessageId,
        {
          status: 'failed',
          error: {
            code: 'MAIL_QUOTA_EXHAUSTED'
          }
        }
      );
      [
        {
          label: 'content',
          extra: {
            text: 'changed body'
          }
        },
        {
          label: 'subject',
          extra: {
            proactiveSubject: 'changed subject'
          }
        },
        {
          label: 'identity',
          extra: {
            requestId: 'PROACTIVE_MESSAGE:2026-07-24:2'
          }
        },
        {
          label: 'delivery metadata',
          extra: {
            model: 'changed-model'
          }
        }
      ].forEach(function(fixture) {
        var patch = {
          createdAt: '2026-07-24T09:04:00+09:00',
          status: 'accepted',
          error: null,
          characterApproval: retryApproval,
          proactiveOriginEventId: proactiveOriginEventId
        };
        Object.keys(fixture.extra).forEach(function(key) {
          patch[key] = fixture.extra[key];
        });
        var mutationError = null;
        try {
          SheetRepository.updateConversationMessage(
            proactiveMessageId,
            patch
          );
        } catch (error) {
          mutationError = error;
        }
        assert(
          mutationError &&
            mutationError.code === 'STORAGE_DATA_CORRUPTED',
          'Failed proactive rebind accepted a forbidden ' +
            fixture.label +
            ' field.'
        );
      });

      [
        {
          label: 'missing origin',
          patch: {
            status: 'accepted',
            error: null,
            characterApproval: retryApproval
          },
          code: 'STORAGE_DATA_CORRUPTED'
        },
        {
          label: 'non-accepted status',
          patch: {
            status: 'failed',
            error: null,
            characterApproval: retryApproval,
            proactiveOriginEventId: proactiveOriginEventId
          },
          code: 'STORAGE_DATA_CORRUPTED'
        },
        {
          label: 'non-null error',
          patch: {
            status: 'accepted',
            error: {
              code: 'MAIL_SEND_FAILED'
            },
            characterApproval: retryApproval,
            proactiveOriginEventId: proactiveOriginEventId
          },
          code: 'STORAGE_DATA_CORRUPTED'
        },
        {
          label: 'invalid origin',
          patch: {
            status: 'accepted',
            error: null,
            characterApproval: retryApproval,
            proactiveOriginEventId: 'not-a-uuid'
          },
          code: 'VALIDATION_REQUEST_INVALID'
        },
        {
          label: 'different origin',
          patch: {
            status: 'accepted',
            error: null,
            characterApproval: retryApproval,
            proactiveOriginEventId:
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          },
          code: 'STORAGE_DATA_CORRUPTED'
        }
      ].forEach(function(fixture) {
        var validationError = null;
        try {
          SheetRepository.updateConversationMessage(
            proactiveMessageId,
            fixture.patch
          );
        } catch (error) {
          validationError = error;
        }
        assert(
          validationError &&
            validationError.code === fixture.code,
          'Failed proactive rebind accepted ' + fixture.label + '.'
        );
      });

      var proactiveRow = rows[rows.length - 1];
      proactiveRow[
        headers.indexOf('approval_character_pack_version')
      ] = '';
      var tolerantMarker =
        SheetRepository.getProactiveMarkerByDedupeKey(
          proactiveDedupeKey
        );
      assert(
        tolerantMarker &&
          tolerantMarker.invalidCharacterApproval === true &&
          tolerantMarker.characterApproval === null &&
          tolerantMarker.text === '' &&
          tolerantMarker.proactiveSubject === null &&
          tolerantMarker.proactiveOriginEventId ===
            proactiveOriginEventId,
        'Partial proactive approval was not returned as a safe marker.'
      );
      var strictDtoError = null;
      try {
        SheetRepository.getMessageByRequestIdAndRole(
          proactiveDedupeKey,
          'system'
        );
      } catch (error) {
        strictDtoError = error;
      }
      assert(
        strictDtoError &&
          strictDtoError.code === 'STORAGE_DATA_CORRUPTED',
        'The public/strict DTO silently accepted partial approval.'
      );
      var foreignQuarantineError = null;
      try {
        SheetRepository.quarantineProactiveMarker(
          proactiveMessageId,
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        );
      } catch (error) {
        foreignQuarantineError = error;
      }
      assert(
        foreignQuarantineError &&
          foreignQuarantineError.code ===
            'STORAGE_DATA_CORRUPTED',
        'A foreign event took ownership of a proactive quarantine.'
      );
      var quarantined = SheetRepository.quarantineProactiveMarker(
        proactiveMessageId,
        proactiveOriginEventId
      );
      assert(
        quarantined.invalidCharacterApproval === true &&
          quarantined.status === 'failed' &&
          quarantined.error &&
          quarantined.error.code ===
            'PROACTIVE_RETRY_QUARANTINED' &&
          quarantined.proactiveOriginEventId ===
            proactiveOriginEventId,
        'Partial approval marker was not quarantined safely.'
      );
      assert(
        SheetRepository.getProactiveMarkerByDedupeKey(
          proactiveDedupeKey
        ) === null,
        'A quarantined marker remained active without an origin lookup.'
      );
      assert(
        SheetRepository.getProactiveMarkerByDedupeKey(
          proactiveDedupeKey,
          proactiveOriginEventId
        ).messageId === proactiveMessageId,
        'Origin-bound quarantine lookup did not recover its audit row.'
      );

      var legacyMessageId =
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      var legacyOriginEventId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      SheetRepository.appendConversation({
        messageId: legacyMessageId,
        requestId: 'PROACTIVE_MESSAGE:2026-07-24:legacy-origin',
        createdAt: '2026-07-24T09:04:30+09:00',
        role: 'system',
        messageType: 'proactive',
        text: '',
        status: 'failed',
        error: {
          code: 'MAIL_SEND_FAILED'
        },
        proactiveOriginEventId: legacyOriginEventId
      });
      var legacyOriginReplacementError = null;
      try {
        SheetRepository.updateConversationMessage(
          legacyMessageId,
          {
            proactiveOriginEventId:
              'ffffffff-ffff-4fff-8fff-ffffffffffff'
          }
        );
      } catch (error) {
        legacyOriginReplacementError = error;
      }
      assert(
        legacyOriginReplacementError &&
          legacyOriginReplacementError.code ===
            'STORAGE_DATA_CORRUPTED',
        'A legacy marker without approval allowed a foreign event to replace its origin.'
      );
      assert(
        rows[rows.length - 1][
          headers.indexOf('proactive_origin_event_id')
        ] === legacyOriginEventId,
        'Rejected legacy marker origin replacement mutated the stored owner.'
      );

      var historicalMessageId =
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      var claimedHistoricalOrigin =
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      SheetRepository.appendConversation({
        messageId: historicalMessageId,
        requestId: 'PROACTIVE_MESSAGE:2026-07-24:2',
        createdAt: '2026-07-24T09:05:00+09:00',
        role: 'system',
        messageType: 'proactive',
        text: 'historical approved body',
        proactiveSubject: 'historical approved subject',
        status: 'failed',
        characterApproval: proactiveApproval
      });
      SheetRepository.updateConversationMessage(
        historicalMessageId,
        {
          createdAt: '2026-07-24T09:06:00+09:00',
          status: 'accepted',
          error: null,
          characterApproval: retryApproval,
          proactiveOriginEventId: claimedHistoricalOrigin
        }
      );
      assert(
        rows[rows.length - 1][
          headers.indexOf('proactive_origin_event_id')
        ] === claimedHistoricalOrigin,
        'A historical null origin could not bind to its current retry event.'
      );
    } finally {
      PropertiesService = originalPropertiesService;
      if (hadSpreadsheetApp) {
        globalThis.SpreadsheetApp = originalSpreadsheetApp;
      } else {
        delete globalThis.SpreadsheetApp;
      }
    }
  });

  test('user_state lookup rejects duplicate singleton rows', function() {
    var originalPropertiesService = PropertiesService;
    var hadSpreadsheetApp = Object.prototype.hasOwnProperty.call(
      globalThis,
      'SpreadsheetApp'
    );
    var originalSpreadsheetApp = hadSpreadsheetApp
      ? globalThis.SpreadsheetApp
      : null;
    var headers = getSheetSchema(APP_CONSTANTS.SHEETS.USER_STATE)
      .map(function(column) {
        return column.name;
      });
    var defaultRow = headers.map(function(header) {
      if (header === 'singleton_id') {
        return APP_CONSTANTS.USER_STATE_SINGLETON_ID;
      }
      if (header === 'proactive_count') {
        return 0;
      }
      if (header === 'updated_at') {
        return new Date('2026-07-26T10:00:00+09:00');
      }
      return '';
    });
    var rows = [
      headers,
      defaultRow,
      defaultRow.slice()
    ];
    var sheet = {
      getLastColumn: function() {
        return headers.length;
      },
      getLastRow: function() {
        return rows.length;
      },
      getRange: function(row, column, rowCount, columnCount) {
        return {
          getValues: function() {
            var values = [];
            for (
              var rowOffset = 0;
              rowOffset < rowCount;
              rowOffset += 1
            ) {
              values.push(
                rows[row - 1 + rowOffset].slice(
                  column - 1,
                  column - 1 + columnCount
                )
              );
            }
            return values;
          }
        };
      }
    };
    PropertiesService = {
      getScriptProperties: function() {
        return {
          getProperty: function() {
            return 'test-spreadsheet';
          }
        };
      }
    };
    globalThis.SpreadsheetApp = {
      openById: function() {
        return {
          getSheetByName: function() {
            return sheet;
          }
        };
      }
    };
    try {
      var thrown = null;
      try {
        SheetRepository.getUserState();
      } catch (error) {
        thrown = error;
      }
      assert(
        thrown && thrown.code === 'STORAGE_DATA_CORRUPTED',
        'Duplicate user_state singleton rows must fail closed.'
      );
    } finally {
      PropertiesService = originalPropertiesService;
      if (hadSpreadsheetApp) {
        globalThis.SpreadsheetApp = originalSpreadsheetApp;
      } else {
        delete globalThis.SpreadsheetApp;
      }
    }
  });

  expectThrows('legacy conversation headers reject approved writes', function() {
    var approvalColumnCount = APP_CONSTANTS.CHARACTER.APPROVAL_COLUMNS.length;
    var legacyHeaders = getSheetSchema(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
      .map(function(column) {
        return column.name;
      })
      .slice(0, -approvalColumnCount);
    SheetRepository.__test.assertCharacterApprovalHeaders(legacyHeaders);
  }, 'STORAGE_DATA_CORRUPTED');

  test('character approval metadata round trips exactly', function() {
    var approval = {
      surface: 'CHAT_TEXT_SYNC',
      source: 'generated',
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 3,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: 'warm-kansai-caretaker',
      characterPackVersion: 'warm-kansai-caretaker.v1'
    };
    var row = SheetRepository.__test.characterApprovalToRow(
      approval,
      'VALIDATION_REQUEST_INVALID'
    );
    var restored = SheetRepository.__test.characterApprovalFromRow(row);
    assert(
      JSON.stringify(restored) === JSON.stringify(approval),
      'Character approval metadata changed during row round trip.'
    );
    assert(
      SheetRepository.__test.characterApprovalsEqual(approval, restored),
      'Equivalent character approval metadata must dedupe safely.'
    );
    var staleApproval = JSON.parse(JSON.stringify(restored));
    staleApproval.profileRevision += 1;
    assert(
      !SheetRepository.__test.characterApprovalsEqual(approval, staleApproval),
      'Dedupe must reject mismatched approval metadata.'
    );
  });

  test('proactive subject stays internal while marker retry can restore it', function() {
    var row = {
      message_id: '11111111-1111-4111-8111-111111111111',
      request_id: 'PROACTIVE_MESSAGE:2026-07-24:1',
      created_at: '2026-07-24T09:00:00+09:00',
      role: 'system',
      message_type: 'proactive',
      text: 'approved body',
      status: 'failed',
      proactive_subject: 'approved subject',
      proactive_origin_event_id:
        '99999999-9999-4999-8999-999999999999',
      approval_surface: 'PROACTIVE_AI',
      approval_source: 'generated',
      approval_policy_version: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      approval_profile_schema_version: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      approval_profile_revision: 3,
      approval_catalog_version: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      approval_character_pack_id: 'warm-kansai-caretaker',
      approval_character_pack_version: 'warm-kansai-caretaker.v1'
    };
    var publicDto = SheetRepository.__test.toMessageDto(row);
    var markerDto = SheetRepository.__test.toProactiveMarkerDto(row);
    assert(
      !Object.prototype.hasOwnProperty.call(
        publicDto,
        'proactiveSubject'
      ) &&
        !Object.prototype.hasOwnProperty.call(
          publicDto,
          'proactiveOriginEventId'
        ) &&
        !Object.prototype.hasOwnProperty.call(
          publicDto,
          'invalidCharacterApproval'
        ),
      'Public MessageDto exposed proactive transport metadata.'
    );
    assert(
      markerDto.proactiveSubject === 'approved subject' &&
        markerDto.proactiveOriginEventId ===
          '99999999-9999-4999-8999-999999999999' &&
        markerDto.invalidCharacterApproval === false &&
        markerDto.characterApproval.surface === 'PROACTIVE_AI',
      'Internal proactive marker must restore the exact approved pair and origin.'
    );
  });

  test('proactive marker lookup prioritizes completion then active and origin-bound quarantine', function() {
    var dedupeKey = 'PROACTIVE_MESSAGE:2026-07-24:1';
    var originEventId =
      '99999999-9999-4999-8999-999999999999';
    var completed = {
      request_id: dedupeKey,
      role: 'system',
      message_type: 'proactive',
      status: 'completed',
      error_code: null,
      text: 'completed authority'
    };
    var selected = SheetRepository.__test.selectProactiveMarkerRow([
      completed,
      {
        request_id: dedupeKey,
        role: 'system',
        message_type: 'proactive',
        error_code: 'PROACTIVE_RETRY_QUARANTINED',
        text: 'quarantined'
      },
      {
        request_id: dedupeKey,
        role: 'system',
        message_type: 'error',
        error_code: null,
        text: 'not a marker'
      },
      {
        request_id: dedupeKey,
        role: 'system',
        message_type: 'proactive',
        status: 'accepted',
        error_code: null,
        text: 'latest active'
      }
    ], dedupeKey);
    assert(
      selected === completed,
      'A newer active row displaced an authoritative completed marker.'
    );
    var latestActive =
      SheetRepository.__test.selectProactiveMarkerRow([
        {
          request_id: dedupeKey,
          role: 'system',
          message_type: 'proactive',
          status: 'failed',
          error_code: 'PROACTIVE_RETRY_QUARANTINED',
          proactive_origin_event_id: originEventId
        },
        {
          request_id: dedupeKey,
          role: 'system',
          message_type: 'proactive',
          status: 'accepted',
          error_code: null,
          text: 'latest active'
        }
      ], dedupeKey);
    assert(
      latestActive && latestActive.text === 'latest active',
      'The latest non-quarantine marker was not selected.'
    );
    var quarantineOnly = [{
      request_id: dedupeKey,
      role: 'system',
      message_type: 'proactive',
      status: 'failed',
      error_code: 'PROACTIVE_RETRY_QUARANTINED',
      proactive_origin_event_id: originEventId
    }];
    assert(
      SheetRepository.__test.selectProactiveMarkerRow(
        quarantineOnly,
        dedupeKey
      ) === null &&
        SheetRepository.__test.selectProactiveMarkerRow(
          quarantineOnly,
          dedupeKey,
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        ) === null &&
        SheetRepository.__test.selectProactiveMarkerRow(
          quarantineOnly,
          dedupeKey,
          originEventId
        ) === quarantineOnly[0],
      'Quarantine lookup was not restricted to its exact origin event.'
    );
  });

  test('conversation readers expose only completed proactive markers', function() {
    var visible = SheetRepository.__test.isConversationRowVisible;
    assert(
      visible({
        role: 'system',
        message_type: 'proactive',
        status: 'completed'
      }),
      'A delivered proactive message must remain visible.'
    );
    ['accepted', 'failed'].forEach(function(status) {
      assert(
        !visible({
          role: 'system',
          message_type: 'proactive',
          status: status
        }),
        'An undelivered proactive marker became conversation content: ' + status
      );
    });
    assert(
      !visible({
        role: 'system',
        message_type: 'proactive',
        status: 'failed',
        error_code: 'PROACTIVE_RETRY_QUARANTINED'
      }),
      'A quarantined proactive marker became conversation content.'
    );
    assert(
      visible({
        role: 'assistant',
        message_type: 'text',
        status: 'failed'
      }),
      'The proactive visibility rule must not hide ordinary conversation rows.'
    );
  });

  [
    {
      name: 'proactive generation with canonical source',
      surface: 'PROACTIVE_AI',
      source: 'canonical'
    },
    {
      name: 'proactive retry with generated source',
      surface: 'PROACTIVE_RETRY',
      source: 'generated'
    },
    {
      name: 'legacy revalidation outside retry',
      surface: 'CHAT_TEXT_SYNC',
      source: 'legacy_revalidated'
    }
  ].forEach(function(fixture) {
    expectThrows(
      'character approval rejects ' + fixture.name,
      function() {
        SheetRepository.__test.normalizeCharacterApproval({
          surface: fixture.surface,
          source: fixture.source,
          policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
          profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
          profileRevision: 3,
          catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
          characterPackId: 'warm-kansai-caretaker',
          characterPackVersion: 'warm-kansai-caretaker.v1'
        }, 'VALIDATION_REQUEST_INVALID');
      },
      'VALIDATION_REQUEST_INVALID'
    );
  });

  test('legacy conversation rows remain readable without approval metadata', function() {
    var dto = SheetRepository.__test.toMessageDto({
      message_id: '11111111-1111-4111-8111-111111111111',
      request_id: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-07-24T09:00:00+09:00',
      role: 'assistant',
      message_type: 'text',
      text: 'legacy',
      status: 'completed'
    });
    assert(dto.text === 'legacy', 'Legacy message content should remain readable.');
    assert(dto.replyToMessageId === null, 'Missing legacy reply target must remain null.');
    assert(dto.characterApproval === null, 'Legacy rows must not be promoted to approved rows.');
  });

  test('message DTO preserves the persisted reply target', function() {
    var replyToMessageId = '33333333-3333-4333-8333-333333333333';
    var dto = SheetRepository.__test.toMessageDto({
      message_id: '11111111-1111-4111-8111-111111111111',
      request_id: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-07-24T09:00:00+09:00',
      role: 'assistant',
      message_type: 'text',
      text: 'reply',
      status: 'completed',
      reply_to_message_id: replyToMessageId
    });
    assert(
      dto.replyToMessageId === replyToMessageId,
      'Persisted reply target was omitted from MessageDto.'
    );
  });

  expectThrows('character approval rejects incomplete request metadata', function() {
    SheetRepository.__test.normalizeCharacterApproval({
      surface: 'CHAT_TEXT_SYNC',
      source: 'generated'
    }, 'VALIDATION_REQUEST_INVALID');
  }, 'VALIDATION_REQUEST_INVALID');

  expectThrows('character approval rejects unknown request enum', function() {
    SheetRepository.__test.normalizeCharacterApproval({
      surface: 'UNKNOWN_SURFACE',
      source: 'generated',
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 3,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: 'warm-kansai-caretaker',
      characterPackVersion: 'warm-kansai-caretaker.v1'
    }, 'VALIDATION_REQUEST_INVALID');
  }, 'VALIDATION_REQUEST_INVALID');

  [
    {
      name: 'wrong policy version',
      patch: { policyVersion: 'character-policy.v999' }
    },
    {
      name: 'wrong profile schema version',
      patch: { profileSchemaVersion: 'character-profile.v999' }
    },
    {
      name: 'wrong catalog version',
      patch: { catalogVersion: 'character-catalog.v999' }
    },
    {
      name: 'invalid character pack id',
      patch: { characterPackId: 'Invalid Pack' }
    },
    {
      name: 'invalid character pack version',
      patch: { characterPackVersion: 'Invalid Version' }
    }
  ].forEach(function(fixture) {
    expectThrows('character approval rejects ' + fixture.name, function() {
      var approval = {
        surface: 'CHAT_TEXT_SYNC',
        source: 'generated',
        policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
        profileSchemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
        profileRevision: 3,
        catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
        characterPackId: 'warm-kansai-caretaker',
        characterPackVersion: 'warm-kansai-caretaker.v1'
      };
      Object.keys(fixture.patch).forEach(function(key) {
        approval[key] = fixture.patch[key];
      });
      SheetRepository.__test.normalizeCharacterApproval(
        approval,
        'VALIDATION_REQUEST_INVALID'
      );
    }, 'VALIDATION_REQUEST_INVALID');
  });

  expectThrows('character approval rejects partial stored metadata', function() {
    SheetRepository.__test.characterApprovalFromRow({
      approval_surface: 'CHAT_TEXT_SYNC'
    });
  }, 'STORAGE_DATA_CORRUPTED');

  expectThrows('character approval rejects invalid stored metadata type', function() {
    SheetRepository.__test.characterApprovalFromRow({
      approval_surface: 'CHAT_TEXT_SYNC',
      approval_source: 'generated',
      approval_policy_version: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      approval_profile_schema_version: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      approval_profile_revision: '3',
      approval_catalog_version: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      approval_character_pack_id: 'warm-kansai-caretaker',
      approval_character_pack_version: 'warm-kansai-caretaker.v1'
    });
  }, 'STORAGE_DATA_CORRUPTED');

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

  test('persisted queue errors redact provider credentials', function() {
    var secret = 'AIza' + new Array(36).join('A');
    var persisted = toPersistedError(createAppError(
      'GEMINI_TEMPORARY_FAILURE',
      'Exception while fetching https://example.invalid/generate?key=' + secret
    ));
    assert(
      persisted.code === 'GEMINI_TEMPORARY_FAILURE',
      'Persisted error code should be preserved.'
    );
    assert(
      persisted.message.indexOf(secret) === -1,
      'Persisted error message must not contain the provider credential.'
    );
    assert(
      persisted.message.indexOf('[REDACTED') !== -1,
      'Persisted error message should retain a redaction marker.'
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
    assert(APP_CONSTANTS.SCHEMA_VERSION === '2026.07.a7', 'Approved memory provenance requires schema version a7.');
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
      entries.PROACTIVE_POLICY_MODE.value === 'probability',
      'Proactive policy must default to probability mode.'
    );
    assert(
      entries.DIARY_CHARACTER_ENFORCEMENT_ENABLED.value === 'false' &&
        entries.DIARY_CHARACTER_ENFORCEMENT_ENABLED.type === 'bool',
      'Diary character enforcement must default to disabled.'
    );
    var diaryHeaders = APP_CONSTANTS.SHEET_SCHEMAS.daily_summaries.map(
      function(column) {
        return column.name;
      }
    );
    assert(
      diaryHeaders.slice(-3).join(',') === [
        'diary_payload_json',
        'diary_approval_json',
        'diary_origin_event_id'
      ].join(','),
      'Diary provenance columns must be appended in the a6 order.'
    );
    assert(
      SheetRepository.__test.assertDiaryProvenanceHeaders(
        diaryHeaders
      ) === true,
      'Diary provenance header guard rejected the a6 schema.'
    );
    assert(
      entries.MEMORY_CHARACTER_ENFORCEMENT_ENABLED.value === 'false' &&
        entries.MEMORY_CHARACTER_ENFORCEMENT_ENABLED.type === 'bool',
      'Memory character enforcement must default to disabled.'
    );
    var memoryHeaders =
      APP_CONSTANTS.SHEET_SCHEMAS.long_term_memories.map(
        function(column) {
          return column.name;
        }
      );
    assert(
      memoryHeaders.slice(-2).join(',') === [
        'memory_approval_json',
        'memory_origin_event_ids_json'
      ].join(','),
      'Memory provenance columns must be appended in the a7 order.'
    );
    assert(
      SheetRepository.__test.assertMemoryProvenanceHeaders(
        memoryHeaders
      ) === true,
      'Memory provenance header guard rejected the a7 schema.'
    );
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

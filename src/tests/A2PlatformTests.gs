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

  test('conversation approval columns are an additive ordered schema block', function() {
    var schemaHeaders = getSheetSchema(APP_CONSTANTS.SHEETS.CONVERSATION_LOGS)
      .map(function(column) {
        return column.name;
      });
    var approvalColumns = APP_CONSTANTS.CHARACTER.APPROVAL_COLUMNS;
    assert(
      JSON.stringify(schemaHeaders.slice(-approvalColumns.length)) ===
        JSON.stringify(approvalColumns),
      'Character approval columns must remain the exact conversation_logs suffix.'
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
  });

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
      assert(
        rows[1][headers.length - 1] === '',
        'Append must leave an unknown future column empty.'
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
    assert(APP_CONSTANTS.SCHEMA_VERSION === '2026.07.a3', 'Chat approval columns require schema version a3.');
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

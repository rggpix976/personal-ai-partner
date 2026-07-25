function runA16ImmersionSafetyAuditTests() {
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

  function binding(revision) {
    var activePack = CharacterPackService.getActive();
    return {
      policyVersion:
        APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      profileSchemaVersion:
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: revision,
      catalogVersion:
        APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: activePack.packId,
      characterPackVersion: activePack.packVersion
    };
  }

  function approval(surface, source, eventBinding) {
    return {
      surface: surface,
      source: source,
      policyVersion: eventBinding.policyVersion,
      profileSchemaVersion:
        eventBinding.profileSchemaVersion,
      profileRevision: eventBinding.profileRevision,
      catalogVersion: eventBinding.catalogVersion,
      characterPackId: eventBinding.characterPackId,
      characterPackVersion:
        eventBinding.characterPackVersion
    };
  }

  function approvalColumns(value) {
    return {
      approval_surface: value.surface,
      approval_source: value.source,
      approval_policy_version: value.policyVersion,
      approval_profile_schema_version:
        value.profileSchemaVersion,
      approval_profile_revision: value.profileRevision,
      approval_catalog_version: value.catalogVersion,
      approval_character_pack_id: value.characterPackId,
      approval_character_pack_version:
        value.characterPackVersion
    };
  }

  function merge(left, right) {
    var result = {};
    Object.keys(left || {}).forEach(function(key) {
      result[key] = left[key];
    });
    Object.keys(right || {}).forEach(function(key) {
      result[key] = right[key];
    });
    return result;
  }

  function enforcedEvent(
    eventId,
    eventType,
    eventBinding,
    payload,
    status
  ) {
    return {
      eventId: eventId,
      eventType: eventType,
      status: status || 'DONE',
      payload: merge(
        {
          characterRuntimeMode: 'enforced',
          characterBinding: eventBinding
        },
        payload || {}
      )
    };
  }

  function chatGraph(ids, revision) {
    var eventBinding = binding(revision);
    var chatApproval = approval(
      'CHAT_TEXT_SYNC',
      'generated',
      eventBinding
    );
    return {
      event: enforcedEvent(
        ids.eventId,
        'CHAT_REPLY',
        eventBinding,
        {
          requestId: ids.requestId,
          userMessageId: ids.userMessageId
        }
      ),
      rows: [
        {
          message_id: ids.userMessageId,
          request_id: ids.requestId,
          role: 'user',
          message_type: 'text',
          text: 'user-secret',
          status: 'accepted'
        },
        merge(
          {
            message_id: ids.assistantMessageId,
            request_id: ids.requestId,
            role: 'assistant',
            message_type: 'text',
            text: 'assistant-secret',
            reply_to_message_id: ids.userMessageId,
            status: 'completed'
          },
          approvalColumns(chatApproval)
        )
      ]
    };
  }

  function inspect(input) {
    return ImmersionSafetyAuditService.__test.inspectRows(
      merge(
        {
          events: [],
          conversations: [],
          diaries: [],
          memories: []
        },
        input || {}
      )
    );
  }

  test(
    'NO_DATA is not a pass and provenance-free legacy rows are ignored',
    function() {
      var result = inspect({
        conversations: [{
          message_id:
            '11111111-1111-4111-8111-111111111111',
          request_id:
            '22222222-2222-4222-8222-222222222222',
          role: 'assistant',
          message_type: 'text',
          text: 'legacy-secret',
          status: 'completed'
        }],
        diaries: [{
          summary_date: '2026-07-01',
          diary_status: 'DONE'
        }],
        memories: [{
          memory_id:
            '33333333-3333-4333-8333-333333333333',
          status: 'active',
          content: 'legacy-memory'
        }]
      });

      assert(result.valid === false, 'NO_DATA passed.');
      assert(
        result.issues.indexOf('NO_ENFORCED_EVENTS') !== -1,
        'NO_DATA token is missing.'
      );
      assert(
        result.unsafePersistedOrSent.total === 0 &&
          result.checked.total === 0,
        'Legacy rows were treated as enforced evidence.'
      );
    }
  );

  test(
    'all enforced revisions remain auditable after later profile changes',
    function() {
      var first = chatGraph({
        eventId:
          '11111111-1111-4111-8111-111111111111',
        requestId:
          '22222222-2222-4222-8222-222222222222',
        userMessageId:
          '33333333-3333-4333-8333-333333333333',
        assistantMessageId:
          '44444444-4444-4444-8444-444444444444'
      }, 4);
      var second = chatGraph({
        eventId:
          '55555555-5555-4555-8555-555555555555',
        requestId:
          '66666666-6666-4666-8666-666666666666',
        userMessageId:
          '77777777-7777-4777-8777-777777777777',
        assistantMessageId:
          '88888888-8888-4888-8888-888888888888'
      }, 7);
      var result = inspect({
        events: [first.event, second.event],
        conversations: first.rows.concat(second.rows)
      });

      assert(result.valid === true, 'Historical revisions failed.');
      assert(
        result.windowSource === 'ALL_ENFORCED_EVENTS' &&
          result.checked.chatMessages === 2 &&
          result.unsafePersistedOrSent.total === 0,
        'The complete enforced graph was not audited.'
      );
    }
  );

  test(
    'approval revision mismatch fails without returning secrets or identifiers',
    function() {
      var graph = chatGraph({
        eventId:
          '11111111-1111-4111-8111-111111111111',
        requestId:
          '22222222-2222-4222-8222-222222222222',
        userMessageId:
          '33333333-3333-4333-8333-333333333333',
        assistantMessageId:
          '44444444-4444-4444-8444-444444444444'
      }, 3);
      graph.rows[1].approval_profile_revision = 9;
      graph.rows[1].text =
        'secret-body secret@example.com https://secret.invalid';
      var result = inspect({
        events: [graph.event],
        conversations: graph.rows
      });
      var serialized = JSON.stringify(result);

      assert(result.valid === false, 'Mismatched approval passed.');
      assert(
        result.unsafePersistedOrSent.chatMessages === 1,
        'Mismatched approval was not counted.'
      );
      [
        'secret-body',
        'secret@example.com',
        'https://secret.invalid',
        graph.event.eventId,
        graph.event.payload.requestId,
        'profileRevision',
        'updatedAt'
      ].forEach(function(forbidden) {
        assert(
          serialized.indexOf(forbidden) === -1,
          'Audit result exposed forbidden data.'
        );
      });
    }
  );

  test(
    'unresolved proactive delivery cannot pass despite valid approval',
    function() {
      var eventBinding = binding(5);
      var eventId =
        '11111111-1111-4111-8111-111111111111';
      var dedupeKey = 'proactive-dedupe-5';
      var proactiveApproval = approval(
        'PROACTIVE_AI',
        'generated',
        eventBinding
      );
      var marker = merge(
        {
          message_id:
            '22222222-2222-4222-8222-222222222222',
          request_id: dedupeKey,
          role: 'system',
          message_type: 'proactive',
          text: 'secret-body',
          proactive_subject: 'secret-subject',
          proactive_origin_event_id: eventId,
          status: 'accepted'
        },
        approvalColumns(proactiveApproval)
      );
      var result = inspect({
        events: [
          enforcedEvent(
            eventId,
            'PROACTIVE_SEND',
            eventBinding,
            { messageDedupeKey: dedupeKey },
            'PROCESSING'
          )
        ],
        conversations: [marker]
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.total === 0,
        'Unresolved delivery was treated as safe completion.'
      );
      assert(
        result.issues.indexOf(
          'PROACTIVE_DELIVERY_UNRESOLVED'
        ) !== -1,
        'Unresolved delivery token is missing.'
      );
    }
  );

  test(
    'completed retry revalidation may use a later profile revision',
    function() {
      var originalBinding = binding(2);
      var retryBinding = binding(6);
      var eventId =
        '11111111-1111-4111-8111-111111111111';
      var dedupeKey = 'proactive-dedupe-6';
      var retryApproval = approval(
        'PROACTIVE_RETRY',
        'legacy_revalidated',
        retryBinding
      );
      var result = inspect({
        events: [
          enforcedEvent(
            eventId,
            'PROACTIVE_SEND',
            originalBinding,
            { messageDedupeKey: dedupeKey },
            'DONE'
          )
        ],
        conversations: [
          merge(
            {
              message_id:
                '22222222-2222-4222-8222-222222222222',
              request_id: dedupeKey,
              role: 'system',
              message_type: 'proactive',
              text: 'secret-body',
              proactive_subject: 'secret-subject',
              proactive_origin_event_id: eventId,
              status: 'completed'
            },
            approvalColumns(retryApproval)
          )
        ]
      });

      assert(result.valid === true, 'Valid retry was rejected.');
      assert(
        result.checked.sentProactiveMarkers === 1 &&
          result.unsafePersistedOrSent
            .sentProactiveMarkers === 0,
        'Completed retry evidence was not counted safely.'
      );
    }
  );

  test(
    'diary and memory provenance bind to their enforced origin events',
    function() {
      var diaryBinding = binding(8);
      var memoryBinding = binding(9);
      var diaryEventId =
        '11111111-1111-4111-8111-111111111111';
      var memoryEventId =
        '22222222-2222-4222-8222-222222222222';
      var sourceMessageId =
        '33333333-3333-4333-8333-333333333333';
      var diaryPayload = {
        title: 'title',
        narrative: 'narrative',
        groundedSummary: 'summary',
        partnerWorldEvents: [],
        thingsToRemember: [],
        unresolvedFollowUps: []
      };
      var result = inspect({
        events: [
          enforcedEvent(
            diaryEventId,
            'DIARY_GENERATE',
            diaryBinding,
            { diaryDate: '2026-07-24' }
          ),
          enforcedEvent(
            memoryEventId,
            'MEMORY_EXTRACT',
            memoryBinding,
            { sourceMessageIds: [sourceMessageId] }
          )
        ],
        diaries: [{
          summary_date: '2026-07-24',
          diary_status: 'DONE',
          diary_doc_anchor: 'secret-anchor',
          diary_payload_json: diaryPayload,
          diary_approval_json: approval(
            'DIARY',
            'generated',
            diaryBinding
          ),
          diary_origin_event_id: diaryEventId
        }],
        memories: [{
          memory_id:
            '44444444-4444-4444-8444-444444444444',
          category: 'preference',
          normalized_key: 'favorite',
          content: 'secret-memory',
          confidence: 0.9,
          status: 'active',
          source_message_ids_json: [sourceMessageId],
          memory_approval_json: approval(
            'MEMORY_EXTRACTION',
            'rewrite',
            memoryBinding
          ),
          memory_origin_event_ids_json: [memoryEventId]
        }]
      });

      assert(result.valid === true, 'Provenance graph failed.');
      assert(
        result.checked.diaries === 1 &&
          result.checked.memories === 1 &&
          result.unsafePersistedOrSent.total === 0,
        'Diary or memory evidence was not audited.'
      );
    }
  );

  test(
    'completed assistant cannot pass with a non-DONE origin event',
    function() {
      var graph = chatGraph({
        eventId:
          '11111111-1111-4111-8111-111111111111',
        requestId:
          '22222222-2222-4222-8222-222222222222',
        userMessageId:
          '33333333-3333-4333-8333-333333333333',
        assistantMessageId:
          '44444444-4444-4444-8444-444444444444'
      }, 10);
      graph.event.status = 'PROCESSING';
      var result = inspect({
        events: [graph.event],
        conversations: graph.rows
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.chatMessages === 1,
        'Completed chat passed without a DONE origin.'
      );
    }
  );

  test(
    'DONE diary cannot pass with a DEAD origin event',
    function() {
      var eventBinding = binding(11);
      var eventId =
        '11111111-1111-4111-8111-111111111111';
      var result = inspect({
        events: [
          enforcedEvent(
            eventId,
            'DIARY_GENERATE',
            eventBinding,
            { diaryDate: '2026-07-24' },
            'DEAD'
          )
        ],
        diaries: [{
          summary_date: '2026-07-24',
          diary_status: 'DONE',
          diary_doc_anchor: 'secret-anchor',
          diary_payload_json: {
            title: 'title',
            narrative: 'narrative',
            groundedSummary: 'summary',
            partnerWorldEvents: [],
            thingsToRemember: [],
            unresolvedFollowUps: []
          },
          diary_approval_json: approval(
            'DIARY',
            'generated',
            eventBinding
          ),
          diary_origin_event_id: eventId
        }]
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.diaries === 1,
        'Completed diary passed without a DONE origin.'
      );
    }
  );

  test(
    'completed proactive marker cannot pass with a PROCESSING origin',
    function() {
      var eventBinding = binding(12);
      var eventId =
        '11111111-1111-4111-8111-111111111111';
      var dedupeKey = 'proactive-dedupe-12';
      var result = inspect({
        events: [
          enforcedEvent(
            eventId,
            'PROACTIVE_SEND',
            eventBinding,
            { messageDedupeKey: dedupeKey },
            'PROCESSING'
          )
        ],
        conversations: [
          merge(
            {
              message_id:
                '22222222-2222-4222-8222-222222222222',
              request_id: dedupeKey,
              role: 'system',
              message_type: 'proactive',
              text: 'secret-body',
              proactive_subject: 'secret-subject',
              proactive_origin_event_id: eventId,
              status: 'completed'
            },
            approvalColumns(
              approval(
                'PROACTIVE_AI',
                'generated',
                eventBinding
              )
            )
          )
        ]
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent
            .proactiveMarkers === 1 &&
          result.unsafePersistedOrSent
            .sentProactiveMarkers === 1,
        'Completed proactive marker passed without a DONE origin.'
      );
    }
  );

  test(
    'active memory cannot pass with a RETRY_WAIT origin event',
    function() {
      var eventBinding = binding(13);
      var eventId =
        '11111111-1111-4111-8111-111111111111';
      var sourceMessageId =
        '22222222-2222-4222-8222-222222222222';
      var result = inspect({
        events: [
          enforcedEvent(
            eventId,
            'MEMORY_EXTRACT',
            eventBinding,
            { sourceMessageIds: [sourceMessageId] },
            'RETRY_WAIT'
          )
        ],
        memories: [{
          memory_id:
            '33333333-3333-4333-8333-333333333333',
          category: 'preference',
          normalized_key: 'favorite',
          content: 'secret-memory',
          confidence: 0.9,
          status: 'active',
          source_message_ids_json: [sourceMessageId],
          memory_approval_json: approval(
            'MEMORY_EXTRACTION',
            'generated',
            eventBinding
          ),
          memory_origin_event_ids_json: [eventId]
        }]
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.memories === 1,
        'Active memory passed without DONE origins.'
      );
    }
  );

  test(
    'syntactically valid inactive CharacterPack cannot pass',
    function() {
      var graph = chatGraph({
        eventId:
          '11111111-1111-4111-8111-111111111111',
        requestId:
          '22222222-2222-4222-8222-222222222222',
        userMessageId:
          '33333333-3333-4333-8333-333333333333',
        assistantMessageId:
          '44444444-4444-4444-8444-444444444444'
      }, 14);
      graph.event.payload.characterBinding.characterPackId =
        'inactive-valid-pack';
      graph.rows[1].approval_character_pack_id =
        'inactive-valid-pack';
      var result = inspect({
        events: [graph.event],
        conversations: graph.rows
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.chatMessages === 1,
        'Inactive CharacterPack binding passed.'
      );
    }
  );

  test(
    'memory source ids must belong to the union of origin payloads',
    function() {
      var eventBinding = binding(15);
      var eventId =
        '11111111-1111-4111-8111-111111111111';
      var eventSourceId =
        '22222222-2222-4222-8222-222222222222';
      var unrelatedSourceId =
        '33333333-3333-4333-8333-333333333333';
      var result = inspect({
        events: [
          enforcedEvent(
            eventId,
            'MEMORY_EXTRACT',
            eventBinding,
            { sourceMessageIds: [eventSourceId] }
          )
        ],
        memories: [{
          memory_id:
            '44444444-4444-4444-8444-444444444444',
          category: 'preference',
          normalized_key: 'favorite',
          content: 'secret-memory',
          confidence: 0.9,
          status: 'active',
          source_message_ids_json: [unrelatedSourceId],
          memory_approval_json: approval(
            'MEMORY_EXTRACTION',
            'generated',
            eventBinding
          ),
          memory_origin_event_ids_json: [eventId]
        }]
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.memories === 1,
        'Unrelated memory source id passed provenance audit.'
      );
    }
  );

  test(
    'proactive marker request id must match its event dedupe key',
    function() {
      var eventBinding = binding(16);
      var eventId =
        '11111111-1111-4111-8111-111111111111';
      var expectedDedupe = 'expected-proactive-dedupe';
      var wrongDedupe = 'wrong-proactive-dedupe';
      var result = inspect({
        events: [
          enforcedEvent(
            eventId,
            'PROACTIVE_SEND',
            eventBinding,
            { messageDedupeKey: expectedDedupe },
            'DONE'
          )
        ],
        conversations: [
          merge(
            {
              message_id:
                '22222222-2222-4222-8222-222222222222',
              request_id: wrongDedupe,
              role: 'system',
              message_type: 'proactive',
              text: 'secret-body',
              proactive_subject: 'secret-subject',
              proactive_origin_event_id: eventId,
              status: 'completed'
            },
            approvalColumns(
              approval(
                'PROACTIVE_AI',
                'generated',
                eventBinding
              )
            )
          )
        ]
      });
      var serialized = JSON.stringify(result);

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent
            .proactiveMarkers === 1 &&
          result.unsafePersistedOrSent
            .sentProactiveMarkers === 1,
        'Mismatched proactive dedupe binding passed.'
      );
      assert(
        serialized.indexOf(expectedDedupe) === -1 &&
          serialized.indexOf(wrongDedupe) === -1,
        'Proactive dedupe identifiers leaked.'
      );
    }
  );

  test(
    'two DONE diary events for one date cannot pass',
    function() {
      var firstBinding = binding(17);
      var secondBinding = binding(18);
      var firstEventId =
        '11111111-1111-4111-8111-111111111111';
      var secondEventId =
        '22222222-2222-4222-8222-222222222222';
      var result = inspect({
        events: [
          enforcedEvent(
            firstEventId,
            'DIARY_GENERATE',
            firstBinding,
            { diaryDate: '2026-07-24' },
            'DONE'
          ),
          enforcedEvent(
            secondEventId,
            'DIARY_GENERATE',
            secondBinding,
            {
              diaryDate: '2026-07-24',
              originalEventId: firstEventId
            },
            'DONE'
          )
        ],
        diaries: [{
          summary_date: '2026-07-24',
          diary_status: 'DONE',
          diary_doc_anchor: 'secret-anchor',
          diary_payload_json: {
            title: 'title',
            narrative: 'narrative',
            groundedSummary: 'summary',
            partnerWorldEvents: [],
            thingsToRemember: [],
            unresolvedFollowUps: []
          },
          diary_approval_json: approval(
            'DIARY',
            'generated',
            firstBinding
          ),
          diary_origin_event_id: firstEventId
        }]
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.diaries === 2,
        'Duplicate DONE diary events passed.'
      );
    }
  );

  test(
    'one DEAD original plus one DONE diary repair remains valid',
    function() {
      var originalBinding = binding(19);
      var originalEventId =
        '11111111-1111-4111-8111-111111111111';
      var repairEventId =
        '22222222-2222-4222-8222-222222222222';
      var result = inspect({
        events: [
          enforcedEvent(
            originalEventId,
            'DIARY_GENERATE',
            originalBinding,
            { diaryDate: '2026-07-24' },
            'DEAD'
          ),
          enforcedEvent(
            repairEventId,
            'DIARY_GENERATE',
            originalBinding,
            {
              diaryDate: '2026-07-24',
              originalEventId: originalEventId
            },
            'DONE'
          )
        ],
        diaries: [{
          summary_date: '2026-07-24',
          diary_status: 'DONE',
          diary_doc_anchor: 'secret-anchor',
          diary_payload_json: {
            title: 'title',
            narrative: 'narrative',
            groundedSummary: 'summary',
            partnerWorldEvents: [],
            thingsToRemember: [],
            unresolvedFollowUps: []
          },
          diary_approval_json: approval(
            'DIARY',
            'generated',
            originalBinding
          ),
          diary_origin_event_id: originalEventId
        }]
      });

      assert(
        result.valid === true &&
          result.checked.diaries === 2 &&
          result.unsafePersistedOrSent.diaries === 0,
        'Normal DEAD-to-DONE diary repair was rejected.'
      );
    }
  );

  test(
    'diary repair with a different character binding cannot pass',
    function() {
      var originalBinding = binding(20);
      var changedBinding = binding(21);
      var originalEventId =
        '11111111-1111-4111-8111-111111111111';
      var repairEventId =
        '22222222-2222-4222-8222-222222222222';
      var result = inspect({
        events: [
          enforcedEvent(
            originalEventId,
            'DIARY_GENERATE',
            originalBinding,
            { diaryDate: '2026-07-24' },
            'DEAD'
          ),
          enforcedEvent(
            repairEventId,
            'DIARY_GENERATE',
            changedBinding,
            {
              diaryDate: '2026-07-24',
              originalEventId: originalEventId
            },
            'DONE'
          )
        ],
        diaries: [{
          summary_date: '2026-07-24',
          diary_status: 'DONE',
          diary_doc_anchor: 'secret-anchor',
          diary_payload_json: {
            title: 'title',
            narrative: 'narrative',
            groundedSummary: 'summary',
            partnerWorldEvents: [],
            thingsToRemember: [],
            unresolvedFollowUps: []
          },
          diary_approval_json: approval(
            'DIARY',
            'generated',
            originalBinding
          ),
          diary_origin_event_id: originalEventId
        }]
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.diaries === 2,
        'Binding-changing diary repair passed.'
      );
    }
  );

  test(
    'one DEAD chat origin plus one manual DONE retry remains valid',
    function() {
      var ids = {
        eventId:
          '11111111-1111-4111-8111-111111111111',
        requestId:
          '22222222-2222-4222-8222-222222222222',
        userMessageId:
          '33333333-3333-4333-8333-333333333333',
        assistantMessageId:
          '44444444-4444-4444-8444-444444444444'
      };
      var retryEventId =
        '55555555-5555-4555-8555-555555555555';
      var manualRequestId =
        '66666666-6666-4666-8666-666666666666';
      var graph = chatGraph(ids, 22);
      graph.event.status = 'DEAD';
      graph.event.payload.requestedAt =
        '2026-07-24T10:00:00+09:00';
      var retryEvent = enforcedEvent(
        retryEventId,
        'CHAT_REPLY',
        graph.event.payload.characterBinding,
        {
          requestId: ids.requestId,
          userMessageId: ids.userMessageId,
          requestedAt: '2026-07-24T11:00:00+09:00',
          image: null,
          manualRequestId: manualRequestId,
          originalEventId: ids.eventId
        },
        'DONE'
      );
      var result = inspect({
        events: [graph.event, retryEvent],
        conversations: graph.rows
      });

      assert(
        result.valid === true &&
          result.checked.chatMessages === 2 &&
          result.unsafePersistedOrSent.chatMessages === 0,
        'Normal DEAD-to-DONE chat retry was rejected.'
      );
    }
  );

  test(
    'manual chat retry with a different character binding cannot pass',
    function() {
      var ids = {
        eventId:
          '11111111-1111-4111-8111-111111111111',
        requestId:
          '22222222-2222-4222-8222-222222222222',
        userMessageId:
          '33333333-3333-4333-8333-333333333333',
        assistantMessageId:
          '44444444-4444-4444-8444-444444444444'
      };
      var retryEventId =
        '55555555-5555-4555-8555-555555555555';
      var manualRequestId =
        '66666666-6666-4666-8666-666666666666';
      var graph = chatGraph(ids, 23);
      var changedBinding = binding(24);
      graph.event.status = 'DEAD';
      var retryEvent = enforcedEvent(
        retryEventId,
        'CHAT_REPLY',
        changedBinding,
        {
          requestId: ids.requestId,
          userMessageId: ids.userMessageId,
          image: null,
          manualRequestId: manualRequestId,
          originalEventId: ids.eventId
        },
        'DONE'
      );
      var changedApprovalColumns = approvalColumns(
        approval(
          'CHAT_TEXT_SYNC',
          'generated',
          changedBinding
        )
      );
      Object.keys(changedApprovalColumns).forEach(
        function(key) {
          graph.rows[1][key] =
            changedApprovalColumns[key];
        }
      );
      var result = inspect({
        events: [graph.event, retryEvent],
        conversations: graph.rows
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.chatMessages === 1,
        'Binding-changing manual chat retry passed.'
      );
    }
  );

  test(
    'manual chat retry cannot drop a non-character completion route',
    function() {
      var ids = {
        eventId:
          '11111111-1111-4111-8111-111111111111',
        requestId:
          '22222222-2222-4222-8222-222222222222',
        userMessageId:
          '33333333-3333-4333-8333-333333333333',
        assistantMessageId:
          '44444444-4444-4444-8444-444444444444'
      };
      var retryEventId =
        '55555555-5555-4555-8555-555555555555';
      var manualRequestId =
        '66666666-6666-4666-8666-666666666666';
      var graph = chatGraph(ids, 25);
      graph.event.status = 'DEAD';
      graph.event.payload.completionRoute = 'PRODUCT_INFO';
      var retryEvent = enforcedEvent(
        retryEventId,
        'CHAT_REPLY',
        graph.event.payload.characterBinding,
        {
          requestId: ids.requestId,
          userMessageId: ids.userMessageId,
          image: null,
          manualRequestId: manualRequestId,
          originalEventId: ids.eventId
        },
        'DONE'
      );
      var result = inspect({
        events: [graph.event, retryEvent],
        conversations: graph.rows
      });

      assert(
        result.valid === false &&
          result.unsafePersistedOrSent.chatMessages === 1,
        'Route-changing manual chat retry passed.'
      );
    }
  );

  return results;
}

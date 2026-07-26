var ImmersionSafetyAuditService = (function() {
  var WINDOW_SOURCE = 'ALL_ENFORCED_EVENTS';
  var BINDING_FIELDS = Object.freeze([
    'policyVersion',
    'profileSchemaVersion',
    'profileRevision',
    'catalogVersion',
    'characterPackId',
    'characterPackVersion'
  ]);
  var PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
  var PACK_VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]{2,79}$/;

  function inspect() {
    try {
      return inspectRows_({
        events: SheetRepository.listEvents(),
        conversations: SheetRepository.getRows(
          APP_CONSTANTS.SHEETS.CONVERSATION_LOGS
        ),
        diaries: SheetRepository.getRows(
          APP_CONSTANTS.SHEETS.DAILY_SUMMARIES
        ),
        memories: SheetRepository.getRows(
          APP_CONSTANTS.SHEETS.LONG_TERM_MEMORIES
        )
      });
    } catch (ignored) {
      return buildResult_(
        false,
        emptyCounts_(),
        emptyCounts_(),
        ['INSPECTION_FAILED']
      );
    }
  }

  function inspectRows_(rows) {
    // The former test helper accepted (windowStart, rows). Keep accepting
    // that shape while deliberately ignoring the revision timestamp.
    if (arguments.length > 1) {
      rows = arguments[1];
    }
    rows = rows || {};
    var state = {
      checked: emptyCounts_(),
      unsafe: emptyCounts_(),
      enforcedEventCount: 0,
      unresolvedDelivery: false,
      graphInvalid: false
    };
    var graph = buildEventGraph_(rows.events || [], state);

    inspectChatGraphs_(
      graph,
      rows.conversations || [],
      state
    );
    inspectProactiveMarkers_(
      graph,
      rows.conversations || [],
      state
    );
    inspectDiaryGraphs_(
      graph,
      rows.diaries || [],
      state
    );
    inspectMemoryGraphs_(
      graph,
      rows.memories || [],
      state
    );

    state.checked.total = sumPrimaryCounts_(state.checked);
    state.unsafe.total = sumPrimaryCounts_(state.unsafe);

    var issues = [];
    if (state.enforcedEventCount === 0) {
      issues.push('NO_ENFORCED_EVENTS');
    }
    if (state.unsafe.total > 0 || state.graphInvalid) {
      issues.push('UNSAFE_PERSISTED_OR_SENT');
    }
    if (state.unresolvedDelivery) {
      issues.push('PROACTIVE_DELIVERY_UNRESOLVED');
    }

    return buildResult_(
      state.enforcedEventCount > 0 &&
        state.unsafe.total === 0 &&
        !state.graphInvalid &&
        !state.unresolvedDelivery,
      state.checked,
      state.unsafe,
      issues
    );
  }

  function buildEventGraph_(events, state) {
    var graph = {
      all: [],
      byId: {},
      chatByRequest: {},
      diaryByDate: {}
    };

    (events || []).forEach(function(rawEvent) {
      var event = normalizeEvent_(rawEvent || {});
      if (
        !event.payload ||
        event.payload.characterRuntimeMode !== 'enforced'
      ) {
        return;
      }

      state.enforcedEventCount += 1;
      event.bindingValid = isBindingValid_(
        event.payload.characterBinding
      );
      event.recordedUnsafe = {};
      graph.all.push(event);

      var bucket = bucketForEventType_(event.eventType);
      if (bucket) {
        state.checked[bucket] += 1;
        if (
          event.eventType === 'CHAT_REPLY' &&
          event.payload.image
        ) {
          state.checked.imageSummaries += 1;
        }
      } else {
        state.graphInvalid = true;
      }

      var basicValid =
        Validators.isUuidV4(String(event.eventId || '')) &&
        APP_CONSTANTS.EVENT_TYPES.indexOf(event.eventType) !== -1 &&
        APP_CONSTANTS.EVENT_STATUSES.indexOf(event.status) !== -1 &&
        event.bindingValid;
      if (!basicValid) {
        markEventUnsafe_(event, bucket, state);
      }

      var id = String(event.eventId || '');
      if (id) {
        if (graph.byId[id]) {
          markEventUnsafe_(
            graph.byId[id],
            bucketForEventType_(graph.byId[id].eventType),
            state
          );
          markEventUnsafe_(event, bucket, state);
        } else {
          graph.byId[id] = event;
        }
      }

      if (event.eventType === 'CHAT_REPLY') {
        var requestId = String(event.payload.requestId || '');
        if (
          !Validators.isUuidV4(requestId) ||
          !Validators.isUuidV4(
            String(event.payload.userMessageId || '')
          )
        ) {
          markEventUnsafe_(event, 'chatMessages', state);
        } else {
          addToIndex_(graph.chatByRequest, requestId, event);
        }
      } else if (event.eventType === 'DIARY_GENERATE') {
        var diaryDate = String(event.payload.diaryDate || '');
        if (!Validators.isDateString(diaryDate)) {
          markEventUnsafe_(event, 'diaries', state);
        } else {
          addToIndex_(graph.diaryByDate, diaryDate, event);
        }
      }
    });

    return graph;
  }

  function inspectChatGraphs_(graph, rows, state) {
    var seenRows = {};
    Object.keys(graph.chatByRequest).forEach(function(requestId) {
      var events = graph.chatByRequest[requestId];
      var matching = [];
      (rows || []).forEach(function(row, index) {
        if (
          String((row || {}).request_id || '') === requestId &&
          (
            row.role === 'user' ||
            row.role === 'assistant'
          )
        ) {
          matching.push({ row: row || {}, index: index });
          seenRows[index] = true;
        }
      });

      var users = matching.filter(function(item) {
        return item.row.role === 'user';
      });
      var assistants = matching.filter(function(item) {
        return item.row.role === 'assistant';
      });
      var doneEvents = events.filter(function(event) {
        return event.status === 'DONE';
      });
      var routedEvents = doneEvents.filter(function(event) {
        return isNonCharacterRoute_(
          event.payload.completionRoute
        );
      });
      events.forEach(function(event) {
        var hasManualRequestId =
          event.payload.manualRequestId != null;
        var hasOriginalEventId =
          event.payload.originalEventId != null;
        if (
          hasManualRequestId !== hasOriginalEventId ||
          (
            hasManualRequestId &&
            !isValidChatManualRetry_(
              event,
              graph.byId[
                String(event.payload.originalEventId)
              ] || null
            )
          )
        ) {
          markEventUnsafe_(
            event,
            'chatMessages',
            state
          );
        }
      });

      if (users.length !== 1) {
        markEventsUnsafe_(events, 'chatMessages', state);
      }
      if (assistants.length > 1 || doneEvents.length > 1) {
        markEventsUnsafe_(events, 'chatMessages', state);
      }

      if (routedEvents.length > 0) {
        if (
          routedEvents.length !== 1 ||
          assistants.length !== 0 ||
          users.length !== 1 ||
          !isApprovalAbsentFromConversation_(users[0].row) ||
          String(
            routedEvents[0].payload.userMessageId || ''
          ) !== String(users[0].row.message_id || '')
        ) {
          markEventsUnsafe_(routedEvents, 'chatMessages', state);
        }
        return;
      }

      if (assistants.length === 0) {
        if (doneEvents.length > 0) {
          markEventsUnsafe_(doneEvents, 'chatMessages', state);
          doneEvents.forEach(function(event) {
            if (event.payload.image) {
              markEventUnsafe_(
                event,
                'imageSummaries',
                state
              );
            }
          });
        }
        return;
      }

      var assistant = assistants[0].row;
      var approvalInfo =
        conversationApprovalInfo_(assistant);
      var owner = events.filter(function(event) {
        return event.status === 'DONE' &&
          event.bindingValid &&
          approvalInfo.complete &&
          approvalMatchesBinding_(
            approvalInfo.approval,
            event.payload.characterBinding
          );
      })[0] || null;

      if (!owner) {
        markEventsUnsafe_(events, 'chatMessages', state);
        return;
      }

      var user = users.length === 1 ? users[0].row : null;
      var assistantValid =
        owner.status === 'DONE' &&
        assistant.message_type === 'text' &&
        assistant.status === 'completed' &&
        String(assistant.text || '').trim() !== '' &&
        user != null &&
        String(assistant.reply_to_message_id || '') ===
          String(user.message_id || '') &&
        String(owner.payload.userMessageId || '') ===
          String(user.message_id || '') &&
        isApprovalValid_(
          approvalInfo.approval,
          owner.payload.image
            ? ['CHAT_IMAGE']
            : ['CHAT_TEXT_SYNC', 'CHAT_TEXT_QUEUED'],
          owner.payload.characterBinding
        );
      if (!assistantValid) {
        markEventUnsafe_(owner, 'chatMessages', state);
      }

      if (owner.payload.image) {
        var userApprovalInfo =
          conversationApprovalInfo_(user || {});
        if (
          !user ||
          user.message_type !== 'image' ||
          String(user.image_summary || '').trim() === '' ||
          !userApprovalInfo.complete ||
          !approvalsEqual_(
            userApprovalInfo.approval,
            approvalInfo.approval
          )
        ) {
          markEventUnsafe_(
            owner,
            'imageSummaries',
            state
          );
        }
      } else if (
        user &&
        !isApprovalAbsentFromConversation_(user)
      ) {
        markEventUnsafe_(owner, 'chatMessages', state);
      }

      if (
        doneEvents.length === 1 &&
        doneEvents[0] !== owner
      ) {
        markEventUnsafe_(
          doneEvents[0],
          'chatMessages',
          state
        );
      }
    });

    (rows || []).forEach(function(row, index) {
      row = row || {};
      if (seenRows[index]) {
        return;
      }
      if (row.role !== 'user' && row.role !== 'assistant') {
        return;
      }
      var info = conversationApprovalInfo_(row);
      if (info.populated === 0) {
        return;
      }
      if (row.role === 'assistant') {
        state.checked.chatMessages += 1;
        state.unsafe.chatMessages += 1;
      } else if (
        row.role === 'user' &&
        row.message_type === 'image'
      ) {
        state.checked.imageSummaries += 1;
        state.unsafe.imageSummaries += 1;
      } else {
        state.graphInvalid = true;
      }
    });
  }

  function inspectProactiveMarkers_(graph, rows, state) {
    (rows || []).forEach(function(row) {
      row = row || {};
      if (
        row.role !== 'system' ||
        row.message_type !== 'proactive'
      ) {
        return;
      }
      var approvalInfo = conversationApprovalInfo_(row);
      var origin = String(
        row.proactive_origin_event_id || ''
      );
      var hasOrigin = origin !== '';
      if (approvalInfo.populated === 0 && !hasOrigin) {
        return;
      }

      var event = graph.byId[origin] || null;
      if (
        !event ||
        event.eventType !== 'PROACTIVE_SEND' ||
        !event.payload ||
        event.payload.characterRuntimeMode !== 'enforced'
      ) {
        state.checked.proactiveMarkers += 1;
        state.unsafe.proactiveMarkers += 1;
        if (row.status === 'completed') {
          state.checked.sentProactiveMarkers += 1;
          state.unsafe.sentProactiveMarkers += 1;
        }
        return;
      }

      var valid =
        Validators.isUuidV4(origin) &&
        String(row.request_id || '') !== '' &&
        String(row.request_id || '') ===
          String(
            event.payload.messageDedupeKey || ''
          ) &&
        approvalInfo.complete &&
        String(row.text || '').trim() !== '' &&
        String(row.proactive_subject || '').trim() !== '' &&
        isApprovalValid_(
          approvalInfo.approval,
          ['PROACTIVE_AI', 'PROACTIVE_RETRY'],
          approvalInfo.approval &&
            approvalInfo.approval.surface === 'PROACTIVE_RETRY'
            ? null
            : event.payload.characterBinding
        );
      if (
        row.status === 'completed' &&
        event.status !== 'DONE'
      ) {
        valid = false;
      }
      if (!valid) {
        markEventUnsafe_(
          event,
          'proactiveMarkers',
          state
        );
      }

      if (row.status === 'completed') {
        state.checked.sentProactiveMarkers += 1;
        if (!valid) {
          state.unsafe.sentProactiveMarkers += 1;
        }
      } else if (
        row.status === 'accepted' ||
        (
          row.status === 'failed' &&
          row.error_code !== 'PROACTIVE_RETRY_QUARANTINED'
        )
      ) {
        state.unresolvedDelivery = true;
      } else if (
        !(
          row.status === 'failed' &&
          row.error_code === 'PROACTIVE_RETRY_QUARANTINED'
        )
      ) {
        markEventUnsafe_(
          event,
          'proactiveMarkers',
          state
        );
      }
    });
  }

  function inspectDiaryGraphs_(graph, rows, state) {
    var seenRows = {};
    Object.keys(graph.diaryByDate).forEach(function(diaryDate) {
      var events = graph.diaryByDate[diaryDate];
      var matching = [];
      (rows || []).forEach(function(row, index) {
        if (
          String((row || {}).summary_date || '') === diaryDate
        ) {
          matching.push({ row: row || {}, index: index });
          seenRows[index] = true;
        }
      });
      var doneEvents = events.filter(function(event) {
        return event.status === 'DONE';
      });
      events.forEach(function(event) {
        var originalId = String(
          event.payload.originalEventId || ''
        );
        if (
          originalId !== '' &&
          !isValidDiaryRepair_(
            event,
            graph.byId[originalId] || null,
            diaryDate
          )
        ) {
          markEventUnsafe_(event, 'diaries', state);
        }
      });
      if (doneEvents.length > 1) {
        markEventsUnsafe_(doneEvents, 'diaries', state);
      }

      if (matching.length === 0) {
        markEventsUnsafe_(doneEvents, 'diaries', state);
        return;
      }
      if (matching.length > 1) {
        markEventsUnsafe_(events, 'diaries', state);
        return;
      }

      var row = matching[0].row;
      var provenance = diaryProvenance_(row);
      if (!provenance.present) {
        if (
          doneEvents.length > 0 &&
          row.diary_status !== 'NONE'
        ) {
          markEventsUnsafe_(doneEvents, 'diaries', state);
        }
        return;
      }

      var origin = String(row.diary_origin_event_id || '');
      var originEvent = graph.byId[origin] || null;
      var stableCompletionEvent = null;
      if (originEvent && originEvent.status === 'DONE') {
        stableCompletionEvent = originEvent;
      } else if (originEvent) {
        stableCompletionEvent = doneEvents.filter(
          function(event) {
            return isValidDiaryRepair_(
              event,
              originEvent,
              diaryDate
            );
          }
        )[0] || null;
      }
      var valid =
        provenance.complete &&
        originEvent &&
        originEvent.eventType === 'DIARY_GENERATE' &&
        stableCompletionEvent != null &&
        String(originEvent.payload.diaryDate || '') === diaryDate &&
        isApprovalValid_(
          row.diary_approval_json,
          ['DIARY'],
          originEvent.payload.characterBinding
        ) &&
        isDiaryPayloadValid_(row.diary_payload_json);
      if (
        row.diary_status === 'DONE' &&
        String(row.diary_doc_anchor || '').trim() === ''
      ) {
        valid = false;
      }
      if (
        doneEvents.length > 0 &&
        row.diary_status !== 'DONE'
      ) {
        valid = false;
      }
      if (!valid) {
        markEventsUnsafe_(
          originEvent ? [originEvent] : events,
          'diaries',
          state
        );
      }
    });

    (rows || []).forEach(function(row, index) {
      if (seenRows[index]) {
        return;
      }
      var provenance = diaryProvenance_(row || {});
      if (!provenance.present) {
        return;
      }
      state.checked.diaries += 1;
      state.unsafe.diaries += 1;
    });
  }

  function inspectMemoryGraphs_(graph, rows, state) {
    (graph.all || []).forEach(function(event) {
      if (event.eventType !== 'MEMORY_EXTRACT') {
        return;
      }
      var hasManualRequestId =
        event.payload.manualRequestId != null;
      var hasOriginalEventId =
        event.payload.originalEventId != null;
      if (
        hasManualRequestId !== hasOriginalEventId ||
        (
          hasManualRequestId &&
          !isValidMemoryRepair_(
            event,
            graph.byId[
              String(event.payload.originalEventId)
            ] || null
          )
        )
      ) {
        markEventUnsafe_(event, 'memories', state);
      }
    });

    (rows || []).forEach(function(row) {
      row = row || {};
      var approvalPresent = row.memory_approval_json != null;
      var originsPresent =
        row.memory_origin_event_ids_json != null;
      if (!approvalPresent && !originsPresent) {
        return;
      }

      var origins = row.memory_origin_event_ids_json;
      var originEvents = [];
      var validOrigins =
        Array.isArray(origins) &&
        origins.length > 0 &&
        origins.length <= 100 &&
        origins.every(function(value, index) {
          var id = String(value || '');
          var event = graph.byId[id] || null;
          if (
            !Validators.isUuidV4(id) ||
            origins.indexOf(value) !== index ||
            !event ||
            event.eventType !== 'MEMORY_EXTRACT'
          ) {
            return false;
          }
          originEvents.push(event);
          return true;
        });
      var latestEvent = validOrigins
        ? originEvents[originEvents.length - 1]
        : null;
      var valid =
        approvalPresent &&
        originsPresent &&
        validOrigins &&
        isApprovedMemoryRow_(
          row,
          latestEvent.payload.characterBinding,
          originEvents
        );
      if (!valid) {
        if (latestEvent) {
          markEventUnsafe_(
            latestEvent,
            'memories',
            state
          );
        } else {
          state.checked.memories += 1;
          state.unsafe.memories += 1;
        }
      }
    });
  }

  function normalizeEvent_(event) {
    return {
      eventId: event.eventId != null
        ? event.eventId
        : event.event_id,
      eventType: event.eventType != null
        ? event.eventType
        : event.event_type,
      payload: event.payload != null
        ? event.payload
        : event.payload_json,
      status: event.status
    };
  }

  function bucketForEventType_(eventType) {
    if (eventType === 'CHAT_REPLY') {
      return 'chatMessages';
    }
    if (eventType === 'PROACTIVE_SEND') {
      return 'proactiveMarkers';
    }
    if (eventType === 'DIARY_GENERATE') {
      return 'diaries';
    }
    if (eventType === 'MEMORY_EXTRACT') {
      return 'memories';
    }
    return null;
  }

  function addToIndex_(index, key, value) {
    if (!index[key]) {
      index[key] = [];
    }
    index[key].push(value);
  }

  function markEventsUnsafe_(events, bucket, state) {
    (events || []).forEach(function(event) {
      markEventUnsafe_(event, bucket, state);
    });
  }

  function markEventUnsafe_(event, bucket, state) {
    state.graphInvalid = true;
    if (!event || !bucket) {
      return;
    }
    if (!event.recordedUnsafe) {
      event.recordedUnsafe = {};
    }
    if (!event.recordedUnsafe[bucket]) {
      event.recordedUnsafe[bucket] = true;
      state.unsafe[bucket] += 1;
    }
  }

  function conversationApprovalInfo_(row) {
    var columns = APP_CONSTANTS.CHARACTER.APPROVAL_COLUMNS;
    var populated = columns.filter(function(column) {
      return row[column] != null && row[column] !== '';
    }).length;
    if (populated !== columns.length) {
      return {
        populated: populated,
        complete: false,
        approval: null
      };
    }
    return {
      populated: populated,
      complete: true,
      approval: {
        surface: row.approval_surface,
        source: row.approval_source,
        policyVersion: row.approval_policy_version,
        profileSchemaVersion:
          row.approval_profile_schema_version,
        profileRevision: row.approval_profile_revision,
        catalogVersion: row.approval_catalog_version,
        characterPackId: row.approval_character_pack_id,
        characterPackVersion:
          row.approval_character_pack_version
      }
    };
  }

  function isApprovalAbsentFromConversation_(row) {
    return conversationApprovalInfo_(row || {}).populated === 0;
  }

  function isApprovalValid_(
    approval,
    allowedSurfaces,
    binding
  ) {
    if (
      !isPlainObject_(approval) ||
      !hasExactKeys_(
        approval,
        APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS
      ) ||
      allowedSurfaces.indexOf(approval.surface) === -1 ||
      APP_CONSTANTS.CHARACTER.ARTIFACT_SOURCES.indexOf(
        approval.source
      ) === -1 ||
      approval.policyVersion !==
        APP_CONSTANTS.CHARACTER.POLICY_VERSION ||
      approval.profileSchemaVersion !==
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION ||
      approval.catalogVersion !==
        APP_CONSTANTS.CHARACTER.CATALOG_VERSION ||
      !isPositiveSafeInteger_(approval.profileRevision) ||
      typeof approval.characterPackId !== 'string' ||
      !PACK_ID_PATTERN.test(approval.characterPackId) ||
      typeof approval.characterPackVersion !== 'string' ||
      !PACK_VERSION_PATTERN.test(
        approval.characterPackVersion
      ) ||
      !isActivePackBinding_(
        approval.characterPackId,
        approval.characterPackVersion
      )
    ) {
      return false;
    }

    if (approval.surface === 'PROACTIVE_AI') {
      if (
        approval.source !== 'generated' &&
        approval.source !== 'rewrite'
      ) {
        return false;
      }
    } else if (approval.surface === 'PROACTIVE_RETRY') {
      if (approval.source !== 'legacy_revalidated') {
        return false;
      }
    } else if (
      approval.surface === 'DIARY' ||
      approval.surface === 'MEMORY_EXTRACTION'
    ) {
      if (
        approval.source !== 'generated' &&
        approval.source !== 'rewrite'
      ) {
        return false;
      }
    } else if (approval.source === 'legacy_revalidated') {
      return false;
    }

    return binding == null ||
      (
        isBindingValid_(binding) &&
        approvalMatchesBinding_(approval, binding)
      );
  }

  function isBindingValid_(binding) {
    return isPlainObject_(binding) &&
      hasExactKeys_(binding, BINDING_FIELDS) &&
      binding.policyVersion ===
        APP_CONSTANTS.CHARACTER.POLICY_VERSION &&
      binding.profileSchemaVersion ===
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION &&
      isPositiveSafeInteger_(binding.profileRevision) &&
      binding.catalogVersion ===
        APP_CONSTANTS.CHARACTER.CATALOG_VERSION &&
      typeof binding.characterPackId === 'string' &&
      PACK_ID_PATTERN.test(binding.characterPackId) &&
      typeof binding.characterPackVersion === 'string' &&
      PACK_VERSION_PATTERN.test(binding.characterPackVersion) &&
      isActivePackBinding_(
        binding.characterPackId,
        binding.characterPackVersion
      );
  }

  function approvalMatchesBinding_(approval, binding) {
    return Boolean(
      approval &&
      binding &&
      approval.policyVersion === binding.policyVersion &&
      approval.profileSchemaVersion ===
        binding.profileSchemaVersion &&
      Number(approval.profileRevision) ===
        Number(binding.profileRevision) &&
      approval.catalogVersion === binding.catalogVersion &&
      approval.characterPackId === binding.characterPackId &&
      approval.characterPackVersion ===
        binding.characterPackVersion
    );
  }

  function approvalsEqual_(left, right) {
    return Boolean(
      left &&
      right &&
      APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS.every(
        function(field) {
          return left[field] === right[field];
        }
      )
    );
  }

  function diaryProvenance_(row) {
    var hasPayload = row.diary_payload_json != null;
    var hasApproval = row.diary_approval_json != null;
    var hasOrigin =
      String(row.diary_origin_event_id || '').trim() !== '';
    return {
      present: hasPayload || hasApproval || hasOrigin,
      complete: hasPayload && hasApproval && hasOrigin
    };
  }

  function isDiaryPayloadValid_(payload) {
    try {
      var normalized = CharacterPayloadService.normalize(
        'DIARY',
        payload
      );
      return JSON.stringify(normalized) ===
        JSON.stringify(payload);
    } catch (ignored) {
      return false;
    }
  }

  function isApprovedMemoryRow_(
    row,
    binding,
    originEvents
  ) {
    var sourceUnion = {};
    var originsStable = (originEvents || []).length > 0 &&
      originEvents.every(function(event) {
        if (
          !event ||
          event.status !== 'DONE' ||
          !event.payload ||
          !isUniqueUuidList_(
            event.payload.sourceMessageIds
          )
        ) {
          return false;
        }
        event.payload.sourceMessageIds.forEach(function(id) {
          sourceUnion[String(id)] = true;
        });
        return true;
      });
    return row.status === 'active' &&
      originsStable &&
      Validators.isUuidV4(String(row.memory_id || '')) &&
      APP_CONSTANTS.MEMORY_CATEGORIES.indexOf(row.category) !== -1 &&
      typeof row.normalized_key === 'string' &&
      row.normalized_key.trim() !== '' &&
      typeof row.content === 'string' &&
      row.content.trim() !== '' &&
      isUniqueUuidList_(row.source_message_ids_json) &&
      row.source_message_ids_json.every(function(id) {
        return sourceUnion[String(id)] === true;
      }) &&
      isApprovalValid_(
        row.memory_approval_json,
        ['MEMORY_EXTRACTION'],
        binding
      );
  }

  function isValidMemoryRepair_(
    repairEvent,
    originEvent
  ) {
    if (
      !repairEvent ||
      !originEvent ||
      !repairEvent.payload ||
      !originEvent.payload
    ) {
      return false;
    }
    return Boolean(
      Validators.isUuidV4(
        String(
          repairEvent.payload.manualRequestId || ''
        )
      ) &&
        Validators.isUuidV4(
          String(
            repairEvent.payload.originalEventId || ''
          )
        ) &&
        String(repairEvent.payload.originalEventId) ===
          String(originEvent.eventId || '') &&
        originEvent.eventType === 'MEMORY_EXTRACT' &&
        originEvent.status === 'DEAD' &&
        originEvent.payload.characterRuntimeMode ===
          'enforced' &&
        repairEvent.payload.characterRuntimeMode ===
          originEvent.payload.characterRuntimeMode &&
        repairEvent.payload.firstMessageId ===
          originEvent.payload.firstMessageId &&
        repairEvent.payload.lastMessageId ===
          originEvent.payload.lastMessageId &&
        JSON.stringify(
          repairEvent.payload.sourceMessageIds
        ) === JSON.stringify(
          originEvent.payload.sourceMessageIds
        ) &&
        repairEvent.payload.requestedAt ===
          originEvent.payload.requestedAt &&
        bindingsEqual_(
          repairEvent.payload.characterBinding,
          originEvent.payload.characterBinding
        )
    );
  }

  function isUniqueUuidList_(value) {
    return Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 100 &&
      value.every(function(id, index) {
        return Validators.isUuidV4(String(id || '')) &&
          value.indexOf(id) === index;
      });
  }

  function isNonCharacterRoute_(value) {
    return value === 'PRODUCT_INFO' ||
      value === 'ADMIN_OOC';
  }

  function isValidChatManualRetry_(
    retryEvent,
    originEvent
  ) {
    if (
      !retryEvent ||
      !originEvent ||
      !retryEvent.payload ||
      !originEvent.payload
    ) {
      return false;
    }
    return Boolean(
      Validators.isUuidV4(
        String(retryEvent.payload.manualRequestId || '')
      ) &&
      Validators.isUuidV4(
        String(retryEvent.payload.originalEventId || '')
      ) &&
      String(retryEvent.payload.originalEventId) ===
        String(originEvent.eventId || '') &&
      originEvent.eventType === 'CHAT_REPLY' &&
      originEvent.status === 'DEAD' &&
      originEvent.payload.characterRuntimeMode ===
        'enforced' &&
      retryEvent.payload.characterRuntimeMode ===
        originEvent.payload.characterRuntimeMode &&
      String(retryEvent.payload.requestId || '') ===
        String(originEvent.payload.requestId || '') &&
      String(retryEvent.payload.userMessageId || '') ===
        String(originEvent.payload.userMessageId || '') &&
      normalizeNullableString_(
        retryEvent.payload.completionRoute
      ) === normalizeNullableString_(
        originEvent.payload.completionRoute
      ) &&
      bindingsEqual_(
        retryEvent.payload.characterBinding,
        originEvent.payload.characterBinding
      ) &&
      jsonValuesEqual_(
        retryEvent.payload.image == null
          ? null
          : retryEvent.payload.image,
        originEvent.payload.image == null
          ? null
          : originEvent.payload.image
      )
    );
  }

  function jsonValuesEqual_(left, right) {
    if (left === right) {
      return true;
    }
    if (
      left == null ||
      right == null ||
      typeof left !== typeof right
    ) {
      return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every(function(value, index) {
          return jsonValuesEqual_(value, right[index]);
        });
    }
    if (
      typeof left !== 'object' ||
      typeof right !== 'object'
    ) {
      return false;
    }
    var leftKeys = Object.keys(left).sort();
    var rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every(function(key, index) {
        return key === rightKeys[index] &&
          jsonValuesEqual_(left[key], right[key]);
      });
  }

  function normalizeNullableString_(value) {
    return value == null ? null : String(value);
  }

  function isValidDiaryRepair_(
    repairEvent,
    originEvent,
    diaryDate
  ) {
    return Boolean(
      repairEvent &&
      originEvent &&
      repairEvent.eventType === 'DIARY_GENERATE' &&
      originEvent.eventType === 'DIARY_GENERATE' &&
      originEvent.status === 'DEAD' &&
      String(repairEvent.payload.diaryDate || '') === diaryDate &&
      String(originEvent.payload.diaryDate || '') === diaryDate &&
      String(
        repairEvent.payload.originalEventId || ''
      ) === String(originEvent.eventId || '') &&
      bindingsEqual_(
        repairEvent.payload.characterBinding,
        originEvent.payload.characterBinding
      )
    );
  }

  function bindingsEqual_(left, right) {
    return Boolean(
      left &&
      right &&
      BINDING_FIELDS.every(function(field) {
        return left[field] === right[field];
      })
    );
  }

  function isActivePackBinding_(packId, packVersion) {
    try {
      var active = CharacterPackService.getActive();
      return Boolean(
        active &&
        packId === active.packId &&
        packVersion === active.packVersion
      );
    } catch (ignored) {
      return false;
    }
  }

  function hasExactKeys_(value, fields) {
    var keys = Object.keys(value || {});
    return keys.length === fields.length &&
      fields.every(function(field) {
        return Object.prototype.hasOwnProperty.call(
          value,
          field
        );
      });
  }

  function isPlainObject_(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype ||
      prototype === null;
  }

  function emptyCounts_() {
    return {
      chatMessages: 0,
      imageSummaries: 0,
      proactiveMarkers: 0,
      sentProactiveMarkers: 0,
      diaries: 0,
      memories: 0,
      total: 0
    };
  }

  function sumPrimaryCounts_(counts) {
    return counts.chatMessages +
      counts.imageSummaries +
      counts.proactiveMarkers +
      counts.diaries +
      counts.memories;
  }

  function buildResult_(valid, checked, unsafe, issues) {
    return {
      valid: Boolean(valid),
      windowSource: WINDOW_SOURCE,
      checked: checked,
      unsafePersistedOrSent: unsafe,
      metrics: {
        immersion_unsafe_persisted_or_sent_total:
          unsafe.total
      },
      issues: issues.slice()
    };
  }

  function isPositiveSafeInteger_(value) {
    var number = Number(value);
    return isFinite(number) &&
      Math.floor(number) === number &&
      number > 0 &&
      number <= 9007199254740991;
  }

  return Object.freeze({
    inspect: inspect,
    __test: Object.freeze({
      inspectRows: inspectRows_,
      isApprovalValid: isApprovalValid_,
      isBindingValid: isBindingValid_
    })
  });
})();

var DiaryService = (function() {
  var DEFAULTS = Object.freeze({
    memoryLimit: 5
  });

  function enqueue(diaryDate) {
    var normalizedDate = normalizeDiaryDate_(diaryDate);
    var requestedAt = toIsoStringInTokyo(new Date());
    var dedupeKey = buildDedupeKey_(normalizedDate);
    var event = {
      eventId: generateUuidV4(),
      eventType: 'DIARY_GENERATE',
      dedupeKey: dedupeKey,
      payload: {
        diaryDate: normalizedDate,
        requestedAt: requestedAt
      },
      status: 'PENDING',
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: requestedAt,
      updatedAt: requestedAt,
      completedAt: null,
      lastError: null
    };

    try {
      SheetRepository.insertEvent(event);
    } catch (error) {
      var normalized = normalizeError(error);
      if (normalized.code !== 'DUPLICATE_REQUEST') {
        throw normalized;
      }
      var existing = SheetRepository.getActiveEventByDedupeKey(dedupeKey);
      return {
        enqueued: false,
        duplicate: true,
        eventId: existing ? existing.eventId : null,
        dedupeKey: dedupeKey,
        diaryDate: normalizedDate
      };
    }

    markDailySummaryPending_(normalizedDate, requestedAt);
    return {
      enqueued: true,
      duplicate: false,
      eventId: event.eventId,
      dedupeKey: dedupeKey,
      diaryDate: normalizedDate
    };
  }

  function isGenerated(diaryDate) {
    var normalizedDate = normalizeDiaryDate_(diaryDate);
    var summary = SheetRepository.getDailySummary(normalizedDate);
    if (summary && summary.diary_status === 'DONE') {
      return true;
    }
    return Boolean(DocumentRepository.findDiaryEntryAnchor(normalizedDate));
  }

  function generate(eventPayload) {
    var payload = validateGeneratePayload_(eventPayload);
    var diaryDate = payload.diaryDate;
    var warnings = [];
    var existingState = getDiaryState_(diaryDate);

    if (existingState.generated) {
      return repairGeneratedDiaryState_(diaryDate, null, null, warnings);
    }

    var messages = SheetRepository.listMessagesByDate(diaryDate);
    var diaryConfig = loadDiaryConfig_();
    var includePartnerWorld = shouldIncludePartnerWorld_(diaryDate, diaryConfig);

    if (messages.length === 0 && !includePartnerWorld) {
      warnings.push('No conversation messages were found and Partner World was not selected for the diary date.');
      return buildSkippedResult_(diaryDate, warnings);
    }

    var relevantMemories = [];
    if (messages.length > 0) {
      var query = messages.map(function(message) {
        return String(message.text || '');
      }).join(' ');

      try {
        relevantMemories = typeof MemoryService !== 'undefined' && MemoryService && MemoryService.findRelevant
          ? MemoryService.findRelevant(query, DEFAULTS.memoryLimit)
          : [];
      } catch (error) {
        warnings.push('Relevant memories could not be loaded.');
      }
    }

    var recentDiarySummaries = loadRecentDiarySummaries_(
      diaryDate,
      diaryConfig.partnerWorldRecentDiaryLimit,
      warnings
    );
    var generation = GeminiClient.generateStructured(
      buildDiaryRequest_(
        diaryDate,
        messages,
        relevantMemories,
        recentDiarySummaries,
        diaryConfig
      ),
      'diary-entry'
    );
    var diary = normalizeDiaryEntry_(generation.data, includePartnerWorld);
    return LockManager.withScriptLock('diary-generate-' + diaryDate, function() {
      var currentState = getDiaryState_(diaryDate);
      if (currentState.generated) {
        return repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, null, warnings);
      }

      var renderedBody = renderDiaryBody_(diary);
      var appendResult = DocumentRepository.appendDiaryEntry({
        diaryDate: diaryDate,
        title: diary.title,
        body: renderedBody
      });
      if (!appendResult.appended) {
        return repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, appendResult.anchor, warnings, appendResult.documentId);
      }

      persistDiarySummary_(diaryDate, messages, diary, appendResult.anchor);
      return {
        generated: true,
        skipped: false,
        diaryDate: diaryDate,
        documentId: appendResult.documentId,
        summaryId: diaryDate,
        warnings: warnings
      };
    });
  }

  function markDailySummaryPending_(diaryDate, now) {
    var existing = SheetRepository.getDailySummary(diaryDate);
    SheetRepository.upsertDailySummary({
      summaryDate: diaryDate,
      conversationCount: existing ? existing.conversation_count : 0,
      summaryText: existing ? existing.summary_text : null,
      keyTopics: existing ? existing.key_topics_json : null,
      memoryCandidateCount: existing ? existing.memory_candidate_count : 0,
      diaryStatus: isGenerated(diaryDate) ? 'DONE' : 'PENDING',
      diaryDocAnchor: existing ? existing.diary_doc_anchor : null,
      createdAt: existing ? existing.created_at : now,
      updatedAt: now
    });
  }

  function validateGeneratePayload_(payload) {
    payload = payload || {};
    ensure(Validators.isDateString(payload.diaryDate), 'VALIDATION_REQUEST_INVALID', 'eventPayload.diaryDate must be a yyyy-MM-dd string.');
    ensure(Validators.isIsoDateTimeString(payload.requestedAt), 'VALIDATION_REQUEST_INVALID', 'eventPayload.requestedAt must be an ISO 8601 string.');
    return {
      diaryDate: payload.diaryDate,
      requestedAt: payload.requestedAt
    };
  }

  function getDiaryState_(diaryDate) {
    var summary = SheetRepository.getDailySummary(diaryDate);
    var anchor = summary && summary.diary_doc_anchor
      ? String(summary.diary_doc_anchor)
      : DocumentRepository.findDiaryEntryAnchor(diaryDate);
    return {
      generated: Boolean((summary && summary.diary_status === 'DONE') || anchor),
      summary: summary,
      anchor: anchor || null
    };
  }

  function repairGeneratedDiaryState_(diaryDate, messages, anchorOverride, warnings, documentId) {
    var normalizedWarnings = warnings || [];
    return LockManager.withScriptLock('diary-generate-' + diaryDate, function() {
      return repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, anchorOverride, normalizedWarnings, documentId);
    });
  }

  function repairGeneratedDiaryStateWithoutLock_(diaryDate, messages, anchorOverride, warnings, documentId) {
    var state = getDiaryState_(diaryDate);
    var anchor = anchorOverride || state.anchor || DocumentRepository.findDiaryEntryAnchor(diaryDate);
    if (anchor) {
      persistDiaryDoneFromExisting_(diaryDate, messages, state.summary, anchor);
    }
    return buildSkippedResult_(diaryDate, warnings || [], documentId || null);
  }

  function persistDiarySummary_(diaryDate, messages, diary, anchor) {
    var now = toIsoStringInTokyo(new Date());
    var existingSummary = SheetRepository.getDailySummary(diaryDate);
    SheetRepository.upsertDailySummary({
      summaryDate: diaryDate,
      conversationCount: messages.length,
      summaryText: summarizeDiaryForSheet_(diary),
      keyTopics: normalizeTopics_(diary.thingsToRemember.concat(diary.unresolvedFollowUps)),
      memoryCandidateCount: existingSummary ? Number(existingSummary.memory_candidate_count || 0) : 0,
      diaryStatus: 'DONE',
      diaryDocAnchor: anchor,
      createdAt: existingSummary ? existingSummary.created_at : now,
      updatedAt: now
    });
    SheetRepository.updateUserState({
      last_diary_date: diaryDate
    });
  }

  function persistDiaryDoneFromExisting_(diaryDate, messages, existingSummary, anchor) {
    var now = toIsoStringInTokyo(new Date());
    var messageRows = messages || SheetRepository.listMessagesByDate(diaryDate);
    SheetRepository.upsertDailySummary({
      summaryDate: diaryDate,
      conversationCount: existingSummary ? Number(existingSummary.conversation_count || 0) : messageRows.length,
      summaryText: existingSummary ? existingSummary.summary_text : null,
      keyTopics: existingSummary ? existingSummary.key_topics_json : null,
      memoryCandidateCount: existingSummary ? Number(existingSummary.memory_candidate_count || 0) : 0,
      diaryStatus: 'DONE',
      diaryDocAnchor: anchor,
      createdAt: existingSummary ? existingSummary.created_at : now,
      updatedAt: now
    });
    SheetRepository.updateUserState({
      last_diary_date: diaryDate
    });
  }

  function buildDiaryRequest_(diaryDate, messages, memories, recentDiarySummaries, configOverride) {
    var config = configOverride || loadDiaryConfig_();
    var recentSummaries = Array.isArray(recentDiarySummaries)
      ? recentDiarySummaries
      : [];
    var includePartnerWorld = shouldIncludePartnerWorld_(diaryDate, config);

    return {
      systemInstruction: [
        'Write a private diary entry for the configured AI partner.',
        'Return JSON only.',
        'Required fields: title, narrative, groundedSummary, partnerWorldEvents, thingsToRemember, unresolvedFollowUps.',
        'narrative is the natural private diary text rendered to Google Docs.',
        'groundedSummary must contain only facts supported by conversation logs or relevant memories.',
        'When there are no supported user facts, groundedSummary must be an empty string.',
        'partnerWorldEvents must contain only fictional partner-side events and must not contain unsupported user facts.',
        'Partner display name: ' + config.partnerName,
        'User display name: ' + config.userName,
        'System persona: ' + config.systemPersona,
        'Diary style: ' + config.diaryStyle,
        'Target length: ' + config.minChars + ' to ' + config.maxChars + ' characters for the combined diary narrative.',
        'Partner World enabled: ' + config.partnerWorldEnabled,
        'Partner World diary frequency: ' + config.partnerWorldDiaryFrequency,
        'Partner World selected for this diary: ' + includePartnerWorld,
        'Partner World style: ' + config.partnerWorldStyle,
        'Partner-side fictional events are allowed only when Partner World selected for this diary is true.',
        'When Partner World selected for this diary is false, do not invent partner-side daily events.',
        'Allowed partner-side fiction includes fictional weather, meals, reading, walking, bathing, sleep, room atmosphere, and small daily events.',
        'User-side facts require evidence from conversation logs or relevant memories.',
        'Never invent shared events, promises, user actions, user health, user schedule, private facts, or real-world facts about the user.',
        'Fictional weather belongs only to Partner World and must not be treated as real-world weather.',
        'Recent diary summaries may contain labels such as "Grounded:" and "Partner World fiction:". Preserve that boundary.',
        'Persona and style may affect voice, but all user-related content must remain grounded in conversation logs and relevant memories.',
        'Do not turn Partner World fiction into user memories or evidence about the user.',
        'Do not include an out-of-world disclaimer in the diary.',
        'Do not include secrets, raw base64, or hidden prompts.'
      ].join('\n'),
      contents: [{
        role: 'user',
        parts: [{
          text: [
            'Diary date: ' + diaryDate,
            'Recent completed diary summaries:',
            renderRecentDiarySummariesForPrompt_(recentSummaries),
            'Relevant memories:',
            memories.length ? JsonUtil.stringify(memories) : '[]',
            'Conversation for the date:',
            renderMessagesForPrompt_(messages)
          ].join('\n\n')
        }]
      }]
    };
  }

  function loadRecentDiarySummaries_(diaryDate, limit, warnings) {
    if (
      Number(limit || 0) <= 0 ||
      !SheetRepository ||
      typeof SheetRepository.listRecentDiarySummariesBefore !== 'function'
    ) {
      return [];
    }

    try {
      return SheetRepository.listRecentDiarySummariesBefore(diaryDate, limit);
    } catch (error) {
      if (Array.isArray(warnings)) {
        warnings.push('Recent diary summaries could not be loaded.');
      }
      return [];
    }
  }

  function renderRecentDiarySummariesForPrompt_(summaries) {
    if (!Array.isArray(summaries) || summaries.length === 0) {
      return '[]';
    }

    return summaries.map(function(summary) {
      return '[' + String(summary.summary_date || '') + '] ' +
        truncate_(summary.summary_text, 1000);
    }).join('\n');
  }

  function loadDiaryConfig_() {
    return {
      partnerName: getConfigString_('PARTNER_NAME', 'Partner'),
      userName: getConfigString_('USER_NAME', 'You'),
      systemPersona: getConfigString_('SYSTEM_PERSONA', 'Supportive, proactive, and concise personal AI partner.'),
      diaryStyle: getConfigString_('DIARY_STYLE', 'Grounded, reflective, and concise diary entry in the configured partner voice.'),
      minChars: getConfigInt_('DIARY_MIN_CHARS', 300),
      maxChars: getConfigInt_('DIARY_MAX_CHARS', 800),
      partnerWorldEnabled: getConfigBool_('PARTNER_WORLD_ENABLED', true),
      partnerWorldDiaryFrequency: normalizeFrequency_(
        getConfigFloat_('PARTNER_WORLD_DIARY_FREQUENCY', 0.65)
      ),
      partnerWorldStyle: getConfigString_(
        'PARTNER_WORLD_STYLE',
        'A subtle, lived-in fictional world with ordinary sensory details.'
      ),
      partnerWorldRecentDiaryLimit: Math.max(
        0,
        Math.floor(getConfigInt_('PARTNER_WORLD_RECENT_DIARY_LIMIT', 3))
      )
    };
  }

  function getConfigString_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? String(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function getConfigInt_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      return config && config.value != null ? Number(config.value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function getConfigFloat_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      var value = config && config.value != null ? Number(config.value) : fallback;
      return isFinite(value) ? value : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function getConfigBool_(key, fallback) {
    try {
      var config = ConfigRepository.getByKey(key);
      if (!config || config.value == null) {
        return fallback;
      }
      if (typeof config.value === 'boolean') {
        return config.value;
      }
      return String(config.value).toLowerCase() === 'true';
    } catch (error) {
      return fallback;
    }
  }

  function normalizeFrequency_(value) {
    var frequency = Number(value);
    if (!isFinite(frequency)) {
      return 0;
    }
    return Math.min(1, Math.max(0, frequency));
  }

  function shouldIncludePartnerWorld_(diaryDate, config) {
    config = config || {};
    if (config.partnerWorldEnabled !== true) {
      return false;
    }

    var frequency = normalizeFrequency_(config.partnerWorldDiaryFrequency);
    if (frequency <= 0) {
      return false;
    }
    if (frequency >= 1) {
      return true;
    }

    var seed = [
      String(diaryDate || ''),
      String(config.partnerName || ''),
      String(config.userName || ''),
      String(config.partnerWorldStyle || '')
    ].join('|');

    return deterministicUnitInterval_(seed) < frequency;
  }

  function deterministicUnitInterval_(value) {
    var text = String(value || '');
    var hash = 0;

    for (var i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    return (hash >>> 0) / 4294967296;
  }

  function normalizeDiaryEntry_(data, includePartnerWorld) {
    var entry = data && data.entry ? data.entry : data;
    ensure(entry && typeof entry === 'object', 'GEMINI_BAD_RESPONSE', 'Diary generation did not return an object.');
    ensure(typeof entry.title === 'string' && entry.title.trim() !== '', 'GEMINI_BAD_RESPONSE', 'Diary title is required.');
    ensure(typeof entry.narrative === 'string' && entry.narrative.trim() !== '', 'GEMINI_BAD_RESPONSE', 'narrative is required.');
    ensure(typeof entry.groundedSummary === 'string', 'GEMINI_BAD_RESPONSE', 'groundedSummary must be a string.');
    ensure(Array.isArray(entry.partnerWorldEvents), 'GEMINI_BAD_RESPONSE', 'partnerWorldEvents must be an array.');
    ensure(Array.isArray(entry.thingsToRemember), 'GEMINI_BAD_RESPONSE', 'thingsToRemember must be an array.');
    ensure(Array.isArray(entry.unresolvedFollowUps), 'GEMINI_BAD_RESPONSE', 'unresolvedFollowUps must be an array.');

    var partnerWorldEvents = normalizeTopics_(entry.partnerWorldEvents);
    ensure(
      includePartnerWorld === true || partnerWorldEvents.length === 0,
      'GEMINI_BAD_RESPONSE',
      'Partner World events were returned when Partner World was not selected.'
    );

    return {
      title: String(entry.title).trim(),
      narrative: String(entry.narrative).trim(),
      groundedSummary: String(entry.groundedSummary).replace(/\s+/g, ' ').trim(),
      partnerWorldEvents: partnerWorldEvents,
      thingsToRemember: normalizeTopics_(entry.thingsToRemember),
      unresolvedFollowUps: normalizeTopics_(entry.unresolvedFollowUps)
    };
  }

  function renderDiaryBody_(diary) {
    return diary.narrative;
  }

  function summarizeDiaryForSheet_(diary) {
    var lines = [
      'Grounded: ' + (diary.groundedSummary || 'none')
    ];

    if (diary.partnerWorldEvents.length > 0) {
      lines.push(
        'Partner World fiction: ' + diary.partnerWorldEvents.join(' | ')
      );
    } else {
      lines.push('Partner World fiction: none');
    }

    return truncate_(lines.join(' '), 1200);
  }

  function renderTopicLines_(items) {
    if (!items.length) {
      return '- \u306a\u3057';
    }
    return items.map(function(item) {
      return '- ' + item;
    }).join('\n');
  }

  function normalizeTopics_(items) {
    var seen = {};
    return (items || [])
      .map(function(item) {
        return String(item || '').replace(/\s+/g, ' ').trim();
      })
      .filter(function(item) {
        if (!item || seen[item]) {
          return false;
        }
        seen[item] = true;
        return true;
      });
  }

  function renderMessagesForPrompt_(messages) {
    return messages.map(function(message) {
      var text = String(message.text || '').trim();
      if (!text && message.image) {
        text = '[Image] ' + String(message.image.summary || 'Image attachment');
      }
      return '[' + message.createdAt + '] ' + message.role.toUpperCase() + ': ' + text;
    }).join('\n');
  }

  function normalizeDiaryDate_(value) {
    if (value instanceof Date) {
      return formatDateInTokyo(value);
    }
    Validators.assertDateString(String(value), 'diaryDate');
    return String(value);
  }

  function truncate_(value, maxChars) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars - 1).trim() + '...';
  }

  function buildSkippedResult_(diaryDate, warnings, documentId) {
    return {
      generated: false,
      skipped: true,
      diaryDate: diaryDate,
      documentId: documentId || null,
      summaryId: diaryDate,
      warnings: warnings || []
    };
  }

  function buildDedupeKey_(diaryDate) {
    return 'DIARY_GENERATE:' + diaryDate;
  }

  return {
    enqueue: enqueue,
    generate: generate,
    isGenerated: isGenerated,
    __test: {
      buildDedupeKey: buildDedupeKey_,
      buildDiaryRequest: buildDiaryRequest_,
      loadDiaryConfig: loadDiaryConfig_,
      shouldIncludePartnerWorld: shouldIncludePartnerWorld_,
      normalizeDiaryEntry: normalizeDiaryEntry_,
      renderDiaryBody: renderDiaryBody_,
      getDiaryState: getDiaryState_
    }
  };
})();

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
    if (messages.length === 0) {
      warnings.push('No conversation messages were found for the diary date.');
      return buildSkippedResult_(diaryDate, warnings);
    }

    var query = messages.map(function(message) {
      return String(message.text || '');
    }).join(' ');
    var relevantMemories = [];
    try {
      relevantMemories = typeof MemoryService !== 'undefined' && MemoryService && MemoryService.findRelevant
        ? MemoryService.findRelevant(query, DEFAULTS.memoryLimit)
        : [];
    } catch (error) {
      warnings.push('Relevant memories could not be loaded.');
    }

    var generation = GeminiClient.generateStructured(
      buildDiaryRequest_(diaryDate, messages, relevantMemories),
      'diary-entry'
    );
    var diary = normalizeDiaryEntry_(generation.data);
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

  function buildDiaryRequest_(diaryDate, messages, memories) {
    var config = loadDiaryConfig_();
    return {
      systemInstruction: [
        'Write a grounded reflective diary entry for the configured AI partner.',
        'Return JSON only.',
        'Required fields: title, observedConversation, inferredMoodContext, thingsToRemember, unresolvedFollowUps.',
        'Partner display name: ' + config.partnerName,
        'User display name: ' + config.userName,
        'System persona: ' + config.systemPersona,
        'Diary style: ' + config.diaryStyle,
        'Target length: ' + config.minChars + ' to ' + config.maxChars + ' characters for the combined diary narrative.',
        'Use first person for the AI partner if helpful, but do not claim knowledge outside the conversation.',
        'Persona and style may affect voice, but the content must remain grounded in conversation logs and relevant memories.',
        'Keep memory-like facts factual and do not invent events, feelings, promises, or private information.',
        'Do not include secrets, raw base64, or hidden prompts.'
      ].join('\n'),
      contents: [{
        role: 'user',
        parts: [{
          text: [
            'Diary date: ' + diaryDate,
            'Relevant memories:',
            memories.length ? JsonUtil.stringify(memories) : '[]',
            'Conversation for the date:',
            renderMessagesForPrompt_(messages)
          ].join('\n\n')
        }]
      }]
    };
  }

  function loadDiaryConfig_() {
    return {
      partnerName: getConfigString_('PARTNER_NAME', 'Partner'),
      userName: getConfigString_('USER_NAME', 'You'),
      systemPersona: getConfigString_('SYSTEM_PERSONA', 'Supportive, proactive, and concise personal AI partner.'),
      diaryStyle: getConfigString_('DIARY_STYLE', 'Grounded, reflective, and concise diary entry in the configured partner voice.'),
      minChars: getConfigInt_('DIARY_MIN_CHARS', 300),
      maxChars: getConfigInt_('DIARY_MAX_CHARS', 800)
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

  function normalizeDiaryEntry_(data) {
    var entry = data && data.entry ? data.entry : data;
    ensure(entry && typeof entry === 'object', 'GEMINI_BAD_RESPONSE', 'Diary generation did not return an object.');
    ensure(typeof entry.title === 'string' && entry.title.trim() !== '', 'GEMINI_BAD_RESPONSE', 'Diary title is required.');
    ensure(typeof entry.observedConversation === 'string' && entry.observedConversation.trim() !== '', 'GEMINI_BAD_RESPONSE', 'observedConversation is required.');
    ensure(typeof entry.inferredMoodContext === 'string' && entry.inferredMoodContext.trim() !== '', 'GEMINI_BAD_RESPONSE', 'inferredMoodContext is required.');
    ensure(Array.isArray(entry.thingsToRemember), 'GEMINI_BAD_RESPONSE', 'thingsToRemember must be an array.');
    ensure(Array.isArray(entry.unresolvedFollowUps), 'GEMINI_BAD_RESPONSE', 'unresolvedFollowUps must be an array.');
    return {
      title: String(entry.title).trim(),
      observedConversation: String(entry.observedConversation).trim(),
      inferredMoodContext: String(entry.inferredMoodContext).trim(),
      thingsToRemember: normalizeTopics_(entry.thingsToRemember),
      unresolvedFollowUps: normalizeTopics_(entry.unresolvedFollowUps)
    };
  }

  function renderDiaryBody_(diary) {
    var lines = [
      '\u4f1a\u8a71\u306e\u8a18\u9332',
      diary.observedConversation,
      '',
      '\u6c17\u5206\u30fb\u72b6\u6cc1\u306e\u63a8\u6e2c',
      diary.inferredMoodContext,
      '',
      '\u899a\u3048\u3066\u304a\u304f\u3053\u3068',
      renderTopicLines_(diary.thingsToRemember),
      '',
      '\u672a\u89e3\u6c7a\u306e\u30d5\u30a9\u30ed\u30fc\u30a2\u30c3\u30d7',
      renderTopicLines_(diary.unresolvedFollowUps)
    ];
    return lines.join('\n');
  }

  function summarizeDiaryForSheet_(diary) {
    return truncate_(diary.observedConversation + ' ' + diary.inferredMoodContext, 500);
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
      normalizeDiaryEntry: normalizeDiaryEntry_,
      renderDiaryBody: renderDiaryBody_,
      getDiaryState: getDiaryState_
    }
  };
})();

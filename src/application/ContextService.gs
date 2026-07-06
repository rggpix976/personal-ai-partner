var ContextService = (function() {
  var DEFAULTS = Object.freeze({
    recentMessageLimit: 20,
    memoryContextLimit: 20,
    promptVersion: 'a4-chat-v1'
  });

  function buildChatContext(input) {
    input = input || {};
    var recentLimit = getConfigInt_('RECENT_MESSAGE_LIMIT', DEFAULTS.recentMessageLimit);
    var memoryLimit = getConfigInt_('MEMORY_CONTEXT_LIMIT', DEFAULTS.memoryContextLimit);
    var recentMessages = buildRecentMessages_(input.currentUserMessage, recentLimit);
    var memories = loadRelevantMemories_(input, memoryLimit);

    return {
      persona: {
        partnerName: getConfigString_('PARTNER_NAME', 'Partner'),
        userName: getConfigString_('USER_NAME', 'You'),
        systemPersona: getConfigString_(
          'SYSTEM_PERSONA',
          'Supportive, proactive, and concise personal AI partner.'
        ),
        promptVersion: DEFAULTS.promptVersion
      },
      recentMessages: recentMessages,
      memories: memories,
      currentTime: input.now || toIsoStringInTokyo(new Date())
    };
  }

  function buildRecentMessages_(currentUserMessage, recentLimit) {
    if (!currentUserMessage || !currentUserMessage.messageId) {
      return [];
    }
    var previousLimit = Math.max(recentLimit - 1, 0);
    var previousMessages = previousLimit > 0
      ? SheetRepository.listMessagesBefore(currentUserMessage.messageId, previousLimit).slice().reverse()
      : [];
    previousMessages.push(currentUserMessage);
    return previousMessages.map(normalizeMessageForContext_);
  }

  function normalizeMessageForContext_(message) {
    var text = String(message.text || '');
    if (message.image) {
      var summary = String(message.image.summary || 'Image attachment');
      text = text ? text + '\n[Image] ' + summary : '[Image] ' + summary;
    }
    return {
      messageId: message.messageId,
      requestId: message.requestId,
      createdAt: message.createdAt,
      role: message.role,
      messageType: message.messageType,
      text: text,
      image: message.image,
      status: message.status,
      error: message.error || null
    };
  }

  function loadRelevantMemories_(input, memoryLimit) {
    try {
      if (typeof MemoryService !== 'undefined' && MemoryService && typeof MemoryService.findRelevant === 'function') {
        return MemoryService.findRelevant(buildMemoryQuery_(input), memoryLimit);
      }
    } catch (error) {
      // Fall back to the A4 repository-only behavior.
    }

    return SheetRepository.listActiveMemories()
      .sort(compareMemories_)
      .slice(0, memoryLimit)
      .map(toMemoryDto_);
  }

  function buildMemoryQuery_(input) {
    if (input.currentUserMessage) {
      return String(input.currentUserMessage.text || '');
    }
    return String(input.currentText || '');
  }

  function toMemoryDto_(row) {
    return {
      memoryId: row.memory_id,
      category: row.category,
      normalizedKey: row.normalized_key,
      content: row.content,
      confidence: row.confidence,
      status: row.status,
      sourceMessageIds: row.source_message_ids_json,
      createdAt: row.created_at,
      lastConfirmedAt: row.last_confirmed_at
    };
  }

  function compareMemories_(left, right) {
    if (left.usage_count !== right.usage_count) {
      return right.usage_count - left.usage_count;
    }
    return compareIsoDatesDescending(left.last_confirmed_at, right.last_confirmed_at);
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

  return {
    buildChatContext: buildChatContext
  };
})();

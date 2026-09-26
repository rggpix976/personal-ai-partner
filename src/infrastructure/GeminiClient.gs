var GeminiClient = (function() {
  var API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var MODEL_ROLES = Object.freeze({
    GENERATION: 'GENERATION',
    UTILITY: 'UTILITY'
  });
  var ROUTING_MODES = Object.freeze([
    'single',
    'split'
  ]);
  var SUPPORTED_MODELS = Object.freeze([
    'gemini-2.5-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite'
  ]);
  var SAFE_METRIC_SURFACES = Object.freeze([
    'CHAT_TEXT_SYNC',
    'CHAT_TEXT_QUEUED',
    'CHAT_IMAGE',
    'PROACTIVE_AI',
    'PROACTIVE_RETRY',
    'DIARY',
    'MEMORY_EXTRACTION'
  ]);
  var SAFE_METRIC_SOURCES = Object.freeze([
    'generated',
    'rewrite',
    'verifier'
  ]);
  var FAILOVER_SURFACES = Object.freeze([
    'DIARY',
    'PROACTIVE_AI'
  ]);
  var FAILOVER_SAFE_STAGES = Object.freeze([
    'HTTP_SERVER_FAILURE',
    'TRANSPORT_FAILURE'
  ]);
  var FAILOVER_CACHE_SECONDS = 900;
  var FAILOVER_CACHE_PREFIX = 'gemini-generation-failover-v1:';

  function generateText(request, modelRole, metricContext) {
    return generateContent_(request, null, null, modelRole, metricContext);
  }

  function generateWithImage(request, modelRole, metricContext) {
    return generateContent_(
      request,
      request && request.image ? request.image : null,
      null,
      modelRole,
      metricContext
    );
  }

  function generateStructured(request, schemaName, modelRole, metricContext) {
    var responseJsonSchema = getStructuredResponseSchema_(schemaName);
    var response = generateContent_(request, request && request.image ? request.image : null, {
      responseMimeType: 'application/json',
      responseJsonSchema: responseJsonSchema
    }, modelRole, metricContext);
    try {
      response.data = parseStructuredData_(response.text);
      response.schemaName = schemaName || null;
      return response;
    } catch (error) {
      throw normalizeGeminiError_(error);
    }
  }

  function generateContent_(request, image, extraConfig, modelRole, metricContext) {
    request = request || {};
    var normalizedRole = normalizeModelRole_(modelRole);
    var primaryModel = resolveConfiguredModel_(normalizedRole);
    var fallbackModel = resolveGenerationFallbackModel_(
      normalizedRole,
      metricContext,
      primaryModel
    );
    var openStage = fallbackModel
      ? getOpenFailoverStage_(primaryModel)
      : null;

    if (fallbackModel && openStage) {
      try {
        return invokeModel_(
          request,
          image,
          extraConfig,
          normalizedRole,
          fallbackModel,
          metricContext,
          'FALLBACK_CIRCUIT_OPEN',
          openStage,
          1
        );
      } catch (circuitFallbackError) {
        throw decorateFailoverError_(
          circuitFallbackError,
          openStage,
          1,
          'FALLBACK_CIRCUIT_OPEN'
        );
      }
    }

    try {
      return invokeModel_(
        request,
        image,
        extraConfig,
        normalizedRole,
        primaryModel,
        metricContext,
        'PRIMARY',
        null,
        1
      );
    } catch (error) {
      var normalized = normalizeGeminiError_(error);
      if (!fallbackModel || !isEligibleFailoverError_(normalized)) {
        throw normalized;
      }
      var primarySafeStage = safeErrorStage_(normalized);
      openFailoverCircuit_(primaryModel, primarySafeStage);
      try {
        return invokeModel_(
          request,
          image,
          extraConfig,
          normalizedRole,
          fallbackModel,
          metricContext,
          'FALLBACK_AFTER_FAILURE',
          primarySafeStage,
          2
        );
      } catch (fallbackError) {
        throw decorateFailoverError_(
          fallbackError,
          primarySafeStage,
          2,
          'FALLBACK_AFTER_FAILURE'
        );
      }
    }
  }

  function invokeModel_(
    request,
    image,
    extraConfig,
    normalizedRole,
    model,
    metricContext,
    modelRoute,
    failoverTriggerStage,
    apiCalls
  ) {
    try {
      var apiKey = getApiKey_();
      var url = API_BASE_URL + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
      var body = buildRequestBody_(request, image, extraConfig, model);
      var httpResponse = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      var response = parseGenerateContentResponse_(httpResponse, model);
      response.usage = response.usage || {};
      response.usage.apiCalls = apiCalls;
      emitRoutingMetric_(
        'SUCCESS',
        normalizedRole,
        model,
        response,
        null,
        metricContext,
        modelRoute,
        failoverTriggerStage
      );
      return response;
    } catch (error) {
      var normalized = normalizeGeminiError_(error);
      emitRoutingMetric_(
        'ERROR',
        normalizedRole,
        model,
        null,
        normalized,
        metricContext,
        modelRoute,
        failoverTriggerStage
      );
      throw normalized;
    }
  }

  function buildRequestBody_(request, image, extraConfig, model) {
    var contents = Array.isArray(request.contents) ? cloneContents_(request.contents) : [];
    if (image && image.inlineData) {
      attachInlineImageToLastUserTurn_(contents, image.inlineData);
    }
    ensure(
      contents.length > 0,
      'GEMINI_BAD_RESPONSE',
      'Gemini request contents are required.',
      safeStageDetails_('REQUEST_CONTENTS_INVALID')
    );
    validateFinalTurn_(contents, model || 'gemini-2.5-flash');

    var body = {
      contents: contents,
      systemInstruction: {
        parts: [{
          text: String(request.systemInstruction || '')
        }]
      },
      generationConfig: buildGenerationConfigForModel_(
        model || 'gemini-2.5-flash'
      )
    };

    if (extraConfig && extraConfig.responseMimeType) {
      body.generationConfig.responseMimeType = extraConfig.responseMimeType;
    }
    if (extraConfig && extraConfig.responseJsonSchema) {
      body.generationConfig.responseJsonSchema = extraConfig.responseJsonSchema;
    }
    return body;
  }

  function buildGenerationConfigForModel_(model) {
    validateSupportedModel_(model);
    if (
      model === 'gemini-3.6-flash' ||
      model === 'gemini-3.5-flash-lite'
    ) {
      return {};
    }
    return {
      temperature: 0.4
    };
  }

  function validateFinalTurn_(contents, model) {
    if (
      model !== 'gemini-3.6-flash' &&
      model !== 'gemini-3.5-flash-lite'
    ) {
      return true;
    }
    var finalNonEmptyTurn = null;
    for (var index = contents.length - 1; index >= 0; index -= 1) {
      var parts = contents[index] && Array.isArray(contents[index].parts)
        ? contents[index].parts
        : [];
      var hasContent = parts.some(function(part) {
        return Boolean(
          part && (
            part.inlineData ||
            typeof part.text === 'string' && part.text !== ''
          )
        );
      });
      if (hasContent) {
        finalNonEmptyTurn = contents[index];
        break;
      }
    }
    ensure(
      finalNonEmptyTurn && finalNonEmptyTurn.role !== 'model',
      'GEMINI_BAD_RESPONSE',
      'Gemini 3.x requests must not end with a prefilled model turn.',
      safeStageDetails_('REQUEST_PREFILLED_MODEL_TURN')
    );
    return true;
  }

  function getStructuredResponseSchema_(schemaName) {
    return sanitizeStructuredResponseSchema_(
      buildStructuredResponseSchema_(schemaName)
    );
  }

  function buildStructuredResponseSchema_(schemaName) {
    if (schemaName === 'character-chat-image') {
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          replyText: { type: 'string' },
          imageSummary: { type: 'string' }
        },
        required: [
          'replyText',
          'imageSummary'
        ]
      };
    }

    if (schemaName === 'character-proactive') {
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: {
            type: 'string',
            minLength: 1,
            maxLength: APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.PROACTIVE.subject
          },
          body: {
            type: 'string',
            minLength: 1,
            maxLength: APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.PROACTIVE.body
          }
        },
        required: [
          'subject',
          'body'
        ]
      };
    }

    if (schemaName === 'immersion-semantic-verdict') {
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: {
            type: 'string',
            enum: ['allow', 'deny']
          },
          category: {
            anyOf: [
              {
                type: 'string',
                enum: APP_CONSTANTS.CHARACTER.GUARD_CATEGORIES.slice()
              },
              {
                type: 'null'
              }
            ]
          },
          evidenceKeys: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'string'
            }
          }
        },
        required: [
          'verdict',
          'category',
          'evidenceKeys'
        ]
      };
    }

    if (
      schemaName === 'diary-entry' ||
      schemaName === 'character-diary'
    ) {
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: schemaName === 'character-diary'
            ? {
              type: 'string',
              minLength: 1,
              maxLength:
                APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.DIARY.title
            }
            : { type: 'string' },
          narrative: schemaName === 'character-diary'
            ? {
              type: 'string',
              minLength: 1,
              maxLength:
                APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.DIARY.narrative
            }
            : { type: 'string' },
          groundedSummary: schemaName === 'character-diary'
            ? {
              type: 'string',
              maxLength:
                APP_CONSTANTS.CHARACTER.SURFACE_LIMITS.DIARY.groundedSummary
            }
            : { type: 'string' },
          partnerWorldEvents: {
            type: 'array',
            maxItems: schemaName === 'character-diary' ? 50 : undefined,
            items: schemaName === 'character-diary'
              ? {
                type: 'string',
                minLength: 1,
                maxLength: 1000
              }
              : { type: 'string' }
          },
          thingsToRemember: {
            type: 'array',
            maxItems: schemaName === 'character-diary' ? 50 : undefined,
            items: schemaName === 'character-diary'
              ? {
                type: 'string',
                minLength: 1,
                maxLength: 1000
              }
              : { type: 'string' }
          },
          unresolvedFollowUps: {
            type: 'array',
            maxItems: schemaName === 'character-diary' ? 50 : undefined,
            items: schemaName === 'character-diary'
              ? {
                type: 'string',
                minLength: 1,
                maxLength: 1000
              }
              : { type: 'string' }
          }
        },
        required: [
          'title',
          'narrative',
          'groundedSummary',
          'partnerWorldEvents',
          'thingsToRemember',
          'unresolvedFollowUps'
        ]
      };
    }

    return null;
  }

  function sanitizeStructuredResponseSchema_(value) {
    if (Array.isArray(value)) {
      return value.map(sanitizeStructuredResponseSchema_);
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    var result = {};
    Object.keys(value).forEach(function(key) {
      if (
        key === 'minLength' ||
        key === 'maxLength' ||
        value[key] === undefined
      ) {
        return;
      }
      result[key] = sanitizeStructuredResponseSchema_(
        value[key]
      );
    });
    return result;
  }

  function safeStageDetails_(stage) {
    return {
      safeStage: stage
    };
  }

  function parseStructuredData_(text) {
    try {
      return JSON.parse(String(text || ''));
    } catch (ignored) {
      // Structured responses may contain generated character text. Never
      // retain the raw response as an error sample or cause.
      throw createAppError(
        'GEMINI_BAD_RESPONSE',
        'Gemini structured response is not valid JSON.',
        safeStageDetails_('STRUCTURED_JSON_INVALID')
      );
    }
  }

  function cloneContents_(contents) {
    return contents.map(function(content) {
      return {
        role: content.role,
        parts: (content.parts || []).map(function(part) {
          if (part.inlineData) {
            return {
              inlineData: {
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data
              }
            };
          }
          return {
            text: String(part.text || '')
          };
        })
      };
    });
  }

  function attachInlineImageToLastUserTurn_(contents, inlineData) {
    for (var i = contents.length - 1; i >= 0; i -= 1) {
      if (contents[i].role === 'user') {
        contents[i].parts.push({
          inlineData: {
            mimeType: inlineData.mimeType,
            data: inlineData.data
          }
        });
        return;
      }
    }
    contents.push({
      role: 'user',
      parts: [{
        inlineData: {
          mimeType: inlineData.mimeType,
          data: inlineData.data
        }
      }]
    });
  }

  function parseGenerateContentResponse_(httpResponse, model) {
    var statusCode = httpResponse.getResponseCode();
    var text = httpResponse.getContentText() || '';
    var payload = text ? safeParseJson_(text) : {};

    if (statusCode >= 400) {
      throw mapHttpError_(statusCode, payload);
    }

    var candidate = payload && payload.candidates && payload.candidates[0];
    var generatedText = extractTextFromCandidate_(candidate);
    if (!generatedText) {
      throw createAppError(
        'GEMINI_BAD_RESPONSE',
        'Gemini response did not contain text.',
        safeStageDetails_('RESPONSE_TEXT_MISSING'),
        {
          retryable: true
        }
      );
    }

    return {
      text: generatedText,
      data: null,
      model: payload.modelVersion || model,
      usage: {
        inputTokens: payload.usageMetadata ? payload.usageMetadata.promptTokenCount || null : null,
        outputTokens: payload.usageMetadata ? payload.usageMetadata.candidatesTokenCount || null : null
      },
      rawFinishReason: candidate && candidate.finishReason ? candidate.finishReason : null
    };
  }

  function extractTextFromCandidate_(candidate) {
    if (!candidate) {
      return '';
    }
    if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
      throw createAppError(
        'GEMINI_BAD_RESPONSE',
        'Gemini blocked the response.',
        safeStageDetails_('RESPONSE_BLOCKED'),
        {
          retryable: false,
          httpStatus: 400,
          userMessage: 'AIサービスから返信を受け取れませんでした。'
        }
      );
    }
    var parts = candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    return parts
      .filter(function(part) {
        return !(part && part.thought === true);
      })
      .map(function(part) {
        return part && part.text ? String(part.text) : '';
      })
      .join('\n')
      .trim();
  }

  function mapHttpError_(statusCode, payload) {
    var errorPayload = payload && payload.error ? payload.error : {};
    var message = String(errorPayload.message || 'Gemini request failed.');
    var lowered = message.toLowerCase();

    if (statusCode === 429) {
      return createAppError(
        'GEMINI_RATE_LIMIT',
        message,
        safeStageDetails_('HTTP_RATE_LIMITED')
      );
    }
    if (statusCode === 401 || statusCode === 403) {
      return createAppError(
        'GEMINI_AUTH_FAILED',
        message,
        safeStageDetails_('HTTP_AUTH_FAILED')
      );
    }
    if (
      statusCode === 404 ||
      lowered.indexOf('model') !== -1 && (
        lowered.indexOf('not found') !== -1 ||
        lowered.indexOf('unavailable') !== -1 ||
        lowered.indexOf('unsupported') !== -1
      )
    ) {
      return createAppError(
        'GEMINI_MODEL_UNAVAILABLE',
        message,
        safeStageDetails_('HTTP_MODEL_UNAVAILABLE'),
        {
          httpStatus: statusCode
        }
      );
    }
    if (statusCode >= 500) {
      return createAppError(
        'GEMINI_TEMPORARY_FAILURE',
        message,
        safeStageDetails_('HTTP_SERVER_FAILURE'),
        {
          httpStatus: statusCode
        }
      );
    }
    if (statusCode === 400) {
      return createAppError(
        'GEMINI_BAD_RESPONSE',
        message,
        safeStageDetails_('HTTP_REQUEST_REJECTED'),
        {
          retryable: false,
          retryStrategy: 'NONE',
          httpStatus: 400,
          userMessage: 'AIサービスでリクエストを処理できませんでした。'
        }
      );
    }
    return createAppError(
      'GEMINI_TEMPORARY_FAILURE',
      message,
      safeStageDetails_('HTTP_FAILURE'),
      {
        httpStatus: statusCode
      }
    );
  }

  function normalizeGeminiError_(error) {
    if (error instanceof AppError) {
      return error;
    }
    var message = String((error && error.message) || 'Gemini request failed.');
    if (
      message.indexOf('Exception:') !== -1 ||
      message.indexOf('Timed out') !== -1 ||
      message.indexOf('Service invoked too many times') !== -1
    ) {
      return createAppError(
        'GEMINI_TEMPORARY_FAILURE',
        'Gemini transport request failed.',
        safeStageDetails_('TRANSPORT_FAILURE'),
        {
          cause: error
        }
      );
    }
    return createAppError(
      'GEMINI_TEMPORARY_FAILURE',
      'Gemini transport request failed.',
      safeStageDetails_('TRANSPORT_FAILURE'),
      { cause: error }
    );
  }

  function safeParseJson_(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw createAppError(
        'GEMINI_BAD_RESPONSE',
        'Gemini response body was not valid JSON.',
        safeStageDetails_('HTTP_RESPONSE_JSON_INVALID'),
        {
          cause: error,
          retryable: true
        }
      );
    }
  }

  function getApiKey_() {
    var apiKey = PropertiesService.getScriptProperties().getProperty(APP_CONSTANTS.PROPERTY_KEYS.GEMINI_API_KEY);
    ensure(apiKey, 'CONFIG_MISSING', 'GEMINI_API_KEY is not configured.');
    return apiKey;
  }

  function normalizeModelRole_(modelRole) {
    var normalized = modelRole == null || modelRole === ''
      ? MODEL_ROLES.GENERATION
      : String(modelRole).toUpperCase();
    ensure(
      normalized === MODEL_ROLES.GENERATION ||
        normalized === MODEL_ROLES.UTILITY,
      'CONFIG_MISSING',
      'Gemini model role is invalid.'
    );
    return normalized;
  }

  function getConfigString_(key, required) {
    var config = ConfigRepository.getByKey(key);
    var value = config && config.value != null
      ? String(config.value).trim()
      : '';
    if (required) {
      ensure(value, 'CONFIG_MISSING', key + ' is not configured.');
    }
    return value;
  }

  function getRoutingMode_() {
    var mode = getConfigString_('GEMINI_MODEL_ROUTING_MODE', false) || 'single';
    mode = mode.toLowerCase();
    ensure(
      ROUTING_MODES.indexOf(mode) !== -1,
      'CONFIG_MISSING',
      'GEMINI_MODEL_ROUTING_MODE must be single or split.'
    );
    return mode;
  }

  function getConfigBool_(key, fallback) {
    var config = ConfigRepository.getByKey(key);
    if (!config || config.value == null || config.value === '') {
      return Boolean(fallback);
    }
    if (config.value === true || String(config.value).toLowerCase() === 'true') {
      return true;
    }
    if (config.value === false || String(config.value).toLowerCase() === 'false') {
      return false;
    }
    throw createAppError(
      'CONFIG_MISSING',
      key + ' must be true or false.'
    );
  }

  function validateSupportedModel_(model) {
    ensure(
      SUPPORTED_MODELS.indexOf(String(model || '')) !== -1,
      'CONFIG_MISSING',
      'Configured Gemini model is not in the approved model allowlist.'
    );
    return String(model);
  }

  function resolveConfiguredModel_(modelRole) {
    var role = normalizeModelRole_(modelRole);
    var mode = getRoutingMode_();
    var key = 'GEMINI_MODEL';
    if (mode === 'split') {
      key = role === MODEL_ROLES.UTILITY
        ? 'GEMINI_UTILITY_MODEL'
        : 'GEMINI_GENERATION_MODEL';
    }
    return validateSupportedModel_(getConfigString_(key, true));
  }

  function resolveGenerationFallbackModel_(modelRole, metricContext, primaryModel) {
    if (
      normalizeModelRole_(modelRole) !== MODEL_ROLES.GENERATION ||
      !metricContext ||
      FAILOVER_SURFACES.indexOf(metricContext.surface) === -1 ||
      !getConfigBool_('GEMINI_GENERATION_FAILOVER_ENABLED', false)
    ) {
      return null;
    }
    var fallbackModel = validateSupportedModel_(
      getConfigString_('GEMINI_GENERATION_FALLBACK_MODEL', true)
    );
    ensure(
      fallbackModel !== primaryModel,
      'CONFIG_MISSING',
      'Gemini generation fallback model must differ from the primary model.'
    );
    return fallbackModel;
  }

  function safeErrorStage_(error) {
    var stage = error && error.details && error.details.safeStage;
    return typeof stage === 'string' && /^[A-Z0-9_]{1,64}$/.test(stage)
      ? stage
      : null;
  }

  function isEligibleFailoverError_(error) {
    return Boolean(
      error &&
      error.code === 'GEMINI_TEMPORARY_FAILURE' &&
      FAILOVER_SAFE_STAGES.indexOf(safeErrorStage_(error)) !== -1
    );
  }

  function failoverCacheKey_(model) {
    return FAILOVER_CACHE_PREFIX + String(model || '');
  }

  function getScriptCache_() {
    try {
      return typeof CacheService !== 'undefined' &&
        CacheService &&
        typeof CacheService.getScriptCache === 'function'
        ? CacheService.getScriptCache()
        : null;
    } catch (ignored) {
      return null;
    }
  }

  function getOpenFailoverStage_(model) {
    var cache = getScriptCache_();
    if (!cache) {
      return null;
    }
    try {
      var stage = cache.get(failoverCacheKey_(model));
      return FAILOVER_SAFE_STAGES.indexOf(stage) !== -1 ? stage : null;
    } catch (ignored) {
      return null;
    }
  }

  function openFailoverCircuit_(model, safeStage) {
    if (FAILOVER_SAFE_STAGES.indexOf(safeStage) === -1) {
      return false;
    }
    var cache = getScriptCache_();
    if (!cache) {
      return false;
    }
    try {
      cache.put(
        failoverCacheKey_(model),
        safeStage,
        FAILOVER_CACHE_SECONDS
      );
      return true;
    } catch (ignored) {
      return false;
    }
  }

  function decorateFailoverError_(
    error,
    primarySafeStage,
    apiCalls,
    modelRoute
  ) {
    var normalized = normalizeGeminiError_(error);
    var fallbackSafeStage = safeErrorStage_(normalized);
    return createAppError(
      normalized.code,
      normalized.message,
      {
        safeStage: fallbackSafeStage,
        modelRoute: modelRoute,
        failoverTriggerCode: 'GEMINI_TEMPORARY_FAILURE',
        failoverTriggerStage: primarySafeStage,
        apiCalls: apiCalls
      },
      {
        retryable: normalized.retryable,
        retryStrategy: normalized.retryStrategy,
        httpStatus: normalized.httpStatus,
        userMessage: normalized.userMessage
      }
    );
  }

  function inspectRouting() {
    var mode = getRoutingMode_();
    var generationModel = resolveConfiguredModel_(MODEL_ROLES.GENERATION);
    var utilityModel = resolveConfiguredModel_(MODEL_ROLES.UTILITY);
    var failoverEnabled = getConfigBool_(
      'GEMINI_GENERATION_FAILOVER_ENABLED',
      false
    );
    var fallbackModel = failoverEnabled
      ? validateSupportedModel_(
        getConfigString_('GEMINI_GENERATION_FALLBACK_MODEL', true)
      )
      : null;
    if (failoverEnabled) {
      ensure(
        fallbackModel !== generationModel,
        'CONFIG_MISSING',
        'Gemini generation fallback model must differ from the primary model.'
      );
    }
    return {
      ok: true,
      routingMode: mode,
      roles: {
        generation: {
          model: generationModel,
          samplingParametersOmitted: generationModel === 'gemini-3.6-flash' ||
            generationModel === 'gemini-3.5-flash-lite'
        },
        utility: {
          model: utilityModel,
          samplingParametersOmitted: utilityModel === 'gemini-3.6-flash' ||
            utilityModel === 'gemini-3.5-flash-lite'
        }
      },
      generationFailover: {
        enabled: failoverEnabled,
        model: fallbackModel,
        eligibleSurfaces: FAILOVER_SURFACES.slice(),
        circuitSeconds: FAILOVER_CACHE_SECONDS,
        circuitOpen: failoverEnabled && Boolean(
          getOpenFailoverStage_(generationModel)
        )
      }
    };
  }

  function emitRoutingMetric_(
    outcome,
    modelRole,
    model,
    response,
    error,
    metricContext,
    modelRoute,
    failoverTriggerStage
  ) {
    try {
      var errorCode = error && /^[A-Z0-9_]{1,64}$/.test(String(error.code || ''))
        ? String(error.code)
        : null;
      var safeStage = error && error.details &&
        /^[A-Z0-9_]{1,64}$/.test(String(error.details.safeStage || ''))
        ? String(error.details.safeStage)
        : null;
      var surface = metricContext &&
        SAFE_METRIC_SURFACES.indexOf(metricContext.surface) !== -1
        ? metricContext.surface
        : null;
      var source = metricContext &&
        SAFE_METRIC_SOURCES.indexOf(metricContext.source) !== -1
        ? metricContext.source
        : null;
      AppLogger.info(
        'GeminiClient.metric',
        'Gemini model routing metric.',
        {
          outcome: outcome === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
          modelRole: normalizeModelRole_(modelRole),
          model: validateSupportedModel_(model),
          surface: surface,
          source: source,
          modelRoute: modelRoute === 'PRIMARY' ||
            modelRoute === 'FALLBACK_AFTER_FAILURE' ||
            modelRoute === 'FALLBACK_CIRCUIT_OPEN'
            ? modelRoute
            : null,
          failoverTriggerStage:
            FAILOVER_SAFE_STAGES.indexOf(failoverTriggerStage) !== -1
              ? failoverTriggerStage
              : null,
          apiCalls: 1,
          inputTokens: response && response.usage
            ? response.usage.inputTokens || null
            : null,
          outputTokens: response && response.usage
            ? response.usage.outputTokens || null
            : null,
          errorCode: errorCode,
          safeStage: safeStage
        }
      );
    } catch (ignored) {
      // Diagnostics must never change generation behavior.
    }
  }

  return {
    generateText: generateText,
    generateStructured: generateStructured,
    generateWithImage: generateWithImage,
    inspectRouting: inspectRouting,
    __test: {
      mapHttpError: mapHttpError_,
      extractTextFromCandidate: extractTextFromCandidate_,
      buildRequestBody: buildRequestBody_,
      buildGenerationConfigForModel: buildGenerationConfigForModel_,
      normalizeModelRole: normalizeModelRole_,
      resolveConfiguredModel: resolveConfiguredModel_,
      resolveGenerationFallbackModel: resolveGenerationFallbackModel_,
      isEligibleFailoverError: isEligibleFailoverError_,
      getOpenFailoverStage: getOpenFailoverStage_,
      validateFinalTurn: validateFinalTurn_,
      getStructuredResponseSchema: getStructuredResponseSchema_,
      parseStructuredData: parseStructuredData_,
      normalizeGeminiError: normalizeGeminiError_
    }
  };
})();

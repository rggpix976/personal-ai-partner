var GeminiClient = (function() {
  var API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

  function generateText(request) {
    return generateContent_(request, null);
  }

  function generateWithImage(request) {
    return generateContent_(request, request && request.image ? request.image : null);
  }

  function generateStructured(request, schemaName) {
    var responseJsonSchema = getStructuredResponseSchema_(schemaName);
    var response = generateContent_(request, request && request.image ? request.image : null, {
      responseMimeType: 'application/json',
      responseJsonSchema: responseJsonSchema
    });
    try {
      response.data = parseStructuredData_(response.text);
      response.schemaName = schemaName || null;
      return response;
    } catch (error) {
      throw normalizeGeminiError_(error);
    }
  }

  function generateContent_(request, image, extraConfig) {
    request = request || {};
    var model = getConfiguredModel_();
    var apiKey = getApiKey_();
    var url = API_BASE_URL + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    var body = buildRequestBody_(request, image, extraConfig);

    try {
      var httpResponse = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      return parseGenerateContentResponse_(httpResponse, model);
    } catch (error) {
      throw normalizeGeminiError_(error);
    }
  }

  function buildRequestBody_(request, image, extraConfig) {
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

    var body = {
      contents: contents,
      systemInstruction: {
        parts: [{
          text: String(request.systemInstruction || '')
        }]
      },
      generationConfig: {
        temperature: 0.4
      }
    };

    if (extraConfig && extraConfig.responseMimeType) {
      body.generationConfig.responseMimeType = extraConfig.responseMimeType;
    }
    if (extraConfig && extraConfig.responseJsonSchema) {
      body.generationConfig.responseJsonSchema = extraConfig.responseJsonSchema;
    }
    return body;
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
          userMessage: 'The AI could not answer that request.'
        }
      );
    }
    var parts = candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    return parts
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
          userMessage: 'The AI request could not be processed.'
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

  function getConfiguredModel_() {
    var config = ConfigRepository.getByKey('GEMINI_MODEL');
    var model = config && config.value ? String(config.value) : '';
    ensure(model, 'CONFIG_MISSING', 'GEMINI_MODEL is not configured.');
    return model;
  }

  return {
    generateText: generateText,
    generateStructured: generateStructured,
    generateWithImage: generateWithImage,
    __test: {
      mapHttpError: mapHttpError_,
      extractTextFromCandidate: extractTextFromCandidate_,
      buildRequestBody: buildRequestBody_,
      getStructuredResponseSchema: getStructuredResponseSchema_,
      parseStructuredData: parseStructuredData_,
      normalizeGeminiError: normalizeGeminiError_
    }
  };
})();

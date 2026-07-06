var GeminiClient = (function() {
  var API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

  function generateText(request) {
    return generateContent_(request, null);
  }

  function generateWithImage(request) {
    return generateContent_(request, request && request.image ? request.image : null);
  }

  function generateStructured(request, schemaName) {
    var response = generateContent_(request, request && request.image ? request.image : null, {
      responseMimeType: 'application/json'
    });
    try {
      response.data = JsonUtil.parse(response.text, {
        code: 'GEMINI_BAD_RESPONSE',
        message: 'Gemini structured response is not valid JSON.'
      });
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
    ensure(contents.length > 0, 'GEMINI_BAD_RESPONSE', 'Gemini request contents are required.');

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
    return body;
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
      throw createAppError('GEMINI_BAD_RESPONSE', 'Gemini response did not contain text.', null, {
        retryable: true
      });
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
        null,
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
      return createAppError('GEMINI_RATE_LIMIT', message);
    }
    if (statusCode === 401 || statusCode === 403) {
      return createAppError('GEMINI_AUTH_FAILED', message);
    }
    if (
      statusCode === 404 ||
      lowered.indexOf('model') !== -1 && (
        lowered.indexOf('not found') !== -1 ||
        lowered.indexOf('unavailable') !== -1 ||
        lowered.indexOf('unsupported') !== -1
      )
    ) {
      return createAppError('GEMINI_MODEL_UNAVAILABLE', message, null, {
        httpStatus: statusCode
      });
    }
    if (statusCode >= 500) {
      return createAppError('GEMINI_TEMPORARY_FAILURE', message, null, {
        httpStatus: statusCode
      });
    }
    if (statusCode === 400) {
      return createAppError('GEMINI_BAD_RESPONSE', message, null, {
        retryable: false,
        httpStatus: 400,
        userMessage: 'The AI request could not be processed.'
      });
    }
    return createAppError('GEMINI_TEMPORARY_FAILURE', message, null, {
      httpStatus: statusCode
    });
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
      return createAppError('GEMINI_TEMPORARY_FAILURE', message, null, {
        cause: error
      });
    }
    return normalizeError(error, 'GEMINI_TEMPORARY_FAILURE', message);
  }

  function safeParseJson_(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw createAppError('GEMINI_BAD_RESPONSE', 'Gemini response body was not valid JSON.', null, {
        cause: error,
        retryable: true
      });
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
      extractTextFromCandidate: extractTextFromCandidate_
    }
  };
})();

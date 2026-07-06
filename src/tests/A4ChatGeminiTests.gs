function runA4ChatGeminiTests() {
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
        message: error && error.message ? error.message : String(error)
      });
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

  test('completed ChatResult structure', function() {
    var result = {
      ok: true,
      status: 'completed',
      requestId: '11111111-1111-4111-8111-111111111111',
      userMessage: {
        messageId: '22222222-2222-4222-8222-222222222222',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:00+09:00',
        role: 'user',
        messageType: 'text',
        text: 'Hi',
        image: null,
        status: 'accepted',
        error: null
      },
      assistantMessage: {
        messageId: '33333333-3333-4333-8333-333333333333',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:02+09:00',
        role: 'assistant',
        messageType: 'text',
        text: 'Hello',
        image: null,
        status: 'completed',
        error: null
      },
      retryAfterSeconds: null,
      error: null,
      warnings: []
    };
    assert(result.ok === true && result.status === 'completed', 'Completed result should be successful.');
    assert(Array.isArray(result.warnings), 'Warnings must be an array.');
    assert(result.userMessage && result.assistantMessage, 'Completed result requires both messages.');
  });

  test('queued ChatResult structure', function() {
    var result = {
      ok: true,
      status: 'queued',
      requestId: '11111111-1111-4111-8111-111111111111',
      userMessage: {
        messageId: '22222222-2222-4222-8222-222222222222',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:00+09:00',
        role: 'user',
        messageType: 'text',
        text: 'Hi',
        image: null,
        status: 'accepted',
        error: null
      },
      assistantMessage: null,
      retryAfterSeconds: 60,
      error: null,
      warnings: ['Retrying']
    };
    assert(result.ok === true && result.status === 'queued', 'Queued result should be successful.');
    assert(result.retryAfterSeconds >= 1, 'Queued result needs retryAfterSeconds.');
    assert(Array.isArray(result.warnings), 'Warnings must be an array.');
  });

  test('failed ChatResult structure', function() {
    var errorDto = createAppError('GEMINI_AUTH_FAILED', 'bad auth').toUserDto();
    var result = {
      ok: false,
      status: 'failed',
      requestId: '11111111-1111-4111-8111-111111111111',
      userMessage: null,
      assistantMessage: null,
      retryAfterSeconds: null,
      error: errorDto,
      warnings: []
    };
    assert(result.ok === false && result.status === 'failed', 'Failed result should not be successful.');
    assert(result.error.code === 'GEMINI_AUTH_FAILED', 'Failed result should expose the error DTO.');
    assert(Array.isArray(result.warnings), 'Warnings must be an array.');
  });

  test('image metadata validation accepts supported temp file flow', function() {
    var image = {
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      tempFileId: 'temp-file-id'
    };
    assert(ImageService.validateImageMetadata(image) === true, 'Temp-file-backed image should validate.');
  });

  expectThrows('image metadata validation rejects unsupported MIME type', function() {
    ImageService.validateImageMetadata({
      name: 'photo.gif',
      mimeType: 'image/gif',
      base64: 'Zm9v'
    });
  }, 'VALIDATION_IMAGE_UNSUPPORTED');

  test('Gemini error normalization rate limit', function() {
    var error = GeminiClient.__test.mapHttpError(429, {
      error: {
        message: 'Rate limit exceeded.'
      }
    });
    assert(error.code === 'GEMINI_RATE_LIMIT', '429 should map to GEMINI_RATE_LIMIT.');
    assert(error.retryable === true, 'Rate limit should be retryable.');
  });

  test('Gemini error normalization auth failure', function() {
    var error = GeminiClient.__test.mapHttpError(403, {
      error: {
        message: 'Permission denied.'
      }
    });
    assert(error.code === 'GEMINI_AUTH_FAILED', '403 should map to GEMINI_AUTH_FAILED.');
    assert(error.retryable === false, 'Auth failures should not be retryable.');
  });

  test('duplicate request helper yields positive retry seconds', function() {
    var seconds = ChatService.__test.computeRetryAfterSeconds({
      nextAttemptAt: '2099-01-01T00:00:10+09:00'
    });
    assert(seconds >= 1, 'Retry delay should be positive.');
  });

  test('chat prompt includes latest current user turn', function() {
    var contents = ChatService.__test.buildContents({
      recentMessages: [{
        messageId: '22222222-2222-4222-8222-222222222222',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-06T10:00:00+09:00',
        role: 'user',
        messageType: 'image',
        text: '[Image] cat photo',
        image: {
          name: 'cat.jpg',
          mimeType: 'image/jpeg',
          summary: 'cat photo'
        },
        status: 'accepted',
        error: null
      }]
    }, {
      requestId: '11111111-1111-4111-8111-111111111111',
      text: 'What is in this image?'
    }, {
      storedImage: {
        name: 'cat.jpg',
        mimeType: 'image/jpeg',
        summary: 'cat photo'
      }
    });
    assert(contents.length === 1, 'Current request should collapse to one latest user turn.');
    assert(contents[0].role === 'user', 'Current turn should be sent as a user role.');
    assert(contents[0].parts[0].text === 'What is in this image?', 'Current user text should be preserved.');
  });

  test('image summary truncates to 150 chars', function() {
    var summary = ImageService.buildImageSummary({
      name: 'photo.jpg'
    }, new Array(200).join('a'));
    assert(summary.length <= 150, 'Summary should be bounded.');
  });

  return results;
}

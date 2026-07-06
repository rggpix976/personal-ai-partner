var JsonUtil = (function() {
  function parse(text, options) {
    options = options || {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw createAppError(
        options.code || 'STORAGE_DATA_CORRUPTED',
        options.message || 'Failed to parse JSON.',
        {
          sample: AppLogger.mask(text)
        },
        {
          cause: error
        }
      );
    }
  }

  function stringify(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      throw createAppError('STORAGE_DATA_CORRUPTED', 'Failed to stringify JSON.', null, {
        cause: error
      });
    }
  }

  function clone(value) {
    return parse(stringify(value));
  }

  return {
    parse: parse,
    stringify: stringify,
    clone: clone
  };
})();

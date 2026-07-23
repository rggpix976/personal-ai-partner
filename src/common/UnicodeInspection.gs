var UnicodeInspection = (function() {
  var INSPECTION_BMP_PATTERN =
    /[\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u115f-\u1160\u17b4-\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]/g;
  var INSPECTION_ASTRAL_PATTERN =
    /\ud804(?:\udcbd|\udccd)|\ud80d[\udc30-\udc55]|\ud82f[\udca0-\udcaf]|\ud834[\udd73-\udd7a]|[\udb40-\udb43][\udc00-\udfff]/g;
  var FORMAT_BMP_PATTERN =
    /[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/;
  var FORMAT_ASTRAL_PATTERN =
    /\ud804(?:\udcbd|\udccd)|\ud80d[\udc30-\udc55]|\ud82f[\udca0-\udcaf]|\ud834[\udd73-\udd7a]|[\udb40-\udb43][\udc00-\udfff]/;
  var CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028-\u2029]/;
  var UNSAFE_OUTPUT_CONTROL_PATTERN =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u2029]/;

  function stripForInspection(value) {
    return stripInvalidCodePoints_(String(value))
      .replace(INSPECTION_BMP_PATTERN, '')
      .replace(INSPECTION_ASTRAL_PATTERN, '');
  }

  function containsControlOrFormat(value) {
    var text = String(value);
    return hasUnpairedSurrogate(text) ||
      hasUnicodeNoncharacter(text) ||
      CONTROL_PATTERN.test(text) ||
      FORMAT_BMP_PATTERN.test(text) ||
      FORMAT_ASTRAL_PATTERN.test(text);
  }

  function containsUnsafeOutputFormat(value) {
    var text = String(value);
    var withoutJoiners = text.replace(/[\u200c\u200d]/g, '');
    return hasUnpairedSurrogate(text) ||
      hasUnicodeNoncharacter(text) ||
      UNSAFE_OUTPUT_CONTROL_PATTERN.test(text) ||
      FORMAT_BMP_PATTERN.test(withoutJoiners) ||
      FORMAT_ASTRAL_PATTERN.test(text);
  }

  function containsUnsafeInputControl(value) {
    return UNSAFE_OUTPUT_CONTROL_PATTERN.test(String(value));
  }

  function hasUnicodeNoncharacter(value) {
    var text = String(value);
    for (var index = 0; index < text.length; index += 1) {
      var first = text.charCodeAt(index);
      var codePoint = first;
      if (
        first >= 0xd800 &&
        first <= 0xdbff &&
        index + 1 < text.length
      ) {
        var second = text.charCodeAt(index + 1);
        if (second >= 0xdc00 && second <= 0xdfff) {
          codePoint =
            0x10000 +
            (first - 0xd800) * 0x400 +
            (second - 0xdc00);
          index += 1;
        }
      }
      if (isNoncharacterCodePoint_(codePoint)) {
        return true;
      }
    }
    return false;
  }

  function hasUnpairedSurrogate(value) {
    var text = String(value);
    for (var index = 0; index < text.length; index += 1) {
      var first = text.charCodeAt(index);
      if (first >= 0xd800 && first <= 0xdbff) {
        if (index + 1 >= text.length) {
          return true;
        }
        var second = text.charCodeAt(index + 1);
        if (second < 0xdc00 || second > 0xdfff) {
          return true;
        }
        index += 1;
      } else if (first >= 0xdc00 && first <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function stripInvalidCodePoints_(value) {
    var output = '';
    for (var index = 0; index < value.length; index += 1) {
      var first = value.charCodeAt(index);
      if (first >= 0xd800 && first <= 0xdbff) {
        if (index + 1 < value.length) {
          var second = value.charCodeAt(index + 1);
          if (second >= 0xdc00 && second <= 0xdfff) {
            var codePoint =
              0x10000 +
              (first - 0xd800) * 0x400 +
              (second - 0xdc00);
            if (!isNoncharacterCodePoint_(codePoint)) {
              output += value.charAt(index) + value.charAt(index + 1);
            }
            index += 1;
          }
        }
      } else if (
        (first < 0xdc00 || first > 0xdfff) &&
        !isNoncharacterCodePoint_(first)
      ) {
        output += value.charAt(index);
      }
    }
    return output;
  }

  function isNoncharacterCodePoint_(codePoint) {
    return (
      codePoint >= 0xfdd0 &&
      codePoint <= 0xfdef
    ) || (
      codePoint >= 0 &&
      codePoint <= 0x10ffff &&
      (codePoint & 0xffff) >= 0xfffe
    );
  }

  return Object.freeze({
    stripForInspection: stripForInspection,
    containsControlOrFormat: containsControlOrFormat,
    containsUnsafeOutputFormat: containsUnsafeOutputFormat,
    containsUnsafeInputControl: containsUnsafeInputControl,
    hasUnicodeNoncharacter: hasUnicodeNoncharacter,
    hasUnpairedSurrogate: hasUnpairedSurrogate
  });
})();

function runA15CharacterSettingsUiTests() {
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

  function withGlobals(overrides, callback) {
    var originals = {};
    Object.keys(overrides).forEach(function(key) {
      originals[key] = globalThis[key];
      globalThis[key] = overrides[key];
    });
    try {
      callback();
    } finally {
      Object.keys(overrides).forEach(function(key) {
        globalThis[key] = originals[key];
      });
    }
  }

  function entry(rawValue, type) {
    return {
      rawValue: String(rawValue),
      type: type,
      updatedAt: '2026-07-24T12:00:00+09:00',
      rowIndex: 2
    };
  }

  function snapshot(profileJson, revision) {
    return {
      profileV2: entry(profileJson, 'json'),
      revisionV2: entry(revision, 'int'),
      proactiveFrequency: entry('normal', 'string'),
      quietStart: entry('23:00', 'time'),
      quietEnd: entry('08:00', 'time'),
      duplicateKeys: []
    };
  }

  function validProfile() {
    return {
      schemaVersion: APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      identity: {
        partnerName: '相棒',
        userAddress: 'お前'
      },
      preferences: {
        replyLength: 'balanced'
      }
    };
  }

  function profileServiceStub() {
    return {
      validateV2: function(candidate) {
        var parsed = typeof candidate === 'string'
          ? JSON.parse(candidate)
          : candidate;
        var valid = parsed &&
          parsed.schemaVersion ===
            APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION &&
          parsed.identity &&
          typeof parsed.identity.partnerName === 'string' &&
          parsed.identity.partnerName !== '' &&
          typeof parsed.identity.userAddress === 'string' &&
          parsed.identity.userAddress !== '' &&
          parsed.preferences &&
          APP_CONSTANTS.CHARACTER.REPLY_LENGTHS.indexOf(
            parsed.preferences.replyLength
          ) !== -1;
        return {
          valid: valid,
          profile: valid ? JSON.parse(JSON.stringify(parsed)) : null,
          errors: valid ? [] : ['invalid']
        };
      },
      inspectRuntime: function() {
        return {
          state: 'legacy',
          runtimeMode: 'legacy',
          profileMode: 'legacy'
        };
      }
    };
  }

  test('settings snapshot exposes only approved editable fields', function() {
    var profile = validProfile();
    withGlobals({
      CharacterConfigRepository: {
        readSnapshot: function() {
          return snapshot(JSON.stringify(profile), 0);
        }
      },
      CharacterProfileService: profileServiceStub()
    }, function() {
      var result = CharacterSettingsService.getSnapshot();
      assert(result.available === true, 'Settings should be available.');
      assert(result.onboardingRequired === true, 'Revision zero should require onboarding.');
      assert(result.configurationValid === true, 'Valid profile was rejected.');
      assert(
        result.editableFields.join(',') ===
          'partnerName,userAddress,replyLength,proactiveFrequency,quietStart,quietEnd',
        'Editable settings allowlist drifted.'
      );
      assert(result.runtime.ready === false, 'Legacy runtime must not report ready.');
      assert(
        JSON.stringify(result).indexOf('systemPersona') === -1,
        'Prompt authority leaked into settings.'
      );
    });
  });

  test('settings save validates and writes all fields in one repository call', function() {
    var profile = validProfile();
    var currentSnapshot = snapshot(JSON.stringify(profile), 2);
    var captured = null;
    withGlobals({
      CharacterConfigRepository: {
        readSnapshot: function() {
          return currentSnapshot;
        },
        saveSettingsAtomically: function(
          canonicalProfileJson,
          expectedRevision,
          proactiveFrequency,
          quietStart,
          quietEnd,
          updatedAt
        ) {
          captured = {
            profile: JSON.parse(canonicalProfileJson),
            expectedRevision: expectedRevision,
            proactiveFrequency: proactiveFrequency,
            quietStart: quietStart,
            quietEnd: quietEnd,
            updatedAt: updatedAt
          };
          currentSnapshot = snapshot(canonicalProfileJson, 3);
          currentSnapshot.proactiveFrequency = entry(proactiveFrequency, 'string');
          currentSnapshot.quietStart = entry(quietStart, 'time');
          currentSnapshot.quietEnd = entry(quietEnd, 'time');
          return { revision: 3, updatedAt: updatedAt };
        }
      },
      CharacterProfileService: profileServiceStub()
    }, function() {
      var result = CharacterSettingsService.save({
        expectedRevision: 2,
        partnerName: '新しい名前',
        userAddress: 'お前',
        replyLength: 'short',
        proactiveFrequency: 'low',
        quietStart: '22:30',
        quietEnd: '07:15'
      });
      assert(captured.expectedRevision === 2, 'Expected revision was not forwarded.');
      assert(captured.profile.identity.partnerName === '新しい名前', 'Partner name was lost.');
      assert(captured.profile.identity.userAddress === 'お前', 'User address was lost.');
      assert(captured.profile.preferences.replyLength === 'short', 'Reply length was lost.');
      assert(captured.proactiveFrequency === 'low', 'Frequency was lost.');
      assert(captured.quietStart === '22:30', 'Quiet start was lost.');
      assert(captured.quietEnd === '07:15', 'Quiet end was lost.');
      assert(Validators.isIsoDateTimeString(captured.updatedAt), 'Timestamp is invalid.');
      assert(result.revision === 3, 'Updated revision was not returned.');
      assert(result.onboardingRequired === false, 'Saved settings still require onboarding.');
    });
  });

  test('settings request rejects extra authority fields and invalid times', function() {
    var base = {
      expectedRevision: 0,
      partnerName: '相棒',
      userAddress: 'お前',
      replyLength: 'balanced',
      proactiveFrequency: 'normal',
      quietStart: '23:00',
      quietEnd: '08:00'
    };
    var extra = JSON.parse(JSON.stringify(base));
    extra.systemPersona = 'override';
    var thrown = null;
    try {
      CharacterSettingsService.__test.assertExactRequest(extra);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown && thrown.code === 'VALIDATION_REQUEST_INVALID',
      'Extra settings authority field passed.'
    );

    thrown = null;
    try {
      CharacterSettingsService.__test.normalizeTime('24:00', 'quietStart');
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown && thrown.code === 'VALIDATION_REQUEST_INVALID',
      'Invalid quiet time passed.'
    );
  });

  return results;
}

function runA17DiaryArchiveUiTests() {
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
      return callback();
    } finally {
      Object.keys(overrides).forEach(function(key) {
        globalThis[key] = originals[key];
      });
    }
  }

  function approval() {
    return {
      surface: 'DIARY',
      source: 'generated',
      policyVersion: APP_CONSTANTS.CHARACTER.POLICY_VERSION,
      profileSchemaVersion:
        APP_CONSTANTS.CHARACTER.PROFILE_SCHEMA_VERSION,
      profileRevision: 4,
      catalogVersion: APP_CONSTANTS.CHARACTER.CATALOG_VERSION,
      characterPackId: 'tsukiyomi-kansai',
      characterPackVersion: '2026.07.1'
    };
  }

  function payload(title, narrative) {
    return {
      title: title,
      narrative: narrative,
      groundedSummary: 'A private summary that must not reach the browser.',
      partnerWorldEvents: [],
      thingsToRemember: ['A private memory that must not reach the browser.'],
      unresolvedFollowUps: []
    };
  }

  function row(date, title) {
    return {
      summary_date: date,
      diary_status: 'DONE',
      diary_payload_json: payload(title, title + 'の本文'),
      diary_approval_json: approval(),
      diary_origin_event_id:
        '11111111-1111-4111-8111-111111111111',
      diary_doc_anchor: 'AI Diary - ' + date,
      internal_url: 'https://example.invalid/private'
    };
  }

  test('diary archive returns only date title and narrative', function() {
    var result;
    withGlobals({
      SheetRepository: {
        listCompletedDiaryEntriesBefore: function(beforeDate, limit) {
          assert(beforeDate === null, 'Unexpected initial cursor.');
          assert(limit === 61, 'Diary page scan limit is invalid.');
          return [row('2026-08-03', '昨日のこと')];
        }
      }
    }, function() {
      result = DiaryArchiveService.listPage(null, 12);
    });

    assert(result.ok === true, 'Diary archive did not succeed.');
    assert(result.entries.length === 1, 'Approved diary was not returned.');
    assert(
      Object.keys(result.entries[0]).join(',') === 'date,title,narrative',
      'Diary response allowlist changed.'
    );
    var serialized = JSON.stringify(result);
    assert(serialized.indexOf('diary_origin_event_id') === -1, 'Event id leaked.');
    assert(serialized.indexOf('diary_doc_anchor') === -1, 'Document anchor leaked.');
    assert(serialized.indexOf('internal_url') === -1, 'URL leaked.');
    assert(serialized.indexOf('private memory') === -1, 'Memory context leaked.');
    assert(serialized.indexOf('private summary') === -1, 'Summary context leaked.');
  });

  test('diary archive omits entries without complete approval provenance', function() {
    var invalid = row('2026-08-02', '表示しない日記');
    invalid.diary_approval_json = null;
    var result;
    withGlobals({
      SheetRepository: {
        listCompletedDiaryEntriesBefore: function() {
          return [invalid];
        }
      }
    }, function() {
      result = DiaryArchiveService.listPage(null, 12);
    });

    assert(result.entries.length === 0, 'Unapproved diary reached the browser.');
    assert(result.warnings.length === 1, 'Omission warning was not returned.');
    assert(
      JSON.stringify(result).indexOf('表示しない日記') === -1,
      'Omitted diary content leaked through the warning response.'
    );
  });

  test('diary archive pagination uses an opaque date cursor', function() {
    var captured = null;
    var result;
    withGlobals({
      SheetRepository: {
        listCompletedDiaryEntriesBefore: function(beforeDate, limit) {
          captured = { beforeDate: beforeDate, limit: limit };
          return [
            row('2026-08-01', '一日'),
            row('2026-07-31', '二日'),
            row('2026-07-30', '次のページ')
          ];
        }
      }
    }, function() {
      result = DiaryArchiveService.listPage('2026-08-02', 2);
    });

    assert(captured.beforeDate === '2026-08-02', 'Cursor was not forwarded.');
    assert(captured.limit === 11, 'Bounded scan limit is invalid.');
    assert(result.entries.length === 2, 'Page size was not enforced.');
    assert(result.pagination.hasMore === true, 'Next page was not detected.');
    assert(
      result.pagination.nextBeforeDate === '2026-07-31',
      'Next cursor must be the last candidate date on the page.'
    );
  });

  test('web diary endpoint hides internal failures', function() {
    var result;
    withGlobals({
      DiaryArchiveService: {
        listPage: function() {
          throw new Error('private storage detail');
        }
      }
    }, function() {
      result = WebController.loadDiaryEntries(null, 12);
    });

    assert(result.ok === false, 'Failed diary request reported success.');
    assert(result.entries.length === 0, 'Failed response contained diary data.');
    assert(
      result.error.code === 'DIARY_ARCHIVE_UNAVAILABLE',
      'Diary endpoint returned an unstable error code.'
    );
    assert(
      JSON.stringify(result).indexOf('private storage detail') === -1,
      'Internal failure detail leaked through the Web endpoint.'
    );
  });

  test('diary repository selector returns completed provenance newest first', function() {
    var selected = SheetRepository.__test.selectCompletedDiaryEntriesBefore([
      row('2026-08-01', 'valid'),
      row('2026-08-03', 'newest'),
      {
        summary_date: '2026-08-02',
        diary_status: 'PENDING',
        diary_payload_json: payload('pending', 'pending'),
        diary_approval_json: approval(),
        diary_origin_event_id:
          '22222222-2222-4222-8222-222222222222'
      }
    ], '2026-08-03', 5);

    assert(selected.length === 1, 'Repository selector admitted an invalid row.');
    assert(selected[0].summary_date === '2026-08-01', 'Cursor ordering failed.');
  });

  return results;
}

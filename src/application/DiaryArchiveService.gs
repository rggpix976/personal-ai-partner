var DiaryArchiveService = (function() {
  var DEFAULT_PAGE_SIZE = 12;
  var MAX_PAGE_SIZE = 30;

  function listPage(beforeDate, limit) {
    var normalizedCursor = normalizeCursor_(beforeDate);
    var normalizedLimit = normalizeLimit_(limit);
    var scanLimit = normalizedLimit * 5 + 1;
    var rows = SheetRepository.listCompletedDiaryEntriesBefore(
      normalizedCursor,
      scanLimit
    );
    var entries = [];
    var omittedCount = 0;
    var consumedCount = 0;

    for (var i = 0; i < rows.length; i += 1) {
      if (entries.length >= normalizedLimit) {
        break;
      }
      var row = rows[i];
      consumedCount = i + 1;
      var entry = normalizeApprovedEntry_(row);
      if (entry) {
        entries.push(entry);
      } else {
        omittedCount += 1;
      }
    }

    var hasMore = consumedCount < rows.length || rows.length === scanLimit;

    return {
      ok: true,
      entries: entries,
      pagination: {
        hasMore: hasMore,
        nextBeforeDate: hasMore && consumedCount > 0
          ? rows[consumedCount - 1].summary_date
          : null
      },
      warnings: omittedCount > 0
        ? ['一部の日記は安全に表示できないため省略しました。']
        : []
    };
  }

  function normalizeApprovedEntry_(row) {
    if (
      !row ||
      row.diary_status !== 'DONE' ||
      !Validators.isDateString(String(row.summary_date || '')) ||
      !isApprovedDiaryProvenance_(row)
    ) {
      return null;
    }

    var payload;
    try {
      payload = CharacterPayloadService.normalize(
        'DIARY',
        row.diary_payload_json
      );
    } catch (ignored) {
      return null;
    }

    return {
      date: String(row.summary_date),
      title: payload.title,
      narrative: payload.narrative
    };
  }

  function isApprovedDiaryProvenance_(row) {
    var approval = row.diary_approval_json;
    var fields = APP_CONSTANTS.CHARACTER.APPROVAL_FIELDS;
    if (
      !approval ||
      typeof approval !== 'object' ||
      Array.isArray(approval) ||
      Object.keys(approval).length !== fields.length ||
      !fields.every(function(field) {
        return Object.prototype.hasOwnProperty.call(approval, field);
      }) ||
      approval.surface !== 'DIARY' ||
      (approval.source !== 'generated' && approval.source !== 'rewrite') ||
      typeof approval.policyVersion !== 'string' ||
      approval.policyVersion.trim() === '' ||
      typeof approval.profileSchemaVersion !== 'string' ||
      approval.profileSchemaVersion.trim() === '' ||
      !Number.isSafeInteger(Number(approval.profileRevision)) ||
      Number(approval.profileRevision) <= 0 ||
      typeof approval.catalogVersion !== 'string' ||
      approval.catalogVersion.trim() === '' ||
      typeof approval.characterPackId !== 'string' ||
      approval.characterPackId.trim() === '' ||
      typeof approval.characterPackVersion !== 'string' ||
      approval.characterPackVersion.trim() === ''
    ) {
      return false;
    }

    return Validators.isUuidV4(String(row.diary_origin_event_id || ''));
  }

  function normalizeCursor_(value) {
    if (value == null || String(value).trim() === '') {
      return null;
    }
    var cursor = String(value);
    Validators.assertDateString(cursor, 'beforeDate');
    return cursor;
  }

  function normalizeLimit_(value) {
    var normalized = Number(value || DEFAULT_PAGE_SIZE);
    if (!isFinite(normalized) || normalized <= 0) {
      normalized = DEFAULT_PAGE_SIZE;
    }
    return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(normalized)));
  }

  return {
    listPage: listPage,
    __test: {
      normalizeApprovedEntry: normalizeApprovedEntry_,
      isApprovedDiaryProvenance: isApprovedDiaryProvenance_,
      normalizeLimit: normalizeLimit_
    }
  };
})();

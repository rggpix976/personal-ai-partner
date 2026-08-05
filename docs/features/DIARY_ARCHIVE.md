# Web App diary archive

## Purpose

The owner can read generated diary entries without opening the backing Google
Document. The Web App is the primary reading surface; Google Docs remains the
storage and operational recovery surface.

## User experience

- The header contains a `日記` button.
- Opening it loads the newest completed diary entries.
- Selecting a date shows that entry inside the Web App.
- `以前の日記を読む` loads older entries in bounded pages.
- `更新` reloads the newest page.
- The layout becomes one column on narrow screens.
- The archive is read-only. It does not edit or delete diary data.

## Data boundary

The Web endpoint returns only:

```text
date
title
narrative
```

An entry is eligible only when its daily summary is `DONE` and contains a
complete generated or rewritten diary approval, a valid origin event, and a
payload accepted by `CharacterPayloadService`.

The response never contains Google Drive or Docs identifiers, document
anchors, URLs, approval records, queue event identifiers, grounded summaries,
memory candidates, or Partner World metadata. Invalid entries are omitted and
produce only a generic warning.

The client renders all server-provided diary content with `textContent` and
does not interpret diary text as HTML.

## API

`loadDiaryEntries(beforeDate, limit)` delegates through `PublicApi` and
`WebController` to `DiaryArchiveService`.

- `beforeDate` is an optional `yyyy-MM-dd` exclusive cursor.
- The default page size is 12 and the maximum is 30.
- Results are newest first.
- Internal failures are mapped to `DIARY_ARCHIVE_UNAVAILABLE` without storage
  details.

## Verification

- `runA17DiaryArchiveUiTests()` covers the response allowlist, provenance
  rejection, pagination, repository filtering, and error redaction.
- `tools/validate_web_ui.js` parses the client script, checks referenced DOM
  identifiers, and rejects unsafe HTML writes.
- The complete Apps Script self-test suite and static audit must pass before
  deployment.

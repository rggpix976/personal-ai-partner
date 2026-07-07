# A7 Security Review

## Summary

A7 reviewed the repository for static security risks and prepared the live validation checklist. The review is based on source inspection and local static checks. It does not replace live Apps Script authorization, Gmail, Drive, Docs, or Gemini validation.

## Security Posture

Current recommendation:

- Proceed to controlled live validation in a personal Google account.
- Do not claim production readiness until live validation passes.
- Keep all secrets in Apps Script Script Properties.
- Keep Web App deployment owner-only or otherwise restricted to the intended single user.

## Reviewed Areas

### Secret Handling

Expected controls:

- `GEMINI_API_KEY` is read from Script Properties.
- `OWNER_EMAIL` is read from Script Properties.
- API keys are not committed to repository files.
- Owner email is not hardcoded in production source.
- Logs must not include API keys, full prompts, raw image base64, or owner email.

A7 static audit checks for likely API keys, private key blocks, OAuth tokens, and hardcoded non-example email addresses.

### Gemini Boundary

Expected controls:

- Direct `UrlFetchApp` calls to Gemini are isolated in `GeminiClient`.
- Application services call `GeminiClient` instead of constructing Gemini HTTP requests directly.
- Gemini errors are normalized before queue retry/dead handling.

### Gmail Boundary

Expected controls:

- `MailApp` usage is isolated in `GmailNotifier`.
- Remaining daily quota is checked before send.
- `MAIL_QUOTA_EXHAUSTED` does not use common short retry loops.
- Proactive send uses a pre-send marker so retry favors no duplicate email over duplicate email.

### Sheets Boundary

Expected controls:

- `SpreadsheetApp` usage is isolated in `SheetRepository`, `Setup`, and tests.
- Event queue updates preserve A1 state transitions.
- `DONE` and `DEAD` events are not claimed.
- `PENDING` with future `nextAttemptAt` is not claimed.
- `lastError: null` clears stored error columns.

### Drive and Docs Boundary

Expected controls:

- Temporary image storage and cleanup are isolated in `DriveTempRepository`.
- Weekly backup copies are created by `MaintenanceService`.
- Diary document append operations are isolated in `DocumentRepository`.
- Cleanup must target only configured temp files and must not delete arbitrary Drive files.
- Weekly backup must not be re-created repeatedly for the same `backupDate`.

### WebUI XSS

Expected controls:

- User-controlled content is rendered through DOM text APIs.
- Unsafe DOM APIs such as `innerHTML`, `outerHTML`, `insertAdjacentHTML`, and `document.write` are not used for user content.
- Inline bootstrap JSON is escaped.

### Triggers

Expected controls:

- `installTriggers()` avoids duplicate trigger creation.
- `deleteProjectTriggers()` exists for teardown.
- Time-based queue and scheduler triggers are visible through `listProjectTriggers()`.

## Static Audit Command

```bash
python tools/a7_static_audit.py
```

Latest local result: `A7_STATIC_AUDIT_SUMMARY errors=0 warnings=0 files=79`.

The audit checks:

- UTF-8 decoding
- LF-only line endings
- no BOM
- no bidi controls
- no Unicode format controls
- no NBSP
- no unexpected ASCII controls
- likely hardcoded secrets
- hardcoded non-example email addresses
- forbidden Apps Script APIs outside approved files
- unsafe DOM APIs
- suspicious base64/API-key/full-prompt logging
- extremely long Markdown lines as warnings

## Residual Risks

| Risk | Status | Mitigation |
| --- | --- | --- |
| Apps Script OAuth scope prompt not reviewed live | Open | Review scopes during first deployment. |
| Gemini API key validity not tested locally | Open | Run live text and image chat in target project. |
| MailApp quota behavior varies by account | Open | Run manual quota-safe test or dry-run stub first. |
| Drive backup creates real files | Open | Validate in a test folder before relying on backups. |
| Trigger timing cannot be proven locally | Open | Install triggers and inspect execution history in Apps Script. |
| Web App deployment sharing setting can be misconfigured | Open | Confirm deployment is restricted to the intended owner/user. |

## Go / No-Go Recommendation

- Go: local static and contract validation.
- Go: controlled live validation.
- No-go: production-ready claim until all live checks pass.

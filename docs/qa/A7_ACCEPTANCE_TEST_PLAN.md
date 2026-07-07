# A7 Acceptance Test Plan

## Purpose

This plan defines the acceptance checks required before the Personal Proactive AI Partner can be treated as MVP-ready.

A7 does not mark the system production-ready by itself. Production readiness requires passing the live Apps Script, Gemini, Gmail, Drive, Docs, and browser validation steps.

## Scope

Covered:

- Setup and configuration
- WebUI smoke tests
- Chat and image chat
- Queue retry behavior
- Memory extraction
- Diary generation
- Proactive email behavior
- Weekly backup
- Maintenance cleanup
- Security and rollback

Not covered:

- Google Chat integration
- Multi-user account isolation
- Paid-tier Gemini guarantees
- Enterprise operations

## Acceptance Matrix

| ID | Area | Test | Expected Result | Type |
| --- | --- | --- | --- | --- |
| AT-001 | Setup | Run `setup()` after setting required Script Properties. | Sheets, Docs, temp folder, backup folder, defaults, and schema version are created or reused. | Live GAS |
| AT-002 | Setup | Run `validatePreSetupProperties()`. | Required pre-setup properties are valid. | Live GAS |
| AT-003 | Setup | Run `validatePostSetupProperties()`. | All required sheets and storage objects exist. | Live GAS |
| AT-004 | Setup | Run `validatePostDeployProperties()` after setting `WEB_APP_URL`. | `/exec` deployment URL is accepted. | Live GAS |
| AT-005 | WebUI | Open deployed Web App in the owner account. | Initial screen loads without server error. | Browser |
| AT-006 | WebUI | Load latest messages. | `conversation_logs` messages appear in chronological UI order. | Browser |
| AT-007 | Chat | Send a short text message. | User and assistant messages are persisted, and response is displayed. | Live |
| AT-008 | Chat | Repeat the same `requestId`. | Duplicate request is idempotent and does not create duplicate user/assistant rows. | Live or self-test |
| AT-009 | Image | Send a JPEG image under limit. | Image is accepted, temporarily stored, Gemini receives inline image, and temp file is later eligible for cleanup. | Live |
| AT-010 | Image | Send a PNG image under limit. | Same as JPEG path. | Live |
| AT-011 | Image | Send a WebP image under limit. | Same as JPEG path. | Live |
| AT-012 | Image | Send unsupported MIME type. | Request is rejected with validation error and no Gemini call. | Browser/self-test |
| AT-013 | Chat Retry | Simulate Gemini temporary failure. | `CHAT_REPLY` event is queued and visible in `event_queue`. | Manual/stub |
| AT-014 | Queue | Run `processQueueJob()` on queued chat reply. | Event moves through `PROCESSING` to `DONE` or `RETRY_WAIT` according to error. | Live/stub |
| AT-015 | Queue | One event fails in a claimed batch. | Other claimed events still process. | Self-test |
| AT-016 | Memory | Enqueue and process `MEMORY_EXTRACT`. | Candidate memories are created/confirmed/updated without duplicate normalized keys. | Live/stub |
| AT-017 | Memory | Re-run same memory extraction event. | Operation is idempotent and does not create duplicate active memories. | Live/stub |
| AT-018 | Diary | Enqueue and process `DIARY_GENERATE`. | Diary entry is appended to configured Google Doc and `daily_summaries` is updated. | Live |
| AT-019 | Diary | Re-run same diary generation. | No duplicate diary heading or body is appended. | Live/stub |
| AT-020 | Proactive | Silence threshold reached outside quiet hours. | `PROACTIVE_SEND` event is enqueued once. | Live/stub |
| AT-021 | Proactive | Quiet hours active. | No proactive event is enqueued. | Self-test |
| AT-022 | Proactive | Daily max reached. | No additional proactive event is enqueued. | Self-test |
| AT-023 | Proactive | Cooldown active. | No proactive event is enqueued. | Self-test |
| AT-024 | Gmail | Mail quota is zero. | No email is sent; retry is deferred safely or event is completed without short retry loop. | Stub/live caution |
| AT-025 | Gmail | Retry after quota failure. | Conditions are re-evaluated and stale message body is not sent blindly. | Self-test/manual |
| AT-026 | Backup | Sunday after 03:00 Tokyo. | One `WEEKLY_BACKUP:{date}` event is enqueued. | Stub/live |
| AT-027 | Backup | Same Sunday after backup DONE. | No duplicate backup event or Drive copy is created. | Self-test/live |
| AT-028 | Maintenance | Temp image cleanup. | Only expired temp files in the configured temp folder are trashed. | Live caution |
| AT-029 | Maintenance | Debug log cleanup. | Only debug logs older than retention are removed. | Stub/live |
| AT-030 | Triggers | Run `installTriggers()` twice. | No duplicate `processQueueJob` or `schedulerJob` triggers are created. | Live GAS |
| AT-031 | Triggers | Run `deleteProjectTriggers()`. | Project triggers are removed for teardown. | Live GAS |
| AT-032 | Security | Run `python tools/a7_static_audit.py`. | Audit exits with zero errors. | Local |
| AT-033 | Contracts | Run `python tools/validate_contracts.py`. | Contract validation passes. | Local |
| AT-034 | Syntax | Parse all `.gs` files with Node. | Syntax pass succeeds. | Local |
| AT-035 | Rollback | Disable triggers and redeploy previous version if needed. | System stops scheduled side effects and previous deployment can be restored. | Manual |
| AT-036 | Restore | Restore from weekly backup copy. | Spreadsheet/Doc copies contain expected recoverable data. | Manual |

## Entry Criteria

- A6 is merged into `main`.
- `python tools/validate_contracts.py` passes.
- `python tools/a7_static_audit.py` passes.
- Apps Script project has correct OAuth scopes from `src/appsscript.json`.
- Test account has access to the target Google Sheet, Doc, Drive folders, and Gmail/MailApp.

## Exit Criteria

MVP validation can be accepted only when:

- All non-live local checks pass.
- All live smoke tests pass in the target Apps Script project.
- No P0/P1 security issue remains.
- All known limitations are documented.
- Triggers are installed exactly once each for queue and scheduler.
- Teardown procedure has been verified.

## Defect Severity

- P0: secret leak, broad destructive Drive deletion, uncontrolled email loop, broken setup, or data loss.
- P1: queue stuck, duplicate emails, duplicate diary/backup, broken chat, or wrong event transition.
- P2: degraded proactive behavior, partial cleanup failure, or non-blocking documentation mismatch.
- P3: formatting, minor diagnostics, or non-runtime documentation defects.

# A7 Integration Report

## Purpose

This document records the static integration review across A1-A6 and identifies the remaining live checks.

## Integration Map

### Web Chat

```text
Browser
  -> doGet()
  -> WebController
  -> sendChat(request)
  -> ChatService.send(...)
  -> ContextService
  -> GeminiClient
  -> SheetRepository conversation_logs
  -> WebUI polling / rendering
```

Status: statically wired.

A7 live checks:

- Browser can open deployed `/exec`.
- Text chat persists user and assistant rows.
- Duplicate `requestId` does not duplicate messages.
- Temporary Gemini failures create `CHAT_REPLY` events.

### Image Chat

```text
Browser file input
  -> Client MIME and byte-size validation
  -> sendChat(request.image)
  -> WebController validation
  -> ImageService
  -> temporary Drive file
  -> Gemini inline image input
  -> conversation_logs image metadata and bounded summary
  -> temporary file cleanup
```

Status: implemented and live-verified in the production Web App on 2026-07-21.

Privacy-safe live acceptance evidence:

- JPEG, PNG, and WebP each displayed an attachment preview, submitted
  successfully, and produced a completed assistant response.
- An unsupported text file was rejected before submission and did not add a
  conversation message.
- The three corresponding `sendChat` executions completed, reply polling
  completed, and no failed execution was visible in the reviewed history.
- The latest visible queue and scheduler executions were completed.
- Synthetic local test files were deleted after validation. No message
  content, raw image data, resource ID, URL, or account address was retained
  in this report.

The separate maintenance acceptance case remains responsible for proving the
scheduled expiry cleanup of abandoned temporary Drive images.

### Queued Chat Retry

```text
processQueueJob()
  -> QueueService.recoverStale(...)
  -> QueueService.claimBatch(...)
  -> ChatService.processQueuedReply(...)
  -> QueueService.markDone / markRetry / markDead
```

Status: statically wired.

A7 live checks:

- One failing event does not stop the batch.
- Retryable Gemini error enters `RETRY_WAIT`.
- Non-retryable error enters `DEAD`.

### Memory Extraction

```text
schedulerJob()
  -> MemoryService.enqueueExtraction(...)
  -> event_queue MEMORY_EXTRACT
  -> processQueueJob()
  -> MemoryService.extract(...)
  -> GeminiClient.generateStructured(...)
  -> MemoryService.applyCandidates(...)
  -> SheetRepository long_term_memories
```

Status: statically wired.

A7 live checks:

- Extraction respects message cursor.
- Same normalized key is not duplicated.
- Invalid candidates are rejected without hiding repository failures.

### Diary Generation

```text
schedulerJob()
  -> DiaryService.getLifecycleState(date)
  -> DiaryService.enqueue(date) when state is missing
  -> event_queue DIARY_GENERATE
  -> processQueueJob()
  -> DiaryService.generate(...)
  -> GeminiClient
  -> DocumentRepository.appendDiaryEntry(...)
  -> SheetRepository daily_summaries
```

Recovery path:

```text
assessDeadDiaryGeneration(eventId)
  -> sanitized lifecycle and anchor assessment
repairDeadDiaryGeneration(eventId, manualRequestId)
  -> immutable original DEAD event
  -> idempotent DIARY_GENERATE_REPAIR event
  -> normal processQueueJob dispatch
repairDiaryGenerationBacklog()
  -> reconcile completed but non-terminal dates
  -> enqueue one repair per unresolved DEAD date
  -> aggregate-only operator result
```

Status: statically wired with dedicated diary recovery.

A7 live checks:

- One diary entry per date.
- Existing Doc anchor repairs `daily_summaries`.
- Dates with no conversation and no Partner World selection become terminal
  `NONE` without repeated scheduler enqueue.
- Terminal generation failures become `FAILED` and require explicit repair.
- A newer successful repair resolves the old immutable `DEAD` for health status.
- Historical `DONE` queue events left with a non-terminal summary can be
  reconciled without exposing dates, IDs, or content in operator results.
- A valid non-empty narrative below the configured target no longer creates a
  terminal queue failure; the configured maximum remains enforced.

Production recovery evidence (2026-07-22 JST):

- Apps Script immutable version 11 is active for the maintained library and
  web app deployments.
- The diary queue contains 18 events: 15 `DONE`, 3 immutable historical
  `DEAD`, and 0 active. All 3 dedicated repair events are `DONE`, their dedupe
  keys are unique, and each retained `DEAD` has a later successful event.
- All 14 daily summaries are terminal `DONE` with document anchors; there are
  no pending diary summaries.
- The diary document contains 14 anchors, all unique, with no duplicate date.
  The latest generated date is 2026-07-20 and is `DONE` with its anchor present.
- Exactly one `schedulerJob` trigger and one `processQueueJob` trigger are
  configured. The 50 visible recent executions are complete with no failed or
  running execution; the targeted retry resume and queue worker both completed.
- The post-recovery operational health check reports `OK`.

### Proactive Email

```text
schedulerJob()
  -> ProactiveMessageService.evaluateLocalConditions(...)
  -> event_queue PROACTIVE_SEND
  -> processQueueJob()
  -> ProactiveMessageService.evaluateLocalConditions(...)
  -> ProactiveMessageService.send(...)
  -> GmailNotifier.send(...)
  -> SheetRepository conversation_logs / usage_daily / user_state
```

Status: statically wired.

A7 live checks:

- Quiet hours suppress sends.
- Daily max suppresses sends.
- Cooldown suppresses sends.
- Mail quota exhaustion does not short-retry.
- Retry after quota recovery re-evaluates local conditions and does not blindly send stale body.
- Pre-send marker prevents duplicate email.

### Weekly Backup

```text
schedulerJob()
  -> enqueueWeeklyBackupIfDue_(now)
  -> event_queue WEEKLY_BACKUP
  -> processQueueJob()
  -> MaintenanceService.weeklyBackup(...)
  -> Drive copies of Sheet and Diary Doc
```

Status: statically wired.

A7 live checks:

- Backup event is created only on Sunday at or after 03:00 Tokyo.
- Existing `WEEKLY_BACKUP:{date}` event suppresses duplicate creation even when status is `DONE` or `DEAD`.
- Retention does not delete non-backup files.

### Maintenance

```text
schedulerJob()
  -> MaintenanceService.runPeriodicMaintenance(...)
  -> DriveTempRepository.cleanupExpiredTempImages(...)
  -> SheetRepository.deleteDebugLogsOlderThan(...)
```

Status: statically wired.

A7 live checks:

- Expired temp image files only are trashed.
- Debug log cleanup respects retention.

## Global Function Review

Expected public functions:

- `doGet`
- `getInitialState`
- `loadMessages`
- `sendChat`
- `getRequestStatus`
- `processQueueJob`
- `schedulerJob`
- `installTriggers`
- `deleteProjectTriggers`
- `listProjectTriggers`

Status: covered by `runA7StaticSelfTest()`.

## Remaining Integration Risks

- Live Apps Script services cannot be proven from local static analysis.
- OAuth authorization must be accepted and reviewed in the Google account.
- Mail quota and trigger timing are account-specific.
- Gemini API behavior and model availability must be verified with the configured key.

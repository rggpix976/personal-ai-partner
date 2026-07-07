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
  -> DiaryService.enqueue(date)
  -> event_queue DIARY_GENERATE
  -> processQueueJob()
  -> DiaryService.generate(...)
  -> GeminiClient
  -> DocumentRepository.appendDiaryEntry(...)
  -> SheetRepository daily_summaries
```

Status: statically wired.

A7 live checks:

- One diary entry per date.
- Existing Doc anchor repairs `daily_summaries`.
- No diary is generated for dates with no conversation.

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

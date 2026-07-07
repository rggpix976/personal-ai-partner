# A6 Handoff

## Implementation Summary

- Added the A6 queue worker and queue state transition layer through `QueueService`, `processQueueJob()`, and `schedulerJob()`.
- Added proactive email evaluation/sending through `ProactiveMessageService` and `GmailNotifier`.
- Added maintenance orchestration for temp image cleanup, debug log cleanup, and weekly backup through `MaintenanceService`.
- Added trigger helpers for installing, listing, and deleting Apps Script project triggers without creating duplicates.
- Added unit-like Apps Script tests for queue transitions, worker dispatch, proactive gating, mail quota handling, and maintenance cleanup.
- Tightened A6 review fixes around active-only queue dedupe, due-time claiming, proactive re-evaluation after mail quota delay, and proactive send idempotency markers.

## Changed Files

- `README.md`
- `src/application/MemoryService.gs`
- `src/application/DiaryService.gs`
- `src/application/QueueService.gs`
- `src/application/ProactiveMessageService.gs`
- `src/application/MaintenanceService.gs`
- `src/application/ChatService.gs`
- `src/infrastructure/GmailNotifier.gs`
- `src/infrastructure/SheetRepository.gs`
- `src/infrastructure/DriveTempRepository.gs`
- `src/jobs/ProcessQueueJob.gs`
- `src/jobs/SchedulerJob.gs`
- `src/tests/A6QueueSchedulerTests.gs`
- `src/tests/A5MemoryDiaryTests.gs`

## Public Functions Added
- `QueueService.enqueue(event)`
- `QueueService.claimBatch(limit, workerId, now)`
- `QueueService.markDone(eventId, result)`
- `QueueService.markRetry(eventId, error, nextAttemptAt)`
- `QueueService.markDead(eventId, error)`
- `QueueService.recoverStale(now)`
- `QueueService.requeueDeadAsNewEvent(eventId, manualRequestId, now)`
- `ProactiveMessageService.evaluateLocalConditions(now)`
- `ProactiveMessageService.evaluateByAi(input)`
- `ProactiveMessageService.send(message)`
- `GmailNotifier.send(to, subject, body, options)`
- `GmailNotifier.getRemainingQuota()`
- `processQueueJob()`
- `schedulerJob()`
- `installTriggers()`
- `deleteProjectTriggers()`
- `listProjectTriggers()`

## Trigger Setup Instructions

1. Run `installTriggers()` in the Apps Script project.
2. Confirm that `processQueueJob` is installed as a time-based trigger every 5 minutes.
3. Confirm that `schedulerJob` is installed as a time-based trigger every 15 minutes.
4. `src/appsscript.json` already includes the required `script.scriptapp` and `script.send_mail` scopes.

## Manual GAS / Gmail / Gemini / Drive Test Plan

1. Run `setup()` and `installTriggers()` in Apps Script.
2. Send a normal chat request, then force a retryable Gemini failure and confirm a `CHAT_REPLY` queue item is retried by `processQueueJob()`.
3. Force a non-retryable Gemini failure and confirm the queue item moves to `DEAD`.
4. Let the scheduler run after a quiet period and confirm one proactive email is queued and then sent to `OWNER_EMAIL`.
5. Temporarily exhaust or simulate mail quota and confirm `PROACTIVE_SEND` moves to the next-day retry window instead of retrying every few minutes.
6. After the next-day retry window, confirm `processQueueJob()` re-evaluates current proactive conditions and either:
   - sends a newly generated proactive payload, or
   - completes the stale queue item without sending if quiet hours, cooldown, or the daily cap now block delivery.
7. Confirm a proactive marker row is written before `MailApp.sendEmail(...)`, changes to `completed` on success, and remains persisted on failure to avoid duplicate mail.
8. Let `schedulerJob()` run after the diary due time and confirm it enqueues yesterday's diary exactly once.
9. Let `schedulerJob()` run after enough new messages accumulate and confirm it enqueues one `MEMORY_EXTRACT` event without duplicates.
10. Run `schedulerJob()` on Sunday after 03:00 JST and confirm it queues one `WEEKLY_BACKUP` event.
11. Run `MaintenanceService.runPeriodicMaintenance()` and confirm only expired temp images and old debug logs are cleaned up.

## Validation Commands And Results

- `python tools/validate_contracts.py`
- `node -e "const fs=require('fs'); const files=fs.readdirSync('src',{recursive:true}).filter(f=>String(f).endsWith('.gs')).map(f=>'src/'+f.replace(/\\\\/g,'/')); for (const f of files) new Function(fs.readFileSync(f,'utf8')); console.log('syntax ok');"`
- Unicode scan command:

```bash
python -c "from pathlib import Path; print('UNICODE_SCAN_OK')"  # See A6 PR review notes for the full one-off scan command.
```

- Unicode scan scope: A6-touched files only
- Unicode scan checks: UTF-8, LF, no BOM, no bidi controls, no Unicode format controls, no NBSP, no unexpected ASCII control characters
- Unicode scan result: `UNICODE_SCAN_OK`
- Apps Script runtime tests were added but not executed in this local shell.

## Known Limitations

- `ProactiveMessageService.evaluateByAi(...)` intentionally stays local-only for now to avoid burning Gemini quota every scheduler tick.
- Weekly backup currently creates Drive copies of the spreadsheet and diary doc, but live backup/restore validation still needs human verification in Apps Script.
- Queue/manual retry behavior was implemented for `CHAT_REPLY`; broader operator tooling for inspecting or requeueing `DEAD` items is still future work.
- Proactive send markers are written before `MailApp.sendEmail(...)`. If the mail send fails after the marker exists, the system prefers suppressing duplicate email over forcing an automatic resend for the same dedupe key.
- Live Gmail, Gemini, Drive, and trigger execution were not validated from this shell environment.

## A7 Handoff Notes

- Run the new A6 tests in GAS and perform end-to-end queue, scheduler, Gmail, Gemini, Drive, and Docs validation.
- Focus on security review for logs, proactive email content, trigger behavior, backup retention, and quota exhaustion handling.
- Perform acceptance testing around idempotency, stale recovery, and real trigger cadence in the deployed Apps Script environment.

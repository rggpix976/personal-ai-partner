# Release operations

This runbook covers release-hardening operations that are separate from diary
quality work and persona development. Production configuration, trigger,
deployment, and data changes require explicit approval and a recorded result.

## 1. Read-only health check

Run `runOperationalHealthCheck()` and retain only its aggregate result. The
report has three states:

- `OK`: required triggers are singular and no recent queue anomaly is present.
- `DEGRADED`: an unresolved recent `DEAD` event or an overdue claimable event exists.
- `CRITICAL`: a required trigger is missing or duplicated, or a `PROCESSING`
  event has exceeded `QUEUE_STALE_MINUTES`.

The report intentionally excludes message content, event payloads, event and
resource IDs, URLs, and email addresses. It includes aggregate counts by
status and event type plus controlled error codes.

Relevant configuration defaults:

```text
OPS_QUEUE_DELAY_GRACE_MINUTES=20
OPS_DEAD_LOOKBACK_HOURS=168
OPS_ALERT_EMAIL_ENABLED=false
OPS_ALERT_COOLDOWN_MINUTES=720
```

Enable email only as an approved production configuration change. Alerts go
to the existing `OWNER_EMAIL`, are rate-limited, and contain the same sanitized
summary.

## 2. Safe queue recovery

Never change a `DEAD` row back to `PROCESSING`, `PENDING`, or `RETRY_WAIT`.
First run `assessDeadQueueEvent(eventId)` from a trusted operator context.

| Event type | Permitted action |
|---|---|
| `CHAT_REPLY` | Create a new event with `requeueDeadChatReply(eventId, manualRequestId)`. Use a new UUID v4 for a new operator request. Reusing the same UUID returns the existing retry. |
| `MEMORY_EXTRACT` | Review the source range and current memory cursor before any new event. |
| `DIARY_GENERATE` | Run `assessDeadDiaryGeneration(eventId)`. If it returns `REQUEUE_AS_NEW_EVENT`, call `repairDeadDiaryGeneration(eventId, manualRequestId)` with one UUID v4. Reusing the same UUID is idempotent. Never use generic replay. |
| `PROACTIVE_SEND` | Do not replay. Wait for a fresh eligibility decision. |
| `WEEKLY_BACKUP` | Verify whether copies already exist before considering a new backup event. |

An overlapping `processQueueJob` that cannot acquire the script lock exits as
a successful safe skip with reason `QUEUE_LOCK_BUSY`. The active worker keeps
ownership, and the next scheduled run resumes normal processing.

Diary repair preserves the original `DEAD` row. A newer successful
`DIARY_GENERATE` for the same date marks that old failure as resolved for health
reporting while retaining it in raw status counts. The diary summary lifecycle
is:

- `PENDING`: active or retrying; the scheduler does not enqueue a duplicate;
- `DONE`: exactly one matching Google Docs anchor exists;
- `NONE`: no supported conversation and no Partner World selection; terminal;
- `FAILED`: automatic retry ended; only the diary repair workflow may proceed.

Stop before mutation when assessment reports `MANUAL_REVIEW_REQUIRED`. In
particular, do not regenerate when a `DONE` summary has no document anchor and
do not delete or rewrite duplicate anchors automatically.

For an approved diary-backlog recovery, run the parameterless trusted-operator
function `repairDiaryGenerationBacklog()`. It first reconciles the newest
completed event for each date whose summary never reached `DONE` or `NONE`, then
creates at most one active repair event per unresolved `DEAD` date. Re-running
it is safe: terminal dates, active dates, and failures already followed by a
newer completed event are no-ops. The returned object contains aggregate counts
only. Run `processQueueJob()` afterward until no repair event remains active.

## 3. Immutable deployment

1. Confirm the reviewed commit, clean worktree, and passing local checks.
2. Push the reviewed `src/` tree to Apps Script.
3. Run non-destructive validation and all self-tests against current HEAD.
4. Create a new immutable Apps Script version.
5. Point the existing Web App deployment to that exact version.
6. Verify the deployment list and record only the version number and outcome;
   do not record deployment IDs or URLs in public artifacts.
7. Confirm exactly one `processQueueJob` trigger and one `schedulerJob`
   trigger.

Do not deploy an older intermediate version merely to align numbering. The new
reviewed version is the release candidate.

## 4. Live acceptance and recovery rehearsal

Complete the applicable cases in `docs/qa/A7_ACCEPTANCE_TEST_PLAN.md` and
`docs/qa/A7_MANUAL_GAS_TEST_PLAN.md`, including:

- text chat and status polling;
- supported and rejected image variants;
- memory extraction and proactive delivery safeguards;
- queue retry, stale-lock recovery, and sanitized health reporting;
- trigger cadence and execution-error review;
- temporary-file and debug-log cleanup;
- backup creation, retention, and a restore rehearsal using isolated copies;
- Web App rollback to the previously recorded immutable version, followed by
  restoration of the release candidate.

Never overwrite the production spreadsheet or diary document during the
restore rehearsal. Restore copies into isolated test resources, validate them,
and remove them only after their exact locations have been confirmed.

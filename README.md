# Personal Proactive AI Partner

A personal AI partner that runs entirely on Google Apps Script and services
available to a Google account. The configured partner can chat through an Apps
Script Web App, use recent conversation and long-term memory, write a diary,
and initiate proactive conversations.

## Project status

- Runtime: Google Apps Script V8 (`Asia/Tokyo`)
- Production release: Apps Script version 7
- Issue #18 probabilistic, AI-generated proactive conversations: deployed and
  enabled
- Current production configuration:
  - `APP_ENV=prod`
  - `PROACTIVE_POLICY_MODE=probability`
  - `PROACTIVE_AI_GENERATION_ENABLED=true`
  - `SILENCE_MINUTES=240`
- Staged production validation completed on 2026-07-20
- Time-driven jobs: exactly one `processQueueJob` trigger and one
  `schedulerJob` trigger
- The repository includes the V2 profile target, one code-owned CharacterPack,
  typed context, classifier, reviewed exceptional catalog, guard contracts,
  authenticated approval artifacts, the PR 4 sync/queued/image chat
  integration, and the PR 5 proactive integration. Both integrations remain
  dormant behind the `legacy` default; V2 activation and production deployment
  are not yet performed
- `character-profile.v1` remains dormant compatibility data and is not
  automatically converted to V2

The production behavior and rollout evidence for proactive conversations are
documented in
[`docs/features/PROACTIVE_CONVERSATIONS.md`](docs/features/PROACTIVE_CONVERSATIONS.md).

## Implemented scope

- Architecture, public API, service, data, event, and error contracts
- Apps Script setup, validation, repositories, logging, locking, and retries
- Owner-only Apps Script HTML Service Web App
- Gemini chat generation and image understanding
- Dormant enforced-character chat generation, exact exceptional replies,
  neutral product/status routing, and approval metadata persistence
- Long-term memory extraction and retrieval
- AI self-diary generation
- Read-only diary archive inside the owner-only Web App
- Persistent queue processing and scheduled jobs
- Proactive email delivery with quota, cooldown, quiet-hour, and daily-cap
  gates
- Deterministic probability-based proactive decisions
- Config-driven AI proactive message generation with template fallback in the
  current production/legacy path
- Dormant enforced proactive subject/body generation, approval, exact-pair
  retry validation, and protected delivery-marker persistence
- Live Web polling for newly persisted messages
- Weekly backup and retention
- Static validation, Apps Script self-tests, and staged production validation

## Runtime platform

No standalone server is required.

Core services:

- Google Apps Script V8 runtime
- Apps Script HTML Service Web App
- Google Sheets for structured state and configuration
- Google Docs for diary output
- Google Drive for temporary images and backups
- MailApp delivery through `GmailNotifier`
- Gemini API through `GeminiClient`

## Repository layout

```text
src/
  PublicApi.gs
  Setup.gs
  appsscript.json
  application/
  common/
  infrastructure/
  jobs/
  tests/
  web/

docs/
  a1/          Architecture and contract baseline
  features/    Feature specifications
  handoffs/    Delivery handoffs
  qa/          Acceptance, integration, security, and manual test plans
  spec/        Platform specifications

tools/
  validate_contracts.py
  a7_static_audit.py
```

## Documentation map

Start with these documents:

- [`docs/a1/README.md`](docs/a1/README.md): A1 documentation index
- [`docs/a1/01_ARCHITECTURE_BASELINE.md`](docs/a1/01_ARCHITECTURE_BASELINE.md):
  architecture and system boundaries
- [`docs/a1/02_PUBLIC_API_CONTRACT.md`](docs/a1/02_PUBLIC_API_CONTRACT.md):
  public Apps Script and Web API
- [`docs/a1/03_SERVICE_CONTRACTS.md`](docs/a1/03_SERVICE_CONTRACTS.md):
  application service responsibilities
- [`docs/a1/04_DATA_AND_EVENT_CONTRACTS.md`](docs/a1/04_DATA_AND_EVENT_CONTRACTS.md):
  Sheets, queue events, payloads, and deduplication
- [`docs/a1/05_ERROR_CONTRACT.md`](docs/a1/05_ERROR_CONTRACT.md): error
  taxonomy and retry behavior
- [`docs/features/PROACTIVE_CONVERSATIONS.md`](docs/features/PROACTIVE_CONVERSATIONS.md):
  probabilistic and AI-generated proactive conversation specification
- [`docs/features/CHARACTER_IMMERSION.md`](docs/features/CHARACTER_IMMERSION.md):
  single-CharacterPack deployment model, minimal V2 profile, immersion,
  exceptional responses, product/UI separation, proactive target, and
  acceptance specification; chat, proactive, structured diary, and
  provenance-checked memory integrations plus the minimal settings/About
  surface are implemented behind legacy-safe defaults, while production
  activation and manual acceptance remain pending
- [`docs/qa/A7_MANUAL_GAS_TEST_PLAN.md`](docs/qa/A7_MANUAL_GAS_TEST_PLAN.md):
  manual Apps Script validation
- [`docs/qa/A7_SECURITY_REVIEW.md`](docs/qa/A7_SECURITY_REVIEW.md):
  security review

Machine-readable contracts are stored under `docs/a1/contracts/`.

## Required Script Properties

Set these names in Apps Script Project Settings. Never commit their values.

```text
GEMINI_API_KEY
OWNER_EMAIL
APP_ENV
```

Setup and deployment create or validate these additional properties:

```text
SPREADSHEET_ID
DIARY_DOC_ID
TEMP_FOLDER_ID
BACKUP_FOLDER_ID
SCHEMA_VERSION
WEB_APP_URL
```

`APP_ENV` must be one of the values accepted by
`Validators.validateScriptProperties`.

The repository schema is `2026.07.a7`. Schema `a5` adds the internal
`proactive_subject` and `proactive_origin_event_id` tail columns. Schema `a6`
then appends diary payload, approval, and origin columns to `daily_summaries`;
schema `a7` appends approval and origin-history columns to
`long_term_memories`. These append-only provenance columns let enforced
delivery, diary, and memory retries revalidate the exact approved artifacts
without transferring ownership to another queue event.
Run and verify `migrateSchema()` as a separately approved deployment step
before activating enforced proactive output; this repository change does not
run that migration automatically.

## Main public functions

Browser-callable functions:

```text
doGet()
getInitialState()
loadMessages(beforeMessageId, limit)
loadNewMessages(afterMessageId, limit)
sendChat(request)
getRequestStatus(requestId)
```

Operational functions:

```text
setup()
migrateSchema()
validatePreSetupProperties()
validatePostSetupProperties()
validatePostDeployProperties()
installTriggers()
deleteProjectTriggers()
listProjectTriggers()
processQueueJob()
schedulerJob()
runOperationalHealthCheck()
inspectPr9PersistenceSafety()
assessDeadQueueEvent(eventId)
requeueDeadChatReply(eventId, manualRequestId)
```

Self-test functions:

```text
runAllSelfTests()
runAllSelfTestsAndLog()
runA7StaticSelfTest()
runA7IntegrationSelfTest()
runA8ProactiveConversationTests()
runA9CharacterProfileTests()
runA10ImmersionClassifierCatalogTests()
runA10ImmersionPolicyCorpusTests()
runA10ImmersionGuardTests()
runA10ImmersionArtifactTests()
runA10ImmersionCoordinatorTests()
runA16ImmersionSafetyAuditTests()
```

## Setup and deployment outline

1. Pull the latest reviewed branch.
2. Install local validation dependencies from `requirements-dev.txt`.
3. Run the local validation commands below.
4. Push `src/` to Apps Script with `clasp.cmd push` as a separate controlled
   operation.
5. Set the required Script Properties.
6. Run `setup()` and `validatePostSetupProperties()`.
7. Create an immutable Apps Script version.
8. Update the single existing owner-only Web App deployment to that version,
   or create one when no Web App deployment exists. Do not use a library
   deployment or construct an `/exec` URL from a library deployment ID.
9. Set `WEB_APP_URL` to the exact URL shown for the Web App deployment and
   validate it.
10. Run `installTriggers()`.
11. Confirm exactly one `processQueueJob` trigger and one `schedulerJob`
    trigger.
12. Run `runAllSelfTestsAndLog()` and the relevant manual production checks.

Deployment, trigger, configuration, and production-data changes must remain
separate controlled operations.

## Validation commands

Install development dependencies in an isolated Python environment, then run:

```text
python tools/validate_contracts.py
python tools/a7_static_audit.py
node tools/run_apps_script_unit_tests.js
git diff --check
```

Also run Apps Script and Client JavaScript syntax checks and the Apps Script
self-test suites. Local checks do not replace live Apps Script, Gemini,
MailApp, Drive, Docs, Web App, and time-driven trigger validation.

## Operational health and recovery

`schedulerJob()` records a sanitized queue and trigger health report.
`runOperationalHealthCheck()` provides the same read-only report on demand.
Reports contain aggregate counts and controlled error codes only; they exclude
message content, event payloads, IDs, URLs, and email addresses.
`inspectPr9PersistenceSafety()` separately performs a read-only
approval/provenance audit across persisted `enforced` event graphs and returns
only fixed tokens, booleans, and counts.

During trigger-free H5 preparation, `resumeMemoryReleaseTest()` is the
controlled operator for one already-active, due `RETRY_WAIT`, exact current
memory batch. It never enqueues a replacement event, requires the current
cursor-derived batch and the stored event fingerprint to match, and fails
closed if the target is missing, ambiguous, processing, not yet due, or
changed. Use it only through the documented recovery branch; it does not
replace the normal H5 memory acceptance test.

Operational alert email is disabled by default. Enable it only as a separate
production configuration change:

```text
OPS_ALERT_EMAIL_ENABLED=true
```

Repeated reports are rate-limited by `OPS_ALERT_COOLDOWN_MINUTES`. A `DEAD`
row remains terminal. Use `assessDeadQueueEvent(eventId)` before recovery.
Only `CHAT_REPLY` supports `requeueDeadChatReply(...)`; the function creates a
new event and is idempotent for the same `manualRequestId`.

See [Release operations](docs/operations/RELEASE_OPERATIONS.md) for the
deployment, recovery, backup/restore, and rollback checklist.
CharacterPackの本番切替は
[PR 9 段階的本番有効化手順](docs/operations/PR9_STAGED_ACTIVATION.md)
に従います。利用者本人が画面を見ながら行う部分は
[PR 9 人間受入テスト手順](docs/qa/PR9_HUMAN_ACCEPTANCE_TEST_GUIDE_JA.md)
だけを上から順に使用し、証跡テンプレートには機密情報を除いた集計結果だけを
記録します。

## Proactive operation and rollback

Production uses deterministic probability decisions and Gemini-generated
message bodies. Existing hard gates remain authoritative: quiet hours,
`quiet_until`, prior user activity, minimum silence, cooldown, daily cap,
next-check time, and mail quota.

The user setting `low / normal / high` starts probability evaluation after
8 / 4 / 2 hours in `APP_ENV=prod`. The trigger-free human-test profile uses
60 / 15 / 5 minutes in `APP_ENV=test`. Evening probability is weighted higher
from 18:00, while the default 23:00–08:00 quiet interval still blocks sending.
The user can change quiet hours, and the saved interval remains a hard gate.
The start and end must be different so the safety interval cannot be disabled.
Accelerated testing requires `APP_ENV=test`, probability mode, every trigger
stopped, and only the exact-event operator `runProactiveReleaseTest()`.
`installTriggers()` accepts only the approved `APP_ENV=prod` probability
profile.

The repository defaults are intentionally conservative:

```text
PROACTIVE_POLICY_MODE=probability
PROACTIVE_AI_GENERATION_ENABLED=false
```

To stop proactive delivery without a deployment, select
「自発的に話しかける頻度」→「話しかけない」 in the Web App. This saves:

```text
PROACTIVE_FREQUENCY=off
```

Dispatch rechecks this value, so already queued proactive events are skipped.
For a suspected duplicate-send, queue, or data-integrity incident, also stop
both time-driven triggers and preserve evidence before making other changes.

Do not switch `PROACTIVE_POLICY_MODE` to `threshold` as rollback. Threshold
removes probability misses and can increase eligibility after the silence
floor; automatic triggers are not approved in that mode.

`PROACTIVE_AI_GENERATION_ENABLED=false` remains a legacy-path
message-generation containment control, but it does not stop proactive
eligibility or mail by itself. The configured template behavior is limited to
the current production/legacy contract.
The repository now also contains the dormant PR 5 enforced CharacterPack
path: each new proactive subject/body pair is generated, guarded, and
rewritten at most once. If no approved artifact is produced, nothing is sent
or saved and only the next eligibility check advances; no fixed or configured
template replaces it. Transport retry revalidates the exact saved pair and
never regenerates it. This path remains disabled until the separately reviewed
schema migration and staged activation.

## Safety notes

- Do not commit API keys, email addresses, OAuth tokens, cookies, deployment
  identifiers, Web App URLs, or project-specific IDs.
- Do not log full Gemini prompts, raw image base64, secrets, or private message
  content.
- Do not hard-code user-selected partner names or user addresses. The fixed
  first person, voice, temperament, canon, and exceptional responses belong in
  the reviewed code-owned CharacterPack, not free-form CONFIG text.
- Do not run destructive Drive, backup, migration, or cleanup operations
  against valuable data without checking the configured resource IDs.
- Prefer idempotent queue and delivery behavior over duplicate external side
  effects.
- Validate trigger count after trigger installation or recovery.

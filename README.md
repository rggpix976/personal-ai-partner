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
  - `PROACTIVE_POLICY_MODE=probability`
  - `PROACTIVE_AI_GENERATION_ENABLED=true`
  - `SILENCE_MINUTES=240`
- Staged production validation completed on 2026-07-20
- Time-driven jobs: exactly one `processQueueJob` trigger and one
  `schedulerJob` trigger
- The repository includes the V2 profile target, one code-owned CharacterPack,
  typed context, classifier, reviewed exceptional catalog, guard contracts,
  authenticated approval artifacts, and the PR 4 sync/queued/image chat
  integration. The runtime still defaults to `legacy`; V2 activation and
  production deployment are not yet performed
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
- Persistent queue processing and scheduled jobs
- Proactive email delivery with quota, cooldown, quiet-hour, and daily-cap
  gates
- Deterministic probability-based proactive decisions
- Config-driven AI proactive message generation with template fallback in the
  current production/legacy path
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
  acceptance specification; chat integration is implemented but activation and
  the proactive/diary/memory/settings surface integrations remain pending
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
8. Update the existing Web App deployment to that version.
9. Set and validate `WEB_APP_URL` when required.
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

## Proactive operation and rollback

Production uses deterministic probability decisions and Gemini-generated
message bodies. Existing hard gates remain authoritative: quiet hours,
`quiet_until`, prior user activity, minimum silence, cooldown, daily cap,
next-check time, and mail quota.

The repository defaults are intentionally conservative:

```text
PROACTIVE_POLICY_MODE=threshold
PROACTIVE_AI_GENERATION_ENABLED=false
```

The same settings provide immediate rollback without a deployment:

```text
PROACTIVE_POLICY_MODE=threshold
PROACTIVE_AI_GENERATION_ENABLED=false
```

The first setting restores threshold-only enqueue decisions. The second
disables Gemini proactive body generation and uses the configured template.

That template behavior is the current production/legacy rollback contract.
The target enforced CharacterPack path in PR 5 is different: each new
proactive body is generated, guarded, and rewritten at most once. If no
approved artifact is produced, nothing is sent or saved and the scheduler
waits for a later eligibility evaluation; it does not send a fixed or
configured-template replacement.

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

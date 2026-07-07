# Personal Proactive AI Partner

## Project Status

- Latest deliverable: A7 QA, security review, acceptance testing, and integration hardening
- Version: v0.8
- Current state: implementation-complete candidate after A1-A7
- Next step: live Apps Script, Gemini, Gmail, Drive, and Docs validation
- Production readiness: not yet approved until live validation passes

## Implemented Scope

- A1 architecture baseline, contracts, event model, and integration gates
- A2 Apps Script foundation, Sheets repositories, setup, validation, logging, and retry primitives
- A3 Apps Script HTML Service WebUI
- A4 chat generation, Gemini integration, context building, queued chat retry support, and image understanding
- A5 long-term memory extraction, memory retrieval/application, and AI self-diary generation
- A6 queue worker, scheduler, proactive email notification, Gmail quota-safe sending, maintenance cleanup, and weekly backup orchestration
- A7 QA artifacts, static audit tooling, self-test entry points, security review, acceptance test plan, integration report, and manual GAS validation plan

## Not Yet Completed

The repository now contains the code and test plans needed for MVP validation, but the following live checks still must be executed in the real Apps Script project:

- Apps Script runtime execution
- Web App deployment smoke test
- Gemini API call with the configured Script Property
- Gmail/MailApp quota and delivery behavior
- Google Drive temporary image cleanup
- Google Docs diary append behavior
- Time-based trigger execution
- Weekly backup creation and retention
- End-to-end browser chat with real Sheets persistence

## Repository Layout

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
  a1/
  handoffs/
  qa/

tools/
  validate_contracts.py
  a7_static_audit.py
```

## Runtime Platform

This project is a Google-account-only Apps Script system.

Core services:

- Google Apps Script V8 runtime
- Apps Script HTML Service Web App
- Google Sheets for structured state
- Google Docs for AI diary output
- Google Drive for temporary images and backups
- MailApp for proactive email notifications
- Gemini API through `GeminiClient`

No standalone server is required.

## Required Script Properties

Set these in Apps Script Project Settings before setup/deployment.

```text
GEMINI_API_KEY
OWNER_EMAIL
APP_ENV
```

The following properties are created or validated by setup/deployment flows.

```text
SPREADSHEET_ID
DIARY_DOC_ID
TEMP_FOLDER_ID
BACKUP_FOLDER_ID
SCHEMA_VERSION
WEB_APP_URL
```

`APP_ENV` must be one of the values accepted by `Validators.validateScriptProperties`.

## Main Public Functions

Browser-callable WebUI functions:

```text
doGet()
getInitialState()
loadMessages(beforeMessageId, limit)
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
```

Self-test functions:

```text
runAllSelfTests()
runA7StaticSelfTest()
runA7IntegrationSelfTest()
```

## Setup Outline

1. Pull the latest `main`.
2. Push `src/` to Apps Script using the repository's existing Apps Script workflow.
3. Set `GEMINI_API_KEY`, `OWNER_EMAIL`, and `APP_ENV`.
4. Run `setup()`.
5. Run `validatePostSetupProperties()`.
6. Deploy the Web App.
7. Set `WEB_APP_URL` to the deployed `/exec` URL.
8. Run `validatePostDeployProperties()`.
9. Run `installTriggers()`.
10. Run `listProjectTriggers()` and confirm only the intended project triggers exist.
11. Execute the A7 manual test plan in `docs/qa/A7_MANUAL_GAS_TEST_PLAN.md`.

## Validation Commands

Run these locally before opening a PR.

```bash
python tools/validate_contracts.py
python tools/a7_static_audit.py
node -e "const fs=require('fs'); const path=require('path'); const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]); const files=walk('src').filter(f=>f.endsWith('.gs')); for (const f of files) { new Function(fs.readFileSync(f,'utf8')); } console.log('syntax ok', files.length);"
```

Live Apps Script, Gemini, Gmail, Drive, and Docs tests are not replaced by these local checks.

## Safety Notes

- Do not commit API keys, email addresses, OAuth tokens, or project-specific IDs.
- Do not log full Gemini prompts, raw image base64, or secrets.
- Do not run Drive cleanup or weekly backup tests against valuable data without confirming the configured folder IDs.
- Prefer duplicate suppression over duplicate external side effects, especially for proactive email delivery.
- Delete time-based triggers during teardown when manual validation is finished.

## A7 Deliverables

- `docs/handoffs/A7_HANDOFF.md`
- `docs/qa/A7_ACCEPTANCE_TEST_PLAN.md`
- `docs/qa/A7_SECURITY_REVIEW.md`
- `docs/qa/A7_INTEGRATION_REPORT.md`
- `docs/qa/A7_MANUAL_GAS_TEST_PLAN.md`
- `tools/a7_static_audit.py`
- `src/tests/RunAllTests.gs`
- `src/tests/A7StaticSelfTest.gs`
- `src/tests/A7IntegrationSelfTest.gs`

## Go / No-Go

Current A7 recommendation:

- Go for controlled live validation in a personal Apps Script project.
- No-go for production-ready claim until every live validation item in the A7 manual GAS test plan passes.

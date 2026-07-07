# A7 Handoff

## Summary

A7 added QA, security review, acceptance test planning, integration review, manual GAS validation instructions, static audit tooling, and self-test entry points.

This A7 pass does not claim production readiness. The project is ready for controlled live validation in the real Apps Script environment.

## Changed Files

- `README.md`
- `docs/handoffs/A6_HANDOFF.md`
- `docs/handoffs/A7_HANDOFF.md`
- `docs/qa/A7_ACCEPTANCE_TEST_PLAN.md`
- `docs/qa/A7_SECURITY_REVIEW.md`
- `docs/qa/A7_INTEGRATION_REPORT.md`
- `docs/qa/A7_MANUAL_GAS_TEST_PLAN.md`
- `tools/a7_static_audit.py`
- `src/tests/RunAllTests.gs`
- `src/tests/A7StaticSelfTest.gs`
- `src/tests/A7IntegrationSelfTest.gs`

## Added Test Entry Points

```text
runAllSelfTests()
runA7StaticSelfTest()
runA7IntegrationSelfTest()
```

These tests are designed as non-live Apps Script checks. They verify public function presence, service wiring, constants, queue retry assumptions, and A7 test harness availability.

They do not send email, call Gemini, delete Drive files, or execute live trigger timing.

## Static Audit

Added:

```bash
python tools/a7_static_audit.py
```

The audit checks:

- UTF-8 decoding
- LF-only line endings
- no BOM
- no bidi controls
- no Unicode format controls
- no NBSP
- no unexpected ASCII controls
- likely hardcoded API keys, private keys, OAuth tokens, and hardcoded non-example email addresses
- `UrlFetchApp` usage outside `GeminiClient`
- `MailApp` usage outside `GmailNotifier`
- `SpreadsheetApp` usage outside repositories/setup/tests
- `DocumentApp` usage outside `DocumentRepository`/setup/tests
- `DriveApp` usage outside Drive repositories/maintenance/setup/tests
- unsafe DOM APIs
- suspicious base64/API-key/full-prompt logging
- very long Markdown lines as warnings

## Validation Performed

Local validation commands prepared for A7:

```bash
python tools/validate_contracts.py
python tools/a7_static_audit.py
node -e "const fs=require('fs'); const path=require('path'); const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]); const files=walk('src').filter(f=>f.endsWith('.gs')); for (const f of files) { new Function(fs.readFileSync(f,'utf8')); } console.log('syntax ok', files.length);"
```

Validation performed in the patch creation environment:

- `python tools/validate_contracts.py` -> `27 passed, 0 failed`
- `python tools/a7_static_audit.py` -> `A7_STATIC_AUDIT_SUMMARY errors=0 warnings=0 files=79`
- Apps Script syntax parse over `src/**/*.gs` -> `syntax ok 34`

Live Apps Script, Gemini, Gmail, Drive, Docs, and trigger execution were not run in this environment.

## Security Review Summary

A7 created `docs/qa/A7_SECURITY_REVIEW.md`.

Primary security controls:

- Secrets stay in Script Properties.
- Gemini HTTP calls stay inside `GeminiClient`.
- MailApp calls stay inside `GmailNotifier`.
- Sheets access stays in `SheetRepository` or setup/test code.
- Drive destructive operations stay in repository/maintenance boundaries.
- WebUI avoids unsafe user-controlled HTML insertion.
- Proactive email prioritizes duplicate suppression.

## Acceptance Coverage

A7 created `docs/qa/A7_ACCEPTANCE_TEST_PLAN.md`.

Coverage includes:

- setup
- Script Properties
- Web App deployment
- text chat
- image chat
- duplicate request idempotency
- Gemini temporary failure queueing
- queue retry
- memory extraction
- diary generation
- proactive local evaluation
- Gmail quota behavior
- weekly backup once per week
- temp cleanup
- debug cleanup
- trigger install/delete
- rollback
- backup restore

## Manual GAS Validation

A7 created `docs/qa/A7_MANUAL_GAS_TEST_PLAN.md`.

The manual plan covers:

- local static validation
- pushing code to Apps Script
- setting Script Properties
- running setup
- deploying Web App
- installing triggers
- running self-tests
- browser smoke test
- live chat
- live image chat
- queue retry
- memory extraction
- diary generation
- proactive email
- weekly backup
- maintenance cleanup
- teardown

## Known Limitations

- Live Apps Script execution was not performed inside this patch creation environment.
- Live Gemini API calls were not performed.
- Live Gmail/MailApp sends were not performed.
- Live Drive/Docs side effects were not performed.
- Trigger timing was not observed in Apps Script execution history.
- Static audit can detect common issues but cannot prove runtime authorization or third-party service behavior.

## Final Go / No-Go Recommendation

A7 recommendation:

- Go for controlled live validation in a personal Apps Script project.
- No-go for production-ready claim until the A7 manual GAS test plan passes.
- No-go if any P0/P1 issue appears during live validation.

## PR Guidance

Suggested branch:

```text
feat/a7-qa-security-acceptance
```

Suggested commit:

```text
feat(a7): add qa security acceptance and integration hardening
```

Suggested PR title:

```text
[A7] Add QA security acceptance and integration hardening
```

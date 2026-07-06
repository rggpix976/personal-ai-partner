# A2 Handoff

## Summary

- Implemented the A2 foundation/data layer from scratch under `src/`.
- Added idempotent `setup()`, append-only `migrateSchema()`, property validators, shared error handling, retry policy, lock helper, JSON helper, logger masking, repositories, and Apps Script self-tests.
- Kept secrets in Script Properties only and avoided logging API keys, owner email, authorization headers, file IDs, and base64 image data.

## Files Changed

- `src/common/Constants.gs`
- `src/common/Errors.gs`
- `src/common/LockManager.gs`
- `src/common/RetryPolicy.gs`
- `src/common/Validators.gs`
- `src/common/Json.gs`
- `src/common/AppLogger.gs`
- `src/infrastructure/SheetRepository.gs`
- `src/infrastructure/ConfigRepository.gs`
- `src/infrastructure/DocumentRepository.gs`
- `src/infrastructure/DriveTempRepository.gs`
- `src/Setup.gs`
- `src/appsscript.json`
- `src/tests/A2PlatformTests.gs`

## Contract Assumptions

- The repository intentionally did not yet contain a `src/` tree, so A2-owned files were created fresh within the allowed ownership boundary.
- Resource IDs are treated as opaque non-empty strings because Apps Script/Drive IDs are not UUIDs.
- `RetryPolicy.getRetryDecision(error, attemptCount, now, context)` interprets `attemptCount` as the failed-attempt count after the current failure, matching the A1 backoff table.
- For `MAIL_QUOTA_EXHAUSTED`, the next retry window is the next day at `08:05` in `Asia/Tokyo`.
- `setup()` avoids holding a `ScriptLock` during Drive/Docs creation work; in a rare concurrent first-run race, duplicate unused resources could be created even though the stored property winner remains deterministic.

## Tests Run

- `python -m pip install -r requirements-dev.txt`
- `python tools/validate_contracts.py`

## Test Results

- `python tools/validate_contracts.py`: PASS (`27 passed, 0 failed`)
- Apps Script self-tests were added but could not be executed in this local shell environment because they require a GAS runtime.

## Manual Apps Script Self-Test

1. Open the Apps Script project and set Script Properties for `GEMINI_API_KEY`, `OWNER_EMAIL`, and `APP_ENV`.
2. Run `setup()`.
3. Run `runPlatformSelfTest()`.
4. Optionally run `validatePostSetupProperties()` and, after deployment, `validatePostDeployProperties()`.

## Known Limitations

- The Apps Script self-tests are present but unexecuted locally.
- No change request document was needed because no A1 contract contradiction was found.
- `AppLogger.writeDebugLog(...)` and `SheetRepository.appendDebugLog(...)` are available for downstream A6/A7 use, but no caller is wired into production flows yet.

## Items Requiring Human Setup In Google Apps Script

- Create/import the Apps Script project and upload the `src/` files.
- Populate Script Property `GEMINI_API_KEY`.
- Populate Script Property `OWNER_EMAIL`.
- Populate Script Property `APP_ENV`.
- Run `setup()`.
- Deploy the web app, then store `WEB_APP_URL` in Script Properties.
- Run `validatePostDeployProperties()` after deployment.

## Merge Checklist

### A2 merge prerequisites

- [x] A2-owned foundation files implemented only within allowed paths
- [x] `setup()` is idempotent
- [x] `migrateSchema()` appends missing columns only
- [x] `runPlatformSelfTest()` avoids Gemini API calls
- [x] Contract validator passes

### After creating the Google Apps Script environment

- [ ] Apps Script project created/imported
- [ ] Script Properties set for `GEMINI_API_KEY`, `OWNER_EMAIL`, and `APP_ENV`
- [ ] `setup()` executed successfully
- [ ] Apps Script runtime self-tests executed by a human in GAS

### After web app deployment

- [ ] Web app deployed to `/exec`
- [ ] `WEB_APP_URL` stored in Script Properties
- [ ] `validatePostDeployProperties()` executed successfully

# A7 Manual GAS Test Plan

## Purpose

This is the exact manual validation plan for the real Google Apps Script environment.

Run this in a controlled personal Google account. Do not use valuable production Drive folders for first validation.

## Preconditions

- Latest `main` is pulled locally.
- The Apps Script project is connected to this repository's `src/` files by the existing deployment workflow.
- You have a Gemini API key.
- You know the owner email address that should receive proactive mail.
- You can access Google Sheets, Docs, Drive, and Gmail/MailApp from the same account.

## Phase 1: Local Validation

From the repository root:

```bash
python tools/validate_contracts.py
python tools/a7_static_audit.py
node -e "const fs=require('fs'); const path=require('path'); const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]); const files=walk('src').filter(f=>f.endsWith('.gs')); for (const f of files) { new Function(fs.readFileSync(f,'utf8')); } console.log('syntax ok', files.length);"
```

Expected:

- Contract validation passes.
- A7 static audit reports zero errors.
- Apps Script syntax parse succeeds.

## Phase 2: Push to Apps Script

Use the repository's configured Apps Script workflow. If `clasp` is configured, run:

```bash
clasp push
```

If not, copy the `src/` files into the Apps Script project using the existing manual workflow.

## Phase 3: Script Properties

In Apps Script Project Settings, set:

```text
GEMINI_API_KEY
OWNER_EMAIL
APP_ENV
```

Use real values only in Apps Script properties. Do not write them into repository files.

Recommended `APP_ENV` for first validation:

```text
test
```

## Phase 4: Setup

Run these functions from Apps Script editor:

```text
validatePreSetupProperties()
setup()
validatePostSetupProperties()
```

Expected:

- No exception.
- `SPREADSHEET_ID` is set.
- `DIARY_DOC_ID` is set.
- `TEMP_FOLDER_ID` is set.
- `BACKUP_FOLDER_ID` is set.
- `SCHEMA_VERSION` is set.
- Required sheets exist.

Inspect the generated Sheet tabs:

```text
config
user_state
conversation_logs
event_queue
long_term_memories
daily_summaries
usage_daily
debug_logs
```

## Phase 5: Deploy Web App

Deploy as a Web App.

Recommended first validation settings:

- Execute as: the owner account
- Who has access: only the intended user / owner account, not public

Open the deployed `/exec` URL in the browser.

Then set Script Property:

```text
WEB_APP_URL
```

Run:

```text
validatePostDeployProperties()
```

Expected:

- No exception.
- URL contains `/exec`.

## Phase 6: Trigger Setup

Run:

```text
installTriggers()
listProjectTriggers()
```

Expected:

- One `processQueueJob` time-based trigger.
- One `schedulerJob` time-based trigger.
- Running `installTriggers()` again does not duplicate triggers.

## Phase 7: Self Tests

Run:

```text
runA7StaticSelfTest()
runA7IntegrationSelfTest()
runAllSelfTests()
```

Expected:

- No failures.
- These tests must not send real mail or call Gemini directly.

## Phase 8: WebUI Smoke Test

Open the Web App.

Check:

- Page loads.
- No browser console errors.
- Message input appears.
- Attachment control appears.
- Existing messages load or empty state is shown.

## Phase 9: Text Chat

Send a short text message.

Expected:

- A user row is added to `conversation_logs`.
- Gemini reply appears in UI.
- Assistant row is added to `conversation_logs`.
- `debug_logs` does not contain API key, raw prompt, or secret values.

## Phase 10: Image Chat

Test one small image for each supported type:

- JPEG
- PNG
- WebP

Expected:

- Client accepts the file.
- Request is validated.
- Temporary Drive file is created.
- Gemini response references the image content.
- Raw base64 is not stored in logs or Sheets.
- Temporary file is later cleanup-eligible.

Test unsupported file type.

Expected:

- Request is rejected.
- No Gemini call.
- No temp Drive file remains.

## Phase 11: Queue Retry

Create or simulate a retryable Gemini failure.

Expected:

- `CHAT_REPLY` event is created.
- Event enters `PENDING` or `RETRY_WAIT`.
- Run `processQueueJob()`.
- Event becomes `DONE`, `RETRY_WAIT`, or `DEAD` according to retry policy.
- One failing event does not stop other claimed events.

## Phase 12: Memory Extraction

Create enough conversation messages to exceed `MEMORY_EXTRACT_INTERVAL`.

Run:

```text
schedulerJob()
processQueueJob()
```

Expected:

- `MEMORY_EXTRACT` event is enqueued and processed.
- `long_term_memories` receives valid rows.
- Same normalized key does not produce duplicate active memories.
- `user_state.last_memory_cursor` advances after successful processing.

## Phase 13: Diary Generation

After conversation exists for the target date, run:

```text
schedulerJob()
processQueueJob()
```

or enqueue a controlled `DIARY_GENERATE` event.

Expected:

- Diary entry is appended to the Google Doc.
- `daily_summaries.diary_status` becomes `DONE`.
- Re-running the same event does not append a duplicate entry.

## Phase 14: Proactive Email

Prepare state so silence threshold is reached outside quiet hours and below daily max.

Run:

```text
schedulerJob()
processQueueJob()
```

Expected:

- `PROACTIVE_SEND` event is created.
- A pre-send marker is written.
- Email is sent to owner address.
- `usage_daily.proactive_sent_count` increments.
- `user_state.last_proactive_at` updates.

Also verify:

- Quiet hours suppress event.
- Daily max suppresses event.
- Cooldown suppresses event.
- Mail quota exhausted path does not short-retry.

## Phase 15: Weekly Backup

Use a controlled date/time or wait until Sunday after 03:00 Tokyo.

Run:

```text
schedulerJob()
processQueueJob()
```

Expected:

- One `WEEKLY_BACKUP:{yyyy-MM-dd}` event is created.
- Spreadsheet backup copy is created in backup folder.
- Diary Doc backup copy is created in backup folder.
- Running scheduler again on the same backup date does not create another event or copy.

## Phase 16: Maintenance

Run:

```text
schedulerJob()
```

Expected:

- Expired temporary files are trashed only inside configured temp folder.
- Old debug logs older than retention are deleted.
- Non-expired temp files remain.

## Phase 17: Teardown

When validation is complete, run:

```text
listProjectTriggers()
deleteProjectTriggers()
listProjectTriggers()
```

Expected:

- Triggers are removed.
- No scheduled email/backup side effects continue unexpectedly.

## Rollback

If a blocking issue appears:

1. Run `deleteProjectTriggers()`.
2. Stop using the current Web App deployment.
3. Restore from previous Apps Script version or previous Git commit.
4. Use backup Sheet/Doc copies if data must be recovered.
5. Record the defect with event row, debug log row, timestamp, and reproduction steps.

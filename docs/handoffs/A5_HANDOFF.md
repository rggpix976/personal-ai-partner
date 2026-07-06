# A5 Handoff

## Implementation Summary
- Added `MemoryService` for A1-compatible memory extraction enqueueing, structured Gemini-backed extraction, deterministic memory retrieval, and local candidate application.
- Added `DiaryService` for A1-compatible diary enqueueing, duplicate detection, grounded AI self-diary generation, Google Doc append flow, and `daily_summaries` updates.
- Refactored `ContextService` memory loading so chat context now prefers `MemoryService.findRelevant(...)` and degrades safely to the A4 repository-only behavior if retrieval fails.
- Extended `SheetRepository` with the minimum extra helpers needed for A5 message/date lookup, memory lookup, dedupe lookup, and `daily_summaries` persistence.
- Extended `DocumentRepository` with minimal diary entry detection and append helpers so A5 stays within the repository boundary for Google Docs access.

## Changed Files
- `README.md`
- `src/application/ContextService.gs`
- `src/application/MemoryService.gs`
- `src/application/DiaryService.gs`
- `src/infrastructure/SheetRepository.gs`
- `src/infrastructure/DocumentRepository.gs`
- `src/tests/A5MemoryDiaryTests.gs`
- `docs/handoffs/A5_HANDOFF.md`

## Public Functions Used Or Added
- `MemoryService.enqueueExtraction(messageRange)`
- `MemoryService.extract(eventPayload)`
- `MemoryService.findRelevant(query, limit)`
- `MemoryService.applyCandidates(candidates)`
- `DiaryService.enqueue(date)`
- `DiaryService.generate(eventPayload)`
- `DiaryService.isGenerated(date)`
- Added minimal repository helpers used by A5:
  - `SheetRepository.listMessagesByIds(messageIds)`
  - `SheetRepository.listMessagesByDate(summaryDate)`
  - `SheetRepository.getEventByDedupeKey(dedupeKey)`
  - `SheetRepository.getMemoryById(memoryId)`
  - `SheetRepository.findActiveMemoryByNormalizedKey(normalizedKey)`
  - `SheetRepository.getDailySummary(summaryDate)`
  - `SheetRepository.upsertDailySummary(summary)`
  - `DocumentRepository.findDiaryEntryAnchor(diaryDate)`
  - `DocumentRepository.appendDiaryEntry(entry)`

## Dependencies On A6
- A6 still owns queue worker execution and retry orchestration for `MEMORY_EXTRACT` and `DIARY_GENERATE`.
- A6 still owns `QueueService`, `ProcessQueueJob`, `SchedulerJob`, proactive messaging, Gmail notification, maintenance tasks, and weekly backup behavior.
- A5 can enqueue contract-compatible events and expose service methods for A6 to call, but it does not claim scheduled or worker-driven execution is complete.

## Manual GAS / Gemini / Docs Test Plan
1. In Apps Script, set Script Properties for `GEMINI_API_KEY`, `OWNER_EMAIL`, and `APP_ENV`.
2. Run `setup()`.
3. Add a few user and assistant messages to `conversation_logs` for the same day.
4. Call `MemoryService.enqueueExtraction(...)` with a bounded message range and confirm one `MEMORY_EXTRACT` row is inserted with dedupe key `MEMORY_EXTRACT:{firstMessageId}:{lastMessageId}`.
5. Run `MemoryService.extract(...)` manually with that payload and confirm:
   - messages are loaded through `SheetRepository`
   - Gemini returns structured candidates
   - `long_term_memories` rows are created or updated without duplicate `normalized_key` values
6. Send a new chat request that references a remembered fact and confirm `ContextService.buildChatContext(...)` includes relevant memories without throwing if retrieval is unavailable.
7. Call `DiaryService.enqueue('yyyy-MM-dd')` and confirm one `DIARY_GENERATE` row is inserted with dedupe key `DIARY_GENERATE:{yyyy-MM-dd}`.
8. Run `DiaryService.generate(...)` manually and confirm:
   - the diary is appended once to the configured Google Doc
   - `daily_summaries` is updated to `diary_status: DONE`
   - running the same payload again skips duplicate generation

## Validation Commands And Results
- `node -e "const fs=require('fs'); const files=['src/common/Constants.gs','src/common/Errors.gs','src/common/Validators.gs','src/infrastructure/SheetRepository.gs','src/infrastructure/DocumentRepository.gs','src/infrastructure/GeminiClient.gs','src/application/ContextService.gs','src/application/MemoryService.gs','src/application/DiaryService.gs','src/tests/A5MemoryDiaryTests.gs']; for (const f of files) { new Function(fs.readFileSync(f,'utf8')); } console.log('syntax ok');"`
  - PASS (`syntax ok`)
- `python tools/validate_contracts.py`
  - PASS locally after A5 changes
- Apps Script runtime self-tests were added but not executed in this shell environment

## Known Limitations
- Gemini structured output is prompt-guided JSON rather than hard schema enforcement at the HTTP layer.
- `MemoryService.applyCandidates(...)` resolves duplicate `normalizedKey` create attempts locally by folding them into the existing active memory instead of creating a second active row.
- Diary duplicate detection uses `daily_summaries` and a heading-style anchor string in the Google Doc; it does not rely on hidden bookmarks or richer document metadata.
- Apps Script runtime execution, real Gemini calls, and real Google Docs append verification still need human/manual confirmation in GAS.

# A4 Handoff

## Implementation Summary
- Added the A4 application layer under `src/application/` with `ChatService`, `ContextService`, and `ImageService`.
- Added `src/infrastructure/GeminiClient.gs` as the single Gemini HTTP integration point.
- Wired A3 `WebController.sendChat(request)` so A4 owns idempotency and chat execution whenever `ChatService.send(...)` is available.
- Implemented synchronous chat completion for normal cases and queued retry behavior only for temporary Gemini failures.
- Added image preparation and cleanup flow that stores temp files in Drive, sends inline image data to Gemini, stores only image metadata plus `image_summary` in Sheets, and trashes temp files after successful processing.

## Changed Files
- `README.md`
- `src/application/ChatService.gs`
- `src/application/ContextService.gs`
- `src/application/ImageService.gs`
- `src/infrastructure/GeminiClient.gs`
- `src/infrastructure/DriveTempRepository.gs`
- `src/web/WebController.gs`
- `src/common/Errors.gs`
- `src/tests/A4ChatGeminiTests.gs`

## Public Functions Used Or Added
- Public browser-callable entrypoints remain in `src/PublicApi.gs`:
  - `doGet()`
  - `getInitialState()`
  - `loadMessages(beforeMessageId, limit)`
  - `sendChat(request)`
  - `getRequestStatus(requestId)`
- New internal application/infrastructure functions:
  - `ChatService.send(request, context)`
  - `ContextService.buildChatContext(input)`
  - `ImageService.prepareGeminiInput(image, options)`
  - `ImageService.validateImageMetadata(image)`
  - `GeminiClient.generateText(request)`
  - `GeminiClient.generateWithImage(request)`
  - `GeminiClient.generateStructured(request, schemaName)`
  - `DriveTempRepository.getTempImageData(tempFileId)`
  - `DriveTempRepository.trashTempImage(tempFileId)`

## Dependencies On A5 And A6
- A5 still owns:
  - long-term memory extraction logic
  - `MemoryService`
  - diary generation
  - `DiaryService`
- A6 still owns:
  - queue worker execution for `CHAT_REPLY`
  - stale event recovery and retry worker behavior
  - scheduler / worker orchestration
- A4 already emits contract-compatible `CHAT_REPLY` retry events for temporary Gemini failures, so A6 can pick them up without changing the request contract.

## Manual GAS / Gemini Test Plan
1. In Apps Script, set Script Properties for `GEMINI_API_KEY`, `OWNER_EMAIL`, and `APP_ENV`.
2. Run `setup()`.
3. Deploy or refresh the web app.
4. Send a normal text-only chat request and confirm:
   - `sendChat(request)` returns `status: "completed"`
   - one `user` row and one `assistant` row are stored for the same `request_id`
   - assistant row records `model`, `input_tokens`, and `output_tokens` when Gemini returns usage metadata
5. Send a JPEG, PNG, and WebP image request and confirm:
   - Gemini can respond about the image
   - `conversation_logs` stores `image_name`, `image_mime`, and `image_summary`
   - raw base64 is not stored in Sheets or logs
   - the temp Drive image is trashed after successful processing
6. Force a temporary Gemini error scenario if possible and confirm:
   - the result returns `status: "queued"`
   - one `CHAT_REPLY` event is created with dedupe key `CHAT_REPLY:{requestId}`
   - repeating the same `requestId` does not create duplicate conversation rows or duplicate retry events
7. Force an auth or invalid-model scenario and confirm:
   - the result returns `status: "failed"`
   - no new retry event is created

## Validation Commands And Results
- `node -e "const fs=require('fs'); const files=['src/common/Errors.gs','src/web/WebController.gs','src/infrastructure/DriveTempRepository.gs','src/application/ImageService.gs','src/application/ContextService.gs','src/infrastructure/GeminiClient.gs','src/application/ChatService.gs','src/tests/A4ChatGeminiTests.gs']; for (const f of files) { new Function(fs.readFileSync(f,'utf8')); } console.log('syntax ok');"`
  - PASS (`syntax ok`)
- `python tools/validate_contracts.py`
  - PASS (`27 passed, 0 failed`)
- Apps Script runtime tests were not executed in this local shell environment

## Known Limitations
- The new Apps Script self-tests are static/unit-like only and were not executed in a live GAS runtime here.
- Image requests now write back a bounded post-generation `image_summary`, but the summary is derived from the assistant response text rather than a dedicated structured image-summary model output.
- Queue processing itself is still out of scope here; queued `CHAT_REPLY` items wait for downstream worker support.
- No full long-term memory extraction or diary generation is included in A4.

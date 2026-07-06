# A3 Handoff

## Implementation Summary
- Added the Apps Script HTML Service WebUI layer under `src/web/`.
- Added `src/PublicApi.gs` and moved the browser-callable public functions there to match the A1 public API placement rule.
- Kept `src/web/WebController.gs` as the A3 implementation object and template helper holder.
- Kept A3 contract-compatible with A1 by using the documented function signatures and returning `ChatResult`-shaped objects for send and status flows.
- Used A2 repositories for config, conversation history, user state, and event queue access.
- Updated `sendChat(request)` so it calls `ChatService.send(request, context)` when A4 is implemented and uses the queue fallback only when `ChatService.send` is absent.
- Kept chat generation out of scope for A3. In fallback mode, `sendChat(request)` stores the user message, persists an image via `DriveTempRepository.createTempImage(...)`, and enqueues a `CHAT_REPLY` event for a future A4/A6 worker.
- Added a responsive plain HTML/CSS/JavaScript client with safe text rendering, request-id generation, image preview, client-side image validation, double-send prevention, queue polling, and mobile-friendly layout behavior.
- Refreshed `README.md` to describe the post-A3 repository state.

## Changed Files
- `README.md`
- `src/web/WebController.gs`
- `src/PublicApi.gs`
- `src/web/Index.html`
- `src/web/Styles.html`
- `src/web/Client.html`
- `src/tests/A3WebUiTests.gs`
- `src/infrastructure/DriveTempRepository.gs`

## Public Functions Used Or Added
- Public functions now live in `src/PublicApi.gs`:
  - `doGet()`
  - `getInitialState()`
  - `loadMessages(beforeMessageId, limit)`
  - `sendChat(request)`
  - `getRequestStatus(requestId)`
- Repository and platform functions used:
  - `SheetRepository.listRecentMessages(limit)`
  - `SheetRepository.listMessagesBefore(messageId, limit)`
  - `SheetRepository.getConversationByRequestId(requestId)`
  - `SheetRepository.appendConversation(message)`
  - `SheetRepository.insertEvent(event)`
  - `SheetRepository.getUserState()`
  - `SheetRepository.updateUserState(patch)`
  - `SheetRepository.ensureDefaultUserState()`
  - `ConfigRepository.getByKey(key)`
  - `DriveTempRepository.createTempImage(input)`

## Minimal A2-Owned Change
- `src/infrastructure/DriveTempRepository.gs`
  - Added `createTempImage(input)` so the Web layer no longer performs direct Drive file creation.
  - This was the minimum infrastructure change needed to restore the A1 layering rule that Drive persistence should stay outside the Web layer.

## Dependencies On A4
- A4 is still required for:
  - `ChatService`
  - `GeminiClient`
  - `ImageService`
  - Assistant reply generation
  - Queue worker execution for `CHAT_REPLY`
- Current A3 behavior is intentionally queue-first:
  - `WebController.sendChat(request)` now delegates to `ChatService.send(request, context)` when available
  - user message is saved
  - optional image is stored as a temp Drive file through `DriveTempRepository.createTempImage(...)`
  - `CHAT_REPLY` event is queued only in the no-A4 fallback path
  - UI clearly reports degraded/queued state when no A4 worker is available

## Manual Test Plan
1. In Apps Script, set Script Properties for `GEMINI_API_KEY`, `OWNER_EMAIL`, and `APP_ENV`.
2. Run `setup()`.
3. Deploy the web app to `/exec`.
4. Open the web app on desktop Chrome.
5. Open the web app on smartphone Safari or Chrome.
6. Verify initial load shows the latest messages.
7. Verify older messages load with the `Load older messages` button.
8. Send a text-only message and confirm:
   - a client-generated `requestId` is used
   - the send button is disabled while sending
   - the user message appears in the timeline
   - a queued status is shown when A4 is not present
9. Attach a JPEG, PNG, and WebP image separately and confirm:
   - preview is shown before send
   - invalid types are rejected client-side
   - oversize files are rejected client-side
10. Confirm displayed user and assistant text is rendered via safe text nodes rather than `innerHTML`.
11. Confirm the app shows a clear setup-required state if Script Properties or setup resources are missing.

## Validation Commands And Results
- `python tools/validate_contracts.py`
  - PASS (`27 passed, 0 failed`)
- Python scan over changed files for BOM, bidi controls, Unicode format controls, ASCII control characters, and NBSP
  - No problematic invisible characters found
- `rg -n "AIza|sk-[A-Za-z0-9]|GEMINI_API_KEY\\s*=|x-goog-api-key\\s*[:=]|Authorization\\s*[:=]" README.md docs src`
  - Only existing test fixtures and masking regexes matched; no new secrets were added
- Apps Script runtime tests were not executed in this local shell environment

## Known Limitations
- Assistant replies are not generated yet because A4 is not implemented.
- Queue processing is not implemented here; queued `CHAT_REPLY` events remain waiting for downstream worker support.
- `VALIDATION_REQUEST_INVALID` is used locally in A3 for malformed request payloads so invalid request errors do not surface as setup failures.
- A3 self-tests were added, but they require Apps Script execution to run.

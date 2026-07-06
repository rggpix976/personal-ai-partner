# A3 Handoff

## Implementation Summary
- Added the Apps Script HTML Service WebUI layer under `src/web/`.
- Implemented `doGet()`, `getInitialState()`, `loadMessages(beforeMessageId, limit)`, `sendChat(request)`, and `getRequestStatus(requestId)` in `src/web/WebController.gs`.
- Kept A3 contract-compatible with A1 by using the documented function signatures and returning `ChatResult`-shaped objects for send and status flows.
- Used A2 repositories for config, conversation history, user state, and event queue access.
- Kept chat generation out of scope. `sendChat(request)` stores the user message, persists an image to the temp Drive folder when present, and enqueues a `CHAT_REPLY` event for a future A4/A6 worker.
- Added a responsive plain HTML/CSS/JavaScript client with safe text rendering, request-id generation, image preview, client-side image validation, double-send prevention, queue polling, and mobile-friendly layout behavior.
- Refreshed `README.md` to describe the post-A3 repository state.

## Changed Files
- `README.md`
- `src/web/WebController.gs`
- `src/web/Index.html`
- `src/web/Styles.html`
- `src/web/Client.html`
- `src/tests/A3WebUiTests.gs`

## Public Functions Used Or Added
- Added global wrappers because `src/PublicApi.gs` is not present in the current tree:
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
  - `DriveTempRepository.ensureFolders()`

## Dependencies On A4
- A4 is still required for:
  - `ChatService`
  - `GeminiClient`
  - `ImageService`
  - Assistant reply generation
  - Queue worker execution for `CHAT_REPLY`
- Current A3 behavior is intentionally queue-first:
  - user message is saved
  - optional image is stored as a temp Drive file
  - `CHAT_REPLY` event is queued
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
- `rg -n "[\u202A-\u202E\u2066-\u2069]" README.md docs src`
  - No bidi control characters found
- `rg -n "AIza|sk-[A-Za-z0-9]|GEMINI_API_KEY\\s*=|x-goog-api-key\\s*[:=]|Authorization\\s*[:=]" README.md docs src`
  - Only existing test fixtures and masking regexes matched; no new secrets were added
- Apps Script runtime tests were not executed in this local shell environment

## Known Limitations
- Assistant replies are not generated yet because A4 is not implemented.
- Queue processing is not implemented here; queued `CHAT_REPLY` events remain waiting for downstream worker support.
- `src/PublicApi.gs` is still absent in the current repository snapshot, so A3 currently provides the documented global wrappers directly from `src/web/WebController.gs`.
- A3 self-tests were added, but they require Apps Script execution to run.

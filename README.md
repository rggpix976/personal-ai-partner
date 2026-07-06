# Personal Proactive AI Partner

## Project Status
- Latest deliverable: A3 WebUI layer
- Version: v0.4
- PR state: WebUI layer merged
- Next agent: A4 Chat / Gemini / Image

## Implemented Scope
- A1 contracts and integration gates
- A2 foundation and data layer
- A3 Apps Script HTML Service WebUI

## Not Yet Implemented
- `ChatService`
- `GeminiClient`
- `ImageService`
- `MemoryService`
- `DiaryService`
- `ProactiveMessageService`

## Repository Layout
All Apps Script source files live under [`src/`](src/).

```text
src/
  PublicApi.gs
  Setup.gs
  appsscript.json
  common/
  infrastructure/
  tests/
  web/
```

Current WebUI files:

- `src/web/WebController.gs`
- `src/web/Index.html`
- `src/web/Styles.html`
- `src/web/Client.html`

## Current Behavior
- The web app renders a responsive chat UI for desktop and smartphone browsers.
- Initial load shows the latest conversation messages from `conversation_logs`.
- Users can load older messages.
- Users can send text and attach JPEG, PNG, or WebP images.
- Image type and size are validated client-side before send.
- Public browser-callable functions are defined in `src/PublicApi.gs`.
- `sendChat(request)` delegates to `ChatService.send(request, context)` when A4 is present.
- If A4 is not present, `sendChat(request)` stores the user message and enqueues a `CHAT_REPLY` event as a fallback.
- A4 is still required to generate assistant replies, call Gemini, and process queued chat work.

## Read Before Continuing
1. [`docs/a1/01_ARCHITECTURE_BASELINE.md`](docs/a1/01_ARCHITECTURE_BASELINE.md)
2. [`docs/a1/02_PUBLIC_API_CONTRACT.md`](docs/a1/02_PUBLIC_API_CONTRACT.md)
3. [`docs/a1/03_SERVICE_CONTRACTS.md`](docs/a1/03_SERVICE_CONTRACTS.md)
4. [`docs/a1/04_DATA_AND_EVENT_CONTRACTS.md`](docs/a1/04_DATA_AND_EVENT_CONTRACTS.md)
5. [`docs/a1/05_ERROR_CONTRACT.md`](docs/a1/05_ERROR_CONTRACT.md)
6. [`docs/a1/06_FILE_OWNERSHIP.md`](docs/a1/06_FILE_OWNERSHIP.md)
7. [`docs/a1/07_INTEGRATION_GATES.md`](docs/a1/07_INTEGRATION_GATES.md)
8. [`docs/handoffs/A1_HANDOFF.md`](docs/handoffs/A1_HANDOFF.md)
9. [`docs/handoffs/A2_HANDOFF.md`](docs/handoffs/A2_HANDOFF.md)

## Validation
Install the dev dependencies:

```bash
python -m pip install -r requirements-dev.txt
```

Run the contract validator:

```bash
python tools/validate_contracts.py
```

## Notes
- Keep secrets in Script Properties only.
- Do not add Gemini API calls in the WebUI layer.
- Do not treat the app as fully functional chat until A4 is merged.

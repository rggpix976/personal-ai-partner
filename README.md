# Personal Proactive AI Partner

## Project Status
- Latest deliverable: A5 Long-term memory and AI self-diary layer
- Version: v0.6
- PR state: A5 implementation ready for review
- Next agent: A6 Queue, scheduler, proactive messages, Gmail notification

## Implemented Scope
- A1 contracts and integration gates
- A2 foundation and data layer
- A3 Apps Script HTML Service WebUI
- A4 chat generation, Gemini integration, context building, and image understanding
- A5 long-term memory extraction, memory retrieval/application, and AI self-diary generation

## Not Yet Implemented
- `ProactiveMessageService`
- `GmailNotifier`
- `QueueService` worker
- `SchedulerJob`
- `MaintenanceService`
- Weekly backup
- Full acceptance testing

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
- `sendChat(request)` now delegates to `ChatService.send(request, context)` for synchronous Gemini-backed replies when the request succeeds immediately.
- `ChatService` stores the user message, builds bounded context, calls Gemini through `GeminiClient`, stores the assistant reply, and returns an A1-compatible `ChatResult`.
- Temporary Gemini failures queue a `CHAT_REPLY` retry event instead of failing open.
- Permanent Gemini failures return a failed `ChatResult` without enqueuing duplicate retry work.
- Only image metadata and `image_summary` are stored in `conversation_logs`; raw image base64 stays out of Sheets and logs.
- `MemoryService.enqueueExtraction(...)` and `DiaryService.enqueue(...)` can create A1-compatible queue events, but A6 still owns worker execution.
- `MemoryService.extract(...)` uses `GeminiClient.generateStructured(...)` plus repository-only message loading to create, confirm, update, or ignore durable memories.
- `ContextService` now prefers `MemoryService.findRelevant(...)` for cheap deterministic memory retrieval and falls back safely if memory lookup fails.
- `DiaryService.generate(...)` produces a grounded AI self-diary entry, appends it through `DocumentRepository`, and updates `daily_summaries` idempotently.
- Proactive messaging, scheduled queue processing, Gmail notification, maintenance flows, and weekly backup are still future work.

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
- Gemini API calls stay inside `src/infrastructure/GeminiClient.gs`.
- Do not treat the project as the full MVP yet. A5 makes long-term memory and AI self-diary service logic possible, but queue workers, scheduling, proactive messaging, Gmail notification, maintenance flows, weekly backup, and full acceptance coverage still remain.

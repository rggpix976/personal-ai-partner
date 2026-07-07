# Personal Proactive AI Partner

## Project Status
- Latest deliverable: A6 queue, scheduler, proactive messages, Gmail notification, and maintenance
- Version: v0.7
- PR state: A6 implementation ready for review
- Next agent: A7 QA, security review, acceptance testing, and integration hardening

## Implemented Scope
- A1 contracts and integration gates
- A2 foundation and data layer
- A3 Apps Script HTML Service WebUI
- A4 chat generation, Gemini integration, context building, and image understanding
- A5 long-term memory extraction, memory retrieval/application, and AI self-diary generation
- A6 queue worker, scheduler, proactive email notifications, Gmail quota-safe sending, maintenance cleanup, and weekly backup orchestration

## Not Yet Implemented
- Full A7 acceptance testing
- Final deployment verification
- Live GAS, Gemini, Gmail, Drive, and Docs validation in a production-like environment

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
- Temporary Gemini failures can be retried by `processQueueJob()` through `QueueService`.
- `schedulerJob()` can enqueue proactive messages, diary generation, memory extraction, and weekly backup work on time-based triggers.
- `ProactiveMessageService` evaluates quiet hours, cooldowns, daily caps, and MailApp quota before queueing or sending email.
- `MaintenanceService` handles temp image cleanup, debug log cleanup, and backup retention.

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
- Mail sending stays inside `src/infrastructure/GmailNotifier.gs`.
- Do not treat the project as the full MVP yet. A6 adds scheduled execution and proactive behavior, but A7 still needs to perform QA, security review, acceptance tests, live environment validation, and integration hardening.

# Proactive Conversations Specification

## 1. Status

This document defines the **current production/legacy behavior** of
probabilistic, AI-generated proactive conversations introduced by Issue #18
and released as Apps Script version 7. The approved CharacterPack target is
recorded separately in section 14.1 and is not yet deployed.

Production configuration as of 2026-07-20:

```text
PROACTIVE_POLICY_MODE=probability
PROACTIVE_AI_GENERATION_ENABLED=true
SILENCE_MINUTES=240
```

The production rollout passed three stages: the new code with conservative
defaults, probability-only activation, and probability plus Gemini generation.
The only time-driven jobs are `processQueueJob` and `schedulerJob`.

PR 3 does not modify or connect this production path. PR 5 will replace only
the enforced V2 proactive content path after the dormant guard core is
accepted. Historical behavior and rollout evidence below remain factual.

## 2. Goals

The current feature allows the configured partner to initiate a natural
conversation while preserving the existing `PROACTIVE_SEND` event pipeline.

The implementation must:

- preserve quiet hours, `quiet_until`, user-activity, minimum-silence,
  cooldown, daily-cap, next-check, and mail-quota gates
- make the probability decision only when enqueueing
- derive repeatable samples without `Math.random()`
- avoid probability rerolls during queue processing or retry
- cancel dispatch when the user spoke after enqueue
- generate a message from configuration, recent conversation, and relevant
  memory
- fall back to a configured template for supported Gemini failures
- deliver and persist each proactive message at most once
- expose newly persisted messages to the Web App without a page reload

## 3. Non-goals

- A separate proactive event type
- AI-based eligibility decisions
- Probability rerolls during dispatch or retry
- Pre-generating a message body in the queue payload
- Hard-coded user names, partner names, persona, message style, or templates
- Claims about user health, fatigue, emotion, schedule, location, private
  actions, or current situation without supplied evidence

## 4. Runtime flow

```text
schedulerJob
  -> ProactiveMessageService.evaluateLocalConditions()
  -> QueueService.enqueue(PROACTIVE_SEND)
  -> processQueueJob
  -> ProactiveMessageService.prepareDispatch()
  -> ProactiveMessageService.send()
  -> conversation_logs proactive delivery marker
  -> GmailNotifier / MailApp
  -> Web App loadNewMessages() polling
```

Eligibility and delivery are intentionally separate. The scheduler persists a
decision, while the queue worker rechecks safety and performs the external side
effect.

## 5. Enqueue phase

`schedulerJob` calls `ProactiveMessageService.evaluateLocalConditions(now)`.
The service evaluates the enqueue hard gates, computes the target date and next
daily sequence, and derives the current decision slot.

In threshold mode, a candidate that passes the hard gates is eligible. In
probability mode, the service computes one deterministic sample and compares it
with the configured probability. A miss is not enqueued.

A hit produces a `PROACTIVE_SEND` payload containing decision metadata. The
payload does not contain a subject or message body. `QueueService.enqueue()`
normalizes the payload and suppresses another active event with the same queue
deduplication key.

Probability, sample, decision slot, and `requestedAt` are persisted in the
queue event. Later workers consume those values without recalculating them.

## 6. Dispatch phase

`processQueueJob` claims a queued event and calls
`ProactiveMessageService.prepareDispatch(payload, now)`.

`requestedAt` is the scheduler timestamp recorded when the enqueue decision was
made. Dispatch is cancelled with `USER_ACTIVITY_AFTER_ENQUEUE` when
`last_user_message_at` is later than `requestedAt`.

Dispatch does not rerun the threshold or probability policy. It checks the
target date, later user activity, applicable hard gates, and the delivery
marker. Only after those checks pass does it reuse a saved body, call Gemini,
or render the configured template.

`MAIL_QUOTA_EXHAUSTED` is surfaced to the queue retry policy. Other ineligible
conditions complete the queue event as a safe skip without sending mail.

## 7. Hard gates

| Gate | Enqueue | Dispatch | Source |
|---|:---:|:---:|---|
| Quiet hours | yes | yes | `QUIET_START`, `QUIET_END` |
| Temporary quiet period | yes | yes | `user_state.quiet_until` |
| At least one user message | yes | yes | `user_state.last_user_message_at` |
| Minimum silence | yes | no | `SILENCE_MINUTES` |
| User activity after enqueue | n/a | yes | `requestedAt`, `last_user_message_at` |
| Proactive cooldown | yes | yes | `PROACTIVE_COOLDOWN_MINUTES` |
| Daily send cap | yes | yes | `PROACTIVE_MAX_PER_DAY` |
| Next eligible check | yes | no | `user_state.next_proactive_check_at` |
| Mail quota | yes | yes | `GmailNotifier.getRemainingQuota()` |
| Target-date expiry | n/a | yes | payload `targetDate` |
| Existing delivery marker | n/a | yes | `conversation_logs` |

No proactive event is eligible before the first recorded user message. Silence
and next-check eligibility are enqueue decisions; dispatch replaces them with
the stricter check for user activity after `requestedAt`.

## 8. Threshold mode

```text
PROACTIVE_POLICY_MODE=threshold
```

After every enqueue hard gate passes, the candidate is eligible without a
probability sample affecting the result. The payload still carries the common
decision fields with `probability=1` and `sample=0` so the queue contract stays
uniform.

Threshold is the repository fallback when `PROACTIVE_POLICY_MODE` is missing.
An unrecognized non-empty mode is not treated as threshold; evaluation returns
a configuration failure.

## 9. Probability mode and formula

```text
PROACTIVE_POLICY_MODE=probability
```

Let:

- `elapsed` be minutes since the last user message
- `floor` be `SILENCE_MINUTES`
- `ceiling` be `PROACTIVE_SILENCE_CEILING_MINUTES`
- `curve` be `PROACTIVE_PROBABILITY_CURVE`
- `weight` be the configured weight for the current time period

The normalized silence ratio is:

```text
ratio = clamp((elapsed - floor) / (ceiling - floor), 0, 1)
```

The enqueue probability is:

```text
probability = clamp((ratio ^ curve) * weight, 0, 1)
```

A candidate is enqueued only when:

```text
sample < probability
```

At the silence floor, probability is zero. It rises monotonically toward the
ceiling before the time-of-day weight is applied. Results above one are
clamped.

Time periods use `Asia/Tokyo`:

| Period | Default boundary | Default weight |
|---|---|---:|
| Morning | before `10:00` | `0.7` |
| Day | `10:00` through before `18:00` | `1.0` |
| Evening | `18:00` onward | `1.2` |

`PROACTIVE_DAY_START` must be earlier than `PROACTIVE_EVENING_START`, and all
weights must be non-negative.

## 10. Deterministic sampling

The decision slot is calculated from Unix epoch milliseconds and
`PROACTIVE_RECHECK_MINUTES`:

```text
decisionSlot = floor(epochMillis / (recheckMinutes * 60 * 1000))
```

The seed contains:

```text
targetDate | sequence | decisionSlot | last_user_message_at
```

The service applies a deterministic 32-bit hash and maps the unsigned result
to `[0, 1)`. `Math.random()` is not used.

Consequences:

- identical inputs in the same decision slot produce the same result
- dispatch and queue retries do not reroll
- later decision slots can produce different samples
- a persisted queue event remains stable even after the scheduler advances to
  another slot

## 11. Event, payload, and deduplication contracts

The event type remains:

```text
PROACTIVE_SEND
```

Required payload fields:

| Field | Meaning |
|---|---|
| `targetDate` | Tokyo calendar date for the candidate |
| `sequence` | Daily proactive delivery sequence |
| `requestedAt` | ISO timestamp of the enqueue decision |
| `decisionSlot` | Digit-only deterministic decision-slot identifier |
| `messageDedupeKey` | Expected delivered-message key |
| `probability` | Persisted probability in `[0, 1]` |
| `sample` | Persisted sample in `[0, 1)` |
| `elapsedMinutes` | Silence duration used for the decision |
| `timeWeight` | Time-period weight used for the decision |
| `reason` | Optional decision description |

Queue deduplication key:

```text
PROACTIVE_SEND:{targetDate}:{sequence}:{decisionSlot}
```

Delivered-message key and `conversation_logs.request_id`:

```text
PROACTIVE_MESSAGE:{targetDate}:{sequence}
```

The keys are deliberately different. Multiple decision slots may be
evaluated, while a target-date sequence can be delivered only once.

The machine-readable payload contract is
[`../a1/contracts/events/proactive-send-payload.schema.json`](../a1/contracts/events/proactive-send-payload.schema.json).
The human-readable event contract is
[`../a1/04_DATA_AND_EVENT_CONTRACTS.md`](../a1/04_DATA_AND_EVENT_CONTRACTS.md).

### 11.1 Known sequence boundary

The JSON Schema constrains `sequence` to 1 through 100. The current runtime
normalizers require a positive integer but do not independently enforce the
upper bound. Scheduler-generated values are `proactive_count + 1` and remain
far below that boundary under the current/default daily cap of 2. A direct or
misconfigured payload above 100 is therefore not contract-compliant even
though the runtime guard is less restrictive. This documentation change does
not alter either runtime code or the schema.

## 12. Current production AI prompt context

AI generation is controlled independently from eligibility:

```text
PROACTIVE_AI_GENERATION_ENABLED=true
```

The prompt uses:

- `PARTNER_NAME`
- `USER_NAME`
- `SYSTEM_PERSONA`
- `PROACTIVE_MESSAGE_STYLE`
- current time and last-user-message time
- recent conversation limited by `RECENT_MESSAGE_LIMIT`
- a memory query built from up to the last six non-empty user and assistant
  messages
- relevant long-term memory limited by `MEMORY_CONTEXT_LIMIT`
- configured minimum and maximum message lengths

Recent system markers do not become memory-query text. Missing conversation or
memory context degrades to an empty section rather than blocking delivery.

## 13. Current production prohibited generation behavior

The Gemini prompt requires one message body only and prohibits:

- mentioning schedulers, probability, inactivity detection, queues,
  automation, or internal processing
- pressuring the user to reply
- inventing or assuming user health, fatigue, emotion, schedule, location,
  private actions, or current situation
- unsupported use of memory
- unnecessary repetition of recent proactive wording
- overriding the configured partner identity, persona, or style

Names, persona, and style must come from configuration. They must not be
hard-coded in implementation or documentation examples.

These prohibitions remain prompt-level guidance on the current production
proactive path. The dormant PR 3 immersion core mechanically classifies and
guards these boundaries, as specified in
[Character Persona and Immersion Specification](CHARACTER_IMMERSION.md).
Integration and enforcement on the proactive production path belong to PR 5
and are not yet implemented or deployed.

## 14. Current production output validation and template fallback

Generated text is trimmed. One matching pair of surrounding ASCII quotes,
Japanese corner brackets, or Japanese double corner brackets is removed.

The resulting body must satisfy:

```text
PROACTIVE_MESSAGE_MIN_CHARS <= body.length <= PROACTIVE_MESSAGE_MAX_CHARS
```

Apart from normalization and the length boundary above, the current runtime
does not apply the common immersion guard proposed in
[Character Persona and Immersion Specification](CHARACTER_IMMERSION.md).

Too-short or too-long text becomes `GEMINI_BAD_RESPONSE`. The following
generation failures fall back to `PROACTIVE_BODY_TEMPLATE`:

- `GEMINI_RATE_LIMIT`
- `GEMINI_BAD_RESPONSE`
- `GEMINI_TEMPORARY_FAILURE`

The fallback uses configuration-derived names and template context. Other
unexpected failures are not silently converted to a template.

Template-only operation remains available with:

```text
PROACTIVE_AI_GENERATION_ENABLED=false
```

This configured-template fallback is a verified current-production and legacy
rollback behavior. It is not the target behavior of the enforced V2
CharacterPack path.

### 14.1 Enforced V2 CharacterPack target for PR 5

Every **new proactive message body** in the enforced V2 path is generated at
dispatch time from:

- the active code-owned CharacterPack prompt view
- the minimal active V2 profile
- bounded recent user and approved partner conversation
- accepted memory with validated provenance
- approved Partner World facts, if available for the proactive scope

Until accepted-memory provenance is integrated, the memory list is empty.
Existing retrievable legacy memory is not treated as accepted automatically.
System/error/delivery-marker rows do not enter recent-conversation prompt
context.

Eligibility metadata such as probability, sample, silence duration,
`decisionSlot`, queue state, request/event/message IDs, and raw last-message
timestamps is not prompt material. Eligibility remains local and
deterministic.

The enforced content flow is:

```text
new generated subject/body candidate
  -> common hard and semantic guard
  -> if repairable, at most one rewrite from original typed context
  -> guard again
  -> approved artifact, or no-send
```

`PROACTIVE_GENERIC` does not exist. `PROACTIVE_BODY_TEMPLATE` and another
fixed/configured message body are never used as a replacement when generation,
rewrite, or guard fails. If no approved artifact is produced:

- no delivery marker is appended or updated with new content
- no body or conversation row is stored
- no mail is sent
- proactive send count and `last_proactive_at` are unchanged
- the event ends with a managed no-send result
- `next_proactive_check_at` advances so a later scheduler run performs a fresh
  eligibility decision

The no-send result is not shown as a partner bubble.

## 15. Current production delivery idempotency and target retry rule

Before calling MailApp, the service claims a short-lived marker in
`conversation_logs` using the delivered-message key.

Marker behavior:

- `completed`: do not send again; reconcile state idempotently
- `accepted`: treat delivery as already in progress
- `failed` with saved text: reset the same marker to `accepted` and reuse its
  body
- no marker: append one `accepted` proactive marker before the external side
  effect

The script lock covers marker and state transitions. It is not held around the
MailApp call.

If delivery fails, the marker becomes `failed` and preserves its text. The
next queue retry reuses that saved body, preventing another Gemini call and
wording changes.

In the enforced V2 path, transport retry remains the same attempted utterance,
not a new proactive message. The saved generated subject/body must be rebound
to the current profile/policy/catalog/CharacterPack and revalidated immediately
before reuse. If it is no longer approved, it is quarantined and not sent. It
is not rewritten and is not replaced with fixed or template text.

After successful delivery:

- the marker becomes `completed`
- `last_proactive_at` advances without moving backward
- the daily proactive count advances idempotently
- `next_proactive_check_at` advances by the cooldown
- daily mail-recipient usage increments once

## 16. Web live polling

The server exposes:

```text
loadNewMessages(afterMessageId, limit)
```

`PublicApi` delegates to `WebController`, which returns messages after the
pivot message ID in chronological order. The Web client uses a background
polling timer separate from chat request-status polling.

Default behavior:

- poll every 60 seconds
- clamp the configured interval to 15 through 300 seconds
- pause while the document is hidden
- poll immediately when the document becomes visible
- fetch again after one second while another page is available
- deduplicate and update by `messageId`
- preserve scroll position unless the user is within 80 pixels of the bottom
- render proactive system markers with the configured partner presentation

Configuration:

```text
PROACTIVE_WEB_POLL_SECONDS
```

## 17. Configuration reference

### 17.1 Current production activation

| Key | Production value |
|---|---:|
| `PROACTIVE_POLICY_MODE` | `probability` |
| `PROACTIVE_AI_GENERATION_ENABLED` | `true` |
| `SILENCE_MINUTES` | `240` |

### 17.2 Current repository defaults and legacy-supported controls

| Key | Repository fallback | Type | Purpose |
|---|---:|---|---|
| `SILENCE_MINUTES` | `240` | int | Minimum silence before eligibility |
| `PROACTIVE_COOLDOWN_MINUTES` | `240` | int | Minimum time between deliveries |
| `PROACTIVE_MAX_PER_DAY` | `2` | int | Daily delivery cap |
| `QUIET_START` | `23:00` | time | Quiet-hours start |
| `QUIET_END` | `08:00` | time | Quiet-hours end |
| `PROACTIVE_RECHECK_MINUTES` | `60` | int | Decision-slot duration |
| `PROACTIVE_POLICY_MODE` | `threshold` | string | `threshold` or `probability` |
| `PROACTIVE_SILENCE_CEILING_MINUTES` | `720` | int | Silence duration at probability ceiling |
| `PROACTIVE_PROBABILITY_CURVE` | `1.3` | float | Probability curve exponent |
| `PROACTIVE_DAY_START` | `10:00` | time | Day period start |
| `PROACTIVE_EVENING_START` | `18:00` | time | Evening period start |
| `PROACTIVE_MORNING_WEIGHT` | `0.7` | float | Morning multiplier |
| `PROACTIVE_DAY_WEIGHT` | `1.0` | float | Day multiplier |
| `PROACTIVE_EVENING_WEIGHT` | `1.2` | float | Evening multiplier |
| `PROACTIVE_AI_GENERATION_ENABLED` | `false` | bool | Enable Gemini body generation |
| `PROACTIVE_MESSAGE_MIN_CHARS` | `20` | int | Minimum generated body length |
| `PROACTIVE_MESSAGE_MAX_CHARS` | `220` | int | Maximum generated body length |
| `PROACTIVE_WEB_POLL_SECONDS` | `60` | int | Web new-message polling interval |

Shared context configuration includes `PARTNER_NAME`, `USER_NAME`,
`SYSTEM_PERSONA`, `RECENT_MESSAGE_LIMIT`, and `MEMORY_CONTEXT_LIMIT`.
Template and style configuration includes `PROACTIVE_MESSAGE_STYLE`,
`PROACTIVE_SUBJECT_TEMPLATE`, and `PROACTIVE_BODY_TEMPLATE`.

Those persona/style/body-template keys describe the current production/legacy
path. The enforced V2 path reads partner voice and proactive guidance from the
code-owned CharacterPack. User settings provide the partner name, user address,
reply length, proactive frequency, and quiet-hour controls; they do not expose
a proactive prompt or body-template editor.

## 18. Production rollout evidence

The rollout used independent activation of eligibility policy and message
generation.

### Stage 0: new code, threshold policy, AI disabled

- Existing behavior and safe missing-config fallbacks were exercised.
- No scheduler or queue-worker failures, timeouts, terminal queue events,
  persistent stalls, or duplicate queue keys were found.

### Stage 1: probability enabled, AI disabled

Started 2026-07-15 20:17 JST.

```text
PROACTIVE_SEND: 2
DONE: 2
PROACTIVE_MESSAGE: 2
FAILED: 0
duplicate queue key: 0
duplicate request ID: 0
```

No frequency, interruption, or quiet-hour-delivery concern was observed.

### Stage 2: probability enabled, AI enabled

Started 2026-07-16 20:41 JST.

```text
PROACTIVE_SEND: 6
PROACTIVE_MESSAGE: 4
FAILED event: 0
stalled event: 0
duplicate queue key: 0
duplicate request ID: 0
```

Operator review accepted naturalness, persona and tone, context relevance,
repetition, reply pressure, and unsupported-assertion behavior.

Release evidence also recorded:

- Apps Script self-tests: 110 passed, 0 failed
- contract validation: 27 passed, 0 failed
- Apps Script syntax: passed
- Client JavaScript syntax: passed
- secret-pattern scan: passed

## 19. Monitoring

Normal monitoring checks:

- `schedulerJob` and `processQueueJob` complete naturally
- no terminal queue failures
- no events remain in `PROCESSING` or `RETRY_WAIT` beyond the expected window
- queue deduplication keys are unique
- proactive message request IDs are unique
- dispatch does not occur after newer user activity or during quiet hours
- delivery frequency remains acceptable
- generated text is natural, persona-consistent, non-pressuring, and factual
- supported Gemini failures use template fallback in the current
  production/legacy path

One transient script-lock acquisition failure occurred in
`QueueService.recoverStale()` during `processQueueJob` on
2026-07-19 07:16:22 JST. It produced no queue loss, duplicate delivery,
terminal event failure, or persistent stall and did not recur through
2026-07-20 14:39 JST. Recurrence should trigger a separate investigation into
job overlap, lock scope, trigger intervals, and safe-skip observability.

## 20. Rollback

AI-generation or message-quality incident:

```text
PROACTIVE_AI_GENERATION_ENABLED=false
```

Probability or delivery-frequency incident:

```text
PROACTIVE_POLICY_MODE=threshold
```

These configuration changes apply to later scheduler runs without a deployment
or trigger replacement. The two flags are independent: AI can be disabled
while probability remains active, or the policy can return to threshold while
the selected generation mode remains independently configurable.

After V2 activation, these flags still provide complete rollback to the
verified legacy path. They do not permit configured template text as fallback
inside the enforced V2 path.

For suspected queue loss, duplicate delivery, or data-integrity failure:

1. Stop the two time-driven triggers.
2. Preserve current configuration, queue rows, conversation markers, usage,
   and execution evidence.
3. Investigate before changing data or redeploying.

## 21. Source of truth

The implementation and tests below are the source of truth for the current
production/legacy path and its historical rollout evidence. The target
single-CharacterPack content, guard, no-fixed-fallback, UI-transparency, and
protected-sink rules are defined in
[Character Persona and Immersion Specification](CHARACTER_IMMERSION.md).

Implementation:

- [`../../src/application/ProactiveMessageService.gs`](../../src/application/ProactiveMessageService.gs)
- [`../../src/application/QueueService.gs`](../../src/application/QueueService.gs)
- [`../../src/jobs/SchedulerJob.gs`](../../src/jobs/SchedulerJob.gs)
- [`../../src/jobs/ProcessQueueJob.gs`](../../src/jobs/ProcessQueueJob.gs)
- [`../../src/common/Constants.gs`](../../src/common/Constants.gs)
- [`../../src/infrastructure/SheetRepository.gs`](../../src/infrastructure/SheetRepository.gs)
- [`../../src/PublicApi.gs`](../../src/PublicApi.gs)
- [`../../src/web/WebController.gs`](../../src/web/WebController.gs)
- [`../../src/web/Client.html`](../../src/web/Client.html)

Tests:

- [`../../src/tests/A6QueueSchedulerTests.gs`](../../src/tests/A6QueueSchedulerTests.gs)
- [`../../src/tests/A8ProactiveConversationTests.gs`](../../src/tests/A8ProactiveConversationTests.gs)
- [`../../src/tests/RunAllTests.gs`](../../src/tests/RunAllTests.gs)

Contracts and validation:

- [`../a1/04_DATA_AND_EVENT_CONTRACTS.md`](../a1/04_DATA_AND_EVENT_CONTRACTS.md)
- [`../a1/contracts/events/proactive-send-payload.schema.json`](../a1/contracts/events/proactive-send-payload.schema.json)
- [`../../tools/validate_contracts.py`](../../tools/validate_contracts.py)
- [`../../tools/a7_static_audit.py`](../../tools/a7_static_audit.py)

The machine-readable contract is authoritative for accepted payload shape. The
runtime implementation is authoritative for operational flow. Any future
disagreement between them must be resolved explicitly rather than hidden in
documentation.

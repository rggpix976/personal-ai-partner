# Proactive Conversations Specification

## 1. Status

This document defines the **current production/legacy behavior** of
probabilistic, AI-generated proactive conversations introduced by Issue #18
and released as Apps Script version 7. The PR 5 repository implementation adds
the approved CharacterPack path behind the existing `legacy` default. It is
specified separately in section 14.1 and is not yet deployed or activated.

Production configuration as of 2026-07-20:

```text
APP_ENV=prod
PROACTIVE_POLICY_MODE=probability
PROACTIVE_AI_GENERATION_ENABLED=true
SILENCE_MINUTES=240
```

The production rollout passed three stages: the new code with conservative
defaults, probability-only activation, and probability plus Gemini generation.
The only time-driven jobs are `processQueueJob` and `schedulerJob`.

PR 3 did not modify or connect this production path. PR 5 adds a dormant
`enforced` V2 proactive content path while preserving the verified `legacy`
path and its rollback controls. Historical behavior and rollout evidence below
remain factual; code/tests/docs in PR 5 do not migrate the sheet, change
production CONFIG, install triggers, or deploy the Web App.

### 1.1 Approved forward operating modes

Historical rollout evidence in this document does not define the current
rollback procedure. The approved operating modes for the staged CharacterPack
release are:

- automatic operation: `APP_ENV=prod`,
  `PROACTIVE_POLICY_MODE=probability`, approved production timing and time
  weights, and the two reviewed time-driven triggers
- accelerated human test: `APP_ENV=test`,
  `PROACTIVE_POLICY_MODE=probability`, every project trigger stopped, and only
  the exact-event operator `runProactiveReleaseTest()`
- proactive stop: the user setting `PROACTIVE_FREQUENCY=off`; also stop the
  time-driven triggers when investigating a delivery, queue, or data-integrity
  incident

`threshold` remains a runtime-compatible and historically tested mode, but it
is not approved for automatic operation, accelerated release testing, or
rollback. `installTriggers()` must reject it. Switching from probability to
threshold can increase sends after the silence floor, so it is not a safe
containment action.

## 2. Goals

The current feature allows the configured partner to initiate a natural
conversation while preserving the existing `PROACTIVE_SEND` event pipeline.

The implementation must:

- preserve quiet hours, `quiet_until`, user-activity, minimum-silence,
  cooldown, daily-cap, next-check, and mail-quota gates
- apply `off/low/normal/high` to concrete test and production silence floors
- keep accelerated timing manual-only and prevent test-to-production queue
  leakage
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
effect. This automatic flow is approved only for the production probability
profile.

The accelerated release-test flow is separate:

```text
runProactiveReleaseTest
  -> QueueService.enqueue(PROACTIVE_SEND)
  -> QueueService.claimEventById(the event created by this call)
  -> ProactiveMessageService.prepareDispatch()
  -> ProactiveMessageService.send()
```

Every project trigger must be stopped. The operator requires
`APP_ENV=test` and `PROACTIVE_POLICY_MODE=probability`; ordinary scheduler and
queue-worker entry points must not consume the accelerated profile.

## 5. Enqueue phase

`schedulerJob` calls `ProactiveMessageService.evaluateLocalConditions(now)`.
The service evaluates the enqueue hard gates, computes the target date and next
daily sequence, and derives the current decision slot. It first resolves
`APP_ENV`, `PROACTIVE_FREQUENCY`, and the policy mode. `off` exits before user
state or mail quota is read. `APP_ENV=test` exits from the ordinary scheduler
path and can be used only with probability mode by the trigger-free
release-test operator.

In threshold mode, a candidate that passes the hard gates is eligible. In
probability mode, the service computes one deterministic sample and compares it
with the configured probability. A miss is not enqueued.

A hit produces a `PROACTIVE_SEND` payload containing decision metadata. The
payload does not contain a subject or message body. `QueueService.enqueue()`
normalizes the payload and suppresses another active event with the same queue
deduplication key.

Probability, sample, decision slot, `requestedAt`, and a policy binding
(`environment`, `frequency`, and `mode`) are persisted in the queue event.
Later workers consume those values without recalculating them.

## 6. Dispatch phase

`processQueueJob` claims a queued event and calls
`ProactiveMessageService.prepareDispatch(payload, now)`.

`requestedAt` is the scheduler timestamp recorded when the enqueue decision was
made. Dispatch is cancelled with `USER_ACTIVITY_AFTER_ENQUEUE` when
`last_user_message_at` is later than `requestedAt`.

Dispatch does not reroll the threshold or probability decision. Before any
marker, generation, or mail access, it rejects `off`, an environment/frequency/
mode binding change, and a test profile used by the ordinary queue worker. It
then checks the current minimum-silence floor, target date, later user
activity, applicable hard gates, and the delivery marker. Only after those
checks pass does it reuse a saved body, call Gemini, or render the configured
template.

`MAIL_QUOTA_EXHAUSTED` is surfaced to the queue retry policy. Other ineligible
conditions complete the queue event as a safe skip without sending mail.

## 7. Hard gates

| Gate | Enqueue | Dispatch | Source |
|---|:---:|:---:|---|
| Quiet hours | yes | yes | `QUIET_START`, `QUIET_END` |
| Temporary quiet period | yes | yes | `user_state.quiet_until` |
| At least one user message | yes | yes | `user_state.last_user_message_at` |
| Minimum silence | yes | yes | `APP_ENV`, `PROACTIVE_FREQUENCY`, `SILENCE_MINUTES` |
| User activity after enqueue | n/a | yes | `requestedAt`, `last_user_message_at` |
| Proactive cooldown | yes | yes | `PROACTIVE_COOLDOWN_MINUTES` |
| Daily send cap | yes | yes | `PROACTIVE_MAX_PER_DAY` |
| Next eligible check | yes | no | `user_state.next_proactive_check_at` |
| Mail quota | yes | yes | `GmailNotifier.getRemainingQuota()` |
| Target-date expiry | n/a | yes | payload `targetDate` |
| Existing delivery marker | n/a | yes | `conversation_logs` |
| Frequency `off` | yes | yes | `PROACTIVE_FREQUENCY` |
| Policy binding unchanged | n/a | yes | payload `policyBinding` |
| Accelerated profile is manual-only | yes | yes | `APP_ENV=test` |

No proactive event is eligible before the first recorded user message.
Dispatch repeats minimum-silence using the current frequency so a newly
selected lower frequency cannot leak an earlier queued send. It also applies
the stricter check for user activity after `requestedAt`.

## 8. Threshold mode

```text
PROACTIVE_POLICY_MODE=threshold
```

After every enqueue hard gate passes, the candidate is eligible without a
probability sample affecting the result. The payload still carries the common
decision fields with `probability=1` and `sample=0` so the queue contract stays
uniform.

The repository default is `probability`. A missing or unrecognized mode is not
treated as threshold; evaluation returns a configuration failure.

Threshold mode is retained only for runtime compatibility, historical
evidence, and isolated automated tests. It is not an approved production or
release-test operating mode:

- `installTriggers()` rejects it
- the accelerated release-test operator rejects it
- operators must not switch to it during an incident

To stop proactive delivery, select `off`. For suspected queue, duplicate-send,
or data-integrity problems, stop both time-driven triggers as well. Threshold
mode is not a rollback because every otherwise eligible candidate is accepted
after the silence floor instead of being probability-gated.

## 9. Probability mode and formula

```text
PROACTIVE_POLICY_MODE=probability
```

Let:

- `elapsed` be minutes since the last user message
- `floor` be the environment/frequency silence floor
- `ceiling` be the environment/frequency probability ceiling
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
weights must be non-negative. Quiet hours remain a hard gate and the user may
change their start and end in the Web App settings. With the default
23:00–08:00 interval, the effective higher-probability evening window is
18:00–23:00; the 1.2 weight never permits a quiet-hours send. If the user
changes quiet hours, the current configured interval remains authoritative.

### 9.1 Frequency and environment timing

| Environment | Frequency | Probability starts | Probability reaches 1.0 at unit weight | Decision slot |
|---|---|---:|---:|---:|
| `test` | `low` | 60 min | 120 min | 5 min |
| `test` | `normal` | 15 min | 30 min | 5 min |
| `test` | `high` | 5 min | 10 min | 5 min |
| `prod` | `low` | 480 min (8 h) | 720 min (12 h) | 60 min |
| `prod` | `normal` | 240 min (4 h) | 720 min (12 h) | 60 min |
| `prod` | `high` | 120 min (2 h) | 720 min (12 h) | 60 min |

These start times are not guaranteed delivery times. Probability is exactly
zero at the boundary and rises after it. Cooldown, daily cap, quota, user
activity, and quiet hours always take precedence.

The accelerated `test` profile is available only in probability mode through
`runProactiveReleaseTest()` while every project trigger is stopped. The operator
processes only the exact event it creates in that execution. It uses code-owned
timing:

- `low`: floor 60 minutes, ceiling 120 minutes
- `normal`: floor 15 minutes, ceiling 30 minutes
- `high`: floor 5 minutes, ceiling 10 minutes
- every frequency: five-minute decision slots

Production uses:

- `low`: floor 480 minutes, ceiling 720 minutes
- `normal`: floor 240 minutes, ceiling 720 minutes
- `high`: floor 120 minutes, ceiling 720 minutes
- every frequency: sixty-minute decision slots

`installTriggers()` refuses to mutate trigger state unless `APP_ENV=prod`,
probability mode, production timing, and approved time weights are restored.

## 10. Deterministic sampling

The decision slot is calculated from Unix epoch milliseconds and the resolved
environment interval (five minutes in `test`, sixty minutes in `prod`):

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
| `policyBinding` | Exact enqueue environment, frequency, and policy mode |
| `reason` | Optional managed code: `deterministic_probability_hit` or `local_silence_threshold` |
| `characterRuntimeMode` | Required for every new event: `legacy` or `enforced` |
| `characterBinding` | Required only for `enforced`; exact six-field profile/policy/catalog/pack binding |

The exact binding fields are `profileSchemaVersion`, `profileRevision`,
`policyVersion`, `catalogVersion`, `characterPackId`, and
`characterPackVersion`. `legacy` payloads forbid `characterBinding`. The
machine contract rejects a new event without `characterRuntimeMode`; only
historical rows created before PR 5 may be interpreted by the runtime as
legacy. Enqueue fixes the mode/binding for the event lifetime, including queue
retries. A waiting event is never upgraded or downgraded between modes.

`subject` and `body` are forbidden in the queue payload in both modes. New
enforced content is generated at dispatch; a delivery retry recovers its exact
saved pair from the delivery marker, not from the event payload.

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
legacy proactive path. PR 5 connects the dormant PR 3 immersion core to the
repository's `enforced` path, where these boundaries are mechanically guarded,
as specified in
[Character Persona and Immersion Specification](CHARACTER_IMMERSION.md).
That code path is not yet deployed or activated in production.

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

### 14.1 Enforced V2 CharacterPack implementation contract (PR 5)

Every **new proactive subject/body pair** in the enforced V2 path is generated at
dispatch time from:

- the active code-owned CharacterPack prompt view
- the minimal active V2 profile
- bounded recent user and approved partner conversation
- an empty memory list until PR 7 connects provenance-accepted memory
- an empty Partner World fact list until a later provenance-reviewed integration

Existing retrievable legacy memory is not treated as accepted automatically.
System/error/delivery-marker rows, unapproved assistant rows, and legacy
partner rows do not enter recent-conversation prompt context.

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
- no subject/body pair or conversation row is stored
- no mail is sent
- proactive send count and `last_proactive_at` are unchanged
- the event ends as `DONE` with managed reason
  `NO_APPROVED_PROACTIVE_OUTPUT`
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

If delivery fails, `GmailNotifier` maps provider details to the generic,
retryable `MAIL_SEND_FAILED` contract. The marker becomes `failed` and
preserves its exact subject/body pair. The next queue retry revalidates that
saved pair without another generation or rewrite call.

In the enforced V2 path, the initial `accepted` marker stores the approved body
in `text`, the approved subject in the append-only `proactive_subject` column,
the originating queue event UUID in `proactive_origin_event_id`, and the
complete approval binding. These two internal tail columns follow the eight
approval columns in that exact order. Their schema version is `2026.07.a5`;
migration and activation are separate deployment steps.

Transport retry remains the same attempted utterance, not a new proactive
message. It recovers the exact saved `{subject,body}` pair, rebinds it to the
current profile/policy/catalog/CharacterPack, and asks the common guard to
approve it as `PROACTIVE_RETRY` / `legacy_revalidated`. Retry never calls
generation or rewrite, and neither member of the saved pair may change. A
marker with a missing subject, incomplete approval metadata, or a pair that no
longer passes approval is quarantined and not sent; it is not repaired,
rewritten, or replaced with fixed/template text.

A valid retry may set an origin UUID only when the historical marker has null,
or reuse the same saved UUID; it cannot transfer marker ownership to another
event. Its storage mutation is limited to attempt time, accepted status,
cleared error, current approval binding, and that origin UUID. Identity,
subject/body, model, and token columns cannot change.

A quarantined marker remains as immutable audit evidence. The dedicated lookup
always treats any completed marker for the message key as globally
authoritative, then returns the latest non-quarantine active marker regardless
of origin. Only when neither exists may an optional exact origin event UUID
retrieve its matching quarantine row for audit/reconciliation. A lookup
without that origin does not return quarantine. Because the send count did not
advance, a later fresh eligibility decision may use the same daily sequence
and append a new marker without mutating the quarantined row.

Partial or invalid approval metadata is tolerated only by this internal marker
reader: it clears the returned body/subject, returns no approval object, and
marks `invalidCharacterApproval=true`. Public and ordinary conversation DTOs
remain strict. Quarantine changes only controlled status/error/origin metadata;
the persisted subject/body and malformed approval cells remain audit evidence.

`accepted`, `failed`, and quarantined proactive markers are internal delivery
state and audit evidence. Conversation readers exclude them from the web UI,
memory extraction, and diary input. Only a `completed` proactive marker becomes
visible conversation content.

The worker rechecks its queue lease before enforced generation and immediately
before the protected marker/mail sink. A worker that is already stale at either
checkpoint cannot generate or acquire the delivery marker; mail follows only
after the protected marker claim succeeds.

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
| `APP_ENV` (Script Property) | `prod` |
| `PROACTIVE_POLICY_MODE` | `probability` |
| `PROACTIVE_AI_GENERATION_ENABLED` | `true` |
| `SILENCE_MINUTES` | `240` |
| `PROACTIVE_SILENCE_CEILING_MINUTES` | `720` |
| `PROACTIVE_RECHECK_MINUTES` | `60` |
| `PROACTIVE_DAY_START` | `10:00` |
| `PROACTIVE_EVENING_START` | `18:00` |
| `PROACTIVE_MORNING_WEIGHT` | `0.7` |
| `PROACTIVE_DAY_WEIGHT` | `1.0` |
| `PROACTIVE_EVENING_WEIGHT` | `1.2` |

### 17.2 Current repository defaults and legacy-supported controls

| Key | Repository fallback | Type | Purpose |
|---|---:|---|---|
| `SILENCE_MINUTES` | `240` | int | Minimum silence before eligibility |
| `PROACTIVE_COOLDOWN_MINUTES` | `240` | int | Minimum time between deliveries |
| `PROACTIVE_MAX_PER_DAY` | `2` | int | Daily delivery cap |
| `QUIET_START` | `23:00` | time | User-configurable quiet-hours start; hard gate |
| `QUIET_END` | `08:00` | time | User-configurable quiet-hours end; hard gate |
| `PROACTIVE_RECHECK_MINUTES` | `60` | int | Production decision-slot duration; test is fixed at 5 |
| `PROACTIVE_POLICY_MODE` | `probability` | string | Approved automatic and release-test mode. `threshold` is compatibility-only |
| `PROACTIVE_SILENCE_CEILING_MINUTES` | `720` | int | Production silence duration at probability ceiling |
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
a proactive prompt or body-template editor. PR 5 keeps runtime mode at
`legacy` by default; activating `enforced` requires the separately reviewed
schema migration and production rollout.

`APP_ENV` is the timing-profile selector. Production floors are derived from
`SILENCE_MINUTES=240`: low is 2x (480), normal is 1x (240), and high is 0.5x
(120). The accelerated test floors and ceilings are code-owned release-test
values and do not weaken cooldown, daily-cap, quota, or quiet-hour controls.

## 18. Production rollout evidence

The rollout used independent activation of eligibility policy and message
generation.

### Stage 0: new code, threshold policy, AI disabled

This is historical rollout evidence only. It is not the current automatic,
release-test, or rollback policy.

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

To stop new proactive decisions immediately, use the Web App setting
「自発的に話しかける頻度」→「話しかけない」. This persists:

```text
PROACTIVE_FREQUENCY=off
```

Dispatch rechecks the current frequency, so an already queued event is safely
skipped instead of being sent after `off`.

For a suspected duplicate-send, queue, or data-integrity incident:

1. Set the proactive frequency to `off`.
2. Stop both time-driven triggers.
3. Preserve configuration, queue rows, delivery markers, usage, and execution
   evidence.
4. Investigate before changing data or redeploying.

Do not set `PROACTIVE_POLICY_MODE=threshold` as rollback. It removes the
probability miss gate and can increase eligibility after the silence floor.
Automatic triggers cannot be installed until `APP_ENV=prod`, probability mode,
approved production timing, and approved weights are restored.

For a legacy-path AI-generation or message-quality incident,
`PROACTIVE_AI_GENERATION_ENABLED=false` disables Gemini body generation and
uses the configured legacy template. That flag does not stop eligibility or
mail by itself; combine it with `PROACTIVE_FREQUENCY=off` when delivery must
stop. The enforced CharacterPack path never substitutes a fixed/configured
template when generation or approval fails.

After V2 activation, rollback changes `CHARACTER_RUNTIME_MODE` back to
`legacy` while preserving the append-only a5 sheet columns. The existing
generation flag then retains its verified legacy meaning. It does not permit
configured template text as fallback inside an enforced event.

## 21. Source of truth

The implementation and tests below are the source of truth for both the current
production/legacy path and the repository's dormant PR 5 enforced path.
Historical rollout evidence applies only to legacy production. The
single-CharacterPack content, guard, no-fixed-fallback, UI-transparency, and
protected-sink rules are defined in
[Character Persona and Immersion Specification](CHARACTER_IMMERSION.md).

Implementation:

- [`../../src/application/ProactiveMessageService.gs`](../../src/application/ProactiveMessageService.gs)
- [`../../src/application/CharacterProactiveContextService.gs`](../../src/application/CharacterProactiveContextService.gs)
- [`../../src/application/QueueService.gs`](../../src/application/QueueService.gs)
- [`../../src/infrastructure/CharacterProactiveGeminiAdapter.gs`](../../src/infrastructure/CharacterProactiveGeminiAdapter.gs)
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
- [`../../src/tests/A12CharacterProactiveContextTests.gs`](../../src/tests/A12CharacterProactiveContextTests.gs)
- [`../../src/tests/A12CharacterProactiveGeminiAdapterTests.gs`](../../src/tests/A12CharacterProactiveGeminiAdapterTests.gs)
- [`../../src/tests/A10ImmersionCoordinatorTests.gs`](../../src/tests/A10ImmersionCoordinatorTests.gs)
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

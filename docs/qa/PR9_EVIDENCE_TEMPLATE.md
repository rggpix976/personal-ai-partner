# PR 9 sanitized release evidence

Copy this template for the live run. Store only the allowed aggregate evidence
defined in
[`PR9_STAGED_ACTIVATION.md`](../operations/PR9_STAGED_ACTIVATION.md).
Do not paste user content, names, prompts, IDs, URLs, email addresses, secrets,
or screenshots containing them.

## Candidate

| Field | Value |
|---|---|
| Full Git SHA | |
| PR number | |
| Apps Script version number | |
| Schema version | |
| CharacterPack version | |
| Policy/catalog versions | |
| Operator-confirmed time (JST, minute precision) | |

## Human approvals

| Gate | Approval | Time (JST) | Notes using controlled codes only |
|---|---|---|---|
| H0 reviewed candidate | `PASS / STOP` | | |
| H1 backup and freeze | `PASS / STOP` | | |
| H2 deploy and migration | `PASS / STOP` | | |
| H3 onboarding/settings | `PASS / STOP` | | |
| H4 chat/image/routing | `PASS / STOP` | | |
| H5 diary/memory | `PASS / STOP` | | |
| H6 proactive delivery | `PASS / STOP` | | |
| H7 scheduling/observation | `PASS / STOP` | | |
| Rollback rehearsal | `PASS / STOP` | | |

## Automated checks

| Check | Pass count | Failure count | Result |
|---|---:|---:|---|
| Apps Script self-tests | | | `PASS / STOP` |
| Contract validation | | | `PASS / STOP` |
| Static audit | | | `PASS / STOP` |
| Syntax/diff checks | | | `PASS / STOP` |

## Migration and configuration

| Check | Expected | Observed | Result |
|---|---|---|---|
| Migration actions | append/default only | | `PASS / STOP` |
| Existing content rows rewritten | `0` | | `PASS / STOP` |
| Duplicate controlled config keys | `0` | | `PASS / STOP` |
| V2 profile revision | positive integer (do not record value) | | `PASS / STOP` |
| Final configuration stage | `S4` | | `PASS / STOP` |

## Surface acceptance

Record only result and controlled failure category. Do not record the test
prompt or generated output.

| Criterion | Result | Controlled failure category |
|---|---|---|
| PI-010 identity fixed response | `PASS / STOP` | |
| PI-011 world/truth boundary | `PASS / STOP` | |
| PI-012 product route outside bubble | `PASS / STOP` | |
| PI-013 internal fixed response | `PASS / STOP` | |
| PI-014 capability fixed response | `PASS / STOP` | |
| PI-015 affection handling | `PASS / STOP` | |
| PI-030 chat sink protection | `PASS / STOP` | |
| PI-031 image sink protection | `PASS / STOP` | |
| PI-032 proactive protected send | `PASS / STOP` | |
| PI-036 proactive retry revalidation | `PASS / STOP` | |
| PI-033 diary protected sink | `PASS / STOP` | |
| PI-034 memory provenance/grounding | `PASS / STOP` | |
| PI-035 technical error UI | `PASS / STOP` | |
| PI-042 native Kansai/persona review | `PASS / STOP` | |
| PI-043 exact fixed copy | `PASS / STOP` | |
| PI-051 unsafe content absent from sinks/logs | `PASS / STOP` | |
| PI-056 legacy rows not promoted | `PASS / STOP` | |
| PI-060 dormant-before-activation proof | `PASS / STOP` | |
| PI-061 rollback proof | `PASS / STOP` | |

## Operational evidence

| Check | Expected | Observed | Result |
|---|---:|---:|---|
| `processQueueJob` trigger count | 1 | | `PASS / STOP` |
| `schedulerJob` trigger count | 1 | | `PASS / STOP` |
| Unexpected trigger count | 0 | | `PASS / STOP` |
| Unresolved recent `DEAD` count | 0 | | `PASS / STOP` |
| Stale `PROCESSING` count | 0 | | `PASS / STOP` |
| Unsafe persisted/sent metric | 0 | | `PASS / STOP` |
| Unauthorized sink-attempt metric | 0 | | `PASS / STOP` |
| Duplicate diary anchor count | 0 | | `PASS / STOP` |
| Duplicate proactive delivery count | 0 | | `PASS / STOP` |

## Backup and rollback

| Check | Result | Notes without resource identifiers |
|---|---|---|
| Current backup exists | `PASS / STOP` | |
| Isolated restore succeeds | `PASS / STOP` | |
| S4 → S0 rollback succeeds | `PASS / STOP` | |
| a7-compatible immutable code rollback identified | `PASS / STOP` | |
| Candidate restored after rehearsal | `PASS / STOP` | |

## Final decision

```text
Decision: RELEASE / ROLLBACK / HOLD
Reason code:
Decision time (JST, minute precision):
All prohibited-data checks: PASS / STOP
```

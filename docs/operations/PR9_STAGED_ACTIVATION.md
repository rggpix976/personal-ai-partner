# PR 9 staged activation runbook

## 1. Purpose and authority boundary

This runbook is the production-change gate for the single
`warm-kansai-caretaker.v1` CharacterPack. PRs 4–8 are already merged behind
legacy-safe defaults. PR 9 is not complete merely because code is deployed:
the schema migration, user settings, staged configuration changes, live
acceptance, monitoring, and rollback proof all require a human operator.

Do not begin a mutation step until the preceding gate is recorded as `PASS`.
On any `STOP` condition:

1. stop the current stage;
2. do not retry by editing queue rows, provenance, or content;
3. apply the rollback procedure in section 9 when production behavior changed;
4. record only the sanitized evidence allowed by section 10.

This runbook never authorizes displaying or copying message/diary content,
prompts, event/resource IDs, URLs, email addresses, API keys, tokens, or
deployment IDs into a PR, issue, chat response, or evidence file.

## 2. Fixed target and release invariants

The reviewed target is:

| Item | Required value |
|---|---|
| Git branch | `main` |
| Character profile schema | `character-profile.v2` |
| CharacterPack | `warm-kansai-caretaker / warm-kansai-caretaker.v1` |
| Policy/catalog | repository constants at the reviewed commit |
| Sheet schema | repository `APP_CONSTANTS.SCHEMA_VERSION` (`a7` for this rollout) |
| Web App execution | owner account |
| Web App access | intended owner/user only; never public |

Release invariants:

- one active CharacterPack; there is no user-selectable persona;
- only partner name, user address, reply length, proactive frequency, and
  quiet hours are editable;
- product/AI/configuration explanations stay outside partner bubbles;
- legacy messages, diaries, and memories are never promoted automatically;
- an unapproved artifact never reaches a content sink;
- `immersion_unsafe_persisted_or_sent_total` and
  `immersion_unapproved_sink_attempt_total` remain zero;
- exactly one `processQueueJob` trigger and one `schedulerJob` trigger exist
  after release;
- no production config, trigger, schema, or deployment mutation occurs before
  Gate H1.

## 3. Configuration stages

Edit only the `value` cell of the named `config` row. Never insert, delete,
reorder, rename, or change its `type` or `description`. Confirm that each key
appears exactly once before editing.

| Stage | Runtime | Profile | Diary | Memory | Proactive AI | User frequency |
|---|---|---|---|---|---|---|
| S0 baseline | `legacy` | `legacy` | `false` | `false` | `false` | current value |
| S1 configured/dormant | `legacy` | `v2` | `false` | `false` | `false` | `off` during rollout |
| S2 chat canary | `enforced` | `v2` | `false` | `false` | `false` | `off` |
| S3 diary + memory canary | `enforced` | `v2` | `true` | `true` | `false` | `off` |
| S4 proactive canary | `enforced` | `v2` | `true` | `true` | `true` | approved final value |

The exact config keys are:

```text
CHARACTER_RUNTIME_MODE
CHARACTER_PROFILE_MODE
DIARY_CHARACTER_ENFORCEMENT_ENABLED
MEMORY_CHARACTER_ENFORCEMENT_ENABLED
PROACTIVE_AI_GENERATION_ENABLED
```

Do not set `PROACTIVE_AI_GENERATION_ENABLED=true` while runtime mode is
`legacy`; that would enable the legacy AI/template fallback path before the
approved proactive CharacterPack path is active.

## 4. Gate H0 — local and GitHub preflight (read-only)

Human confirmation required: approve the exact `main` commit for production
preparation.

Checks:

1. `main` equals `origin/main`; worktree is clean.
2. The reviewed PR 9 base includes PRs 4–8.
3. Run:

   ```text
   node tools/run_apps_script_unit_tests.js
   python tools/validate_contracts.py
   python tools/a7_static_audit.py
   git diff --check
   ```

4. Confirm the repository still defaults to S0.
5. Confirm no secret, URL, ID, email address, or user content is present in
   the proposed evidence.

Pass:

- every local check reports zero failures;
- the candidate commit is immutable and recorded by full Git SHA;
- no unreviewed diff remains.

Stop:

- any failing check, dirty worktree, SHA mismatch, secret finding, or
  production-only value committed to Git.

## 5. Gate H1 — production baseline, backup, and freeze

Human confirmation required: approve the first external mutation only after
read-only baseline evidence is reviewed.

Read-only baseline:

1. Record the current immutable Apps Script version number and the rollback
   version number. Do not record deployment ID or URL.
2. Run `runOperationalHealthCheck()`.
3. Run `listProjectTriggers()` and record counts only.
4. Confirm no queue event is currently `PROCESSING`; let safe pending work
   finish before the freeze.
5. Confirm config is S0 and each controlled key appears exactly once.
6. Confirm the current spreadsheet and diary document have recoverable Drive
   copies. Create manual Drive copies if there is no current verified backup.
   Record only `PASS`, time, and copy count—not names, IDs, URLs, or owners.

Freeze:

1. Run `deleteProjectTriggers()`.
2. Run `listProjectTriggers()` again.
3. Confirm both required trigger counts are zero before pushing code.

Pass:

- baseline health has no unresolved stopped state;
- backup/restore source is verified;
- no active worker remains;
- required trigger counts are both zero.

Stop:

- missing backup, active `PROCESSING` work, unresolved `DEAD` event requiring
  review, duplicate/unexpected triggers, or non-S0 configuration.

Why the freeze is first: time-driven triggers execute the Apps Script project
HEAD, so pushing source before deleting triggers can run partially prepared
code even if the Web App deployment still points to an older version.

## 6. Gate H2 — deploy code and migrate schema, still dormant

Human confirmation required: approve the reviewed source push and append-only
schema migration.

1. Push the exact reviewed `src/` state to Apps Script.
2. Verify the remote project contains the reviewed commit's source state.
3. Run:

   ```text
   validatePreSetupProperties()
   migrateSchema()
   validatePostSetupProperties()
   runAllSelfTests()
   ```

4. Confirm migration reports only expected append-column/default-add actions.
5. Confirm schema version is `a7`.
6. Confirm these appended columns exist exactly once:

   - `daily_summaries.diary_payload_json`
   - `daily_summaries.diary_approval_json`
   - `daily_summaries.diary_origin_event_id`
   - `long_term_memories.memory_approval_json`
   - `long_term_memories.memory_origin_event_ids_json`

7. Confirm old rows were not rewritten or promoted.
8. Create a new immutable Apps Script version and point the existing owner-only
   Web App deployment to it.
9. Run `validatePostDeployProperties()`.
10. Confirm config remains S0 and triggers remain absent.

Pass:

- migration, post-setup validation, all Apps Script self-tests, and Web App
  validation pass;
- only trailing schema columns/default config rows were added;
- no content row or existing provenance was rewritten;
- production behavior remains legacy because S0 is unchanged.

Stop:

- header drift, a non-append migration, self-test failure, unexpected row
  mutation, Web App access broader than intended, or any trigger reappearing.

## 7. Gate H3 — onboarding and dormant settings

Human confirmation required: the user reviews and saves the real settings.

1. Open the owner-only Web App.
2. Confirm onboarding and About text appear outside conversation bubbles.
3. Confirm the settings form exposes only:

   - partner name;
   - user address;
   - reply length;
   - proactive frequency;
   - quiet start/end.

4. Set proactive frequency to `off` for rollout isolation.
5. Enter the user-approved partner name and remaining preferences, then save.
6. Refresh and confirm:

   - onboarding is complete;
   - the settings round-trip;
   - no free-form persona, prompt, first-person, dialect, fixed-response, or
     CharacterPack control exists;
   - a second stale browser tab receives a revision-conflict message rather
     than overwriting newer settings.

7. Change only `CHARACTER_PROFILE_MODE` from `legacy` to `v2`, producing S1.
8. Confirm `CHARACTER_RUNTIME_MODE` is still `legacy`.

Pass:

- V2 revision is positive;
- `CharacterProfileService.inspectRuntime()` remains `legacy` at S1;
- no partner output behavior changed yet.

Stop:

- invalid settings, missing CAS conflict, extra authority field, failed
  round-trip, or runtime leaving `legacy` early.

## 8. Gates H4–H7 — staged canaries

Keep time triggers deleted through all canaries. Run only the named manual
functions and inspect controlled state. Do not repair failures by editing queue
rows or provenance.

### H4 — chat, image, fixed copy, and product routing

Human confirmation required: change only the following key/value:

```text
CHARACTER_RUNTIME_MODE=enforced
```

This produces S2. Refresh the Web App and confirm settings status is active.

Run the minimum live matrix:

1. normal short text and normal multi-turn text;
2. one supported image and one rejected image type;
3. identity challenge;
4. body/address/meeting request;
5. internal-instruction request;
6. external-operation request;
7. explicit affection request;
8. product/AI-use question;
9. configuration/status question.

Pass:

- normal replies sound like the reviewed calm Kansai caretaker;
- fixed cases match the reviewed catalog after allowed name/address
  substitution and use zero generation;
- direct partner confessions such as `愛している` or `キスしたい` are absent;
- product/admin answers appear only in neutral status UI, with zero assistant
  row and zero character artifact;
- supported image reply and summary have approval; rejected input produces no
  Gemini call or temporary-file residue;
- no unsafe or unapproved content reaches a sink.

Stop:

- identity/world fabrication, AI self-explanation in partner speech, wrong
  dialect, direct forbidden confession, technical text in a bubble, duplicate
  assistant row, unsafe image persistence, or any guard/sink counter above
  zero.

### H5 — diary and memory

Human confirmation required: change:

```text
DIARY_CHARACTER_ENFORCEMENT_ENABLED=true
MEMORY_CHARACTER_ENFORCEMENT_ENABLED=true
```

This produces S3. Keep proactive frequency `off`. Perform this gate in a
window where a diary is legitimately due, or wait for that window; do not
lower operational gates merely to force a pass.

After enough approved conversation exists, run:

```text
schedulerJob()
processQueueJob()
```

Repeat `processQueueJob()` only while controlled queue status says work remains
claimable.

Pass for diary:

- latest target date reaches `DONE` with exactly one document anchor, or
  legitimately reaches terminal `NONE`;
- structured diary payload, complete approval, and origin UUID are present
  together;
- rerun creates no duplicate anchor or replacement narrative;
- Partner World continuity comes only from an approved `DONE` diary.

Pass for memory:

- non-empty candidates are grounded to accepted source messages;
- every accepted active row has complete current approval and non-empty UUID
  origin history;
- same-origin retry performs zero new generation/write;
- legacy or partial rows are not promoted and do not enter later context.

Stop:

- partial provenance, duplicate diary anchor, rewritten approved payload,
  legacy-row promotion, unsupported memory grounding, lost lease, stale
  binding, or any content sink before approval.

### H6 — proactive external-send canary

Human confirmation required: external email delivery is the last feature
enabled.

1. Set the final user-approved proactive frequency and quiet hours in the Web
   App.
2. Change only:

   ```text
   PROACTIVE_AI_GENERATION_ENABLED=true
   ```

3. Confirm S4.
4. Wait for a naturally eligible window outside quiet hours. Do not reduce
   silence, cooldown, daily-cap, or quota protections merely to force a send.
5. Run:

   ```text
   schedulerJob()
   processQueueJob()
   ```

Pass:

- exactly one eligible event/marker/send occurs;
- subject/body are newly generated and approved;
- send count and `last_proactive_at` advance once;
- a repeated scheduler/worker run does not duplicate delivery;
- ineligible quiet/cooldown/daily-cap cases remain suppressed;
- a no-approved-output case produces no content, marker, send, count, or
  `last_proactive_at` write.

Stop:

- template/fixed fallback on the enforced route, duplicate email, missing
  approval, stale retry send, pressure/conditional-affection copy, or any
  delivery side effect before approval.

### H7 — restore scheduling and observe

Human confirmation required: approve automated scheduling only after H4–H6
pass.

1. Run `installTriggers()` twice.
2. Run `listProjectTriggers()`.
3. Confirm exactly one `processQueueJob` and one `schedulerJob`, with no
   unexpected trigger.
4. Run `runOperationalHealthCheck()`.
5. Observe at least:

   - one normal queue-processing interval;
   - one scheduler interval;
   - one eligible diary cycle;
   - one natural proactive eligibility decision.

6. Re-run operational health after the observation window.

Pass:

- trigger counts remain exactly one each;
- no unresolved `DEAD`, stale `PROCESSING`, delayed queue, duplicate sink
  effect, or sanitized-health failure;
- unsafe/unauthorized sink metrics remain zero.

Release exit:

- every applicable `PI-*` criterion is recorded `PASS`;
- all H0–H7 human approvals are present;
- rollback rehearsal in section 9 passes;
- evidence contains no prohibited information.

## 9. Rollback and rollback rehearsal

### 9.1 Immediate configuration rollback

If a canary fails:

1. run `deleteProjectTriggers()` and verify required trigger counts are zero;
2. do not process any newly queued enforced event;
3. set:

   ```text
   PROACTIVE_AI_GENERATION_ENABLED=false
   DIARY_CHARACTER_ENFORCEMENT_ENABLED=false
   MEMORY_CHARACTER_ENFORCEMENT_ENABLED=false
   CHARACTER_RUNTIME_MODE=legacy
   CHARACTER_PROFILE_MODE=legacy
   ```

4. refresh the Web App and confirm legacy chat is restored;
5. run `runOperationalHealthCheck()` read-only;
6. assess pending/failed events through their dedicated assessment path.
   Never change event status, approval, provenance, or content cells manually.

Queued enforced work is not converted to legacy and must not be blindly
replayed after rollback.

### 9.2 Deployment rollback

Configuration rollback is primary. Redeploy code only if required.

- The safe code rollback target must be explicitly recorded as compatible with
  the a7 trailing columns.
- Do not deploy an unknown pre-a7 version against the migrated spreadsheet.
- Point the Web App only to a recorded immutable version; never record its
  deployment ID or URL in public evidence.
- Keep triggers disabled until post-rollback validation passes.

### 9.3 Rehearsal

Before final release acceptance:

1. use isolated copies of the spreadsheet and diary document;
2. verify S4 → S0 configuration rollback;
3. verify the Web App returns to legacy behavior;
4. verify restore from backup into isolated resources;
5. verify no production resource was overwritten;
6. reinstall exactly one trigger of each required type only after restoring
   the approved S4 candidate.

## 10. Evidence rules

Use [`PR9_EVIDENCE_TEMPLATE.md`](../qa/PR9_EVIDENCE_TEMPLATE.md).

Allowed:

- full Git commit SHA;
- pull request number;
- Apps Script version number;
- schema/policy/catalog/CharacterPack version strings;
- timestamps rounded to the minute;
- aggregate pass/fail counts;
- controlled status/error/reason codes;
- trigger counts by handler;
- config key names and reviewed enum/boolean state;
- confirmation that backup/rollback succeeded.

Forbidden:

- partner/user names;
- message, diary, memory, image, email subject, or email body content;
- prompts, model responses, or fixed-copy test inputs;
- event, request, message, file, document, spreadsheet, trigger, deployment,
  or other resource IDs;
- URLs or email addresses;
- secrets, tokens, cookies, API keys, or authorization data;
- screenshots containing any forbidden item.

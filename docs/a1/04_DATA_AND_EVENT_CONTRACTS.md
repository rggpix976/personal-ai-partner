# 4. データ・イベント契約

## 4.1 ID

- `message_id`: UUID v4
- `request_id`: ブラウザ生成UUID v4
- `event_id`: UUID v4
- `memory_id`: UUID v4
- `correlation_id`: `requestId` またはjob実行UUID

## 4.2 時刻

- JSON: ISO 8601、`+09:00`
- Sheets: Date型
- 比較基準: `Asia/Tokyo`
- 文字列の日付比較は禁止

## 4.3 Event

正式な `eventType`:

```text
CHAT_REPLY
MEMORY_EXTRACT
DIARY_GENERATE
PROACTIVE_SEND
WEEKLY_BACKUP
```

共通構造は [`contracts/event.schema.json`](contracts/event.schema.json) を正とする。

```javascript
{
  eventId: string,
  eventType:
    | "CHAT_REPLY"
    | "MEMORY_EXTRACT"
    | "DIARY_GENERATE"
    | "PROACTIVE_SEND"
    | "WEEKLY_BACKUP",
  dedupeKey: string,
  payload: object,
  status: "PENDING" | "PROCESSING" | "RETRY_WAIT" | "DONE" | "DEAD",
  attemptCount: number,
  nextAttemptAt: string | null,
  lockedAt: string | null,
  lockedBy: string | null,
  createdAt: string,
  updatedAt: string,
  completedAt: string | null,
  lastError: {
    code: string,
    message: string
  } | null
}
```

## 4.4 eventType別payload

| eventType | Schema |
|---|---|
| `CHAT_REPLY` | [`events/chat-reply-payload.schema.json`](contracts/events/chat-reply-payload.schema.json) |
| `MEMORY_EXTRACT` | [`events/memory-extract-payload.schema.json`](contracts/events/memory-extract-payload.schema.json) |
| `DIARY_GENERATE` | [`events/diary-generate-payload.schema.json`](contracts/events/diary-generate-payload.schema.json) |
| `PROACTIVE_SEND` | [`events/proactive-send-payload.schema.json`](contracts/events/proactive-send-payload.schema.json) |
| `WEEKLY_BACKUP` | [`events/weekly-backup-payload.schema.json`](contracts/events/weekly-backup-payload.schema.json) |

`event.schema.json` は `eventType` と対応payloadの組合せを `oneOf` で検証する。別のeventType用payloadを流用してはならない。

PR 4以降の `CHAT_REPLY` は新規起票時に
`characterRuntimeMode:"legacy"|"enforced"` を保存する。`enforced` は
`profileSchemaVersion`、`profileRevision`、`policyVersion`、
`catalogVersion`、`characterPackId`、`characterPackVersion` のexact
`characterBinding` を必須とする。待機中にactive bindingと一致しなくなった
イベントはlegacyへfallbackせずfail closedする。PR 4以前のmode未保存イベントは
historical legacyとしてだけ処理する。

`PRODUCT_INFO` / `ADMIN_OOC` の完了時は本文をpayloadへ保存せず、
`completionRoute` の管理コードだけを保存する。手動再試行は元イベントのruntime
modeとbindingを新イベントへそのまま引き継ぎ、異なるruntimeへ変換しない。

PR 5以降の新規 `PROACTIVE_SEND` も
`characterRuntimeMode:"legacy"|"enforced"` を必須とする。`enforced` は
`profileSchemaVersion`、`profileRevision`、`policyVersion`、
`catalogVersion`、`characterPackId`、`characterPackVersion` のexact
`characterBinding` を必須とし、`legacy` は `characterBinding` を禁止する。新規
machine payloadではmode欠落を拒否し、PR 5以前のmode未保存eventだけをruntimeの
historical legacy compatibilityとして処理する。enqueue後はmode/bindingを維持し、
retry時を含めてlegacyとenforcedを相互変換しない。queue payloadの
`subject` / `body` はmodeにかかわらず禁止する。

## 4.5 `dedupe_key`

```text
CHAT_REPLY:{requestId}
CHAT_REPLY_MANUAL:{requestId}:{manualRequestId}
MEMORY_EXTRACT:{firstMessageId}:{lastMessageId}
DIARY_GENERATE:{yyyy-MM-dd}
DIARY_GENERATE_REPAIR:{yyyy-MM-dd}:{manualRequestId}
PROACTIVE_SEND:{yyyy-MM-dd}:{sequence}:{decisionSlot}
WEEKLY_BACKUP:{yyyy-MM-dd}
```

For `PROACTIVE_SEND`, the deterministic probability decision is made only
when the scheduler enqueues the event. Queue retries reuse the persisted
`probability`, `sample`, `decisionSlot`, and `requestedAt`; dispatch never
reruns or rerolls the probability decision.

Dispatch performs only hard safety checks: quiet hours, `quiet_until`,
cooldown, daily cap, mail quota, target-date expiry, and whether the user
spoke after `requestedAt`. The queue event is deduplicated by
`PROACTIVE_SEND:{targetDate}:{sequence}:{decisionSlot}`, while actual
conversation delivery is deduplicated separately by
`PROACTIVE_MESSAGE:{targetDate}:{sequence}`.

現行productionとPR 5の `legacy` 経路は生成失敗時の設定template fallbackを持つ。
PR 5の `enforced` V2経路では、queue payloadへsubject/bodyを保存せず、dispatch時に
CharacterPackと承認可能なcontextから新しいsubject/bodyを生成する。guardと最大1回
rewrite後も承認artifactを得られない場合は、managed reason
`NO_APPROVED_PROACTIVE_OUTPUT` でeventを `DONE` にする。このときdelivery marker、
subject/body、conversation row、mail、送信回数、`last_proactive_at`を更新せず、
`next_proactive_check_at` だけを進め、次回の新しいeligibility評価を待つ。
`PROACTIVE_GENERIC` または設定template本文へのfallbackは禁止する。

enforced delivery失敗後のqueue retryは、markerに保存したexact subject/bodyだけを
再利用する。`PROACTIVE_RETRY` / `legacy_revalidated` としてcurrent bindingへ
再bind・再承認し、generate/rewriteを呼ばない。保存済みsubject、完全なapproval
metadataのいずれかがない、または再承認できないmarkerはquarantineし、本文を
rewrite・置換・送信しない。

Web clients fetch newly appended conversation messages with
`loadNewMessages(afterMessageId, limit)`. Clients deduplicate by `messageId`,
pause polling while the page is hidden, and resume immediately when it
becomes visible.

`DEAD` の手動再試行は既存行を変更せず、新しいイベントとして作成する。
`CHAT_REPLY` は `CHAT_REPLY_MANUAL`、`DIARY_GENERATE` は
`DIARY_GENERATE_REPAIR` を使い、既存 `dedupe_key` を再利用しない。同じ
`manualRequestId` は同じ手動再試行イベントを返し、新しい行を追加しない。
日記修復では `originalEventId` と `manualRequestId` をpayloadへ保存し、同じ
`diaryDate` のactiveイベントをdedupe keyの違いにかかわらず1件に制限する。

## 4.6 イベント状態遷移

許可する遷移は次だけである。

```text
PENDING -> PROCESSING
PROCESSING -> DONE | RETRY_WAIT | DEAD
RETRY_WAIT -> PROCESSING
PROCESSING(stale) -> RETRY_WAIT
```

新規claimの `lockedBy` はworker名ではなく、claim単位のopaque
`queue-lease:v1:{uuid-v4}` tokenである。`PROCESSING -> DONE | RETRY_WAIT | DEAD`
ではworkerが保持するleaseと保存行の現在値を完全一致させる。不一致は
`QUEUE_LOCK_BUSY` / `QUEUE_LEASE_MISMATCH` とし、状態、attempt、payload、
完了時刻を変更しない。stale回収または再claimでleaseが変わった後の旧workerは
結果を書き戻せない。旧形式 `lockedBy` を持つ既存 `PROCESSING` 行だけは
移行互換として従来の遷移を許可する。

`CHAT_REPLY` ではこのfenceを終端遷移だけでなくconversation sinkにも適用する。
assistant行または画像summaryの保存直前に同じevent statusとleaseをscript lock内で
再検証し、leaseを失ったworkerはconversationを一切変更しない。

`lastError.message` は保存前に秘密除去を行う。providerのtransport例外にrequest URLが
含まれていても、API key、token、Authorization値をevent行へ残さない。

禁止事項:

- `PENDING -> DONE` へ直接遷移しない。
- `DONE` は終端状態であり、他状態へ戻さない。
- `DEAD` は終端状態であり、`PROCESSING` へ戻さない。
- `DEAD` の手動再試行は既存行を更新せず、新規イベントとして再起票する。
- 汎用復旧操作は `DEAD` を自動再起票しない。`PROACTIVE_SEND` は再送せず、新しい適格性評価を待つ。
- stale回収は `attemptCount` を成功扱いにせず、ロック情報をクリアして `RETRY_WAIT` にする。

## 4.7 日記ライフサイクル

`daily_summaries.diary_status` は次の意味で使用する。

| Status | Meaning | Automatic scheduler action |
|---|---|---|
| `NONE` | 対象日に会話がなく、Partner Worldも選択されず、日記作成が不要と確定した | 再起票しない |
| `PENDING` | activeイベントまたはretryが存在する | 重複起票しない |
| `DONE` | 対象日のGoogle Docsアンカーが正確に1件存在する | 再起票しない |
| `FAILED` | キューが終端失敗した | 自動再起票せず、日記専用修復のみ許可する |

`DONE`なのにアンカーが0件、またはアンカーが複数件ある状態は不整合として
自動修復を停止する。日記専用修復は`assessDeadDiaryGeneration(eventId)`で
評価してから`repairDeadDiaryGeneration(eventId, manualRequestId)`で新規イベントを
作成する。元の`DEAD`行は監査履歴として不変のまま残す。
旧実装でイベントだけが`DONE`になり、日記状態が終端化しなかった場合は、
`repairDiaryGenerationBacklog()`が対象日を`DONE`または`NONE`へ整合してから
未解決`DEAD`を再起票する。戻り値は集計値だけとし、IDや本文を含めない。

新規`DIARY_GENERATE` payloadは`characterRuntimeMode`を必須とする。
`enforced`は起票時点の`characterBinding`も必須とし、`legacy`ではbindingを禁止する。
既存のmodeなしイベントはruntime互換のため`legacy`として読む。手動修復イベントは
元イベントのmode/bindingを維持する。

enforced日記は現在の`PROCESSING` leaseを持つworkerだけが処理する。承認後、Docsへの
書き込みより先に次の3列を同時に保存し、以後は不変とする。

```text
diary_payload_json
diary_approval_json
diary_origin_event_id
```

途中失敗の再試行では保存済みpayloadそのものを現行policy/profile/catalog/packで
再検証し、別本文を生成しない。3列の部分欠落、起票event不一致、payload変更、
lease喪失はcontent sink前にfail closedする。旧日記行を承認済み行へ自動昇格しない。
Partner World継続情報は`DONE`かつ完全で現行の`DIARY`承認証跡を持つ行だけから読む。

## 4.8 再試行

共通一時障害:

| 失敗回数 | 待機 |
|---:|---|
| 1 | 1分 |
| 2 | 5分 |
| 3 | 30分 |
| 4 | 2時間 |
| 5 | `DEAD` |

`MAIL_QUOTA_EXHAUSTED` はこの共通短時間リトライを使用しない。専用規則は [`05_ERROR_CONTRACT.md`](05_ERROR_CONTRACT.md) を参照する。

## 4.9 `conversation_logs` の一意性

`request_id` 単独を一意キーにしてはならない。

```text
UNIQUE(request_id, role)
```

- user行: 同一 `request_id` につき最大1件
- assistant行: 同一 `request_id` につき最大1件
- `role=system` のproactive/error行はこのuser/assistant複合一意の対象外

Apps Script/SheetsにはDB制約がないため、Repositoryが書込み前に検査し、重複時は既存行を返す。
proactive deliveryは専用marker lookupで `request_id=messageDedupeKey` を解決し、
同じkeyの `completed` markerを全eventに対して最優先する。completedがなければ
non-quarantineの最新active markerをoriginにかかわらず返し、同じdedupe keyへ
並行markerを作らない。activeが1件もない場合だけ、呼出元がoptional
`originEventId` を指定したときに、そのUUIDと一致するquarantine行を監査用に返す。
origin指定なしではquarantine行を返さない。後日の新しいeligibility eventは、
quarantine行を変更せず同じsequenceの新markerを追加できるが、同じ
messageDedupeKeyで `completed` deliveryを2件作ってはならない。

PR 4以降の承認済みcharacter出力は `conversation_logs` の末尾へ追加した次の列で
監査bindingを保存する。

```text
approval_surface
approval_source
approval_policy_version
approval_profile_schema_version
approval_profile_revision
approval_catalog_version
approval_character_pack_id
approval_character_pack_version
proactive_subject
proactive_origin_event_id
```

先頭8列のapproval blockは全て空、または全て正規な値のどちらかだけを許可する。
その直後へ `proactive_subject`、`proactive_origin_event_id` の順で追加する。
前者はenforced proactive markerの承認済みsubject、後者はmarkerを起票または
quarantineしたqueue eventのUUID v4を保存する。本文は従来どおり `text` に保存し、
subject/bodyのexact pairとevent ownershipをtransport retryで復元できるようにする。

| Row class | approval block | `proactive_subject` | `proactive_origin_event_id` |
|---|---|---|---|
| legacy row、通常user row、error row、non-character system row | 全て空 | 空 | 空 |
| approved chat assistant / approved image summary user row | 全て正規 | 空 | 空 |
| historical / legacy proactive marker | 全て空 | 空。読み取り互換だけを保証し、enforcedへ自動昇格しない | 空を許可 |
| new enforced proactive marker | 全て正規。`approval_surface=PROACTIVE_AI`、sourceは `generated` または `rewrite` | 承認済みsubjectと完全一致 | 起票eventのUUID v4 |
| enforced transport retry marker | current bindingへ再承認した全て正規の値。`approval_surface=PROACTIVE_RETRY`、`approval_source=legacy_revalidated` | 元のsubjectと完全一致し、`text` とともに変更禁止 | 保存済みUUIDと同一。historical nullだけは現在event UUIDを1回設定可能 |
| quarantined proactive marker | 保存済みblockを監査証跡として変更しない | 保存済み値を変更しない | quarantineを実行したevent UUID。別の非null UUIDへownershipを移さない |

画像会話では承認された `image_summary` のuser行とassistant行の両方へ同じbindingを
保存する。enforced proactive markerはmail前にsubject、body、approval blockの
全てが揃っていなければならない。approval blockがpartialまたは不正なmarkerは、
専用internal DTOだけが本文を空、subjectをnull、`characterApproval=null`、
`invalidCharacterApproval=true` として安全に読み、通常MessageDtoは従来どおり
storage corruptionで停止する。破損markerは専用Repository操作でcontent/approvalを
変更せず、`status=failed`、`error=PROACTIVE_RETRY_QUARANTINED`、current origin
event UUIDだけを保存して送信しない。
同一 `(request_id, role)` のdedupeで既存approval metadataが異なる場合は、
既存行を静かに採用せずstorage corruptionとして停止する。

## 4.10 スキーマ変更

- 列削除、列順変更は禁止。
- 追加列は末尾へ追加する。
- 変更時は `SCHEMA_VERSION` を上げる。
- `migrateSchema()` を用意する。
- 破壊的変更前にバックアップを作る。

PR 4のapproval 8列は `SCHEMA_VERSION=2026.07.a3` で追加した。PR 5は
その直後へ `proactive_subject`、`proactive_origin_event_id` の順で追加し、
`SCHEMA_VERSION=2026.07.a5` とする。
`migrateSchema()` で不足列を上記順に末尾へappendし、a5を確認してからenforced
proactive runtimeを有効化する。このPRのcode/tests/docs変更だけではmigration、
CONFIG変更、deploy、trigger変更を実行しない。

rollbackは追加列を保持したまま `CHARACTER_RUNTIME_MODE=legacy` へ戻すか、
a5の未知末尾列を保持できる互換rollback buildを使う。未修正のpre-PR 5 buildをa5
sheetへ直接deployしてはならず、sheetがa5の間はversion propertyもa5のまま維持する。

## 4.11 `CharacterProfileV2` / `CharacterPack`

Active profileの構造契約は
[`contracts/character-profile-v2.schema.json`](contracts/character-profile-v2.schema.json)
の `character-profile.v2` であり、exact shapeは次とする。

```javascript
{
  schemaVersion: "character-profile.v2",
  identity: {
    partnerName: string,
    userAddress: string
  },
  preferences: {
    replyLength: "short" | "balanced" | "long"
  }
}
```

runtime validatorはtrim後のNFC保存、Unicode code point長、UTF-8上限、control文字、
prompt境界、URL、メールアドレス、秘密値、運用識別子、危険なobject keyを検査する。
利用者profileはfirst person、方言、personality、canon、fixed response、raw promptを
持たない。

保存先は `CHARACTER_PROFILE_V2`、system-managed revisionは
`CHARACTER_PROFILE_V2_REVISION` とする。profileとrevisionは同一のlock/CAS/単一範囲
writeで更新し、profile JSON内へrevisionを入れない。profile modeは `v2` とする。

既存の `character-profile.v1`、`CHARACTER_PROFILE_V1`、旧revisionは休眠互換として
残すが、V2へ自動変換、fallback、部分mergeしない。`SYSTEM_PERSONA`、speech preset、
warmth、flavor、example lineもV2へコピーしない。

Active CharacterPackはcode-ownedなexact `character-pack.v1` objectであり、次の
metadataを持つ。

```text
packId = warm-kansai-caretaker
packVersion = warm-kansai-caretaker.v1
firstPerson = 俺
```

packはgeneration rules、`CHARACTER_CANON` entries、fixed responsesを所有する。
profile JSONやCONFIG rowからpack内容を上書きできない。pack prompt viewは
fixed responsesを含まず、`allowedScopes` をcontext構築前に適用する。memory
prompt viewは `canon=[]` であり、memory生成器やsemantic verifierへ
`CHARACTER_CANON` を渡さない。

これらは既存config sheetへの後方互換な休眠key追加であり、sheet列契約は変更
しない。platform `SCHEMA_VERSION` は既存production compatibilityのため
`2026.07.a2` のまま維持し、profile/pack自身を独立してversion管理する。PR 3では
`migrateSchema()`、production CONFIG、trigger、deploymentを変更しない。

## 4.12 没入保護の内部契約

PR 3の休眠coreは次を正とする。

- [`contracts/immersion-semantic-verdict.schema.json`](contracts/immersion-semantic-verdict.schema.json)
- [`contracts/immersion-guard-decision.schema.json`](contracts/immersion-guard-decision.schema.json)
- [`contracts/approved-character-artifact.schema.json`](contracts/approved-character-artifact.schema.json)

semantic verifierは `verdict`、管理された `category`、typed context内を参照する
`evidenceKeys` だけを返す。自由記述の理由、候補本文、prompt、provider errorを返さない。
fact境界をallowする場合は、active context内に存在する非空のevidence keyを必要とする。
1 payloadで異なる `claimType` を同時に検出した場合、単一domainのevidenceで別claimを
承認しないようlocal policyがfail closedにしてrewrite対象とする。
timeout、malformed、未知または矛盾するevidenceはallowではなく
`GUARD_UNAVAILABLE`として扱う。

evidence keyはuntrusted context内の `evidenceKey` / `evidenceKeys` fieldを信用せず、
許可されたcontext pathからruntimeが決定論的にmintする。対象domainは
`CHARACTER_CANON`、`CURRENT_REQUEST`、`RECENT_MESSAGE`、`MEMORY`、
`USER_FACT`、`SHARED_FACT`、
`REAL_WORLD_OBSERVATION`、`RELATIONSHIP_STATE`、`PARTNER_WORLD`だけで、固定順・
最大50件のfrozen `{key, domain, value}` viewとしてsemantic verifierへ渡す。
`CHARACTER_CANON`はactive packからだけmintし、利用者入力やmemoryから作成しない。

guard decisionの公開shapeは本文を持たない。`ALLOW` decisionとpayloadの対応は
同一invocation内のprocess-local capabilityとして評価時classified contextのobject
identityへbindして保持し、JSON round-tripしたlookalikeや同versionの別turn/modeから
承認artifactを作成できない。承認artifactは次のmetadataを必須とする。

```javascript
{
  payload,
  surface,
  source,
  policyVersion,
  profileSchemaVersion,
  profileRevision,
  catalogVersion,
  characterPackId,
  characterPackVersion
}
```

artifactはfactory発行、surface/payload対応、active policy/profile/catalog revisionと
CharacterPack bindingをsink直前に再検証する。raw、wrong-surface、missing-version、
stale、偽造artifactではunderlying sinkを呼ばない。PR 3はこの境界をspyで証明し、
PR 4はchatのRepository/Web、PR 5はenforced proactiveのmarker/mail、PR 6は
enforced diaryのDocs/summaryへ接続する。memory upsertはまだ接続しない。

DIARYとMEMORYのpayloadはPR 3ではtop-level shape、JSON-safe境界、件数・文字数上限
だけを固定した。PR 6のDIARY生成・保存経路は3配列を最大50件の非空plain string
（各1000文字以下）へ限定し、Partner World provenanceを上記3列で保存する。
memory candidate単位の詳細契約はPR 7でsurface接続と同時に追加する。
共通machine-readable schemaはnested string、
array、object key数、最大64文字の固定構造キーexact allowlistを表し、未知キーは表記を問わず拒否する。runtimeは加えて最大depth 12・
最大node数2000を検証する（再帰全体のnode budgetはJSON Schema外のruntime契約）。
暫定allowlistはURL、callback、secret、generic internal ID keyを含めない。provenance用の
`existingMemoryId`、`sourceMessageIds`、`source_message_ids` だけは例外としてUUID v4を
必須とする。これらはMEMORY payload内だけで許可し、canonical lowercaseと配列内uniqueを
runtime/schema双方で検証する。他field・surfaceのUUID-like textは拒否する。

Proactive approved payloadは `{subject, body}` のまま維持するが、fixed proactive
catalog payloadは存在しない。新規本文のsourceは `generated` または `rewrite` に
限る。承認後はbodyをmarkerの `text`、subjectを `proactive_subject`、起票event UUIDを
`proactive_origin_event_id` にexact保存する。
配送失敗後の同一pairを再利用する場合は、現行pack/profile/policy/catalogへ直前に
再bindし、`PROACTIVE_RETRY` / `legacy_revalidated` の組み合わせでguardを再実行する。
`legacy_revalidated` は他surfaceで禁止し、`PROACTIVE_RETRY` では
`generated` / `rewrite` / `canonical` / `fallback` を禁止する。subjectまたは
approval metadataが欠落するmarkerと、再承認できない保存済みpairは隔離し、
generate、rewrite、fixed/template replacementを行わず送信しない。
failed markerの再bind mutationは `createdAt`、`status`、`error`、
`characterApproval`、`proactiveOriginEventId` だけを許可し、`status=accepted`、
`error=null`、current/same origin UUIDを必須とする。identity、content、model、
tokenその他の列を同時に変更してはならない。

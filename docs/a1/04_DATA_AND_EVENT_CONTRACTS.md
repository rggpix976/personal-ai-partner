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

現行productionは生成失敗時の設定template fallbackを持つ。PR 3はこの経路を変更
しない。PR 5のenforced V2経路では、queue payloadへ本文を保存せず、dispatch時に
CharacterPackと承認済みcontextから新しい本文を生成する。guardと最大1回rewrite後も
承認artifactを得られない場合は、delivery marker、本文、conversation row、
送信回数、`last_proactive_at`を更新せずeventを安全に終了し、次回の新しい
eligibility評価を待つ。`PROACTIVE_GENERIC` または設定template本文へのfallbackは
禁止する。

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
- `request_id` が `null` のproactive/system行は複合一意の対象外

Apps Script/SheetsにはDB制約がないため、Repositoryが書込み前に検査し、重複時は既存行を返す。

## 4.10 スキーマ変更

- 列削除、列順変更は禁止。
- 追加列は末尾へ追加する。
- 変更時は `SCHEMA_VERSION` を上げる。
- `migrateSchema()` を用意する。
- 破壊的変更前にバックアップを作る。

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
CharacterPack bindingを
sink直前に再検証する。raw、wrong-surface、missing-version、stale、偽造artifactでは
underlying sinkを呼ばない。PR 3ではこの境界をspyで証明するだけで、既存Repository、
Web response、mail、Docs、memory upsertへ接続しない。永続approval metadataの列設計は
surface接続PRで追加するため、platform `SCHEMA_VERSION` と既存sheet列は変更しない。

DIARYとMEMORYのpayloadはPR 3ではtop-level shape、JSON-safe境界、件数・文字数上限
だけを固定する。Partner World provenanceとmemory candidate単位の詳細契約は、それぞれ
PR 6とPR 7でsurface接続と同時に追加する。machine-readable schemaはnested string、
array、object key数、最大64文字の固定構造キーexact allowlistを表し、未知キーは表記を問わず拒否する。runtimeは加えて最大depth 12・
最大node数2000を検証する（再帰全体のnode budgetはJSON Schema外のruntime契約）。
暫定allowlistはURL、callback、secret、generic internal ID keyを含めない。provenance用の
`existingMemoryId`、`sourceMessageIds`、`source_message_ids` だけは例外としてUUID v4を
必須とする。これらはMEMORY payload内だけで許可し、canonical lowercaseと配列内uniqueを
runtime/schema双方で検証する。他field・surfaceのUUID-like textは拒否する。

Proactive approved payloadは `{subject, body}` のまま維持するが、fixed proactive
catalog payloadは存在しない。新規本文のsourceは `generated` または `rewrite` に
限る。配送失敗後の同一文面を再利用する場合は、現行pack/profile/policy/catalogへ
直前に再bindし、`PROACTIVE_RETRY` / `legacy_revalidated` の組み合わせでguardを
再実行する。`legacy_revalidated` は他surfaceで禁止し、`PROACTIVE_RETRY` では
`generated` / `rewrite` / `canonical` / `fallback` を禁止する。再承認できない
保存済み本文は隔離し、rewriteやfixed/template replacementを行わず送信しない。

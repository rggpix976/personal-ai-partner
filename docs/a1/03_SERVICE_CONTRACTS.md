# 3. サービス間契約

## 3.1 `ChatService`

```javascript
ChatService.send(request, context)
```

入力:

- `ChatRequest`
- `RequestContext`

出力:

- `ChatResult`

責務:

- 検証
- `requestId` 重複確認
- user発言保存
- `ContextService` 呼出し
- `GeminiClient` 呼出し
- assistant発言保存
- 一時障害時の `CHAT_REPLY` 起票

## 3.2 `ContextService`

```javascript
ContextService.buildChatContext(input)
```

入力:

```javascript
{
  requestId: string,
  currentText: string,
  hasImage: boolean,
  now: string
}
```

出力:

```javascript
{
  persona: {
    partnerName: string,
    userName: string,
    systemPersona: string,
    promptVersion: string
  },
  recentMessages: MessageDto[],
  memories: MemoryDto[],
  currentTime: string
}
```

## 3.3 `GeminiClient`

```javascript
GeminiClient.generateText(request)
GeminiClient.generateStructured(request, schemaName)
GeminiClient.generateWithImage(request)
```

統一戻り値:

```javascript
{
  text: string,
  data: object | null,
  model: string,
  usage: {
    inputTokens: number | null,
    outputTokens: number | null
  },
  rawFinishReason: string | null
}
```

`GeminiClient` 以外はHTTPステータスを直接扱わない。`GeminiClient` が `AppError` へ変換する。

## 3.4 `MemoryService`

```javascript
MemoryService.enqueueExtraction(messageRange)
MemoryService.extract(eventPayload)
MemoryService.findRelevant(query, limit)
MemoryService.applyCandidates(candidates)
```

`MemoryService.extract` の戻り値は [`contracts/memory-candidates.schema.json`](contracts/memory-candidates.schema.json) に従う。

## 3.5 `DiaryService`

```javascript
DiaryService.enqueue(date)
DiaryService.generate(eventPayload)
DiaryService.isGenerated(date)
```

## 3.6 `ProactiveMessageService`

```javascript
ProactiveMessageService.evaluateLocalConditions(now)
ProactiveMessageService.evaluateByAi(input)
ProactiveMessageService.prepareDispatch(eventPayload, now)
ProactiveMessageService.send(message)
```

上記は現行production契約であり、設定template fallbackを含む。PR 3はこのserviceへ
接続しない。PR 5のenforced経路では、新しい自発本文をactive CharacterPack、
承認可能な直近会話、承認済みmemoryから毎回生成し、共通guardと最大1回rewriteへ
渡す。承認artifactを得られない場合は送信、本文保存、delivery marker、送信回数、
`last_proactive_at`を更新せず、次の適格性評価を待つ。固定または設定template本文を
代替送信しない。

## 3.7 `QueueService`

実装パスは `src/application/QueueService.gs`、所有者はA6とする。

```javascript
QueueService.enqueue(event)
QueueService.claimBatch(limit, workerId, now)
QueueService.markDone(eventId, result)
QueueService.markRetry(eventId, error, nextAttemptAt)
QueueService.markDead(eventId, error)
QueueService.recoverStale(now)
QueueService.requeueDeadAsNewEvent(eventId, manualRequestId, now)
QueueService.assessDeadEventRecovery(eventId)
```

`requeueDeadAsNewEvent` は既存 `DEAD` 行を変更しない。新しい `event_id` と新しい手動再試行用 `dedupe_key` を生成して新規イベントを登録する。同じ `manualRequestId` の再呼び出しでは既存の手動再試行イベントを返し、二重起票しない。

`assessDeadEventRecovery` は本文、payload、各種IDを返さず、イベント種別、状態、安全な復旧アクション、理由コードだけを返す。自発送信イベントは再送せず、新しい適格性評価を待つ。

## 3.8 `OperationalHealthService`

```javascript
OperationalHealthService.inspect(now, triggerHealth)
OperationalHealthService.run(now, triggerHealth)
```

`inspect` はキューと必須トリガーの状態を集約し、`OK`、`DEGRADED`、`CRITICAL` のいずれかを返す。出力と通知には集計件数と管理されたエラーコードだけを含め、本文、payload、各種ID、URL、メールアドレスを含めない。

## 3.9 Repository

各Repositoryは、呼出し側へシート行番号を公開しない。戻り値はオブジェクトとする。

```javascript
SheetRepository.getConversationByRequestId(requestId)
SheetRepository.appendConversation(message)
SheetRepository.listRecentMessages(limit)
SheetRepository.listMessagesBefore(messageId, limit)
SheetRepository.getUserState()
SheetRepository.updateUserState(patch)
SheetRepository.insertEvent(event)
SheetRepository.listClaimableEvents(limit, now)
SheetRepository.updateEvent(eventId, patch)
SheetRepository.listEvents()
SheetRepository.listActiveMemories()
SheetRepository.upsertMemory(memory)
```

`getConversationByRequestId(requestId)` の戻り値:

```javascript
{
  requestId: string,
  userMessage: MessageDto | null,
  assistantMessage: MessageDto | null
}
```

`conversation_logs` の一意性は `request_id` 単独ではなく、`(request_id, role)` の複合一意である。同じ `request_id` に user行とassistant行を各1件まで保存できる。

## 3.10 `CharacterProfileService` / `CharacterPackService`

PR 3のactive targetはV2 profileと1個のcode-owned CharacterPackである。どちらも
まだ既存の生成経路からは呼び出さない。

```javascript
CharacterProfileService.validateV2(candidate)
CharacterProfileService.readV2()
CharacterProfileService.validateV1(candidate) // dormant compatibility only
CharacterProfileService.readV1()              // dormant compatibility only
CharacterProfileService.inspectRuntime()
CharacterProfileService.requireActive()
CharacterProfileService.saveV2(candidate, expectedRevision)
CharacterProfileService.saveV1(candidate, expectedRevision) // never activates V2
CharacterProfileService.getProactiveFrequency()
CharacterPackService.getActive()
CharacterPackService.getPromptView(scope)
CharacterPackService.assertActiveBinding(packId, packVersion)
```

- `validateV2` は本文をエラーへ含めず、正規化済みprofileまたは管理された
  `path` / `code` のみを返す。
- `readV2` は初回保存前の正規なstaging状態としてrevision `0` を読める。
- `inspectRuntime` はmodeの完全な状態表を決定論的に解決する。
- `legacy` runtimeでは保存済みV1/V2をactive authorityとして読み込まない。
- `requireActive` は有効な `enforced + v2 + revision > 0` とactive pack binding以外を
  fail closedする。
- `saveV2` はmodeを変更せず、検証済みprofileとrevisionだけをCAS保存する。
- `character-profile.v1`、`SYSTEM_PERSONA`、speech preset、warmth、flavor、
  example lineをV2へ自動移行、コピー、またはactive contextへ混入させない。
- V1 APIは既存data/rollback compatibilityのため残るが、V2を作成・更新せず、
  enforced active contextを返さない。
- V2で利用者が変更できるcharacter fieldは `partnerName`、`userAddress`、
  `replyLength`だけである。proactive frequencyとquiet hoursは別の通知設定とする。
- `CharacterPackService` はexact
  `character-pack.v1 / warm-kansai-caretaker /
  warm-kansai-caretaker.v1` を返し、packの
  `firstPerson`、generation rules、`CHARACTER_CANON`、fixed responsesを所有する。
- `getPromptView(scope)` はfixed responsesを除外し、`CHARACTER_CANON` を
  `allowedScopes` でcontext構築前に絞る。memory scopeでは `canon=[]` となり、
  memory生成器とsemantic verifierへcanonを渡さない。fixed textはlocal catalog
  selectionだけで使用し、model promptへ渡さない。

## 3.11 `CharacterContextService`

```javascript
CharacterContextService.buildActive(input)
CharacterContextService.withConversationMode(context, mode)
CharacterContextService.assertUnclassifiedActive(context, expectedSurface)
CharacterContextService.assertClassifiedActive(context, expectedSurface)
CharacterContextService.toGenerationView(classifiedContext)
```

有効なV2 profileとactive CharacterPackから、文字列promptではなく型付きcontextを
構築する。personaは
`{kind:"single-character-pack", profile, pack:CharacterPackService.getPromptView(surface)}`
として保持する。runtime metadataは `characterPackId` と
`characterPackVersion` を含む。現在の要求、履歴、記憶、fact、観測、Partner Worldは
`data.authority = "untrusted"` の配下へ分離する。
`partnerWorld.mayCreate=true` はdiary scopeだけで許可し、memory contextでは
`partnerWorld=null` とする。dataはJSON-safeな値だけを受理し、legacy persona
authorityと危険なobject keyを再帰的に拒否する。`buildActive` は
`UNCLASSIFIED` contextを返し、`withConversationMode` は完全なcontext shapeと
現在activeなprofile/revision/pack bindingを再検証して、PR 3で定義済みmodeを
immutableに結合する。両APIが発行したdeep-frozen object identityはprocess-local
`WeakSet` capabilityとして保持し、mutable object、JSON clone、staleまたは外部で
組み立てたcontextはshapeが同じでも拒否する。PR 3では
coordinatorが本文を読む・分類する前に `assertUnclassifiedActive` でactive binding、
context budget、surface一致を検証する。untrusted inputのコピー中にも、field単位で
最大depth 12、node 2000、配列100件、object key 100件、key 64 code points、
文字列4000 code pointsを適用し、unsafe C0/C1 control、Unicode noncharacter、
unpaired surrogateを拒否する。
完成contextのevidence viewはcanonを含め最大50件とする。
既存surfaceをこのcontextへ接続しない。`toGenerationView` は生成・rewrite・semantic
verificationに必要なprofile、pack rules、scope-filtered canon、bounded dataだけを返し、
policy/catalog/profile revision、pack ID/version、schema version、authority tag等の
operational metadataをmodel-facing callbackへ渡さない。

## 3.12 `CharacterConfigRepository`

```javascript
CharacterConfigRepository.readSnapshot()
CharacterConfigRepository.saveProfileV2Atomically(
  canonicalProfileJson,
  expectedRevision,
  updatedAt
) // active V2
CharacterConfigRepository.saveProfileAtomically(
  canonicalProfileJson,
  expectedRevision,
  updatedAt
) // dormant V1 compatibility
```

character設定を1回のsnapshotとして読み、V2 profileとV2 revisionをScriptLock、CAS、
単一範囲の `setValues()`、`SpreadsheetApp.flush()`、read-back検証で保存する。
bounding range内の非対象数式と `=` で始まるliteral textを保持し、lock競合は
本文を含まないcharacter config conflictへ写像する。modeやlegacy設定は同時に変更しない。
Spreadsheetの手動編集は公式な同時writerとして扱わない。

## 3.13 `CharacterModeClassifier` / `CharacterResponseCatalog`

```javascript
CharacterModeClassifier.classify({
  text,
  partnerName,
  safetyRequired,
  adminRequest,
  capabilityUnavailable
})
CharacterModeClassifier.classifyDetailed({
  text,
  partnerName,
  safetyRequired,
  adminRequest,
  capabilityUnavailable
})
CharacterResponseCatalog.render(key, classifiedContext)
CharacterResponseCatalog.payloadFor(key, classifiedContext, outputSurface)
CharacterResponseCatalog.matches(key, classifiedContext, payload, outputSurface)
```

classifierはlocalかつ決定論的に次のpriorityで1件を返す。

```text
SAFETY
  > ADMIN_OOC
  > PRODUCT_INFO
  > META_INTERNAL
  > WORLD_BOUNDARY
  > CAPABILITY
  > IDENTITY_CHALLENGE
  > AFFECTION_DIRECT_REQUEST
  > CHARACTER
```

`classifyDetailed` はexact frozen
`{mode, affectionVariant:null|"LIKE"|"STRONG"}`を返す。一般的なAIの話題と、
localに結合された明示的なpaired quote内の翻訳、校正、創作対象をexceptional routeへ
誤分類しない。unquoted proseには自然言語の帰属終端を推測した例外を与えない。
validated profileの `partnerName`で本人を直接疑う質問も検出する。
`capabilityUnavailable`は具体的な現在境界だけに使用する。

`PRODUCT_INFO` と `ADMIN_OOC` はcharacter artifactを発行せず、exact
`{kind:"NON_CHARACTER_ROUTE", route, artifact:null}` だけを返して
onboarding/About/status UIへ送る。classified context、会話履歴、memoryはこの
non-character戻り値へ含めない。

catalogはactive CharacterPackの固定値であり、利用者profileから編集できない。
keyは `IDENTITY_CHALLENGE_REPLY`、`WORLD_BOUNDARY_REPLY`、
`META_INTERNAL_REQUEST`、`AFFECTION_DIRECT_REQUEST_LIKE`、
`AFFECTION_DIRECT_REQUEST_STRONG`、`CHAT_RECOVERY`、
`CHAT_CAPABILITY_LIMIT`、`CHAT_GROUNDING_CLARIFY`、
`CHAT_IMAGE_UNCERTAIN`、`DIARY_FAIL_CLOSED`、`MEMORY_FAIL_CLOSED` だけである。
`PROACTIVE_GENERIC` は存在しない。placeholderは `partnerName` と
`userAddress` だけとする。speech preset variantは持たない。`render` は
`text`、`image`、`control` のimmutable unionを返す。`matches` は
classified active contextで再renderし、exact payloadだけをcanonical/fallbackとして
認証する。`payloadFor` はoutput surface固有payloadへ変換し、image turnのdirect
identity/world/internal/affectionまたは外部操作capability境界にはreviewed
`replyText` / `imageSummary` pairを返す。
Diary/Memory entryは本文を作らず `fail_closed` controlを返す。
全固定文のexact copyは
[`../features/CHARACTER_IMMERSION.md` section 6.3](../features/CHARACTER_IMMERSION.md#63-exact-exceptional-responses)
を正とし、CharacterPack以外に重複したeditable copyを持たない。

## 3.14 `CharacterFixedPolicy` / `CharacterSemanticVerifier` / `ImmersionGuard`

```javascript
CharacterFixedPolicy.inspect(payload, surface, classifiedContext)
CharacterSemanticVerifier.evaluate(request, verifierFn)
ImmersionGuard.evaluate(payload, surface, classifiedContext, {
  source,
  catalogKey,
  verifierFn
})
ImmersionGuard.isApprovedDecision(decision, classifiedContext)
ImmersionGuard.getApprovedPayload(decision, classifiedContext)
```

fixed policyはNFKC、大小文字、空白、全半角、引用変形を扱い、一語blacklistを
使用しない。classifierとpolicy照合ではdefault-ignorable Unicodeを除去し、directional
control、unsafe C0/C1 control、Unicode noncharacter、unpaired surrogateはfail
closedにする。既知のidentity tokenを分割するASCII
space/dot/underscore/hyphenもinspection時に正規化する。
高確度違反はlocalでdenyし、grounding/fact境界はspecific
claimとevidence必須条件をsemantic verifierへ渡す。加えて `generated` / `rewrite` / `legacy_revalidated` は、deterministic hard checkを
通過した場合、localで具体的違反を検出しなくてもgeneral immersion判定をsemantic verifierへ必ず1回渡す。hard denyはsemantic callを0回にする。exact reviewed
`canonical` / `fallback` だけがsemantic callなしでlocal approvalできる。verifierの戻り値はschemaどおりの `verdict`、管理category、evidence keyだけで、
timeout、malformed、未知evidenceを `GUARD_UNAVAILABLE` とする。

`verifierFn(request)` の返却shapeはexact
`{verdict:"allow"|"deny", category, evidenceKeys}` とする。
`CharacterSemanticVerifier.evaluate(request, verifierFn)` はこれを検証・正規化し、exact
`{status:"ALLOW"|"DENY"|"GUARD_UNAVAILABLE", category, evidenceKeys}` を返す。

guard decisionの公開shapeは候補本文を含まない。`ALLOW` decisionとapproved payloadの
対応はclosure内の `WeakSet` / `WeakMap` にだけ保持する。`canonical` / `fallback`
sourceはcatalog keyとexact rendered payloadが一致しなければdenyする。
guardはsourceをsurfaceとconversation modeにもbindする。identity/world/internal/
affection/capabilityは `canonical` のみ、`PRODUCT_INFO` / `ADMIN_OOC` は全sourceで
artifact発行禁止、通常の `CHARACTER` / `SAFETY` は `generated` / `rewrite` または
surface固有の `fallback` だけを許可する。`PROACTIVE_RETRY` は
`legacy_revalidated` だけを許可し、このsourceは他surfaceで拒否する。
`IDENTITY_CHALLENGE_REPLY`はAI/humanの明示的な肯定・否定を含めず、本人を突然
疑われた人として応答する。app/model/AI利用の透明性は `PRODUCT_INFO` UI routeが担う。
partnerから利用者への直接的な恋愛告白・身体的恋愛欲求は
`PERSONA_HARD_CONSTRAINT` としてdenyし、利用者から「言って」と頼まれた場合だけ
exact affection catalog responseを使用する。単語 `好き` はblacklistにしない。

## 3.15 `CharacterPayloadService` / `ApprovedCharacterArtifactService`

```javascript
CharacterPayloadService.normalize(surface, payload)
CharacterPayloadService.textFields(surface, payload)
CharacterPayloadService.collectEvidenceView(classifiedContext)
CharacterPayloadService.collectEvidenceKeys(classifiedContext)
CharacterPayloadService.contextScopeForSurface(surface)
ApprovedCharacterArtifactService.issue(approvedDecision, classifiedContext)
ApprovedCharacterArtifactService.assertUsable(artifact, expectedSurface, classifiedContext)
```

payload serviceはactive surfaceとそのexact top-level payload、文字数、件数、JSON-safe、
再帰量、immutable境界を検証する。DIARY/MEMORYの全nested stringに加え、object keyも
最大64文字かつ固定の安全な構造キーexact allowlistへ制限する。未知キーは表記を問わず
fail closedとし、allowlist内のcamelCase / snake_caseキーも単語へ分割してhard policy
対象にする。詳細business schemaを所有するsurface接続PRだけがレビュー付きでallowlistを
拡張できる。PR 3の暫定nested shapeはURL、callback、secret、generic internal ID keyを
許可しない。provenance用の `existingMemoryId`、`sourceMessageIds`、
`source_message_ids` はMEMORY payload内だけで許可し、canonical lowercase UUID v4かつ
配列内uniqueをruntime/schema双方で検証する。他field・surfaceのUUID-like textは拒否する。evidence keyは
untrusted input内の同名fieldから採用せず、許可されたtyped context pathから最大50件を
決定論的にmintした `{key, domain, value}` viewを正とする。artifact serviceは
authenticated `ALLOW` decisionだけを受理し、decisionを評価時classified contextの
object identityへbindする。artifactも同じcontext capabilityへbindし、active profile
revision、policy/profile/catalog version、CharacterPack ID/versionを発行時と使用時の
両方で再検証する。
JSON clone、raw object、wrong-context、wrong-surface、missing-version、stale objectは
artifactとして扱わない。

## 3.16 `CharacterOutputCoordinator`

```javascript
CharacterOutputCoordinator.approve({
  context,
  surface,
  classificationSignals,
  generate,
  rewrite,
  savedPayload,
  verifierFn,
  metricEmitter
})
```

current requestからmodeを分類し、identity/world/internal/affectionのexact routeでは
free generationを呼ばない。`PRODUCT_INFO` / `ADMIN_OOC` は
`NON_CHARACTER_ROUTE`を返し、character artifactを作らない。
通常候補はguardで評価し、repairable denyに限って元のtyped contextと管理categoryだけを
渡すrewriteを最大1回呼ぶ。rejected draftはrewrite input、error、metricへ渡さない。
`PROACTIVE_RETRY` だけは `generate` / `rewrite` callbackを禁止し、保存済みexact
`savedPayload:{subject,body}` を再検証する。その他surfaceでは `savedPayload` を
受け付けない。
rewrite不成立後はsurfaceに許可されたreviewed catalogだけをlocal再評価し、
Diary/Memory/proactiveまたはcatalog不成立では本文なしでfail closedする。
proactiveには固定/template fallbackを一切持たせず、`PROACTIVE_GENERIC`を使用しない。
承認不可時はartifactを返さないため、PR 5のsurface adapterはmarker、本文保存、mail、
conversation row、送信回数、`last_proactive_at`をすべて0回のまま安全に終了し、
次回eligibilityを待つ。text chatだけは `currentRequest.text` を必須とし、image、
proactive、diary、memoryは空の分類textを許す。戻り値はexact frozen
`{artifact, classifiedContext}` で、sinkへ同じcontext capabilityを渡せる一方、raw候補を
含まない。non-characterの場合だけ前述のtyped routeを返す。coordinator自身は
保存・配送しない。

## 3.17 `CharacterMetricsService` / `CharacterSinkAdapter`

```javascript
CharacterMetricsService.record(name, dimensions, emitFn)
CharacterSinkAdapter.deliver({
  artifact,
  expectedSurface,
  context,
  write,
  metricEmitter
})
```

metricsは機能仕様で固定したcounter名と低cardinality dimensionだけをemitする。
本文、hash、URL、メールアドレス、request/event/message/resource等のoperational ID、
profile revision、自由記述labelを拒否する。固定allowlistの `characterPackId` と
`characterPackVersion` だけはpack単位の低cardinality dimensionとして許可する。
sink adapterはartifact真正性とstalenessをwrite直前に再検証し、不正時はunderlying writeを
0回のまま `immersion_unapproved_sink_attempt_total` を記録する。`metricEmitter`は
必須であり、欠落時もwriteを行わない。artifactはwrite呼び出し前にone-shotとして消費し、
同一objectの再利用を拒否する。writerが失敗した場合も同じartifactは再利用せず、retryは
現在contextで新しい承認artifactを取得しなければならない。PR 3ではspy writerへ
だけ接続し、既存Repository、Web、mail、Docs、memory sinkへは接続しない。

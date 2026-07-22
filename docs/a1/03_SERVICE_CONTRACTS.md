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
ProactiveMessageService.send(message)
```

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

## 3.10 `CharacterProfileService`

PR 2で追加した内部サービスであり、まだ既存の生成経路からは呼び出さない。

```javascript
CharacterProfileService.validateV1(candidate)
CharacterProfileService.readV1()
CharacterProfileService.inspectRuntime()
CharacterProfileService.requireActive()
CharacterProfileService.saveV1(candidate, expectedRevision)
CharacterProfileService.getProactiveFrequency()
```

- `validateV1` は本文をエラーへ含めず、正規化済みprofileまたは管理された
  `path` / `code` のみを返す。
- `readV1` は初回保存前の正規なstaging状態としてrevision `0` を読める。
- `inspectRuntime` はmodeの完全な状態表を決定論的に解決する。
- `legacy` runtimeでは保存済みv1を読み込まず、完全に休眠させる。
- `requireActive` は有効な `enforced + v1 + revision > 0` 以外をfail closedする。
- `saveV1` はmodeを変更せず、検証済みprofileとrevisionだけをCAS保存する。
- `SYSTEM_PERSONA` をv1へ移行、コピー、またはactive contextへ混入させない。

## 3.11 `CharacterContextService`

```javascript
CharacterContextService.buildActive(input)
CharacterContextService.withConversationMode(context, mode)
```

有効なv1 profileから、文字列promptではなく型付きcontextを構築する。
profileは `persona.kind = "v1"` のtagged unionとして保持し、現在の要求、履歴、
記憶、fact、観測、Partner Worldは `data.authority = "untrusted"` の配下へ分離する。
`partnerWorld.mayCreate=true` はdiary scopeだけで許可し、memory contextでは
`partnerWorld=null` とする。dataはJSON-safeな値だけを受理し、legacy persona
authorityと危険なobject keyを再帰的に拒否する。`buildActive` は
`UNCLASSIFIED` contextを返し、`withConversationMode` は完全なcontext shapeと
現在activeなprofile/revisionを再検証して、PR 3で定義済みmodeをimmutableに
結合する。staleまたは外部で組み立てたcontextは拒否する。PR 2では既存surfaceを
このcontextへ接続しない。

## 3.12 `CharacterConfigRepository`

```javascript
CharacterConfigRepository.readSnapshot()
CharacterConfigRepository.saveProfileAtomically(
  canonicalProfileJson,
  expectedRevision,
  updatedAt
)
```

character設定を1回のsnapshotとして読み、profileとrevisionをScriptLock、CAS、
単一範囲の `setValues()`、`SpreadsheetApp.flush()`、read-back検証で保存する。
bounding range内の非対象数式と `=` で始まるliteral textを保持し、lock競合は
本文を含まないcharacter config conflictへ写像する。modeやlegacy設定は同時に変更しない。
Spreadsheetの手動編集は公式な同時writerとして扱わない。

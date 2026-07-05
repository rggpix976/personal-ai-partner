# 3. サービス間契約

## 3.1 ChatService

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
- requestId重複確認
- user発言保存
- ContextService呼出し
- GeminiClient呼出し
- assistant発言保存
- 一時障害時のCHAT_REPLY起票

## 3.2 ContextService

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

## 3.3 GeminiClient

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

GeminiClient以外はHTTPステータスを直接扱わない。GeminiClientがAppErrorへ変換する。

## 3.4 MemoryService

```javascript
MemoryService.enqueueExtraction(messageRange)
MemoryService.extract(eventPayload)
MemoryService.findRelevant(query, limit)
MemoryService.applyCandidates(candidates)
```

## 3.5 DiaryService

```javascript
DiaryService.enqueue(date)
DiaryService.generate(eventPayload)
DiaryService.isGenerated(date)
```

## 3.6 ProactiveMessageService

```javascript
ProactiveMessageService.evaluateLocalConditions(now)
ProactiveMessageService.evaluateByAi(input)
ProactiveMessageService.send(message)
```

## 3.7 QueueService

```javascript
QueueService.enqueue(event)
QueueService.claimBatch(limit, workerId, now)
QueueService.markDone(eventId, result)
QueueService.markRetry(eventId, error, nextAttemptAt)
QueueService.markDead(eventId, error)
QueueService.recoverStale(now)
```

## 3.8 Repository

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
SheetRepository.listActiveMemories()
SheetRepository.upsertMemory(memory)
```

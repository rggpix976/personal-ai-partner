# 2. 公開API契約

## 2.1 公開関数

公開関数は `PublicApi.gs` に置く。ブラウザから呼べる関数は以下だけとする。

### getInitialState()

```javascript
function getInitialState()
```

戻り値:

```javascript
{
  ok: true,
  system: {
    status: "ready" | "degraded" | "stopped",
    partnerName: string,
    userName: string,
    lastUpdatedAt: string,
    warnings: string[]
  },
  messages: MessageDto[],
  pagination: {
    hasMore: boolean,
    nextBeforeMessageId: string | null
  }
}
```

### loadMessages(beforeMessageId, limit)

```javascript
function loadMessages(beforeMessageId, limit)
```

制約:
- `limit`: 1〜30
- `beforeMessageId`: nullまたは既存message_id

戻り値:

```javascript
{
  ok: true,
  messages: MessageDto[],
  pagination: {
    hasMore: boolean,
    nextBeforeMessageId: string | null
  }
}
```

### sendChat(request)

```javascript
function sendChat(request)
```

入力は `contracts/chat-request.schema.json` を正とする。

戻り値は `contracts/chat-result.schema.json` を正とする。

### getRequestStatus(requestId)

```javascript
function getRequestStatus(requestId)
```

戻り値は `ChatResult`。

### retryRequest(requestId)

```javascript
function retryRequest(requestId)
```

条件:
- 対象requestIdが存在する。
- DONEではない。
- 恒久エラーではない。

### getHealthStatus()

```javascript
function getHealthStatus()
```

戻り値:

```javascript
{
  ok: boolean,
  status: "ready" | "degraded" | "stopped",
  checks: {
    config: CheckResult,
    spreadsheet: CheckResult,
    diaryDocument: CheckResult,
    tempFolder: CheckResult,
    backupFolder: CheckResult,
    triggers: CheckResult,
    geminiModel: CheckResult,
    mailQuota: CheckResult,
    queue: CheckResult
  },
  warnings: string[],
  checkedAt: string
}
```

## 2.2 MessageDto

```javascript
{
  messageId: string,
  requestId: string | null,
  createdAt: string,
  role: "user" | "assistant" | "system",
  messageType: "text" | "image" | "proactive" | "error",
  text: string,
  image: {
    name: string,
    mimeType: "image/jpeg" | "image/png" | "image/webp",
    summary: string
  } | null,
  status: "accepted" | "completed" | "failed",
  error: {
    code: string,
    message: string
  } | null
}
```

## 2.3 公開APIの禁止事項

- Spreadsheet ID、Document ID、Folder IDを返さない。
- APIキーを返さない。
- スタックトレースを返さない。
- Geminiの生レスポンスを返さない。
- シート行番号を外部IDとして使わない。

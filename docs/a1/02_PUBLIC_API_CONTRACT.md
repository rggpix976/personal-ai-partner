# 2. 公開API契約

## 2.1 公開関数

公開関数は `src/PublicApi.gs` に置く。ブラウザから呼べる関数は以下だけとする。

### `getInitialState()`

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

### `loadMessages(beforeMessageId, limit)`

```javascript
function loadMessages(beforeMessageId, limit)
```

制約:

- `limit`: 1〜30
- `beforeMessageId`: `null` または既存 `message_id`

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

### `sendChat(request)`

```javascript
function sendChat(request)
```

入力は [`contracts/chat-request.schema.json`](contracts/chat-request.schema.json) を正とする。

戻り値は [`contracts/chat-result.schema.json`](contracts/chat-result.schema.json) を正とする。

`status` 別の必須条件:

| status | 必須 |
|---|---|
| `completed` | `userMessage`, `assistantMessage` |
| `queued` | `userMessage`, `retryAfterSeconds` |
| `failed` | `error` |

### `getRequestStatus(requestId)`

```javascript
function getRequestStatus(requestId)
```

戻り値は `ChatResult`。

Repositoryから取得する際は、同一 `requestId` の `user` と `assistant` を別行として扱い、両方を組み立てて返す。

### `retryRequest(requestId)`

```javascript
function retryRequest(requestId)
```

条件:

- 対象 `requestId` が存在する。
- 既存の `DONE` イベントを再利用しない。
- 既存の `DEAD` イベントを `PROCESSING` へ戻さない。
- 手動再試行は、新しい `event_id` と新しい `dedupe_key` を持つ `CHAT_REPLY` イベントとして再起票する。
- 恒久エラーは再起票しない。

### `getHealthStatus()`

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

## 2.2 `MessageDto`

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
- `Session.getActiveUser().getEmail()` の取得結果を認可条件にしない。

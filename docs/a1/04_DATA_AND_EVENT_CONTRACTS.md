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
PROACTIVE_SEND:{yyyy-MM-dd}:{sequence}
WEEKLY_BACKUP:{yyyy-MM-dd}
```

`DEAD` の手動再試行は `CHAT_REPLY_MANUAL` を使い、既存 `dedupe_key` を再利用しない。

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
- stale回収は `attemptCount` を成功扱いにせず、ロック情報をクリアして `RETRY_WAIT` にする。

## 4.7 再試行

共通一時障害:

| 失敗回数 | 待機 |
|---:|---|
| 1 | 1分 |
| 2 | 5分 |
| 3 | 30分 |
| 4 | 2時間 |
| 5 | `DEAD` |

`MAIL_QUOTA_EXHAUSTED` はこの共通短時間リトライを使用しない。専用規則は [`05_ERROR_CONTRACT.md`](05_ERROR_CONTRACT.md) を参照する。

## 4.8 `conversation_logs` の一意性

`request_id` 単独を一意キーにしてはならない。

```text
UNIQUE(request_id, role)
```

- user行: 同一 `request_id` につき最大1件
- assistant行: 同一 `request_id` につき最大1件
- `request_id` が `null` のproactive/system行は複合一意の対象外

Apps Script/SheetsにはDB制約がないため、Repositoryが書込み前に検査し、重複時は既存行を返す。

## 4.9 スキーマ変更

- 列削除、列順変更は禁止。
- 追加列は末尾へ追加する。
- 変更時は `SCHEMA_VERSION` を上げる。
- `migrateSchema()` を用意する。
- 破壊的変更前にバックアップを作る。

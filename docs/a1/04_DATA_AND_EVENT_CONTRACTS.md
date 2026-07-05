# 4. データ・イベント契約

## 4.1 ID

- `message_id`: UUID v4
- `request_id`: ブラウザ生成UUID v4
- `event_id`: UUID v4
- `memory_id`: UUID v4
- `correlation_id`: requestIdまたはjob実行UUID

## 4.2 時刻

- JSON: ISO 8601、`+09:00`
- Sheets: Date型
- 比較基準: Asia/Tokyo
- 文字列の日付比較は禁止

## 4.3 Event

```javascript
{
  eventId: string,
  eventType: "CHAT_REPLY" | "MEMORY_EXTRACT" | "DIARY_GENERATE" | "PROACTIVE_SEND",
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

## 4.4 dedupe_key

```text
CHAT_REPLY:{requestId}
MEMORY_EXTRACT:{firstMessageId}:{lastMessageId}
DIARY_GENERATE:{yyyy-MM-dd}
PROACTIVE_SEND:{yyyy-MM-dd}:{sequence}
WEEKLY_BACKUP:{yyyy-MM-dd}
```

## 4.5 イベント状態遷移

```text
PENDING
  -> PROCESSING
     -> DONE
     -> RETRY_WAIT
     -> DEAD

RETRY_WAIT
  -> PROCESSING

PROCESSING(stale)
  -> RETRY_WAIT
```

禁止遷移:
- DONE -> PROCESSING
- DEAD -> PROCESSING（手動retryRequestを除く）
- PENDING -> DONE

## 4.6 再試行

- 1回目失敗: 1分
- 2回目失敗: 5分
- 3回目失敗: 30分
- 4回目失敗: 2時間
- 5回目失敗: DEAD

## 4.7 スキーマ変更

- 列削除、列順変更は禁止。
- 追加列は末尾へ追加する。
- 変更時はSCHEMA_VERSIONを上げる。
- `migrateSchema()` を用意する。
- 破壊的変更前にバックアップを作る。

# 5. エラー契約

## 5.1 `AppError`

```javascript
{
  name: "AppError",
  code: string,
  message: string,
  userMessage: string,
  retryable: boolean,
  retryStrategy: "NONE" | "COMMON_BACKOFF" | "NEXT_DAILY_WINDOW",
  httpStatus: number | null,
  cause: object | null,
  details: object | null,
  correlationId: string
}
```

## 5.2 固定エラーコード

| code | retryable | retryStrategy | 意味 |
|---|---:|---|---|
| VALIDATION_TEXT_TOO_LONG | false | NONE | 文字数超過 |
| VALIDATION_IMAGE_UNSUPPORTED | false | NONE | 未対応画像 |
| VALIDATION_IMAGE_TOO_LARGE | false | NONE | 画像サイズ超過 |
| CONFIG_MISSING | false | NONE | 必須設定欠落 |
| CHARACTER_CONFIG_INVALID | false | NONE | character mode/profile設定不正 |
| CHARACTER_CONFIG_CONFLICT | false | NONE | profile revisionのCASまたは保存lock競合 |
| ACCESS_NOT_ALLOWED | false | NONE | アクセス設定不正 |
| DUPLICATE_REQUEST | false | NONE | 同一要求 |
| GEMINI_RATE_LIMIT | true | COMMON_BACKOFF | 429・無料枠・速度制限 |
| GEMINI_AUTH_FAILED | false | NONE | APIキー不正 |
| GEMINI_MODEL_UNAVAILABLE | false | NONE | モデル不在・終了 |
| GEMINI_BAD_RESPONSE | true | COMMON_BACKOFF | JSON等の形式不正 |
| GEMINI_TEMPORARY_FAILURE | true | COMMON_BACKOFF | 5xx・通信失敗 |
| STORAGE_WRITE_FAILED | true | COMMON_BACKOFF | 保存失敗 |
| STORAGE_DATA_CORRUPTED | false | NONE | JSON・スキーマ破損 |
| MAIL_QUOTA_EXHAUSTED | true | NEXT_DAILY_WINDOW | MailApp残量なし |
| QUEUE_LOCK_BUSY | true | COMMON_BACKOFF | ロック取得不可 |
| QUEUE_DEAD | false | NONE | 最大再試行超過 |
| UNKNOWN | false | NONE | 未分類 |

## 5.3 `MAIL_QUOTA_EXHAUSTED` 専用規則

共通の1分、5分、30分、2時間リトライを適用しない。

- `nextAttemptAt` は次の暦日の `08:05 Asia/Tokyo` 以降に設定する。
- 対象が `PROACTIVE_SEND` の場合、保存済み文面をそのまま翌日送らない。
- 再処理時に沈黙時間、通知禁止時間、日次上限、クールダウンを再評価する。
- 元の `targetDate` が過去日で条件不成立なら、通知を送らず `DONE` とし、結果を `skipped_quota_expired` と記録する。
- 日次枠回復後も失敗した場合のみ、イベント固有の最大試行回数に従う。

## 5.4 利用者向け表示

利用者向けには以下だけを返す。

```javascript
{
  code: string,
  message: string
}
```

以下は返さない。

- stack
- cause
- details
- APIレスポンス全文
- シートID
- ファイルID
- APIキー
- Base64画像

## 5.5 ログのマスキング

必須マスク対象:

- `x-goog-api-key`
- `Authorization`
- APIキーに一致する値
- Base64本文
- `OWNER_EMAIL`
- Spreadsheet/Document/Folder ID

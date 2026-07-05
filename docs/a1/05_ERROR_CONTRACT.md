# 5. エラー契約

## 5.1 AppError

```javascript
{
  name: "AppError",
  code: string,
  message: string,
  userMessage: string,
  retryable: boolean,
  httpStatus: number | null,
  cause: object | null,
  details: object | null,
  correlationId: string
}
```

## 5.2 固定エラーコード

| code | retryable | 意味 |
|---|---:|---|
| VALIDATION_TEXT_TOO_LONG | false | 文字数超過 |
| VALIDATION_IMAGE_UNSUPPORTED | false | 未対応画像 |
| VALIDATION_IMAGE_TOO_LARGE | false | 画像サイズ超過 |
| CONFIG_MISSING | false | 必須設定欠落 |
| ACCESS_NOT_ALLOWED | false | 所有者以外 |
| DUPLICATE_REQUEST | false | 同一要求 |
| GEMINI_RATE_LIMIT | true | 429・無料枠・速度制限 |
| GEMINI_AUTH_FAILED | false | APIキー不正 |
| GEMINI_MODEL_UNAVAILABLE | false | モデル不在・終了 |
| GEMINI_BAD_RESPONSE | true | JSON等の形式不正 |
| GEMINI_TEMPORARY_FAILURE | true | 5xx・通信失敗 |
| STORAGE_WRITE_FAILED | true | 保存失敗 |
| STORAGE_DATA_CORRUPTED | false | JSON・スキーマ破損 |
| MAIL_QUOTA_EXHAUSTED | true | MailApp残量なし |
| QUEUE_LOCK_BUSY | true | ロック取得不可 |
| QUEUE_DEAD | false | 最大再試行超過 |
| UNKNOWN | false | 未分類 |

## 5.3 利用者向け表示

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

## 5.4 ログのマスキング

必須マスク対象:
- `x-goog-api-key`
- `Authorization`
- APIキーに一致する値
- Base64本文
- OWNER_EMAIL
- Spreadsheet/Document/Folder ID

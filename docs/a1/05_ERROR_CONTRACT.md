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
| VALIDATION_REQUEST_INVALID | false | NONE | request/context/source/surface等の型付き境界不正 |
| VALIDATION_TEXT_TOO_LONG | false | NONE | 文字数超過 |
| VALIDATION_IMAGE_UNSUPPORTED | false | NONE | 未対応画像 |
| VALIDATION_IMAGE_TOO_LARGE | false | NONE | 画像サイズ超過 |
| CONFIG_MISSING | false | NONE | 必須設定欠落 |
| CHARACTER_CONFIG_INVALID | false | NONE | character mode/V2 profile/CharacterPack binding設定不正 |
| CHARACTER_CONFIG_CONFLICT | false | NONE | profile revisionのCASまたは保存lock競合 |
| CHARACTER_OUTPUT_BLOCKED | true | COMMON_BACKOFF | 承認済みcharacter出力を作れずfail closed |
| CHARACTER_ARTIFACT_INVALID | false | NONE | raw・偽造・surface不一致・staleな承認artifact |
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

`CHARACTER_OUTPUT_BLOCKED` と `CHARACTER_ARTIFACT_INVALID` のmessage、details、
causeへ候補本文、context、prompt、semantic verifierの自由記述、各種IDを含めない。
管理されたreason/categoryだけを内部制御に使用し、利用者向けには中立なstatus表示だけを返す。

`CHARACTER_OUTPUT_BLOCKED` の共通定義はretryableであるが、PR 5の新規proactive
生成で承認artifactを作れなかった場合は、同じeventを短時間backoffで繰り返して
固定文を送らない。surface adapterが管理された `NO_APPROVED_PROACTIVE_OUTPUT`
no-send結果へ変換し、本文、delivery marker、conversation row、送信回数、
`last_proactive_at`を変更せずeventを安全に完了する。`next_proactive_check_at`を
進め、schedulerの次回eligibility評価を待つ。このno-send結果はpartner bubbleへ
表示しない。

`PRODUCT_INFO` と `ADMIN_OOC` はerrorではない。character artifactを作らないtyped
routeであり、reviewedなonboarding/About/status UIが中立なproduct voiceで表示する。
PR 4のchat APIでは `status:"routed"`、`assistantMessage:null`、`error:null` として
返し、assistant行を保存しない。

review済みの中立文は次をexact textとし、生成modelで言い換えない。

| 用途 | title | message |
|---|---|---|
| `PRODUCT_INFO` | `このアプリについて` | `このアプリは、会話の返信を生成するためにAIを使用しています。送信した会話や画像は返信生成のために設定済みのAIサービスへ送られ、会話履歴はこのアプリの保存先に記録されます。これは推し本人の発言ではなく、アプリからの案内です。` |
| `ADMIN_OOC` | `アプリの状態について` | `設定や動作状態に関する情報は、推しの発言ではなくアプリの管理情報として扱います。詳しい状態はApps Scriptの実行履歴・トリガー・設定で確認してください。` |
| character設定不整合 | `設定の確認が必要です` | `推しとの会話設定が未完了、または整合していません。設定を確認してから、もう一度お試しください。` |

character設定不整合は `CHARACTER_CONFIG_INVALID` または
`CHARACTER_CONFIG_CONFLICT` の中立なstatus表示に使用する。これは
`PRODUCT_INFO` / `ADMIN_OOC` routeではなく、推しの吹き出し、会話本文、queueの
自由文へ保存しない。

## 5.3 `MAIL_QUOTA_EXHAUSTED` 専用規則

共通の1分、5分、30分、2時間リトライを適用しない。

- `nextAttemptAt` は次の暦日の `08:05 Asia/Tokyo` 以降に設定する。
- 対象が `PROACTIVE_SEND` の場合、保存済み文面をそのまま翌日送らない。
- 再処理時に沈黙時間、通知禁止時間、日次上限、クールダウンを再評価する。
- 保存済み生成文を配送再試行する場合もactive profile/policy/catalog/CharacterPackへ
  bindし直してguardを通す。再承認できなければ隔離して送信しない。
- 元の `targetDate` が過去日で条件不成立なら、通知を送らず `DONE` とし、結果を `skipped_quota_expired` と記録する。
- 日次枠回復後も失敗した場合のみ、イベント固有の最大試行回数に従う。

## 5.4 利用者向け表示

errorの場合、利用者向けには以下だけを返す。

```javascript
{
  code: string,
  message: string
}
```

正常な非キャラクター処理はerror DTOではなく、公開API契約の
`status:"routed"`、管理された `route`、review済み `notice` だけを返す。

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

同じマスク境界を `event_queue.last_error_message` にも適用する。ログが安全でも
event行へraw transport例外を保存してはならない。Gemini transport例外は固定された
安全な診断文へ正規化し、queue persistenceでも再度秘密値を除去する。

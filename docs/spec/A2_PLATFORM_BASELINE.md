# A2 基盤実装ベースライン

## 1. 文書の目的

本書は、A2がA1契約だけで基盤実装を開始できるように、Gate 1で必要なデータ、設定、初期構築、共通部品の仕様を固定する。

優先順位:

1. `docs/a1/02_PUBLIC_API_CONTRACT.md`
2. `docs/a1/03_SERVICE_CONTRACTS.md`
3. `docs/a1/04_DATA_AND_EVENT_CONTRACTS.md`
4. `docs/a1/05_ERROR_CONTRACT.md`
5. 本書
6. A2の実装判断

矛盾を発見した場合、A2は独断で修正せず `docs/a1/templates/CHANGE_REQUEST.md` を提出する。

## 2. 実行前提

- 実行基盤: Google Apps Script V8
- タイムゾーン: `Asia/Tokyo`
- 利用者: 所有者本人1名
- データストア: Google Sheets
- 日記: Google Docs
- 一時画像: Google Drive
- 秘密情報: Script Properties
- 課金方針: 無料優先。課金前提の自動フォールバックは禁止
- シート1行目は固定ヘッダー
- 追加列は末尾のみ
- IDはUUID v4
- JSON時刻はISO 8601 `+09:00`
- Sheets時刻はDate型
- 全実装ファイルは `src/` 配下へ置く
- Webアクセス制御はデプロイ設定を主制御とし、`Session.getActiveUser().getEmail()` に依存しない

## 3. 必須シート

### 3.1 `config`

| 列名 | 型 | 必須 | キー | 説明 |
|---|---|---:|---|---|
| key | string | 必須 | PK | 設定キー |
| value | string | 必須 |  | 設定値。秘密情報は禁止 |
| type | enum | 必須 |  | string/int/float/bool/time/json |
| description | string | 必須 |  | 説明 |
| updated_at | datetime | 必須 |  | 更新日時 |

### 3.2 `user_state`

| 列名 | 型 | 必須 | キー | 説明 |
|---|---|---:|---|---|
| singleton_id | string | 必須 | PK | 常に `default` |
| last_user_message_at | datetime | 任意 |  | 最終ユーザー発言 |
| last_assistant_message_at | datetime | 任意 |  | 最終AI発言 |
| last_proactive_at | datetime | 任意 |  | 最終自発送信 |
| proactive_count_date | date | 必須 |  | 日次カウンタ対象日 |
| proactive_count | int | 必須 |  | 当日送信数 |
| next_proactive_check_at | datetime | 任意 |  | 次回AI判定時刻 |
| last_memory_cursor | string | 任意 |  | 抽出済み最終message_id |
| last_diary_date | date | 任意 |  | 最終日記日 |
| quiet_until | datetime | 任意 |  | 自発通知停止期限 |
| updated_at | datetime | 必須 |  | 更新日時 |

初期行は `singleton_id=default`、`proactive_count=0` とする。

### 3.3 `conversation_logs`

| 列名 | 型 | 必須 | キー | 説明 |
|---|---|---:|---|---|
| conversation_id | string | 必須 |  | 固定 `default` |
| message_id | string | 必須 | PK | UUID |
| request_id | string | 任意 | 複合一意 | ブラウザ要求ID。`(request_id, role)` で一意 |
| created_at | datetime | 必須 | INDEX | 発言日時 |
| role | enum | 必須 |  | user/assistant/system |
| message_type | enum | 必須 |  | text/image/proactive/error |
| text | string | 任意 |  | 本文 |
| image_name | string | 任意 |  | 元ファイル名 |
| image_mime | string | 任意 |  | MIME |
| image_summary | string | 任意 |  | 画像要約 |
| reply_to_message_id | string | 任意 |  | 返信元 |
| status | enum | 必須 |  | accepted/completed/failed |
| model | string | 任意 |  | 使用モデル |
| input_tokens | int | 任意 |  | 入力トークン |
| output_tokens | int | 任意 |  | 出力トークン |
| error_code | string | 任意 |  | 失敗コード |

### 3.4 `event_queue`

| 列名 | 型 | 必須 | キー | 説明 |
|---|---|---:|---|---|
| event_id | string | 必須 | PK | UUID |
| event_type | enum | 必須 | INDEX | CHAT_REPLY/MEMORY_EXTRACT/DIARY_GENERATE/PROACTIVE_SEND/WEEKLY_BACKUP |
| dedupe_key | string | 必須 | UNIQUE | 重複防止 |
| payload_json | json | 必須 |  | 処理入力 |
| status | enum | 必須 | INDEX | PENDING/PROCESSING/RETRY_WAIT/DONE/DEAD |
| attempt_count | int | 必須 |  | 試行回数 |
| next_attempt_at | datetime | 任意 | INDEX | 次回実行可能時刻 |
| locked_at | datetime | 任意 |  | ロック日時 |
| locked_by | string | 任意 |  | 実行UUID |
| created_at | datetime | 必須 |  | 作成日時 |
| updated_at | datetime | 必須 |  | 更新日時 |
| completed_at | datetime | 任意 |  | 完了日時 |
| last_error_code | string | 任意 |  | 最終エラーコード |
| last_error_message | string | 任意 |  | 秘密を除去した説明 |

### 3.5 `long_term_memories`

| 列名 | 型 | 必須 | キー | 説明 |
|---|---|---:|---|---|
| memory_id | string | 必須 | PK | UUID |
| category | enum | 必須 | INDEX | profile/preference/relationship/interest/goal/event/promise/other |
| normalized_key | string | 必須 | INDEX | 比較用キー |
| content | string | 必須 |  | 記憶本文 |
| confidence | float | 必須 |  | 0.0..1.0 |
| status | enum | 必須 | INDEX | active/candidate/superseded/disabled |
| source_message_ids_json | json | 必須 |  | 出典message_id配列 |
| created_at | datetime | 必須 |  | 作成日時 |
| last_confirmed_at | datetime | 必須 |  | 最終確認日時 |
| supersedes_memory_id | string | 任意 |  | 置換元 |
| usage_count | int | 必須 |  | 会話利用回数 |
| last_used_at | datetime | 任意 |  | 最終利用 |

### 3.6 `daily_summaries`

| 列名 | 型 | 必須 | キー | 説明 |
|---|---|---:|---|---|
| summary_date | date | 必須 | PK | 対象日 |
| conversation_count | int | 必須 |  | 発言数 |
| summary_text | string | 任意 |  | 日別要約 |
| key_topics_json | json | 任意 |  | 話題一覧 |
| memory_candidate_count | int | 必須 |  | 候補数 |
| diary_status | enum | 必須 |  | `NONE`: 生成不要と確定、`PENDING`: 処理中、`DONE`: 文書アンカー1件、`FAILED`: 手動修復待ち |
| diary_doc_anchor | string | 任意 |  | 見出し識別子 |
| created_at | datetime | 必須 |  | 作成日時 |
| updated_at | datetime | 必須 |  | 更新日時 |

### 3.7 `usage_daily`

| 列名 | 型 | 必須 | キー | 説明 |
|---|---|---:|---|---|
| usage_date | date | 必須 | PK | 対象日 |
| api_calls | int | 必須 |  | Gemini呼出し数 |
| image_calls | int | 必須 |  | 画像入力回数 |
| input_tokens | int | 必須 |  | 入力合計 |
| output_tokens | int | 必須 |  | 出力合計 |
| mail_recipients | int | 必須 |  | MailApp送信先数 |
| errors | int | 必須 |  | エラー件数 |
| updated_at | datetime | 必須 |  | 更新日時 |

### 3.8 `debug_logs`

| 列名 | 型 | 必須 | キー | 説明 |
|---|---|---:|---|---|
| log_id | string | 必須 | PK | UUID |
| timestamp | datetime | 必須 | INDEX | 発生時刻 |
| level | enum | 必須 | INDEX | DEBUG/INFO/WARN/ERROR |
| operation | string | 必須 |  | 処理名 |
| correlation_id | string | 必須 | INDEX | 要求・ジョブ相関ID |
| event_id | string | 任意 |  | 関連イベント |
| message | string | 必須 |  | 要約 |
| details_json | json | 任意 |  | マスク済み詳細 |

## 4. Script Properties

Script Propertiesは検証時点を分離する。

### 4.1 setup前必須

| キー | 説明 |
|---|---|
| GEMINI_API_KEY | Gemini APIキー |
| OWNER_EMAIL | 自発通知先 |
| APP_ENV | `prod` または `test` |

`setup()` はファイル作成などの副作用前に `validatePreSetupProperties()` を実行する。

### 4.2 setup生成

| キー | 説明 |
|---|---|
| SPREADSHEET_ID | データストア |
| DIARY_DOC_ID | AI日記ドキュメント |
| TEMP_FOLDER_ID | 画像一時保存フォルダ |
| BACKUP_FOLDER_ID | バックアップ先 |
| SCHEMA_VERSION | データスキーマ版 |

`setup()` 完了後に `validatePostSetupProperties()` を実行する。

### 4.3 デプロイ後必須

| キー | 説明 |
|---|---|
| WEB_APP_URL | `/exec` のWebアプリURL |

初回setupでは未設定を許可する。デプロイ後に `validatePostDeployProperties()` とヘルスチェックで必須検証する。

秘密値をシート、コード、HTML、ログへ出力してはならない。`OWNER_EMAIL` は通知先であり、Webアクセス認可の判定キーではない。

## 5. `config` 初期値

| キー | 型 | 初期値 |
|---|---|---|
| PARTNER_NAME | string | 相棒 |
| USER_NAME | string | あなた |
| SYSTEM_PERSONA | string | 親しい雑談相手として自然に会話する |
| GEMINI_MODEL | string | 実装時点の無料枠対応安定版 |
| MAX_USER_TEXT_CHARS | int | 4000 |
| RECENT_MESSAGE_LIMIT | int | 20 |
| MEMORY_CONTEXT_LIMIT | int | 20 |
| MEMORY_EXTRACT_INTERVAL | int | 10 |
| SILENCE_MINUTES | int | 240 |
| PROACTIVE_COOLDOWN_MINUTES | int | 240 |
| PROACTIVE_MAX_PER_DAY | int | 2 |
| QUIET_START | time | 23:00 |
| QUIET_END | time | 08:00 |
| PROACTIVE_RECHECK_MINUTES | int | 60 |
| IMAGE_MAX_BYTES | int | 4194304 |
| IMAGE_MAX_DIMENSION | int | 1600 |
| TEMP_IMAGE_TTL_HOURS | int | 24 |
| QUEUE_BATCH_SIZE | int | 3 |
| QUEUE_STALE_MINUTES | int | 15 |
| DIARY_DUE_TIME | time | 23:30 |
| DIARY_MIN_CHARS | int | 300 |
| DIARY_MAX_CHARS | int | 800 |
| LOG_RETENTION_DAYS | int | 30 |
| BACKUP_RETENTION_COUNT | int | 4 |
| FREE_ONLY_MODE | bool | true |

## 6. `setup()` の責務

`setup()` は冪等でなければならない。

1. `validatePreSetupProperties()` を実行し、不足時は副作用なしで停止する。
2. Spreadsheet IDがある場合は検証し、ない場合は作成する。
3. 必須8シートを不足分だけ作る。
4. ヘッダーが完全一致することを検証する。
5. 列不足は末尾へ追加する。既存列の並べ替え・削除は禁止。
6. `config` 初期値を不足分だけ追加する。
7. `user_state` のdefault行を不足時のみ追加する。
8. AI日記用Documentを作成または検証する。
9. 一時画像フォルダとバックアップフォルダを作成または検証する。
10. 作成したIDとSCHEMA_VERSIONをScript Propertiesへ保存する。
11. `validatePostSetupProperties()` を実行する。
12. `WEB_APP_URL` は初回setupで要求しない。
13. トリガーはA2では最終確定しない。作成ヘルパー案までとし、A1/A6統合時に有効化する。
14. `runPlatformSelfTest()` を実行可能な状態にする。

## 7. `migrateSchema()` の責務

- 現在の `SCHEMA_VERSION` を読む。
- バージョン単位の移行関数を順番に実行する。
- 移行前にバックアップを要求できる構造にする。
- 同じ移行を再実行しても壊れない。
- 破壊的変更は禁止。必要な場合はA1 Change Requestを必須とする。

## 8. 共通部品

### `src/common/Constants.gs`

- シート名
- ヘッダー配列
- enum
- Script Propertiesキー
- configキー
- schema version
- エラーコード定数

### `src/common/Errors.gs`

- `AppError`
- 未知例外からの正規化
- 利用者向けエラーへの変換
- retryable判定

### `src/common/LockManager.gs`

- ScriptLock取得
- タイムアウト
- callback実行
- API通信中はロックを保持しない設計を支援

### `src/common/RetryPolicy.gs`

エラーコードと失敗回数から再試行戦略を決定する。

共通一時障害:

| 失敗回数 | 待機 |
|---:|---|
| 1 | 1分 |
| 2 | 5分 |
| 3 | 30分 |
| 4 | 2時間 |
| 5 | DEAD |

`MAIL_QUOTA_EXHAUSTED` は共通短時間リトライへ渡さない。次の暦日 `08:05 Asia/Tokyo` 以降へ設定し、再処理時に自発通知条件を再評価する。

### `src/common/Validators.gs`

- UUID
- ISO 8601
- enum
- 文字数
- MIME
- config値型
- シートヘッダー
- 必須Script Properties

### `src/common/Json.gs`

- 安全なparse/stringify
- 破損時 `STORAGE_DATA_CORRUPTED`
- 循環参照や過大ログの防止

### `src/common/AppLogger.gs`

必須マスク対象:

- x-goog-api-key
- Authorization
- GEMINI_API_KEY値
- Base64本文
- OWNER_EMAIL
- Spreadsheet/Document/Folder ID

## 9. `src/infrastructure/SheetRepository.gs` 規則

- 行番号を公開しない。
- 呼出し側にはオブジェクトを返す。
- IDまたは一意キーで操作する。
- 連続appendRowを避け、可能な箇所はsetValuesを使う。
- シート全件scanを共通化し、無制限に繰り返さない。
- Date型とJSON日時の変換を共通化する。
- JSON列は必ず検証する。
- `conversation_logs` は `(request_id, role)` を複合一意として扱う。
- `getConversationByRequestId(requestId)` は `{requestId, userMessage, assistantMessage}` を返す。
- SheetsにDB制約はないため、同一roleの重複をRepositoryが書込み前に防ぐ。

## 10. `src/appsscript.json` 案

- `timeZone`: `Asia/Tokyo`
- `runtimeVersion`: `V8`
- `exceptionLogging`: `STACKDRIVER`
- OAuthスコープは必要最小限
- A2は案を提出する。最終所有者はA1

## 11. Gate 1必須テスト

| Test ID | 内容 | 期待結果 |
|---|---|---|
| A2-T01 | setup初回 | 全シート・設定・ファイルが作成される |
| A2-T02 | setup再実行 | 重複シート・列・設定・default行が生じない |
| A2-T03 | ヘッダー欠落 | 末尾へ不足列を追加する |
| A2-T04 | ヘッダー順序不正 | 自動並べ替えせずエラーにする |
| A2-T05 | setup前Properties欠落 | 副作用なしでCONFIG_MISSING |
| A2-T06 | setup生成Properties | setup後に全IDとSCHEMA_VERSIONが存在 |
| A2-T07 | WEB_APP_URL欠落 | setupは成功し、デプロイ後検証は失敗 |
| A2-T08 | JSON破損 | STORAGE_DATA_CORRUPTED |
| A2-T09 | Lock競合 | QUEUE_LOCK_BUSYまたは規定の非例外結果 |
| A2-T10 | 共通RetryPolicy | 1分/5分/30分/2時間/DEAD |
| A2-T11 | Mail quota RetryPolicy | 共通短時間リトライを使わない |
| A2-T12 | ログマスク | APIキー・メール・Base64・IDが残らない |
| A2-T13 | Repository戻り値 | 行番号を含まない |
| A2-T14 | request複合一意 | user/assistant各1件を許可し、同じroleの重複を拒否 |
| A2-T15 | request取得 | userMessageとassistantMessageの組を返す |
| A2-T16 | config型変換 | int/float/bool/time/jsonが正しく変換される |
| A2-T17 | migrate再実行 | 同じ移行を再実行しても破損しない |

## 12. A2提出物

A2は差分ではなく担当ファイルの完全版を提出する。ZIPはリポジトリ直下へ展開できる構造とし、以下を含める。

- `src/` 配下の実装対象全ファイル
- `src/appsscript.json` 案
- `src/tests/` のテストファイル
- `docs/handoffs/A2_HANDOFF.md`
- コミットメッセージ
- PRタイトル
- PR本文
- 変更ファイル一覧
- テスト結果
- 未実装事項
- 他担当との競合可能性

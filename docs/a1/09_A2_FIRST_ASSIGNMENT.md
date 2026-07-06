# 9. A2への最初の作業指示

## 目的

A3〜A6が安全に並列実装できる共通基盤を作る。

## 参照範囲

A1契約とA2基盤仕様を全文参照する。

優先順:

1. [`02_PUBLIC_API_CONTRACT.md`](02_PUBLIC_API_CONTRACT.md)
2. [`03_SERVICE_CONTRACTS.md`](03_SERVICE_CONTRACTS.md)
3. [`04_DATA_AND_EVENT_CONTRACTS.md`](04_DATA_AND_EVENT_CONTRACTS.md)
4. [`05_ERROR_CONTRACT.md`](05_ERROR_CONTRACT.md)
5. [`06_FILE_OWNERSHIP.md`](06_FILE_OWNERSHIP.md)
6. [`../spec/A2_PLATFORM_BASELINE.md`](../spec/A2_PLATFORM_BASELINE.md)

## 実装対象

全て `src/` 配下へ置く。

```text
src/common/Constants.gs
src/common/Errors.gs
src/common/LockManager.gs
src/common/RetryPolicy.gs
src/common/Validators.gs
src/common/Json.gs
src/common/AppLogger.gs
src/infrastructure/SheetRepository.gs
src/infrastructure/ConfigRepository.gs
src/infrastructure/DocumentRepository.gs
src/infrastructure/DriveTempRepository.gs
src/Setup.gs
src/appsscript.json（案のみ。最終所有はA1）
src/tests/A2PlatformTests.gs
```

A2は `src/application/QueueService.gs` を実装しない。これはA6所有である。

## 必須成果物

1. `setup()`
2. `migrateSchema()`
3. `runPlatformSelfTest()`
4. 全シートの冪等作成
5. config初期値
6. Script Propertiesの段階別検証
7. Repository CRUD
8. `(request_id, role)` 複合一意
9. `getConversationByRequestId` のuser/assistant組返却
10. `AppError`
11. ログマスキング
12. エラー別RetryPolicy
13. 単体テスト
14. `docs/handoffs/A2_HANDOFF.md`

## Script Propertiesの段階

### setup前必須

- `GEMINI_API_KEY`
- `OWNER_EMAIL`
- `APP_ENV`

`setup()` は副作用を起こす前に `validatePreSetupProperties()` を実行する。

### setup生成

- `SPREADSHEET_ID`
- `DIARY_DOC_ID`
- `TEMP_FOLDER_ID`
- `BACKUP_FOLDER_ID`
- `SCHEMA_VERSION`

`setup()` 完了時に `validatePostSetupProperties()` を実行する。

### デプロイ後必須

- `WEB_APP_URL`

WebアプリURL確定後に設定し、`validatePostDeployProperties()` と `getHealthStatus()` で検証する。初回setupでは未設定を許可する。

## 合格条件

- setupを2回実行して重複シート・重複列が生じない。
- シート列が基盤仕様と一致する。
- 列削除・順番変更を行わない。
- APIキーをシート・ログへ保存しない。
- Repositoryが行番号を外へ返さない。
- 同一 `request_id` のuser/assistant各1件を保存でき、同じroleの重複を防ぐ。
- `getConversationByRequestId` が `{requestId, userMessage, assistantMessage}` を返す。
- JSON破損を検出できる。
- Lock取得失敗を正常に扱える。
- 共通RetryPolicyが1分/5分/30分/2時間/DEADを返す。
- `MAIL_QUOTA_EXHAUSTED` に共通短時間リトライを適用しない。

## 提出形式

利用者はコード編集を行わない。A2は作業完了時に以下を一つのZIPとして提出する。

1. リポジトリ直下からの完全なファイル構成
2. 追加・変更する全ファイルの完全版
3. `docs/handoffs/A2_HANDOFF.md`
4. コミットメッセージ
5. PRタイトル
6. PR本文
7. 変更ファイル一覧
8. 実行したテストと結果
9. 未実装事項
10. 他担当との競合可能性

ZIPはリポジトリ直下へ展開すれば配置が完了する構造にする。差分パッチだけの提出は禁止する。

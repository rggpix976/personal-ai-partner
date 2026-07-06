# 1. アーキテクチャ基準

## 1.1 実行基盤

- Google Apps Script V8
- HTML Service WebUI
- Gemini Developer API
- Google Sheets
- Google Docs
- Google Drive一時領域
- MailApp
- Apps Script時間主導トリガー

## 1.2 リポジトリと実装パス

実装ファイルは全て `src/` 配下へ置く。ルート直下へ `.gs`、`.html`、`appsscript.json` を置かない。

```text
src/
├── PublicApi.gs
├── Setup.gs
├── appsscript.json
├── web/
├── application/
├── infrastructure/
├── jobs/
├── common/
└── tests/
```

文書、検証ツール、引継ぎ資料は `docs/`、`tools/` に置き、実装パスには含めない。

## 1.3 レイヤー

```text
src/web
  -> src/application
      -> src/infrastructure
      -> src/common
src/jobs
  -> src/application
      -> src/infrastructure
      -> src/common
```

### `src/web`

ブラウザから呼ばれる公開関数、HTML、CSS、クライアントJavaScriptのみを置く。

### `src/application`

ユースケースと業務ロジックを置く。`SpreadsheetApp`、`DriveApp`、`DocumentApp`、`MailApp`、`UrlFetchApp` を直接呼び出してはならない。

### `src/infrastructure`

Googleサービス、Gemini API、永続化を扱う。

### `src/jobs`

時間主導トリガーの入口だけを置く。業務ロジックは `src/application` へ委譲する。

### `src/common`

例外、検証、時刻、ロック、JSON、安全なログなど横断機能を置く。

## 1.4 個人専用アクセス制御

主制御はWebアプリのデプロイ設定で行う。

- 実行ユーザー: デプロイした所有者
- アクセス権: 所有者本人のみ
- 一般公開、匿名公開、リンクを知る全員への公開は禁止
- 運用URLは `/exec` を使用する

`Session.getActiveUser().getEmail()` は個人アカウントや実行方式によって空文字を返す場合があるため、認可の主制御に使用しない。補助的な診断情報としても、値が取得できることを前提にしてはならない。

`OWNER_EMAIL` は自発通知の宛先であり、Webアプリの認可判定キーではない。

## 1.5 固定原則

- Sheetsアクセスは `src/infrastructure/SheetRepository.gs` に集約する。
- Gemini通信は `src/infrastructure/GeminiClient.gs` に集約する。
- Google Docsは `src/infrastructure/DocumentRepository.gs` に集約する。
- Drive一時画像は `src/infrastructure/DriveTempRepository.gs` に集約する。
- Gmail送信は `src/infrastructure/GmailNotifier.gs` に集約する。
- キュー操作は `src/application/QueueService.gs` に集約する。
- APIキー、ID、モデル名、時間、上限値をハードコードしない。
- 公開関数以外のトップレベル関数名は末尾 `_` を付ける。
- API呼出し中にScriptLockを保持しない。
- ユーザー文字列を `innerHTML` へ挿入しない。
- 無料枠超過時に有料経路へ自動フォールバックしない。

## 1.6 統合順序

```text
A2 基盤・データ
  -> A4 会話・Gemini・画像
  -> A3 WebUI
  -> A5 長期記憶・日記
  -> A6 自発通知・キュー・ジョブ
  -> A7 総合試験
```

## 1.7 非同期処理の境界

同期処理:

- WebUI初期表示
- 履歴読込
- 通常のテキスト・画像会話
- ヘルス確認

非同期処理:

- 同期会話失敗後の再処理
- 長期記憶抽出
- AI日記生成
- 自発メッセージ
- 週次バックアップ
- ログ・一時画像清掃

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

## 1.2 レイヤー

```text
web
  -> application
      -> infrastructure
      -> common
jobs
  -> application
      -> infrastructure
      -> common
```

### web

ブラウザから呼ばれる公開関数、HTML、CSS、クライアントJavaScriptのみを置く。

### application

ユースケースと業務ロジックを置く。SpreadsheetApp、DriveApp、DocumentApp、MailApp、UrlFetchAppを直接呼び出してはならない。

### infrastructure

Googleサービス、Gemini API、永続化を扱う。

### jobs

時間主導トリガーの入口だけを置く。業務ロジックはapplicationへ委譲する。

### common

例外、検証、時刻、ロック、JSON、安全なログなど横断機能を置く。

## 1.3 固定原則

- Sheetsアクセスは `SheetRepository` に集約する。
- Gemini通信は `GeminiClient` に集約する。
- Google Docsは `DocumentRepository` に集約する。
- Drive一時画像は `DriveTempRepository` に集約する。
- Gmail送信は `GmailNotifier` に集約する。
- APIキー、ID、モデル名、時間、上限値をハードコードしない。
- 公開関数以外のトップレベル関数名は末尾 `_` を付ける。
- API呼出し中にScriptLockを保持しない。
- ユーザー文字列を `innerHTML` へ挿入しない。
- 無料枠超過時に有料経路へ自動フォールバックしない。

## 1.4 統合順序

```text
A2 基盤・データ
  -> A4 会話・Gemini・画像
  -> A3 WebUI
  -> A5 長期記憶・日記
  -> A6 自発通知・キュー・ジョブ
  -> A7 総合試験
```

## 1.5 非同期処理の境界

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
- バックアップ
- ログ・一時画像清掃

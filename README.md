# Personal Proactive AI Partner

## 現在の状態

- 担当ブランチ: A1 統合・アーキテクチャ
- 成果物版: v0.2
- PR状態: PR #1 Changes requested対応済み、再レビュー待ち
- 統合ゲート: Gate 0 契約固定
- 次担当: A2 基盤・データ
- アプリケーションコード: 未実装

このコミットはアプリ本体ではなく、A2〜A7が守る統合契約とA2の作業入力を配置する。

## 実装パス

全てのApps Script実装は `src/` 配下へ置く。

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

現時点では契約固定段階のため、`src/` の実装ファイルはまだ存在しない。

## A2が最初に読む順序

1. [`docs/a1/09_A2_FIRST_ASSIGNMENT.md`](docs/a1/09_A2_FIRST_ASSIGNMENT.md)
2. [`docs/spec/A2_PLATFORM_BASELINE.md`](docs/spec/A2_PLATFORM_BASELINE.md)
3. [`docs/a1/01_ARCHITECTURE_BASELINE.md`](docs/a1/01_ARCHITECTURE_BASELINE.md)
4. [`docs/a1/02_PUBLIC_API_CONTRACT.md`](docs/a1/02_PUBLIC_API_CONTRACT.md)
5. [`docs/a1/03_SERVICE_CONTRACTS.md`](docs/a1/03_SERVICE_CONTRACTS.md)
6. [`docs/a1/04_DATA_AND_EVENT_CONTRACTS.md`](docs/a1/04_DATA_AND_EVENT_CONTRACTS.md)
7. [`docs/a1/05_ERROR_CONTRACT.md`](docs/a1/05_ERROR_CONTRACT.md)
8. [`docs/a1/06_FILE_OWNERSHIP.md`](docs/a1/06_FILE_OWNERSHIP.md)
9. [`docs/a1/07_INTEGRATION_GATES.md`](docs/a1/07_INTEGRATION_GATES.md)
10. [`docs/a1/contracts/event.schema.json`](docs/a1/contracts/event.schema.json)
11. [`docs/a1/contracts/memory-candidates.schema.json`](docs/a1/contracts/memory-candidates.schema.json)

## 検証

開発依存を導入する。

```bash
python3 -m pip install -r requirements-dev.txt
```

再実行可能な契約検証を実行する。

```bash
python3 tools/validate_contracts.py
```

検証対象:

- UTF-8 / LF / 最終改行
- JSON構文
- JSON Schema Draft 2020-12
- status、eventType、MemoryCandidateの条件
- Markdown相対リンク
- 秘密値パターン
- 一時GitHub転記ファイルの不在

## 変更規則

- A1承認なしに公開API、シート列、設定キー、エラーコードを変更しない。
- 担当外ファイルを直接変更しない。
- 変更提案は [`docs/a1/templates/CHANGE_REQUEST.md`](docs/a1/templates/CHANGE_REQUEST.md) を使う。
- 引継ぎは `docs/handoffs/` 配下へ置く。
- A2の最終成果物はリポジトリ直下へ展開可能なZIPで提出する。

## 現在含まれるもの

- A1統合契約
- JSON Schema 10種
- 全eventTypeのpayload Schema
- ファイル所有権
- 統合ゲート
- A2初回作業指示
- A2基盤実装ベースライン
- 再実行可能な契約検証スクリプト
- PR #1レビュー対応表
- A1引継ぎ資料

## 現在含まれないもの

- Apps Script本体コード
- WebUI
- Gemini API実装
- Googleサービス上の実行テスト
- 本番ID、APIキー、メールアドレス

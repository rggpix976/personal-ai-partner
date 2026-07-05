# Personal Proactive AI Partner

## 現在の状態

- 担当ブランチ: A1 統合・アーキテクチャ
- 成果物版: v0.1
- 統合ゲート: Gate 0 契約固定
- 次担当: A2 基盤・データ
- アプリケーションコード: 未実装

このコミットはアプリ本体ではなく、A2〜A7が守る統合契約とA2の作業入力を配置する。

## A2が最初に読む順序

1. `docs/a1/09_A2_FIRST_ASSIGNMENT.md`
2. `docs/spec/A2_PLATFORM_BASELINE.md`
3. `docs/a1/01_ARCHITECTURE_BASELINE.md`
4. `docs/a1/02_PUBLIC_API_CONTRACT.md`
5. `docs/a1/03_SERVICE_CONTRACTS.md`
6. `docs/a1/04_DATA_AND_EVENT_CONTRACTS.md`
7. `docs/a1/05_ERROR_CONTRACT.md`
8. `docs/a1/06_FILE_OWNERSHIP.md`
9. `docs/a1/07_INTEGRATION_GATES.md`
10. `docs/a1/contracts/*.schema.json`

## 変更規則

- A1承認なしに公開API、シート列、設定キー、エラーコードを変更しない。
- 担当外ファイルを直接変更しない。
- 変更提案は `docs/a1/templates/CHANGE_REQUEST.md` を使う。
- 引継ぎは `docs/a1/templates/HANDOFF_REPORT.md` を満たす。
- A2の最終成果物はリポジトリ直下へ展開可能なZIPで提出する。

## 現在含まれるもの

- A1統合契約
- JSON Schema 4種
- ファイル所有権
- 統合ゲート
- A2初回作業指示
- A2基盤実装ベースライン
- GitHub転記用のコミット・PR情報

## 現在含まれないもの

- Apps Script本体コード
- WebUI
- Gemini API実装
- テストコード
- 本番ID、APIキー、メールアドレス

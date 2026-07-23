# A1 統合契約パッケージ v0.2

## 目的

個人専用・自発会話AIの実装開始前に、各AIエージェントが守る契約を固定する。

v0.2はPR #1のChanges requestedを反映した再レビュー版である。

## このパッケージだけでA2が参照できる文書

- [`01_ARCHITECTURE_BASELINE.md`](01_ARCHITECTURE_BASELINE.md)
- [`02_PUBLIC_API_CONTRACT.md`](02_PUBLIC_API_CONTRACT.md)
- [`03_SERVICE_CONTRACTS.md`](03_SERVICE_CONTRACTS.md)
- [`04_DATA_AND_EVENT_CONTRACTS.md`](04_DATA_AND_EVENT_CONTRACTS.md)
- [`05_ERROR_CONTRACT.md`](05_ERROR_CONTRACT.md)
- [`06_FILE_OWNERSHIP.md`](06_FILE_OWNERSHIP.md)
- [`07_INTEGRATION_GATES.md`](07_INTEGRATION_GATES.md)
- [`08_WORK_BREAKDOWN.md`](08_WORK_BREAKDOWN.md)
- [`09_A2_FIRST_ASSIGNMENT.md`](09_A2_FIRST_ASSIGNMENT.md)
- [`10_REVIEW_RESOLUTIONS.md`](10_REVIEW_RESOLUTIONS.md)
- [`../spec/A2_PLATFORM_BASELINE.md`](../spec/A2_PLATFORM_BASELINE.md)
- [`contracts/chat-request.schema.json`](contracts/chat-request.schema.json)
- [`contracts/chat-result.schema.json`](contracts/chat-result.schema.json)
- [`contracts/character-profile-v2.schema.json`](contracts/character-profile-v2.schema.json)
- [`contracts/approved-character-artifact.schema.json`](contracts/approved-character-artifact.schema.json)
- [`contracts/event.schema.json`](contracts/event.schema.json)
- [`contracts/immersion-guard-decision.schema.json`](contracts/immersion-guard-decision.schema.json)
- [`contracts/immersion-semantic-verdict.schema.json`](contracts/immersion-semantic-verdict.schema.json)
- [`contracts/memory-candidate.schema.json`](contracts/memory-candidate.schema.json)
- [`contracts/memory-candidates.schema.json`](contracts/memory-candidates.schema.json)
- `contracts/events/*.schema.json`
- `templates/*.md`

## 優先順位

1. A1の公開API・サービス・データ・エラー契約
2. A2基盤実装ベースライン
3. 各担当エージェントの実装判断

矛盾または不足がある場合は [`templates/CHANGE_REQUEST.md`](templates/CHANGE_REQUEST.md) を提出し、独断で契約を変更しない。

## A1の責務

- 公開API、データ型、エラー、所有ファイルの固定
- 担当間の依存関係管理
- 仕様変更の承認
- 統合順序と受入ゲートの管理
- 最終成果物の整合性確認

## 重要ルール

- 全実装ファイルを `src/` 配下へ置く。
- 担当外ファイルを直接変更しない。
- 公開API、シート列、設定キー、エラーコードはA1承認なしで変更しない。
- 変更申請は [`templates/CHANGE_REQUEST.md`](templates/CHANGE_REQUEST.md) を使う。
- 成果物は [`templates/HANDOFF_REPORT.md`](templates/HANDOFF_REPORT.md) の形式を満たす。
- テストのない実装は受領しない。
- 契約検証はリポジトリ直下で `python3 tools/validate_contracts.py` を実行する。
- Active character targetは `character-profile.v2` とcode-ownedな単一
  CharacterPackの組合せとする。V1や`SYSTEM_PERSONA`を自動変換しない。
- 1 app/deploymentは1 CharacterPackだけを持つ。別の推しは共通engineを再利用した
  別deploymentとし、profile selectorで切り替えない。
- `PRODUCT_INFO` / `ADMIN_OOC` はcharacter artifactを作らず、技術透明性は
  onboarding/About/status UIへ出す。
- 新しいproactive本文は毎回生成し、固定または設定template fallbackを送らない。

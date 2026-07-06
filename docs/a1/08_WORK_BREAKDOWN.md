# 8. 作業分解と依存関係

## Phase 1

並列:
- A1: 契約固定、レビュー基準
- A2: 基盤実装
- A7: テスト計画、故障注入計画

ブロッカー:
- A3〜A6は契約固定前に本実装を開始しない。

## Phase 2

並列:
- A3: WebUI
- A4: 会話・Gemini・画像
- A5: 長期記憶・日記
- A6: キュー・自発通知・ジョブ

前提:
- A2の共通基盤がGate 1合格
- A1のAPI契約が固定

## Phase 3

統合順:
1. A2
2. A4
3. A3
4. A5
5. A6
6. A7

## ブランチ名

```text
a1/integration
a2/platform-data
a3/web-ui
a4/chat-gemini-image
a5/memory-diary
a6/queue-proactive-jobs
a7/qa-security
```

## コミット規則

```text
[A2][FR-070] Add config repository validation
[A4][FR-010] Implement idempotent chat send
[A7][AT-009] Add Gemini temporary failure test
```

## PR必須項目

- 対応設計書項番
- 変更ファイル
- 公開契約変更の有無
- 設定・スキーマ変更の有無
- テスト結果
- 既知の制約
- ロールバック方法

# 10. PR #1 レビュー対応表

## 10.1 Changes requested

| No. | 指摘 | 対応 |
|---:|---|---|
| 1 | ChatResultのstatus別必須条件 | `chat-result.schema.json` の条件Schemaで固定 |
| 2 | `WEEKLY_BACKUP` eventType | Event enum、payload、dedupe規則へ追加 |
| 3 | Event状態遷移 | 許可遷移を4系統へ限定し、DEAD再試行は新規イベント化 |
| 4 | 全payload Schema | `contracts/events/*.schema.json` を5種追加 |
| 5 | conversation一意性 | `(request_id, role)` 複合一意、Repository戻り値を組に変更 |
| 6 | Script Properties | setup前、setup生成、デプロイ後へ分類 |
| 7 | 実装パス | 全て `src/` 配下へ統一 |
| 8 | QueueService所有 | `src/application/QueueService.gs` をA6所有へ追加 |
| 9 | MemoryCandidate | action別条件と候補配列Schemaを追加 |
| 10 | アクセス制御 | デプロイ設定を主制御としSession依存を禁止 |
| 11 | Mail quota | 専用の翌日再評価戦略へ変更 |
| 12 | 文字コード・改行 | `.gitattributes`、`.editorconfig` を追加 |
| 13 | 一時ファイル | `.github` 転記ファイルとルートHANDOFFを削除 |
| 14 | 再実行可能検証 | `tools/validate_contracts.py` を追加 |

## 10.2 Codexレビュー2件

PR上のCodexコメント本文・コメントIDはこの作業入力に含まれていないため、ID単位の照合はできない。レビューで問題となる以下の2系統を契約上解消した。

1. **契約整合性**: Event enumとdedupe規則の不一致、payload未定義、状態遷移の例外を解消した。
2. **リポジトリ衛生**: 実装パスの混在、GitHub転記用一時ファイル、再現不能な手動検証を解消した。

GitHub上では、該当コメントに本コミットを紐付けたうえでResolveする。コメント本文が上記と異なる場合は、A1へ再度Changes requestedとする。

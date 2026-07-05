# 9. A2への最初の作業指示

## 目的

A3〜A6が安全に並列実装できる共通基盤を作る。

## 参照範囲

基本設計書:
- 3章
- 5章
- 8章
- 9章
- 10.3
- 13章
- 14.2〜14.3
- 17章
- 19章
- 21章
- 付録A/B

A1契約:
- 全文

## 実装対象

```text
common/Constants.gs
common/Errors.gs
common/LockManager.gs
common/RetryPolicy.gs
common/Validators.gs
common/Json.gs
common/AppLogger.gs
infrastructure/SheetRepository.gs
infrastructure/ConfigRepository.gs
infrastructure/DocumentRepository.gs
infrastructure/DriveTempRepository.gs
Setup.gs
appsscript.json（案のみ。最終所有はA1）
```

## 必須成果物

1. `setup()`
2. `migrateSchema()`
3. `runPlatformSelfTest()`
4. 全シートの冪等作成
5. config初期値
6. Script Properties検証
7. Repository CRUD
8. AppError
9. ログマスキング
10. 単体テスト
11. HANDOFF_REPORT

## 合格条件

- setupを2回実行して重複シート・重複列が生じない。
- シート列が基本設計書と一致する。
- 列削除・順番変更を行わない。
- APIキーをシート・ログへ保存しない。
- Repositoryが行番号を外へ返さない。
- JSON破損を検出できる。
- Lock取得失敗を正常に扱える。
- RetryPolicyが設計どおりの間隔を返す。


## 提出形式

利用者はコード編集を行わない。A2は作業完了時に以下を一つのZIPとして提出する。

1. リポジトリ直下からの完全なファイル構成
2. 追加・変更する全ファイルの完全版
3. READMEまたはHANDOFF.md
4. コミットメッセージ
5. PRタイトル
6. PR本文
7. 変更ファイル一覧
8. 実行したテストと結果
9. 未実装事項
10. 他担当との競合可能性

ZIPはリポジトリ直下へ展開すれば配置が完了する構造にする。差分パッチだけの提出は禁止する。

# 7. 統合ゲート

## Gate 0: 契約固定

合格条件:

- 公開APIが確定
- シート列が確定
- 設定キーと検証タイミングが確定
- エラーコードと再試行戦略が確定
- 全eventTypeとpayload Schemaが確定
- 所有ファイルが確定
- 全実装パスが `src/` 配下で統一
- `python tools/validate_contracts.py` がPASS
- 各Agentが担当範囲を受領

## Gate 1: A2基盤

合格条件:

- `setup()` が冪等
- 全シートが作成される
- setup前、setup後、デプロイ後のScript Properties検証が分離されている
- Repositoryの基本CRUD
- `(request_id, role)` 複合一意
- `getConversationByRequestId` がuser/assistantの組を返す
- `AppError`
- `LockManager`
- `RetryPolicy`
- `AppLogger`
- 単体テスト合格

## Gate 2: A4会話コア

合格条件:

- テキスト会話
- 画像理解
- `requestId` 冪等性
- `GeminiClient` 一元化
- 構造化出力検証
- 一時障害時のキュー起票
- APIキー漏洩なし

## Gate 3: A3 WebUI

合格条件:

- 最新30件
- 過去履歴
- 多重クリック防止
- 画像圧縮
- スマートフォン表示
- `textContent` 使用
- エラー表示

## Gate 4: A5記憶・日記

合格条件:

- 記憶抽出
- action別MemoryCandidate検証
- active/candidate
- 矛盾処理
- 関連記憶検索
- 日記生成
- 日記重複防止

## Gate 5: A6非同期・自発通知

合格条件:

- `src/application/QueueService.gs`
- 全eventType payload検証
- 規定のQueue状態遷移
- stale回収
- `DEAD` の新規イベント再起票
- 共通再試行
- `MAIL_QUOTA_EXHAUSTED` 専用再試行
- 自発通知の全ローカル条件
- Mail quota確認
- `WEEKLY_BACKUP`
- 清掃

## Gate 6: A7総合試験

合格条件:

- 受入試験30件
- セキュリティ試験
- 429/5xx/不正JSON
- ロック競合
- 無料枠停止
- バックアップ・復元
- スマートフォン実機
- 未解決事項一覧

## Gate 7: 本番承認

合格条件:

- READMEだけで再構築可能
- 本番/テストID分離
- `/exec` URL確定
- デプロイ設定が所有者本人のみ
- `Session.getActiveUser().getEmail()` に認可依存していない
- ロールバック手順確認
- 既知制約承認

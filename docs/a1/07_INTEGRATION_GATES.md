# 7. 統合ゲート

## Gate 0: 契約固定

合格条件:
- 公開APIが確定
- シート列が確定
- 設定キーが確定
- エラーコードが確定
- 所有ファイルが確定
- 各Agentが担当範囲を受領

## Gate 1: A2基盤

合格条件:
- setupが冪等
- 全シートが作成される
- Script Properties検証
- Repositoryの基本CRUD
- AppError
- LockManager
- RetryPolicy
- AppLogger
- 単体テスト合格

## Gate 2: A4会話コア

合格条件:
- テキスト会話
- 画像理解
- requestId冪等性
- GeminiClient一元化
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
- textContent使用
- エラー表示

## Gate 4: A5記憶・日記

合格条件:
- 記憶抽出
- active/candidate
- 矛盾処理
- 関連記憶検索
- 日記生成
- 日記重複防止

## Gate 5: A6非同期・自発通知

合格条件:
- Queue状態遷移
- stale回収
- 再試行
- DEAD
- 自発通知の全ローカル条件
- Mail quota確認
- バックアップ
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
- 所有者本人のみ
- ロールバック手順確認
- 既知制約承認

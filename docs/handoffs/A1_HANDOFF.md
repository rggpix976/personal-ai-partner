# A1 Handoff - PR #1 Changes Requested対応

## 1. 状態

- ブランチ: `a1/integration`
- 対象PR: PR #1
- 判定: Changes requested対応済み、再レビュー待ち
- Gate: Gate 0契約固定
- 成果物版: v0.2
- マージ: まだ行わない
- 次工程: PR #1再承認後にA2へGate 1実装を依頼

## 2. リポジトリ直下からの完全なファイル構成

```text
.
├── .editorconfig
├── .gitattributes
├── README.md
├── requirements-dev.txt
├── docs/
│   ├── a1/
│   │   ├── contracts/
│   │   │   ├── events/
│   │   │   │   ├── chat-reply-payload.schema.json
│   │   │   │   ├── diary-generate-payload.schema.json
│   │   │   │   ├── memory-extract-payload.schema.json
│   │   │   │   ├── proactive-send-payload.schema.json
│   │   │   │   └── weekly-backup-payload.schema.json
│   │   │   ├── chat-request.schema.json
│   │   │   ├── chat-result.schema.json
│   │   │   ├── event.schema.json
│   │   │   ├── memory-candidate.schema.json
│   │   │   └── memory-candidates.schema.json
│   │   ├── templates/
│   │   │   ├── CHANGE_REQUEST.md
│   │   │   └── HANDOFF_REPORT.md
│   │   ├── 01_ARCHITECTURE_BASELINE.md
│   │   ├── 02_PUBLIC_API_CONTRACT.md
│   │   ├── 03_SERVICE_CONTRACTS.md
│   │   ├── 04_DATA_AND_EVENT_CONTRACTS.md
│   │   ├── 05_ERROR_CONTRACT.md
│   │   ├── 06_FILE_OWNERSHIP.md
│   │   ├── 07_INTEGRATION_GATES.md
│   │   ├── 08_WORK_BREAKDOWN.md
│   │   ├── 09_A2_FIRST_ASSIGNMENT.md
│   │   ├── 10_REVIEW_RESOLUTIONS.md
│   │   └── README.md
│   ├── handoffs/
│   │   └── A1_HANDOFF.md
│   └── spec/
│       └── A2_PLATFORM_BASELINE.md
└── tools/
    └── validate_contracts.py
```

このZIPには余分な親ディレクトリを含めない。リポジトリ直下で展開する。

Apps Script実装は全て `src/` 配下へ置く契約だが、Gate 0では実装コードが未着手のため、現コミットに `src/` の実ファイルは含まれない。

## 3. 変更一覧

### 追加

- `.editorconfig`
- `.gitattributes`
- `docs/a1/10_REVIEW_RESOLUTIONS.md`
- `docs/a1/contracts/events/chat-reply-payload.schema.json`
- `docs/a1/contracts/events/diary-generate-payload.schema.json`
- `docs/a1/contracts/events/memory-extract-payload.schema.json`
- `docs/a1/contracts/events/proactive-send-payload.schema.json`
- `docs/a1/contracts/events/weekly-backup-payload.schema.json`
- `docs/a1/contracts/memory-candidates.schema.json`
- `docs/handoffs/A1_HANDOFF.md`
- `requirements-dev.txt`
- `tools/validate_contracts.py`

### 変更

- `README.md`
- `docs/a1/01_ARCHITECTURE_BASELINE.md`
- `docs/a1/02_PUBLIC_API_CONTRACT.md`
- `docs/a1/03_SERVICE_CONTRACTS.md`
- `docs/a1/04_DATA_AND_EVENT_CONTRACTS.md`
- `docs/a1/05_ERROR_CONTRACT.md`
- `docs/a1/06_FILE_OWNERSHIP.md`
- `docs/a1/07_INTEGRATION_GATES.md`
- `docs/a1/09_A2_FIRST_ASSIGNMENT.md`
- `docs/a1/README.md`
- `docs/a1/contracts/chat-request.schema.json`
- `docs/a1/contracts/chat-result.schema.json`
- `docs/a1/contracts/event.schema.json`
- `docs/a1/contracts/memory-candidate.schema.json`
- `docs/a1/templates/HANDOFF_REPORT.md`
- `docs/spec/A2_PLATFORM_BASELINE.md`

### 削除

- `.github/COMMIT_MESSAGE.txt`
- `.github/PR_TITLE.txt`
- `.github/PULL_REQUEST_BODY.md`
- `HANDOFF.md`

削除対象はGitHub転記用の一時ファイルと、旧ルートHANDOFFである。PR情報は本書へ集約した。

## 4. 契約変更一覧

1. `ChatResult` にstatus別条件を追加した。
   - `completed`: `userMessage`、`assistantMessage` 必須
   - `queued`: `userMessage`、`retryAfterSeconds` 必須
   - `failed`: `error` 必須
2. `WEEKLY_BACKUP` を正式なeventTypeへ追加した。
3. Event状態遷移を次のみに限定した。
   - `PENDING -> PROCESSING`
   - `PROCESSING -> DONE | RETRY_WAIT | DEAD`
   - `RETRY_WAIT -> PROCESSING`
   - `PROCESSING(stale) -> RETRY_WAIT`
4. `DEAD` の手動再試行は既存行を戻さず、新しいeventとして再起票する。
5. 全5 eventTypeのpayload Schemaを追加した。
6. `conversation_logs` の一意性を `request_id` 単独から `(request_id, role)` 複合一意へ変更した。
7. `getConversationByRequestId` の戻り値を `userMessage` と `assistantMessage` の組へ変更した。
8. Script Propertiesをsetup前必須、setup生成、デプロイ後必須へ分類した。
9. 全Apps Script実装パスを `src/` 配下へ統一した。
10. `src/application/QueueService.gs` をA6所有へ追加した。
11. `MemoryCandidate` にaction別条件を追加し、候補配列Schemaを追加した。
12. 個人専用アクセス制御はデプロイ設定を主制御とし、`Session.getActiveUser().getEmail()` へ依存しない契約にした。
13. `MAIL_QUOTA_EXHAUSTED` を共通短時間リトライから除外し、翌日枠での専用再評価へ変更した。
14. UTF-8/LF正規化と再実行可能な契約検証を追加した。

## 5. Codexレビュー2件

コメント本文とコメントIDは作業入力に含まれていないため、GitHub上のID単位照合は未実施である。契約上は次の2系統を解消した。

1. Event enum、payload、dedupe、状態遷移の不整合
2. 実装パス混在、一時転記ファイル、手動のみの検証

対応詳細は `docs/a1/10_REVIEW_RESOLUTIONS.md` を参照する。GitHub上では本コミットを該当コメントへ紐付けてResolveする。コメントの内容が異なる場合は再度Changes requestedとする。

## 6. テストコマンド

依存導入:

```bash
python3 -m pip install -r requirements-dev.txt
```

契約検証:

```bash
python3 tools/validate_contracts.py
```

## 7. テスト結果

| Test | 結果 | 内容 |
|---|---|---|
| VAL-001 | PASS | 必須パス存在 |
| VAL-002 | PASS | GitHub転記用一時ファイル不在 |
| VAL-003 | PASS | 全テキストがUTF-8/LF、最終改行あり |
| VAL-004 | PASS | JSON 10ファイル構文解析 |
| VAL-005 | PASS | JSON Schema 10ファイルがDraft 2020-12として有効 |
| VAL-006 | PASS | ChatResultのcompleted/queued/failed条件 |
| VAL-007 | PASS | 全5 eventTypeのpayload検証 |
| VAL-008 | PASS | eventTypeと異なるpayloadを拒否 |
| VAL-009 | PASS | MemoryCandidateの4 action条件 |
| VAL-010 | PASS | MemoryCandidate配列Schema |
| VAL-011 | PASS | Markdown相対リンク |
| VAL-012 | PASS | 秘密値パターンスキャン |
| PKG-001 | PASS | ZIPエントリ30件がリポジトリ直下のファイル集合と完全一致 |
| PKG-002 | PASS | 絶対パス、`..`、余分な親ディレクトリなし |
| PKG-003 | PASS | ZIP再展開後に契約検証を再実行し26件全てPASS |

検証スクリプト集計:

```text
Summary: 26 passed, 0 failed
```

Apps Script本体は未実装のため、Googleサービス上の実行試験はまだ対象外である。

## 8. A2へ影響する事項

A2は以前のv0.1ではなく、本コミットのv0.2だけを入力として作業する。

必須変更:

- 実装ファイルを全て `src/` 配下へ作成する。
- `src/appsscript.json` を案として提出する。
- `src/Setup.gs` と `src/common/*`、`src/infrastructure/*` を実装する。
- Script Properties検証を3段階へ分離する。
- `conversation_logs` で `(request_id, role)` 複合一意を実装する。
- `getConversationByRequestId` はuser/assistantの組を返す。
- `MAIL_QUOTA_EXHAUSTED` を共通RetryPolicyへ流さない。
- `src/application/QueueService.gs` はA6所有のため実装しない。
- A2引継ぎは `docs/handoffs/A2_HANDOFF.md` へ置く。
- A2成果物でも `python3 tools/validate_contracts.py` を通す。

A2はv0.1を基に既に作業している場合、実装を続行せず、本契約との差分を先に取り込む。

## 9. コミットメッセージ

```text
[A1][Gate-0] Address PR #1 contract review
```

同一ブランチへ追加コミットする。

## 10. PRタイトル

既存PR #1のタイトルは変更しない。

```text
[A1] Freeze integration contracts and prepare A2 platform work
```

## 11. PR本文・再レビュー依頼

以下をPR #1本文の追記または再レビューコメントとして使用する。

```markdown
## Changes requested対応

PR #1の指摘14件を同一ブランチの追加コミットで反映しました。

主な契約変更:
- ChatResultのstatus別必須条件
- WEEKLY_BACKUPと全event payload Schema
- Event状態遷移とDEAD再起票規則
- `(request_id, role)`複合一意
- Script Propertiesの段階別検証
- 全実装パスの`src/`統一
- QueueServiceのA6所有
- MemoryCandidateのaction別Schema
- デプロイ設定を主とする個人専用アクセス制御
- Mail quota専用再試行
- UTF-8/LF正規化
- 再実行可能な契約検証

テスト:
`python3 tools/validate_contracts.py`

結果:
`26 passed, 0 failed`

GitHub転記用の一時ファイルはmain対象から除外し、HANDOFFを`docs/handoffs/A1_HANDOFF.md`へ移動しました。

A2向け仕様もv0.2へ同期済みです。再レビューをお願いします。承認されるまでマージしません。
```

## 12. 未実装事項

- `src/appsscript.json`
- `src/Setup.gs`
- `src/PublicApi.gs`
- `src/common/*.gs`
- `src/infrastructure/*.gs`
- `src/application/*.gs`
- `src/jobs/*.gs`
- `src/web/*`
- `src/tests/*`
- Googleサービス上でのsetup、権限承認、Webアプリデプロイ
- 実APIを使った結合試験
- GitHub上のCodexコメントIDへのResolve操作

## 13. 他担当との競合可能性

- A2がv0.1のScript Properties、`request_id` 一意性、旧実装パスで着手済みの場合は競合する。
- A6の `QueueService` とA2のQueue共通部品の責務境界を混同すると競合する。
- A4が旧 `ChatResult` Schemaを前提にすると返却値が契約違反になる。
- A5が単一MemoryCandidateだけを返す実装を作ると配列Schemaと競合する。
- 既存リポジトリに `.editorconfig`、`.gitattributes` がある場合は内容を比較して統合する。
- `README.md`、`docs/a1/*`、`docs/spec/A2_PLATFORM_BASELINE.md` はA1所有である。

## 14. ロールバック

本追加コミットをrevertする。アプリケーションコードやGoogle上のデータは変更していない。

ただし、A2以降がv0.2契約で着手した後にv0.1へ戻してはならない。その場合は新しいChange Requestで後方互換性と移行手順を定義する。

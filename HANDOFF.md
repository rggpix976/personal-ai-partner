# A1 Handoff

## 1. リポジトリ直下からの完全なファイル構成

```text
.
├── .github
│   ├── COMMIT_MESSAGE.txt
│   ├── PR_TITLE.txt
│   └── PULL_REQUEST_BODY.md
├── docs
│   ├── a1
│   │   ├── contracts
│   │   │   ├── chat-request.schema.json
│   │   │   ├── chat-result.schema.json
│   │   │   ├── event.schema.json
│   │   │   └── memory-candidate.schema.json
│   │   ├── templates
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
│   │   └── README.md
│   └── spec
│       └── A2_PLATFORM_BASELINE.md
├── HANDOFF.md
└── README.md
```

ZIPには親ディレクトリを含めていない。リポジトリ直下で展開する。

## 2. 追加・変更する全ファイル

- `.github/COMMIT_MESSAGE.txt`
- `.github/PR_TITLE.txt`
- `.github/PULL_REQUEST_BODY.md`
- `HANDOFF.md`
- `README.md`
- `docs/a1/01_ARCHITECTURE_BASELINE.md`
- `docs/a1/02_PUBLIC_API_CONTRACT.md`
- `docs/a1/03_SERVICE_CONTRACTS.md`
- `docs/a1/04_DATA_AND_EVENT_CONTRACTS.md`
- `docs/a1/05_ERROR_CONTRACT.md`
- `docs/a1/06_FILE_OWNERSHIP.md`
- `docs/a1/07_INTEGRATION_GATES.md`
- `docs/a1/08_WORK_BREAKDOWN.md`
- `docs/a1/09_A2_FIRST_ASSIGNMENT.md`
- `docs/a1/README.md`
- `docs/a1/contracts/chat-request.schema.json`
- `docs/a1/contracts/chat-result.schema.json`
- `docs/a1/contracts/event.schema.json`
- `docs/a1/contracts/memory-candidate.schema.json`
- `docs/a1/templates/CHANGE_REQUEST.md`
- `docs/a1/templates/HANDOFF_REPORT.md`
- `docs/spec/A2_PLATFORM_BASELINE.md`

全ファイルは完全版であり、差分パッチではない。

## 3. README / HANDOFF

- 入口: `README.md`
- 本引継ぎ: `HANDOFF.md`
- A1契約入口: `docs/a1/README.md`
- A2作業指示: `docs/a1/09_A2_FIRST_ASSIGNMENT.md`
- A2基盤仕様: `docs/spec/A2_PLATFORM_BASELINE.md`

## 4. コミットメッセージ

```text
[A1][Gate-0] Add integration contracts and A2 platform baseline
```

同じ内容を `.github/COMMIT_MESSAGE.txt` に格納している。

## 5. PRタイトル

```text
[A1] Freeze integration contracts and prepare A2 platform work
```

同じ内容を `.github/PR_TITLE.txt` に格納している。

## 6. PR本文

`.github/PULL_REQUEST_BODY.md` の全文をGitHubへ貼り付ける。

## 7. 変更ファイル一覧

上記「2. 追加・変更する全ファイル」と同一である。

## 8. 実行したテストと結果

| Test | 結果 | 内容 |
|---|---|---|
| PKG-001 | PASS | ZIP直下に余分な親フォルダがない |
| PKG-002 | PASS | README、HANDOFF、GitHub転記情報、A1契約、A2仕様が存在する |
| PKG-003 | PASS | JSON 4ファイルが構文解析できる |
| PKG-004 | PASS | JSON Schema 4ファイルがDraft 2020-12として有効 |
| PKG-005 | PASS | Markdown内の相対ファイル参照が存在する |
| PKG-006 | PASS | APIキー、実メールアドレス、GoogleファイルIDを含まない |
| PKG-007 | PASS | ZIPエントリに絶対パスまたは`..`がない |
| PKG-008 | PASS | 全テキストファイルがUTF-8で読める |

アプリケーションコードはまだ存在しないため、Apps Script実行試験は対象外である。

## 9. 未実装事項

- `appsscript.json`
- `Setup.gs`
- `PublicApi.gs`
- `common/*.gs`
- `infrastructure/*.gs`
- `application/*.gs`
- `jobs/*.gs`
- `web/*`
- `tests/*`
- Googleサービス上でのsetup、権限承認、Webアプリデプロイ
- 実APIを使った結合試験

次の実装担当はA2である。

## 10. 他担当との競合可能性

- 既存のルート`README.md`がある場合は競合する。
- 既存のルート`HANDOFF.md`がある場合は競合する。
- 既存の`.github/PULL_REQUEST_BODY.md`がある場合は競合する。
- `docs/a1`および`docs/spec/A2_PLATFORM_BASELINE.md`はA1所有とする。
- A2は`appsscript.json`案を提出できるが、最終所有はA1である。
- A2が公開API、シート列、設定キー、エラーコードを変更する場合はChange Requestが必要である。

## 配置手順

1. ZIPをGitHubリポジトリ直下で展開する。
2. ファイル構成を確認する。
3. `.github/COMMIT_MESSAGE.txt`の内容でコミットする。
4. `.github/PR_TITLE.txt`をPRタイトルに使う。
5. `.github/PULL_REQUEST_BODY.md`をPR本文に貼り付ける。

コード編集は不要である。

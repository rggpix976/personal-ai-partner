# 6. ファイル所有権

## 6.1 所有者

全ての実装ファイルは `src/` 配下へ置く。

| ファイル | 所有Agent | 共同レビュー |
|---|---|---|
| `src/PublicApi.gs` | A1 | A3, A4 |
| `src/appsscript.json` | A1 | A2, A7 |
| `README.md` | A1 | 全員 |
| `src/web/WebController.gs` | A3 | A1 |
| `src/web/Index.html` | A3 | A7 |
| `src/web/Styles.html` | A3 | A7 |
| `src/web/Client.html` | A3 | A7 |
| `src/application/ChatService.gs` | A4 | A1, A6 |
| `src/application/ContextService.gs` | A4 | A5 |
| `src/application/ImageService.gs` | A4 | A2, A7 |
| `src/application/MemoryService.gs` | A5 | A4 |
| `src/application/DiaryService.gs` | A5 | A6 |
| `src/application/QueueService.gs` | A6 | A1, A2, A7 |
| `src/application/ProactiveMessageService.gs` | A6 | A5 |
| `src/application/MaintenanceService.gs` | A6 | A2 |
| `src/infrastructure/GeminiClient.gs` | A4 | A1, A7 |
| `src/infrastructure/SheetRepository.gs` | A2 | A1 |
| `src/infrastructure/DocumentRepository.gs` | A2 | A5 |
| `src/infrastructure/DriveTempRepository.gs` | A2 | A4, A7 |
| `src/infrastructure/GmailNotifier.gs` | A6 | A2, A7 |
| `src/infrastructure/ConfigRepository.gs` | A2 | A1 |
| `src/jobs/ProcessQueueJob.gs` | A6 | A1, A7 |
| `src/jobs/SchedulerJob.gs` | A6 | A1, A7 |
| `src/common/Constants.gs` | A2 | A1 |
| `src/common/Errors.gs` | A2 | A1, A7 |
| `src/common/LockManager.gs` | A2 | A6 |
| `src/common/RetryPolicy.gs` | A2 | A6 |
| `src/common/Validators.gs` | A2 | A3, A4 |
| `src/common/Json.gs` | A2 | A4, A5 |
| `src/common/AppLogger.gs` | A2 | A7 |
| `src/Setup.gs` | A2 | A1, A7 |
| `src/tests/*` | A7 | 各所有Agent |
| `docs/a1/*` | A1 | 影響Agent |
| `docs/spec/*` | A1 | A2, A7 |
| `docs/handoffs/A1_HANDOFF.md` | A1 | A7 |
| `tools/validate_contracts.py` | A1 | A7 |
| `.gitattributes` | A1 | A7 |
| `.editorconfig` | A1 | A7 |

## 6.2 変更ルール

- 所有者以外は直接修正しない。
- 修正提案は `docs/a1/templates/CHANGE_REQUEST.md` で提出する。
- A1が契約変更と判断した場合、影響Agent全員の再承認が必要。
- 緊急修正でもA1の記録を残す。
- `src/application/QueueService.gs` はA6所有であり、A2はRepository・Lock・Retryの共通部品だけを提供する。

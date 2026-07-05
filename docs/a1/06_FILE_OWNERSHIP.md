# 6. ファイル所有権

## 6.1 所有者

| ファイル | 所有Agent | 共同レビュー |
|---|---|---|
| `PublicApi.gs` | A1 | A3, A4 |
| `appsscript.json` | A1 | A2, A7 |
| `README.md` | A1 | 全員 |
| `web/WebController.gs` | A3 | A1 |
| `web/Index.html` | A3 | A7 |
| `web/Styles.html` | A3 | A7 |
| `web/Client.html` | A3 | A7 |
| `application/ChatService.gs` | A4 | A1, A6 |
| `application/ContextService.gs` | A4 | A5 |
| `application/ImageService.gs` | A4 | A2, A7 |
| `application/MemoryService.gs` | A5 | A4 |
| `application/DiaryService.gs` | A5 | A6 |
| `application/ProactiveMessageService.gs` | A6 | A5 |
| `application/MaintenanceService.gs` | A6 | A2 |
| `infrastructure/GeminiClient.gs` | A4 | A1, A7 |
| `infrastructure/SheetRepository.gs` | A2 | A1 |
| `infrastructure/DocumentRepository.gs` | A2 | A5 |
| `infrastructure/DriveTempRepository.gs` | A2 | A4, A7 |
| `infrastructure/GmailNotifier.gs` | A6 | A2, A7 |
| `infrastructure/ConfigRepository.gs` | A2 | A1 |
| `jobs/ProcessQueueJob.gs` | A6 | A1, A7 |
| `jobs/SchedulerJob.gs` | A6 | A1, A7 |
| `common/Constants.gs` | A2 | A1 |
| `common/Errors.gs` | A2 | A1, A7 |
| `common/LockManager.gs` | A2 | A6 |
| `common/RetryPolicy.gs` | A2 | A6 |
| `common/Validators.gs` | A2 | A3, A4 |
| `common/Json.gs` | A2 | A4, A5 |
| `common/AppLogger.gs` | A2 | A7 |
| `Setup.gs` | A2 | A1, A7 |
| `tests/*` | A7 | 各所有Agent |

## 6.2 変更ルール

- 所有者以外は直接修正しない。
- 修正提案はCHANGE_REQUESTで提出する。
- A1が契約変更と判断した場合、影響Agent全員の再承認が必要。
- 緊急修正でもA1の記録を残す。

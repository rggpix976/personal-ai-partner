# 用途別Geminiモデル本番テスト手順

## 1. 目的

本番Webアプリで、利用者向け生成を`gemini-3.6-flash`、意味検証と記憶抽出を
`gemini-3.5-flash-lite`へ分離しても、人格、画像、日記、記憶、自発発言、
安全fallbackが正常であることを確認する。

この手順は会話本文、各種ID、URL、メールアドレス、API key、Script Propertiesの
秘密値を証跡へ記録しない。

## 2. 中止条件

次のいずれかに該当したら変更せず停止する。

- reviewed commitと配置対象commitが一致しない。
- 作業ツリーが空でない。
- 現行Webアプリのimmutable versionを復帰点として確認できない。
- owner-only Web App deploymentが0件または複数件ある。
- `runOperationalHealthCheck()`が`OK`ではない。
- `processQueueJob`と`schedulerJob`以外の時間主導triggerがある、または各triggerが
  1件ではない。
- 未解決の`DEAD`、staleな`PROCESSING`、期限超過queueがある。
- AI Studioで対象projectが無料枠ではない、または当日のRPDにテスト余力がない。

## 3. 配置前の復帰点

1. 現行Webアプリのversion番号を非公開の運用記録へ控える。
2. 現行commitを控える。
3. `config`シートの次の値だけを控える。

   ```text
   GEMINI_MODEL
   GEMINI_MODEL_ROUTING_MODE（存在する場合）
   GEMINI_GENERATION_MODEL（存在する場合）
   GEMINI_UTILITY_MODEL（存在する場合）
   ```

4. trigger、health、queueの安全条件を読み取り専用で確認する。

合格条件：旧Webアプリversionと旧モデル設定へ戻せる。

## 4. 新コードをsingleモードで配置する

1. reviewed branchの`src/`をApps Script editorへ配置する。この時点では既存Web App
   deploymentを旧versionから動かさない。
2. Apps Script editor HEADで全self-testを実行する。
3. `migrateSchema()`を1回実行する。新しいconfigの初期値は`single`であり、
   `IMAGE_ARCHIVE_FOLDER_ID`も作成される。
4. `validatePostSetupProperties()`を実行する。
5. `inspectGeminiModelRouting()`を実行し、次の期待結果と一致することを確認する。
6. 新しいimmutable versionを作成する。
7. 既存のowner-only Web App deploymentを新versionへ更新する。
8. `validatePostDeployProperties()`を実行する。

期待結果：

```text
ok=true
routingMode=single
roles.generation.model=現在のGEMINI_MODEL
roles.utility.model=現在のGEMINI_MODEL
```

この段階では`GEMINI_MODEL_ROUTING_MODE`を`split`へ変更しない。

## 5. singleモードの無変更確認

Webアプリを再読み込みし、次のような短い通常会話を1件送信する。

```text
今日はどんな一日やった？
```

合格条件：

- 利用者発言1件と推しの返答1件が正しい順序で表示される。
- 返答が設定済みの名前、一人称、落ち着いた関西弁を維持する。
- 「すまんな、よう聞こえへんかった。」の固定fallbackにならない。
- `GeminiClient.metric`が`modelRole=GENERATION`と`modelRole=UTILITY`の成功を示す。
- 両roleのmodelが現在の`GEMINI_MODEL`である。

不合格なら旧Webアプリversionへ戻し、`split`へ進まない。

## 6. splitモードを有効にする

AI StudioのRPDが切り替わった後、`config`シートの値を次のとおり確認する。

```text
GEMINI_GENERATION_MODEL=gemini-3.6-flash
GEMINI_UTILITY_MODEL=gemini-3.5-flash-lite
```

次に変更する値は1件だけである。

```text
GEMINI_MODEL_ROUTING_MODE=split
```

`inspectGeminiModelRouting()`を実行する。

期待結果：

```text
ok=true
routingMode=split
roles.generation.model=gemini-3.6-flash
roles.utility.model=gemini-3.5-flash-lite
```

## 7. 通常会話テスト

Webアプリで、保存されてもよい実際の内容を3件送信する。たとえば次を参考にし、
事実と異なる内容は使用しない。

```text
今日は少しゆっくりしてたで。
晩ごはん、何にしようか迷ってる。
疲れたときはどう休んだらええと思う？
```

合格条件：

- 各送信に返答が1件あり、エラー・重複・表示順逆転がない。
- 名前、一人称、関西弁、温厚で世話焼きな人格が維持される。
- AI、モデル、システム、プロンプト等の自己言及がない。
- 不自然な直接的愛情表現、返信圧力、根拠のない現実断定がない。
- 固定fallbackが出ない。
- 成功した各会話に、3.6の`GENERATION`と3.5 Flash-Liteの`UTILITY`が各1回ある。
- rewriteが発生しなければ、1会話あたりのAPI呼び出しは2回である。

## 8. 画像テスト

秘密情報や人物の個人情報を含まないJPEG、PNG、またはWebPを1枚添付し、次を送信する。

```text
この画像で分かることだけ教えて。
```

合格条件：

- 画像から確認できる内容だけを答える。
- 見えない情報を推測で断定しない。
- 画像付き利用者発言と返答の表示順が正しい。
- 生成は3.6の`GENERATION`、意味検証は3.5 Flash-Liteの`UTILITY`である。
- 一時画像が既存のcleanup契約に従って削除される。
- 同じ画像付き発言を履歴で見返すと、恒久保存された画像が吹き出し内に表示される。
  画像をクリックすると拡大表示でき、閉じると会話へ戻れる。
- この変更より前に送った画像は復元されず、ファイル名などのメタデータと
  「この過去画像は保存されていません。」の表示になる。

## 9. 24〜72時間の実運用観察

通常利用を継続し、次を安全な集計だけで確認する。

- 次の記憶抽出が3.5 Flash-Liteで`DONE / PROCESSED`になる。
- 次の日記が3.6で生成され、3.5 Flash-Liteで検証される。
- 日記本文が会話の最後の話題だけへ偏らず、長期記憶と推しの世界を自然に含む。
- 次の自発発言が3.6で生成され、Webチャットとメールの既存仕様を維持する。
- 429、空応答、不正JSON、固定fallbackが異常増加しない。
- AI Studioのモデル別RPDが、実行ログのrole別呼び出し数と概ね一致する。

AI Studio表示には遅延があり得るため、アプリの安全なmetricと両方を確認する。

## 10. 合格条件

次をすべて満たした場合だけPRをReady for reviewにできる。

- 全自動テスト、契約検証、静的監査が合格している。
- 通常会話と画像会話が合格している。
- 日記、記憶、自発発言の各本番経路が少なくとも1回成功している。
- 人格と没入感が2.5 Flash運用時より明確に悪化していない。
- 3.6のRPDを意味検証だけで消費していない。
- 自動的な別モデルfallbackが発生していない。
- 設定rollbackを実行できることを確認している。

## 11. rollback

異常時は追加テストや再実行を止め、最初に次の値だけを戻す。

```text
GEMINI_MODEL_ROUTING_MODE=single
```

`inspectGeminiModelRouting()`で両roleが既存`GEMINI_MODEL`へ戻ったことを確認する。
これで復旧しない場合は、既存のowner-only Web App deploymentを手順3で控えた
旧immutable versionへ戻す。新しく追加された3件のconfig行は旧コードから参照されないため、
緊急時に削除しない。

rollback後は通常会話を1件だけ確認し、health checkとqueue集計を読み取り専用で確認する。

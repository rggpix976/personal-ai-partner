#!/usr/bin/env node
'use strict';

const fs = require('fs');

const clientHtml = fs.readFileSync('src/web/Client.html', 'utf8');
const indexHtml = fs.readFileSync('src/web/Index.html', 'utf8');
const errorSource = fs.readFileSync('src/common/Errors.gs', 'utf8');
const webControllerSource = fs.readFileSync('src/web/WebController.gs', 'utf8');
const chatServiceSource = fs.readFileSync('src/application/ChatService.gs', 'utf8');
const geminiClientSource = fs.readFileSync('src/infrastructure/GeminiClient.gs', 'utf8');
const scriptStart = clientHtml.indexOf('<script>');
const scriptEnd = clientHtml.lastIndexOf('</script>');

if (scriptStart === -1 || scriptEnd <= scriptStart) {
  throw new Error('Client.html must contain one executable script block.');
}

const clientScript = clientHtml.slice(scriptStart + '<script>'.length, scriptEnd);
new Function(clientScript);

const referencedIds = Array.from(
  clientScript.matchAll(/getElementById\('([^']+)'\)/g),
  (match) => match[1]
);
const missingIds = referencedIds.filter(
  (id) => !indexHtml.includes(`id="${id}"`)
);

if (missingIds.length > 0) {
  throw new Error(`Index.html is missing referenced ids: ${missingIds.join(', ')}`);
}

const unsafeDomProperty = ['inner', 'HTML'].join('');
const unsafeDomWrite = new RegExp(`\\.${unsafeDomProperty}\\s*=`);
if (unsafeDomWrite.test(clientScript)) {
  throw new Error('Client.html must not render server content with unsafe HTML assignment.');
}

const optimisticImageRequirements = [
  "addOptimisticMessage(requestId, text, clientTimestamp, state.selectedImage)",
  "clientDeliveryState: 'sending'",
  "dataUrl: selectedImage.previewUrl",
  'reconcileOptimisticMessage(message)',
  "delete state.messageImages[pendingMessage.messageId]",
  "markOptimisticMessageFailed(requestId)",
  "deliveryStatus.textContent = message.clientDeliveryState === 'failed'"
];
const missingOptimisticImageRequirements = optimisticImageRequirements.filter(
  (requirement) => !clientScript.includes(requirement)
);

if (missingOptimisticImageRequirements.length > 0) {
  throw new Error(
    `Client.html is missing optimistic image delivery behavior: ${missingOptimisticImageRequirements.join(', ')}`
  );
}

const japaneseUiRequirements = [
  'lang="ja"',
  '以前のメッセージを読み込む',
  '推しへのメッセージを入力',
  '画像を添付',
  'メッセージ本文は安全にエスケープして表示されます。',
  '>送信</button>'
];
const missingJapaneseUiRequirements = japaneseUiRequirements.filter(
  (requirement) => !indexHtml.includes(requirement)
);
if (missingJapaneseUiRequirements.length > 0) {
  throw new Error(
    `Index.html is missing Japanese UI text: ${missingJapaneseUiRequirements.join(', ')}`
  );
}

const localizedErrorMessages = Array.from(
  errorSource.matchAll(/userMessage:\s*'((?:\\.|[^'])*)'/g),
  (match) => match[1]
);
const nonJapaneseErrorMessages = localizedErrorMessages.filter(
  (message) => !/[\u3040-\u30ff\u3400-\u9fff]/.test(message)
);
if (localizedErrorMessages.length === 0 || nonJapaneseErrorMessages.length > 0) {
  throw new Error(
    `Errors.gs contains non-Japanese user messages: ${nonJapaneseErrorMessages.join(', ')}`
  );
}

const obsoleteEnglishUiText = [
  'Preparing the chat screen.',
  'Product information',
  'Load older messages',
  'Latest messages',
  'Write a message for your partner',
  'Attach image',
  'Selected preview',
  '>Remove</button>',
  'Message text is safely escaped before display.',
  '>Send</button>',
  'Refreshで',
  "'Image: '",
  'The app is not fully configured.',
  'Reply processing finished, but the assistant message is not visible yet.',
  'Reply generation is already in progress for this request.',
  'Reply generation is temporarily queued for retry.',
  'The message request could not be found.',
  'The AI could not answer that request.',
  'The AI request could not be processed.'
];
const uiTextSources = [
  indexHtml,
  clientScript,
  errorSource,
  webControllerSource,
  chatServiceSource,
  geminiClientSource
];
const remainingEnglishUiText = obsoleteEnglishUiText.filter(
  (text) => uiTextSources.some((source) => source.includes(text))
);
if (remainingEnglishUiText.length > 0) {
  throw new Error(
    `Web UI still contains obsolete English text: ${remainingEnglishUiText.join(', ')}`
  );
}

console.log(
  `WEB_UI_VALIDATION_OK referencedIds=${referencedIds.length} missingIds=0 innerHtmlWrites=0 optimisticImageRequirements=${optimisticImageRequirements.length} japaneseUiRequirements=${japaneseUiRequirements.length} localizedErrorMessages=${localizedErrorMessages.length}`
);

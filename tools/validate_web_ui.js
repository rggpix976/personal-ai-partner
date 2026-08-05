#!/usr/bin/env node
'use strict';

const fs = require('fs');

const clientHtml = fs.readFileSync('src/web/Client.html', 'utf8');
const indexHtml = fs.readFileSync('src/web/Index.html', 'utf8');
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

console.log(
  `WEB_UI_VALIDATION_OK referencedIds=${referencedIds.length} missingIds=0 innerHtmlWrites=0`
);

#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

function formatDate(value, timeZone, format) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const year = parts.year;
  const month = String(Number(parts.month));
  const day = String(Number(parts.day));
  const hour = String(Number(parts.hour));
  const minute = String(Number(parts.minute));
  const second = String(Number(parts.second));
  const month2 = month.padStart(2, '0');
  const day2 = day.padStart(2, '0');
  const hour2 = hour.padStart(2, '0');
  const minute2 = minute.padStart(2, '0');
  const second2 = second.padStart(2, '0');
  const simpleFormats = {
    yyyy: year,
    M: month,
    d: day,
    'yyyy-MM-dd': `${year}-${month2}-${day2}`,
    H: hour,
    m: minute,
    'HH:mm': `${hour2}:${minute2}`,
    'M/d H:mm': `${month}/${day} ${hour}:${minute2}`
  };
  if (Object.prototype.hasOwnProperty.call(simpleFormats, format)) {
    return simpleFormats[format];
  }
  if (format.indexOf('yyyy-MM-dd') === 0 && format.indexOf('HH:mm:ss') > 0) {
    return `${year}-${month2}-${day2}T${hour2}:${minute2}:${second2}`;
  }
  if (format === 'u') {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short'
    }).format(date);
    return String({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday]);
  }
  throw new Error(`Unsupported Apps Script date format: ${format}`);
}

const context = {
  console,
  LockService: {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => {}
    })
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => key === 'OWNER_EMAIL'
        ? ['owner', 'example.com'].join('@')
        : null,
      getProperties: () => ({}),
      setProperty: () => {}
    })
  },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    formatDate,
    base64Decode: (value) => Array.from(Buffer.from(value, 'base64')),
    base64DecodeWebSafe: (value) => Array.from(Buffer.from(value, 'base64url')),
    base64Encode: (value) => Buffer.from(value).toString('base64')
  }
};
vm.createContext(context);

[
  'src/common/Constants.gs',
  'src/common/Errors.gs',
  'src/common/Json.gs',
  'src/common/Validators.gs',
  'src/common/AppLogger.gs',
  'src/common/LockManager.gs',
  'src/common/RetryPolicy.gs',
  'src/infrastructure/ConfigRepository.gs',
  'src/infrastructure/SheetRepository.gs',
  'src/infrastructure/DriveTempRepository.gs',
  'src/infrastructure/DocumentRepository.gs',
  'src/infrastructure/GeminiClient.gs',
  'src/infrastructure/GmailNotifier.gs',
  'src/application/QueueService.gs',
  'src/application/OperationalHealthService.gs',
  'src/application/MaintenanceService.gs',
  'src/application/MemoryService.gs',
  'src/application/DiaryService.gs',
  'src/application/ProactiveMessageService.gs',
  'src/application/ChatService.gs',
  'src/application/ContextService.gs',
  'src/application/ImageService.gs',
  'src/jobs/ProcessQueueJob.gs',
  'src/jobs/SchedulerJob.gs',
  'src/PublicApi.gs',
  'src/Setup.gs',
  'src/web/WebController.gs',
  'src/tests/A2PlatformTests.gs',
  'src/tests/A3WebUiTests.gs',
  'src/tests/A4ChatGeminiTests.gs',
  'src/tests/A5MemoryDiaryTests.gs',
  'src/tests/A6QueueSchedulerTests.gs',
  'src/tests/A7StaticSelfTest.gs',
  'src/tests/A7IntegrationSelfTest.gs',
  'src/tests/A8ProactiveConversationTests.gs',
  'src/tests/RunAllTests.gs'
].forEach((file) => {
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
});

const result = context.runAllSelfTests();
console.log(JSON.stringify({
  ok: result.ok,
  totalPasses: result.totalPasses,
  totalFailures: result.totalFailures,
  suites: result.suites.map((suite) => ({
    name: suite.name,
    passes: suite.passes.length,
    failures: suite.failures
  }))
}, null, 2));
if (!result.ok) process.exitCode = 1;

var GmailNotifier = (function() {
  function send(to, subject, body, options) {
    options = options || {};
    Validators.assertOwnerEmail(String(to || ''));
    ensure(String(subject || '').trim() !== '', 'VALIDATION_REQUEST_INVALID', 'Mail subject is required.');
    ensure(String(body || '').trim() !== '', 'VALIDATION_REQUEST_INVALID', 'Mail body is required.');
    if (getRemainingQuota() <= 0) {
      throw createAppError('MAIL_QUOTA_EXHAUSTED', 'Mail quota is exhausted.');
    }
    if (options.dryRun) {
      return {
        sent: false,
        dryRun: true,
        to: '[REDACTED_OWNER_EMAIL]'
      };
    }
    try {
      MailApp.sendEmail({
        to: to,
        subject: subject,
        body: body,
        name: options.name || 'Personal AI Partner',
        noReply: options.noReply === true
      });
    } catch (ignoredProviderError) {
      // Provider exceptions can include recipient or message fragments. Keep
      // both the queue error and debug log on a generic retryable contract.
      throw createAppError(
        'MAIL_SEND_FAILED',
        'Mail delivery failed.'
      );
    }
    return {
      sent: true,
      dryRun: false
    };
  }

  function getRemainingQuota() {
    try {
      return Number(MailApp.getRemainingDailyQuota());
    } catch (ignoredProviderError) {
      throw createAppError(
        'MAIL_QUOTA_EXHAUSTED',
        'Mail quota is unavailable.'
      );
    }
  }

  return {
    send: send,
    getRemainingQuota: getRemainingQuota
  };
})();

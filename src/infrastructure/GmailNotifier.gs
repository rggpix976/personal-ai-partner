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
    MailApp.sendEmail({
      to: to,
      subject: subject,
      body: body,
      name: options.name || 'Personal AI Partner',
      noReply: options.noReply === true
    });
    return {
      sent: true,
      dryRun: false
    };
  }

  function getRemainingQuota() {
    try {
      return Number(MailApp.getRemainingDailyQuota());
    } catch (error) {
      throw createAppError('MAIL_QUOTA_EXHAUSTED', 'Mail quota is unavailable.', null, {
        cause: error
      });
    }
  }

  return {
    send: send,
    getRemainingQuota: getRemainingQuota
  };
})();

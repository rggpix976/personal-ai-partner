var CharacterStatusNoticeService = (function() {
  var ROUTE_NOTICES = Object.freeze({
    PRODUCT_INFO: Object.freeze({
      title: 'このアプリについて',
      message: 'このアプリは、会話の返信を生成するためにAIを使用しています。送信した会話や画像は返信生成のために設定済みのAIサービスへ送られ、会話履歴はこのアプリの保存先に記録されます。これは推し本人の発言ではなく、アプリからの案内です。'
    }),
    ADMIN_OOC: Object.freeze({
      title: 'アプリの状態について',
      message: '設定や動作状態に関する情報は、推しの発言ではなくアプリの管理情報として扱います。詳しい状態はApps Scriptの実行履歴・トリガー・設定で確認してください。'
    })
  });
  var CONFIG_NOTICE = Object.freeze({
    title: '設定の確認が必要です',
    message: '推しとの会話設定が未完了、または整合していません。設定を確認してから、もう一度お試しください。'
  });

  function forRoute(route) {
    ensure(
      Object.prototype.hasOwnProperty.call(ROUTE_NOTICES, route),
      'VALIDATION_REQUEST_INVALID',
      'Non-character route is invalid.'
    );
    return ROUTE_NOTICES[route];
  }

  function forConfigError() {
    return CONFIG_NOTICE;
  }

  return Object.freeze({
    forRoute: forRoute,
    forConfigError: forConfigError
  });
})();

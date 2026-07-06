function doGet() {
  return WebController.doGet();
}

function getInitialState() {
  return WebController.getInitialState();
}

function loadMessages(beforeMessageId, limit) {
  return WebController.loadMessages(beforeMessageId, limit);
}

function sendChat(request) {
  return WebController.sendChat(request);
}

function getRequestStatus(requestId) {
  return WebController.getRequestStatus(requestId);
}

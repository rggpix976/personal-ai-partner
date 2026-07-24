function doGet() {
  return WebController.doGet();
}

function getInitialState() {
  return WebController.getInitialState();
}

function getCharacterSettings() {
  return WebController.getCharacterSettings();
}

function saveCharacterSettings(request) {
  return WebController.saveCharacterSettings(request);
}

function loadMessages(beforeMessageId, limit) {
  return WebController.loadMessages(beforeMessageId, limit);
}

function loadNewMessages(afterMessageId, limit) {
  return WebController.loadNewMessages(afterMessageId, limit);
}

function sendChat(request) {
  return WebController.sendChat(request);
}

function getRequestStatus(requestId) {
  return WebController.getRequestStatus(requestId);
}

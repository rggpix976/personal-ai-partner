var DocumentRepository = (function() {
  function createOrOpenDiaryDocument() {
    var properties = PropertiesService.getScriptProperties();
    var documentId = properties.getProperty(APP_CONSTANTS.PROPERTY_KEYS.DIARY_DOC_ID);
    if (documentId) {
      return DocumentApp.openById(documentId);
    }
    var document = DocumentApp.create('Personal AI Partner Diary');
    var body = document.getBody();
    if (body.getText() === '') {
      body.appendParagraph('Personal AI Partner Diary');
      body.appendParagraph('Created by setup()');
    }
    return LockManager.withScriptLock('documentPropertyWrite', function() {
      var existingId = properties.getProperty(APP_CONSTANTS.PROPERTY_KEYS.DIARY_DOC_ID);
      if (existingId) {
        return DocumentApp.openById(existingId);
      }
      properties.setProperty(APP_CONSTANTS.PROPERTY_KEYS.DIARY_DOC_ID, document.getId());
      return document;
    });
  }

  function validateDiaryDocument(documentId) {
    var document = DocumentApp.openById(documentId);
    ensure(document.getBody() != null, 'CONFIG_MISSING', 'Diary document body is missing.');
    return true;
  }

  return {
    createOrOpenDiaryDocument: createOrOpenDiaryDocument,
    validateDiaryDocument: validateDiaryDocument
  };
})();

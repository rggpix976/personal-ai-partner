var DocumentRepository = (function() {
  function getDiaryAnchor_(diaryDate) {
    return 'AI Diary - ' + diaryDate;
  }

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

  function findDiaryEntryAnchor(diaryDate) {
    Validators.assertDateString(diaryDate, 'diaryDate');
    var anchor = getDiaryAnchor_(diaryDate);
    var document = createOrOpenDiaryDocument();
    return findDiaryAnchorInBody_(document.getBody(), anchor);
  }

  function countDiaryEntryAnchors(diaryDate) {
    Validators.assertDateString(diaryDate, 'diaryDate');
    var anchor = getDiaryAnchor_(diaryDate);
    var document = createOrOpenDiaryDocument();
    return countDiaryAnchorsInBody_(document.getBody(), anchor);
  }

  function appendDiaryEntry(entry) {
    Validators.assertDateString(entry.diaryDate, 'entry.diaryDate');
    var document = createOrOpenDiaryDocument();
    var body = document.getBody();
    var anchor = getDiaryAnchor_(entry.diaryDate);
    if (findDiaryAnchorInBody_(body, anchor)) {
      return {
        documentId: document.getId(),
        anchor: anchor,
        appended: false
      };
    }

    if (body.getText() && String(body.getText()).trim() !== '') {
      body.appendParagraph('');
    }
    body.appendParagraph(anchor).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    if (entry.title) {
      body.appendParagraph(String(entry.title)).setHeading(DocumentApp.ParagraphHeading.HEADING3);
    }
    String(entry.body || '')
      .split(/\n{2,}/)
      .forEach(function(block) {
        var text = String(block || '').trim();
        if (text) {
          body.appendParagraph(text);
        }
      });
    document.saveAndClose();
    return {
      documentId: document.getId(),
      anchor: anchor,
      appended: true
    };
  }

  function findDiaryAnchorInBody_(body, anchor) {
    return countDiaryAnchorsInBody_(body, anchor) > 0 ? anchor : null;
  }

  function countDiaryAnchorsInBody_(body, anchor) {
    var paragraphs = body.getParagraphs();
    var count = 0;
    for (var i = 0; i < paragraphs.length; i += 1) {
      if (String(paragraphs[i].getText()).trim() === anchor) {
        count += 1;
      }
    }
    return count;
  }

  return {
    createOrOpenDiaryDocument: createOrOpenDiaryDocument,
    validateDiaryDocument: validateDiaryDocument,
    findDiaryEntryAnchor: findDiaryEntryAnchor,
    countDiaryEntryAnchors: countDiaryEntryAnchors,
    appendDiaryEntry: appendDiaryEntry
  };
})();

/**
 * The Data and AI School of London
 * Google Apps Script — NCFE Admission Form Handler
 *
 * Stores admissions to a SEPARATE Google Sheet (not the contact form one).
 * The spreadsheet is auto-created on first submission and its ID is saved
 * to Script Properties so subsequent runs reuse it.
 *
 * Drive folder structure:
 *   My Drive/
 *   └── DAIS Admissions/
 *       └── 2026/
 *           └── Khan, Ali Fraz — 2026-01-01/
 *               ├── Khan_AliFraz_2026-01-01_Photo.jpg
 *               ├── Khan_AliFraz_2026-01-01_ID_Document.pdf
 *               └── ...
 */

var ADMISSIONS_ROOT_FOLDER  = 'DAIS Admissions';
var ADMISSIONS_SHEET_NAME   = 'Admissions';
var ADMISSIONS_SS_NAME      = 'DAIS Admissions Database';
var ADMISSIONS_SS_PROP_KEY  = 'ADMISSIONS_SPREADSHEET_ID';

// ── Entry point — called from Code.gs doPost routing ─────────────────────────

function handleAdmissionPost(data) {
  try {
    Logger.log('═══════════════════════════════════════════════');
    Logger.log('handleAdmissionPost START');
    Logger.log('Received ' + Object.keys(data).length + ' parameters');
    Logger.log('Key fields: firstName=' + data.firstName + ', lastName=' + data.lastName +
               ', dob=' + data.dob + ', email=' + data.email + ', course=' + data.course);

    // 1. Honeypot — silent ok
    if (data.hp_website && String(data.hp_website).trim() !== '') {
      Logger.log('Honeypot triggered — returning silent ok');
      return _admJson({ result: 'ok' });
    }

    // 2. Rate limit (10 per hour)
    var props   = PropertiesService.getScriptProperties();
    var hourKey = 'adm_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHH');
    var count   = parseInt(props.getProperty(hourKey) || '0', 10);
    if (count >= 10) {
      Logger.log('Rate limit exceeded');
      return _admJson({ result: 'error', message: 'Submission limit reached. Please call +44 207 0990 956.' });
    }
    props.setProperty(hourKey, String(count + 1));

    // 3. Extract files from flat parameters
    var photo  = _admExtractFile(data, 'photo');
    var idDoc  = _admExtractFile(data, 'id');
    var qual   = _admExtractFile(data, 'qual');
    var extras = [];
    for (var i = 1; i <= 3; i++) {
      var f = _admExtractFile(data, 'doc' + i);
      if (f) extras.push(f);
    }
    Logger.log('Files extracted — photo=' + !!photo + ' (' + (photo ? Math.round(photo.data.length / 1024) + 'KB' : 'n/a') + ')' +
               ', id=' + !!idDoc + ' (' + (idDoc ? Math.round(idDoc.data.length / 1024) + 'KB' : 'n/a') + ')' +
               ', qual=' + !!qual +
               ', extras=' + extras.length);

    // 4. Validate
    var v = _admValidate(data, photo, idDoc);
    if (!v.ok) {
      Logger.log('VALIDATION FAILED: ' + v.message);
      return _admJson({ result: 'error', message: v.message });
    }
    Logger.log('Validation OK');

    // 5. Create Drive folder
    Logger.log('Creating Drive folder for ' + data.firstName + ' ' + data.lastName + '...');
    var applicantFolder = _admCreateFolder(data.firstName, data.lastName, data.dob);
    var folderUrl       = applicantFolder.getUrl();
    Logger.log('Folder created: ' + folderUrl);

    // 6. Save files to Drive
    var savedFiles = [];
    if (photo) {
      var pf = _admSaveFile(applicantFolder, photo, data.firstName, data.lastName, data.dob, 'Photo');
      savedFiles.push('Photo → ' + pf.getName());
      Logger.log('  ✓ Photo saved: ' + pf.getName());
    }
    if (idDoc) {
      var idf = _admSaveFile(applicantFolder, idDoc, data.firstName, data.lastName, data.dob, 'ID_Document');
      savedFiles.push('ID → ' + idf.getName());
      Logger.log('  ✓ ID saved: ' + idf.getName());
    }
    if (qual) {
      var qf = _admSaveFile(applicantFolder, qual, data.firstName, data.lastName, data.dob, 'Qualification_Certificate');
      savedFiles.push('Qualification → ' + qf.getName());
      Logger.log('  ✓ Qualification saved: ' + qf.getName());
    }
    extras.forEach(function (doc, i) {
      var df = _admSaveFile(applicantFolder, doc, data.firstName, data.lastName, data.dob, 'Document_' + (i + 1));
      savedFiles.push('Document ' + (i + 1) + ' → ' + df.getName());
      Logger.log('  ✓ Document ' + (i + 1) + ' saved: ' + df.getName());
    });
    Logger.log('Total files saved: ' + savedFiles.length);

    // 7. Log to Sheet (separate admissions spreadsheet)
    Logger.log('Logging to admissions spreadsheet...');
    var ssUrl = _admSaveToSheet(data, folderUrl, savedFiles.join(' | '));
    Logger.log('Sheet row appended');

    // 8. Emails
    _admSendConfirmation(data);
    _admSendAdminAlert(data, folderUrl, savedFiles, ssUrl);

    Logger.log('handleAdmissionPost SUCCESS');
    Logger.log('═══════════════════════════════════════════════');
    return _admJson({ result: 'ok' });

  } catch (err) {
    Logger.log('!!! ADMISSION ERROR: ' + err.message);
    Logger.log('!!! STACK: ' + (err.stack || '(no stack)'));
    Logger.log('═══════════════════════════════════════════════');
    return _admJson({
      result: 'error',
      message: 'Server error: ' + err.message + ' — please email info@dataaischool.com.'
    });
  }
}

// ── Extract a file from flat URL-encoded fields ──────────────────────────────

function _admExtractFile(data, prefix) {
  var b64 = data[prefix + '_data'];
  if (!b64 || String(b64).length < 10) return null;
  return {
    data:     String(b64),
    name:     String(data[prefix + '_name'] || ''),
    mimeType: String(data[prefix + '_mime'] || 'application/octet-stream'),
    ext:      String(data[prefix + '_ext']  || '')
  };
}

// ── Get (or auto-create) the dedicated admissions spreadsheet ─────────────────

function _admGetSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var id    = props.getProperty(ADMISSIONS_SS_PROP_KEY);

  if (id) {
    try {
      var existing = SpreadsheetApp.openById(id);
      return existing;
    } catch (openErr) {
      Logger.log('Stored admissions spreadsheet ID is invalid — creating new');
    }
  }

  // Create a fresh spreadsheet in the script owner's Drive
  var ss = SpreadsheetApp.create(ADMISSIONS_SS_NAME);
  props.setProperty(ADMISSIONS_SS_PROP_KEY, ss.getId());
  Logger.log('🆕 Created admissions spreadsheet: ' + ss.getUrl());
  return ss;
}

// ── Drive folder for applicant ───────────────────────────────────────────────

function _admCreateFolder(firstName, lastName, dob) {
  var rootIter = DriveApp.getFoldersByName(ADMISSIONS_ROOT_FOLDER);
  var root     = rootIter.hasNext() ? rootIter.next() : DriveApp.createFolder(ADMISSIONS_ROOT_FOLDER);

  var yr      = new Date().getFullYear().toString();
  var yrIter  = root.getFoldersByName(yr);
  var yrFlder = yrIter.hasNext() ? yrIter.next() : root.createFolder(yr);

  var fn   = _admCleanName(firstName);
  var ln   = _admCleanName(lastName);
  var name = ln + ', ' + fn + ' — ' + dob;

  var dupIter = yrFlder.getFoldersByName(name);
  if (dupIter.hasNext()) {
    name += ' (' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss') + ')';
  }
  return yrFlder.createFolder(name);
}

// ── Save a file to Drive ─────────────────────────────────────────────────────

function _admSaveFile(folder, fileObj, firstName, lastName, dob, label) {
  var fn     = _admCleanName(firstName).replace(/\s+/g, '');
  var ln     = _admCleanName(lastName).replace(/\s+/g, '');
  var dobStr = String(dob).replace(/[\/\s]/g, '-');
  var ext    = fileObj.ext ? ('.' + String(fileObj.ext).toLowerCase()) : '';
  var name   = ln + '_' + fn + '_' + dobStr + '_' + label + ext;

  var bytes = Utilities.base64Decode(fileObj.data);
  var blob  = Utilities.newBlob(bytes, fileObj.mimeType || 'application/octet-stream', name);
  return folder.createFile(blob);
}

// ── Save to admissions spreadsheet ───────────────────────────────────────────

function _admSaveToSheet(data, folderUrl, filesStr) {
  var ss    = _admGetSpreadsheet();
  var sheet = ss.getSheetByName(ADMISSIONS_SHEET_NAME);

  if (!sheet) {
    // First-time setup: use first sheet (rename it) or create
    sheet = ss.getSheets()[0];
    if (sheet.getName() !== ADMISSIONS_SHEET_NAME) {
      sheet.setName(ADMISSIONS_SHEET_NAME);
    }

    var hdrs = [
      'Timestamp', 'Status',
      'Title', 'First Name', 'Middle Name(s)', 'Last Name', 'Date of Birth',
      'Gender', 'Pronouns', 'NI Number', 'ULN',
      'Email', 'Phone',
      'Address 1', 'Address 2', 'City / Town', 'County', 'Postcode',
      'Ethnicity', 'Disability / LDD', 'Disability Type', 'Access Arrangement',
      'Highest Qualification', 'English Grade', 'Maths Grade', 'Other Qualifications',
      'Employment Status', 'Employer', 'Job Title',
      'Course Applied For', 'Preferred Start', 'How Heard',
      'Emergency Name', 'Emergency Relationship', 'Emergency Phone',
      'Additional Information', 'Drive Folder URL', 'Files Saved'
    ];
    sheet.appendRow(hdrs);
    var hr = sheet.getRange(1, 1, 1, hdrs.length);
    hr.setBackground('#0A2240').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
  }

  function s(v) { return String(v || '').replace(/<[^>]*>/g, '').trim().substring(0, 500); }

  sheet.appendRow([
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
    'New',
    s(data.title),        s(data.firstName), s(data.middleName), s(data.lastName), s(data.dob),
    s(data.gender),       s(data.pronouns),  s(data.niNumber),   s(data.uln),
    s(data.email),        s(data.phone),
    s(data.address1),     s(data.address2),  s(data.city),       s(data.county),   s(data.postcode),
    s(data.ethnicity),    s(data.disability),s(data.disabilityType), s(data.accessArrangement),
    s(data.highestQual),  s(data.englishGrade), s(data.mathsGrade), s(data.otherQuals),
    s(data.employmentStatus), s(data.employer), s(data.jobTitle),
    s(data.course),       s(data.preferredStart), s(data.howHeard),
    s(data.emergencyName),s(data.emergencyRelationship), s(data.emergencyPhone),
    s(data.additionalInfo),
    folderUrl,
    filesStr
  ]);

  var lr = sheet.getLastRow();
  if (lr % 2 === 0) sheet.getRange(lr, 1, 1, 38).setBackground('#EBE4D8');
  return ss.getUrl();
}

// ── Emails ────────────────────────────────────────────────────────────────────

function _admSendConfirmation(data) {
  try {
    function s(v) { return String(v || '').replace(/<[^>]*>/g, '').trim(); }
    var name = s(data.firstName) + ' ' + s(data.lastName);
    MailApp.sendEmail({
      to:      s(data.email),
      subject: 'Application Received — The Data and AI School of London',
      body:
        'Dear ' + name + ',\n\n' +
        'Thank you for submitting your application to The Data and AI School of London.\n\n' +
        'Course applied for:\n  ' + s(data.course) + '\n\n' +
        'What happens next:\n' +
        '  1. Our admissions team will review your application within 3 working days.\n' +
        '  2. You will receive a formal offer letter or a request for further information.\n' +
        '  3. Once you accept your offer, you will receive enrolment confirmation\n' +
        '     and access details for our online learning platform (VLE).\n\n' +
        'Questions? Email info@dataaischool.com or call +44 207 0990 956.\n\n' +
        'Kind regards,\n\n' +
        'Sheherbano Khan\n' +
        'Registrar & Learner Support Lead\n' +
        'The Data and AI School of London'
    });
  } catch (err) {
    Logger.log('Confirmation email failed: ' + err.message);
  }
}

function _admSendAdminAlert(data, folderUrl, savedFiles, ssUrl) {
  try {
    function s(v) { return String(v || '').replace(/<[^>]*>/g, '').trim(); }
    var name = s(data.firstName) + ' ' + s(data.lastName);
    MailApp.sendEmail({
      to:      'info@dataaischool.com',
      subject: 'New Admission Application: ' + name + ' — ' + s(data.course),
      body:
        'New admission application received.\n\n' +
        'Name:            ' + name + '\n' +
        'DOB:             ' + s(data.dob) + '\n' +
        'Email:           ' + s(data.email) + '\n' +
        'Phone:           ' + s(data.phone) + '\n' +
        'Course:          ' + s(data.course) + '\n' +
        'Preferred Start: ' + s(data.preferredStart) + '\n' +
        'Postcode:        ' + s(data.postcode) + '\n\n' +
        'Files saved to Drive:\n' +
        savedFiles.map(function(f) { return '  • ' + f; }).join('\n') + '\n\n' +
        'Drive folder:\n  ' + folderUrl + '\n\n' +
        'Admissions spreadsheet:\n  ' + ssUrl
    });
  } catch (err) {
    Logger.log('Admin alert failed: ' + err.message);
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function _admValidate(d, photo, idDoc) {
  var required = [
    [d.firstName,              'First name'],
    [d.lastName,               'Last name'],
    [d.dob,                    'Date of birth'],
    [d.gender,                 'Gender'],
    [d.email,                  'Email address'],
    [d.phone,                  'Phone number'],
    [d.address1,               'Address line 1'],
    [d.city,                   'City / Town'],
    [d.postcode,               'Postcode'],
    [d.ethnicity,              'Ethnicity'],
    [d.disability,             'Disability / LDD declaration'],
    [d.highestQual,            'Highest qualification'],
    [d.englishGrade,           'English qualification grade'],
    [d.mathsGrade,             'Maths qualification grade'],
    [d.employmentStatus,       'Employment status'],
    [d.course,                 'Course applied for'],
    [d.emergencyName,          'Emergency contact name'],
    [d.emergencyRelationship,  'Emergency contact relationship'],
    [d.emergencyPhone,         'Emergency contact phone']
  ];
  for (var i = 0; i < required.length; i++) {
    if (!required[i][0] || String(required[i][0]).trim() === '') {
      return { ok: false, message: required[i][1] + ' is required.' };
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(d.email || ''))) {
    return { ok: false, message: 'Please enter a valid email address.' };
  }
  if (!photo) return { ok: false, message: 'A passport-size photograph is required.' };
  if (!idDoc) return { ok: false, message: 'Proof of identity is required.' };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL SETUP — run this ONCE from the Apps Script editor.
//
// Select 'setupAdmissionsInfrastructure' from the dropdown → ▶ Run.
// Authorise when prompted (Drive + Sheets + Mail). After it succeeds:
//   • A "DAIS Admissions" folder will exist in your My Drive root
//   • A "DAIS Admissions Database" spreadsheet will exist with headers
//   • Logger shows both URLs
// Then submit a real form and everything will save into these locations.
// ─────────────────────────────────────────────────────────────────────────────

function setupAdmissionsInfrastructure() {
  Logger.log('═══════════════════════════════════════════════');
  Logger.log('SETUP: creating Drive folder + Admissions spreadsheet');

  // 1. Drive folder
  var rootIter = DriveApp.getFoldersByName(ADMISSIONS_ROOT_FOLDER);
  var root;
  if (rootIter.hasNext()) {
    root = rootIter.next();
    Logger.log('Folder already exists: ' + root.getUrl());
  } else {
    root = DriveApp.createFolder(ADMISSIONS_ROOT_FOLDER);
    Logger.log('✓ Created Drive folder: ' + root.getUrl());
  }

  // Year subfolder
  var yr     = new Date().getFullYear().toString();
  var yrIter = root.getFoldersByName(yr);
  var yrFol;
  if (yrIter.hasNext()) {
    yrFol = yrIter.next();
    Logger.log('Year subfolder already exists: ' + yrFol.getUrl());
  } else {
    yrFol = root.createFolder(yr);
    Logger.log('✓ Created year subfolder: ' + yrFol.getUrl());
  }

  // 2. Spreadsheet (auto-creates and stores ID in Script Properties)
  var ss = _admGetSpreadsheet();
  Logger.log('✓ Admissions spreadsheet: ' + ss.getUrl());

  // Ensure the Admissions tab + headers exist
  var sheet = ss.getSheetByName(ADMISSIONS_SHEET_NAME);
  if (!sheet) {
    _admSaveToSheet({}, '(setup)', '(setup)');  // creates the sheet + headers
    var newSheet = ss.getSheetByName(ADMISSIONS_SHEET_NAME);
    newSheet.deleteRow(2);  // remove the dummy row
    Logger.log('✓ Created Admissions tab with headers');
  } else {
    Logger.log('Admissions tab already exists');
  }

  Logger.log('═══════════════════════════════════════════════');
  Logger.log('SETUP COMPLETE');
  Logger.log('Drive folder:  ' + root.getUrl());
  Logger.log('Spreadsheet:   ' + ss.getUrl());
  Logger.log('═══════════════════════════════════════════════');

  return { folder: root.getUrl(), spreadsheet: ss.getUrl() };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _admCleanName(str) {
  return String(str || '').replace(/<[^>]*>/g, '').replace(/[^\w\s'\-\.]/g, '').trim();
}

function _admJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * The Data and AI School of London
 * Google Apps Script — NCFE Admission Form Handler
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SETUP (one-time):
 * ═══════════════════════════════════════════════════════════════════════
 *  1. Apps Script editor → ＋ Add a service → Google Drive API → Add
 *  2. Paste this file as Admission.gs (＋ → Script → name it Admission)
 *  3. Code.gs must include the routing in doPost (already there)
 *  4. Deploy → Manage deployments → Edit (✏️) → New version → Deploy
 *     ✓ The URL does NOT change.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Drive folder structure created automatically:
 *   My Drive/
 *   └── DAIS Admissions/
 *       └── 2026/
 *           └── Khan, Ali Fraz — 01-01-1990/
 *               ├── Khan_AliFraz_01-01-1990_Photo.jpg
 *               ├── Khan_AliFraz_01-01-1990_ID_Document.pdf
 *               ├── Khan_AliFraz_01-01-1990_Qualification_Certificate.pdf
 *               └── Khan_AliFraz_01-01-1990_Document_1.pdf
 *
 * Input format: flat key=value pairs from URL-encoded form POST.
 * Files arrive as `<prefix>_data` (base64), `<prefix>_name`, `<prefix>_mime`, `<prefix>_ext`.
 */

var ADMISSIONS_ROOT_FOLDER = 'DAIS Admissions';
var ADMISSIONS_SHEET_NAME  = 'Admissions';

// ── Entry point — called from Code.gs doPost routing ─────────────────────────

function handleAdmissionPost(data) {
  try {
    Logger.log('handleAdmissionPost: received submission from ' + (data.email || '(no email)'));

    // 1. Honeypot — silent success for bots
    if (data.hp_website && String(data.hp_website).trim() !== '') {
      Logger.log('Honeypot triggered — silent ok');
      return _admJson({ result: 'ok' });
    }

    // 2. Rate limit (10 admissions per hour)
    var props   = PropertiesService.getScriptProperties();
    var hourKey = 'adm_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHH');
    var count   = parseInt(props.getProperty(hourKey) || '0', 10);
    if (count >= 10) {
      return _admJson({ result: 'error', message: 'Submission limit reached. Please call +44 207 0990 956.' });
    }
    props.setProperty(hourKey, String(count + 1));

    // 3. Reconstruct file objects from flat parameters
    var photo  = _admExtractFile(data, 'photo');
    var idDoc  = _admExtractFile(data, 'id');
    var qual   = _admExtractFile(data, 'qual');
    var extras = [];
    for (var i = 1; i <= 3; i++) {
      var f = _admExtractFile(data, 'doc' + i);
      if (f) extras.push(f);
    }

    // 4. Validate required fields
    var v = _admValidate(data, photo, idDoc);
    if (!v.ok) {
      Logger.log('Validation failed: ' + v.message);
      return _admJson({ result: 'error', message: v.message });
    }

    // 5. Create applicant folder
    var applicantFolder = _admCreateFolder(data.firstName, data.lastName, data.dob);
    var folderUrl       = applicantFolder.getUrl();
    Logger.log('Created folder: ' + folderUrl);

    // 6. Save files
    var savedFiles = [];

    if (photo) {
      var pf = _admSaveFile(applicantFolder, photo, data.firstName, data.lastName, data.dob, 'Photo');
      savedFiles.push('Photo → ' + pf.getName());
    }
    if (idDoc) {
      var idf = _admSaveFile(applicantFolder, idDoc, data.firstName, data.lastName, data.dob, 'ID_Document');
      savedFiles.push('ID → ' + idf.getName());
    }
    if (qual) {
      var qf = _admSaveFile(applicantFolder, qual, data.firstName, data.lastName, data.dob, 'Qualification_Certificate');
      savedFiles.push('Qualification → ' + qf.getName());
    }
    extras.forEach(function (doc, i) {
      var df = _admSaveFile(applicantFolder, doc, data.firstName, data.lastName, data.dob, 'Document_' + (i + 1));
      savedFiles.push('Document ' + (i + 1) + ' → ' + df.getName());
    });
    Logger.log('Saved ' + savedFiles.length + ' files');

    // 7. Log to sheet
    _admSaveToSheet(data, folderUrl, savedFiles.join(' | '));

    // 8. Send emails
    _admSendConfirmation(data);
    _admSendAdminAlert(data, folderUrl, savedFiles);

    return _admJson({ result: 'ok' });

  } catch (err) {
    Logger.log('Admission error: ' + err.message + '\n' + err.stack);
    return _admJson({
      result: 'error',
      message: 'A server error occurred. Please email info@dataaischool.com or call +44 207 0990 956.'
    });
  }
}

// ── Extract a file object from flat parameters ───────────────────────────────

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

// ── Create applicant folder ──────────────────────────────────────────────────

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

// ── Save to Sheet ────────────────────────────────────────────────────────────

function _admSaveToSheet(data, folderUrl, filesStr) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(ADMISSIONS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(ADMISSIONS_SHEET_NAME);
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
}

// ── Confirmation email to applicant ──────────────────────────────────────────

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
        '  2. You will receive a formal offer letter or a request for further information by email.\n' +
        '  3. Once you accept your offer, you will receive your enrolment confirmation\n' +
        '     and access details for our online learning platform (VLE).\n\n' +
        'Questions? Contact us:\n  Email: info@dataaischool.com\n  Phone: +44 207 0990 956\n\n' +
        'Kind regards,\n\n' +
        'Sheherbano Khan\n' +
        'Registrar & Learner Support Lead\n' +
        'The Data and AI School of London\n' +
        'www.dataaischool.com\n' +
        '+44 207 0990 956'
    });
  } catch (err) {
    Logger.log('Confirmation email failed: ' + err.message);
  }
}

// ── Admin notification ───────────────────────────────────────────────────────

function _admSendAdminAlert(data, folderUrl, savedFiles) {
  try {
    function s(v) { return String(v || '').replace(/<[^>]*>/g, '').trim(); }
    var name = s(data.firstName) + ' ' + s(data.lastName);
    MailApp.sendEmail({
      to:      'info@dataaischool.com',
      subject: 'New Admission Application: ' + name + ' — ' + s(data.course),
      body:
        'A new admission application has been submitted.\n\n' +
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
        'Admissions spreadsheet:\n  https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID + '/'
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function _admCleanName(str) {
  return String(str || '').replace(/<[^>]*>/g, '').replace(/[^\w\s'\-\.]/g, '').trim();
}

function _admJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

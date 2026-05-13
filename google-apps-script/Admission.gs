/**
 * The Data and AI School of London
 * Google Apps Script — NCFE Admission Form Handler
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SETUP (one-time, do this BEFORE redeploying):
 * ═══════════════════════════════════════════════════════════════════════
 *  1. In Apps Script editor: click "+ Add a service" (left sidebar)
 *     → select "Google Drive API" → Add
 *  2. Paste this file into a NEW script file called "Admission.gs"
 *     (File → New → Script file → name it Admission)
 *  3. Update Code.gs doPost() to add the routing block (see Code.gs)
 *  4. Deploy → Manage deployments → Edit (pencil) → New version → Deploy
 *     ✓ The existing URL does NOT change — no need to update the website.
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
 */

var ADMISSIONS_ROOT_FOLDER = 'DAIS Admissions';
var ADMISSIONS_SHEET_NAME  = 'Admissions';

// ── Entry point — called from doPost routing in Code.gs ───────────────────────

function handleAdmissionPost(data) {
  try {

    // 1. Honeypot — silent fake-success for bots
    if (data.hp_website && String(data.hp_website).trim() !== '') {
      return _admJson({ result: 'ok' });
    }

    // 2. Admission-specific rate limit (10 per hour)
    var props   = PropertiesService.getScriptProperties();
    var hourKey = 'adm_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHH');
    var count   = parseInt(props.getProperty(hourKey) || '0', 10);
    if (count >= 10) {
      return _admJson({ result: 'error', message: 'Submission limit reached. Please call +44 207 0990 956.' });
    }
    props.setProperty(hourKey, String(count + 1));

    // 3. Validate required fields
    var v = _admValidate(data);
    if (!v.ok) return _admJson({ result: 'error', message: v.message });

    // 4. Create applicant folder in Google Drive
    var applicantFolder = _admCreateFolder(data.firstName, data.lastName, data.dob);
    var folderUrl       = applicantFolder.getUrl();

    // 5. Save uploaded files to Drive
    var savedFiles = [];

    if (data.photo && data.photo.data) {
      var pf = _admSaveFile(applicantFolder, data.photo, data.firstName, data.lastName, data.dob, 'Photo');
      savedFiles.push('Photo → ' + pf.getName());
    }

    if (data.idDocument && data.idDocument.data) {
      var idf = _admSaveFile(applicantFolder, data.idDocument, data.firstName, data.lastName, data.dob, 'ID_Document');
      savedFiles.push('ID → ' + idf.getName());
    }

    if (data.qualCertificate && data.qualCertificate.data) {
      var qf = _admSaveFile(applicantFolder, data.qualCertificate, data.firstName, data.lastName, data.dob, 'Qualification_Certificate');
      savedFiles.push('Qualification → ' + qf.getName());
    }

    if (Array.isArray(data.additionalDocs)) {
      data.additionalDocs.forEach(function (doc, i) {
        if (doc && doc.data) {
          var df = _admSaveFile(applicantFolder, doc, data.firstName, data.lastName, data.dob, 'Document_' + (i + 1));
          savedFiles.push('Document ' + (i + 1) + ' → ' + df.getName());
        }
      });
    }

    // 6. Log all data to Google Sheet (Admissions tab)
    _admSaveToSheet(data, folderUrl, savedFiles.join(' | '));

    // 7. Email: confirmation to applicant + alert to admin
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

// ── Create applicant folder in Drive ─────────────────────────────────────────

function _admCreateFolder(firstName, lastName, dob) {
  // Root: "DAIS Admissions"
  var rootIter = DriveApp.getFoldersByName(ADMISSIONS_ROOT_FOLDER);
  var root     = rootIter.hasNext() ? rootIter.next() : DriveApp.createFolder(ADMISSIONS_ROOT_FOLDER);

  // Year subfolder: "2026"
  var yr      = new Date().getFullYear().toString();
  var yrIter  = root.getFoldersByName(yr);
  var yrFlder = yrIter.hasNext() ? yrIter.next() : root.createFolder(yr);

  // Applicant folder: "Khan, Ali Fraz — 01-01-1990"
  var fn   = _admCleanName(firstName);
  var ln   = _admCleanName(lastName);
  var name = ln + ', ' + fn + ' — ' + dob;   // em-dash

  // If duplicate (same name + DOB), append time to avoid clash
  var dupIter = yrFlder.getFoldersByName(name);
  if (dupIter.hasNext()) {
    name += ' (' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss') + ')';
  }

  return yrFlder.createFolder(name);
}

// ── Save a file to a Drive folder ────────────────────────────────────────────

function _admSaveFile(folder, fileObj, firstName, lastName, dob, label) {
  var fn     = _admCleanName(firstName).replace(/\s+/g, '');
  var ln     = _admCleanName(lastName).replace(/\s+/g, '');
  var dobStr = dob.replace(/[\/\s]/g, '-');
  var ext    = fileObj.ext ? ('.' + fileObj.ext.toLowerCase()) : '';
  var name   = ln + '_' + fn + '_' + dobStr + '_' + label + ext;

  var bytes = Utilities.base64Decode(fileObj.data);
  var blob  = Utilities.newBlob(bytes, fileObj.mimeType || 'application/octet-stream', name);
  return folder.createFile(blob);
}

// ── Log admission to Google Sheet ─────────────────────────────────────────────

function _admSaveToSheet(data, folderUrl, filesStr) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);   // defined in Code.gs
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
    // Widen key columns
    [1,4,6,12,13,36,37].forEach(function(c) { sheet.setColumnWidth(c, 180); });
    sheet.setColumnWidth(38, 300);
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

  // Alternate row shading
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
        'Course applied for:\n' +
        '  ' + s(data.course) + '\n\n' +
        'What happens next:\n' +
        '  1. Our admissions team will review your application within 3 working days.\n' +
        '  2. You will receive a formal offer letter or a request for further information by email.\n' +
        '  3. Once you accept your offer, you will receive your enrolment confirmation\n' +
        '     and access details for our online learning platform (VLE).\n\n' +
        'Please keep this email as your reference. If you do not hear from us within\n' +
        '3 working days, please contact us:\n\n' +
        '  Email: info@dataaischool.com\n' +
        '  Phone: +44 207 0990 956\n\n' +
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

// ── Admin notification email ──────────────────────────────────────────────────

function _admSendAdminAlert(data, folderUrl, savedFiles) {
  try {
    function s(v) { return String(v || '').replace(/<[^>]*>/g, '').trim(); }
    var name = s(data.firstName) + ' ' + s(data.lastName);
    MailApp.sendEmail({
      to:      'info@dataaischool.com',
      subject: 'New Admission Application: ' + name + ' — ' + s(data.course),
      body:
        'A new admission application has been submitted.\n\n' +
        '───────────────────────────────────────\n' +
        'APPLICANT SUMMARY\n' +
        '───────────────────────────────────────\n' +
        'Name:            ' + name + '\n' +
        'Date of Birth:   ' + s(data.dob) + '\n' +
        'Email:           ' + s(data.email) + '\n' +
        'Phone:           ' + s(data.phone) + '\n' +
        'Course:          ' + s(data.course) + '\n' +
        'Preferred Start: ' + s(data.preferredStart) + '\n' +
        'Postcode:        ' + s(data.postcode) + '\n\n' +
        '───────────────────────────────────────\n' +
        'FILES SAVED TO DRIVE\n' +
        '───────────────────────────────────────\n' +
        savedFiles.map(function(f) { return '  • ' + f; }).join('\n') + '\n\n' +
        'Drive folder:\n' +
        '  ' + folderUrl + '\n\n' +
        'Admissions spreadsheet:\n' +
        '  https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID + '/\n\n' +
        '───────────────────────────────────────\n' +
        'Action required: Review and update Status column to "Offered", "Rejected" or "Pending Info".'
    });
  } catch (err) {
    Logger.log('Admin alert failed: ' + err.message);
  }
}

// ── Server-side validation ────────────────────────────────────────────────────

function _admValidate(d) {
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
    [d.emergencyPhone,         'Emergency contact phone'],
  ];
  for (var i = 0; i < required.length; i++) {
    if (!required[i][0] || String(required[i][0]).trim() === '') {
      return { ok: false, message: required[i][1] + ' is required.' };
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(d.email || ''))) {
    return { ok: false, message: 'Please enter a valid email address.' };
  }
  if (!d.photo || !d.photo.data) {
    return { ok: false, message: 'A passport-size photograph is required.' };
  }
  if (!d.idDocument || !d.idDocument.data) {
    return { ok: false, message: 'Proof of identity is required.' };
  }
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

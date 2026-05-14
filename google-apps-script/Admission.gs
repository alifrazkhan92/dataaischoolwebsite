/**
 * The Data and AI School of London
 * Google Apps Script, NCFE Admission Form Handler
 *
 * Stores admissions to a SEPARATE Google Sheet (not the contact form one).
 * The spreadsheet is auto-created on first submission and its ID is saved
 * to Script Properties so subsequent runs reuse it.
 *
 * Drive folder structure:
 * My Drive/
 * └── DAIS Admissions/
 * └── 2026/
 * └── Khan, Ali Fraz, 2026-01-01/
 * ├── Khan_AliFraz_2026-01-01_Photo.jpg
 * ├── Khan_AliFraz_2026-01-01_ID_Document.pdf
 * └── ...
 */

var ADMISSIONS_ROOT_FOLDER = 'DAIS Admissions';
var ADMISSIONS_SHEET_NAME = 'Admissions';
var ADMISSIONS_SS_NAME = 'DAIS Admissions Database';
var ADMISSIONS_SS_PROP_KEY = 'ADMISSIONS_SPREADSHEET_ID';

// ── Entry point, called from Code.gs doPost routing ─────────────────────────

function handleAdmissionPost(data) {
 try {
 // Honeypot, silent ok for bots
 if (data.hp_website && String(data.hp_website).trim() !== '') {
 return _admJson({ result: 'ok' });
 }

 // Rate limit (10 per hour)
 var props = PropertiesService.getScriptProperties();
 var hourKey = 'adm_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHH');
 var count = parseInt(props.getProperty(hourKey) || '0', 10);
 if (count >= 10) {
 return _admJson({ result: 'error', message: 'Submission limit reached. Please call +44 207 0990 956.' });
 }
 props.setProperty(hourKey, String(count + 1));

 // Extract files from flat parameters
 var photo = _admExtractFile(data, 'photo');
 var idDoc = _admExtractFile(data, 'id');
 var qual = _admExtractFile(data, 'qual');
 var extras = [];
 for (var i = 1; i <= 3; i++) {
 var f = _admExtractFile(data, 'doc' + i);
 if (f) extras.push(f);
 }

 // Validate
 var v = _admValidate(data, photo, idDoc);
 if (!v.ok) return _admJson({ result: 'error', message: v.message });

 // Create Drive folder
 var applicantFolder = _admCreateFolder(data.firstName, data.lastName, data.dob);
 var folderUrl = applicantFolder.getUrl();

 // Save files
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

 // Log to spreadsheet + emails
 var ssUrl = _admSaveToSheet(data, folderUrl, savedFiles.join(' | '));
 _admSendConfirmation(data);
 _admSendAdminAlert(data, folderUrl, savedFiles, ssUrl);

 Logger.log('Admission saved: ' + data.firstName + ' ' + data.lastName + ' (' + data.email + '), ' + savedFiles.length + ' files');
 return _admJson({ result: 'ok' });

 } catch (err) {
 Logger.log('Admission error: ' + err.message + ', ' + (err.stack || ''));
 return _admJson({
 result: 'error',
 message: 'Server error: ' + err.message + ', please email info@dataaischool.com.'
 });
 }
}

// ── Extract & validate a file from flat URL-encoded fields ───────────────────
//
// SECURITY: Server-side validation independent of what the client claims.
// • Max size 12 MB after base64 decode (~16 MB encoded)
// • MIME must be in allowlist: image/jpeg, image/png, image/webp, application/pdf
// • Extension must match MIME (defence in depth)
// • Base64 must be valid characters only

var ADM_FILE_MAX_BYTES = 12 * 1024 * 1024; // 12 MB hard cap
var ADM_ALLOWED_MIME = {
 'image/jpeg': ['jpg', 'jpeg'],
 'image/png': ['png'],
 'image/webp': ['webp'],
 'application/pdf': ['pdf']
};

function _admExtractFile(data, prefix) {
 var b64 = data[prefix + '_data'];
 if (!b64 || String(b64).length < 10) return null;

 var b64Str = String(b64);
 var mime = String(data[prefix + '_mime'] || '').toLowerCase().trim();
 var ext = String(data[prefix + '_ext'] || '').toLowerCase().trim().replace(/^\./, '');
 var name = String(data[prefix + '_name'] || '');

 // Base64 charset check, only A-Z, a-z, 0-9, +, /, = allowed
 if (!/^[A-Za-z0-9+/=]+$/.test(b64Str.replace(/\s/g, ''))) {
 throw new Error('Invalid file data for ' + prefix + ' (not base64).');
 }

 // Decoded size check (base64 is ~4/3 of binary)
 var approxBytes = Math.floor(b64Str.length * 0.75);
 if (approxBytes > ADM_FILE_MAX_BYTES) {
 throw new Error(prefix + ' file is too large (' + Math.round(approxBytes / 1024 / 1024) + ' MB). Maximum is 12 MB per file.');
 }

 // MIME allowlist
 if (!ADM_ALLOWED_MIME[mime]) {
 throw new Error('Unsupported file type for ' + prefix + ': ' + (mime || 'unknown') + '. Allowed: JPG, PNG, WebP, PDF.');
 }

 // Extension must match MIME
 if (ext && ADM_ALLOWED_MIME[mime].indexOf(ext) === -1) {
 throw new Error('File extension "' + ext + '" does not match its content type "' + mime + '" for ' + prefix + '.');
 }

 // Sanitise filename for logging, no path traversal, no control chars
 name = name.replace(/[\\\/\x00-\x1f]/g, '').substring(0, 120);

 return {
 data: b64Str,
 name: name,
 mimeType: mime,
 ext: ext
 };
}

// ── Get (or auto-create) the dedicated admissions spreadsheet ─────────────────

function _admGetSpreadsheet() {
 var props = PropertiesService.getScriptProperties();
 var id = props.getProperty(ADMISSIONS_SS_PROP_KEY);

 if (id) {
 try {
 var existing = SpreadsheetApp.openById(id);
 return existing;
 } catch (openErr) {
 Logger.log('Stored admissions spreadsheet ID is invalid, creating new');
 }
 }

 // Create a fresh spreadsheet in the script owner's Drive (one-off)
 var ss = SpreadsheetApp.create(ADMISSIONS_SS_NAME);
 props.setProperty(ADMISSIONS_SS_PROP_KEY, ss.getId());
 Logger.log('Created admissions spreadsheet: ' + ss.getUrl());
 return ss;
}

// ── Drive folder for applicant ───────────────────────────────────────────────

function _admCreateFolder(firstName, lastName, dob) {
 var rootIter = DriveApp.getFoldersByName(ADMISSIONS_ROOT_FOLDER);
 var root = rootIter.hasNext() ? rootIter.next() : DriveApp.createFolder(ADMISSIONS_ROOT_FOLDER);

 var yr = new Date().getFullYear().toString();
 var yrIter = root.getFoldersByName(yr);
 var yrFlder = yrIter.hasNext() ? yrIter.next() : root.createFolder(yr);

 var fn = _admCleanName(firstName);
 var ln = _admCleanName(lastName);
 var name = ln + ', ' + fn + ', ' + dob;

 var dupIter = yrFlder.getFoldersByName(name);
 if (dupIter.hasNext()) {
 name += ' (' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss') + ')';
 }
 return yrFlder.createFolder(name);
}

// ── Save a file to Drive ─────────────────────────────────────────────────────

function _admSaveFile(folder, fileObj, firstName, lastName, dob, label) {
 var fn = _admCleanName(firstName).replace(/\s+/g, '');
 var ln = _admCleanName(lastName).replace(/\s+/g, '');
 var dobStr = String(dob).replace(/[\/\s]/g, '-');
 var ext = fileObj.ext ? ('.' + String(fileObj.ext).toLowerCase()) : '';
 var name = ln + '_' + fn + '_' + dobStr + '_' + label + ext;

 var bytes = Utilities.base64Decode(fileObj.data);
 var blob = Utilities.newBlob(bytes, fileObj.mimeType || 'application/octet-stream', name);
 return folder.createFile(blob);
}

// ── Save to admissions spreadsheet ───────────────────────────────────────────

function _admSaveToSheet(data, folderUrl, filesStr) {
 var ss = _admGetSpreadsheet();
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
 s(data.title), s(data.firstName), s(data.middleName), s(data.lastName), s(data.dob),
 s(data.gender), s(data.pronouns), s(data.niNumber), s(data.uln),
 s(data.email), s(data.phone),
 s(data.address1), s(data.address2), s(data.city), s(data.county), s(data.postcode),
 s(data.ethnicity), s(data.disability),s(data.disabilityType), s(data.accessArrangement),
 s(data.highestQual), s(data.englishGrade), s(data.mathsGrade), s(data.otherQuals),
 s(data.employmentStatus), s(data.employer), s(data.jobTitle),
 s(data.course), s(data.preferredStart), s(data.howHeard),
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
 var firstName = s(data.firstName);
 var lastName  = s(data.lastName);
 var fullName  = firstName + ' ' + lastName;
 var course    = s(data.course);
 var toEmail   = s(data.email);

 var subject = 'Application Received, The Data and AI School of London';

 // Plain-text fallback
 var plain =
 'Dear ' + fullName + ',\n\n' +
 'Thank you for submitting your application to The Data and AI School of London.\n\n' +
 'Course applied for: ' + course + '\n\n' +
 'What happens next:\n' +
 ' 1. Our admissions team will review your application within 3 working days.\n' +
 ' 2. You will receive a formal offer letter or a request for further information.\n' +
 ' 3. Once you accept your offer, you will receive enrolment confirmation and\n' +
 ' access details for our online learning platform (VLE).\n\n' +
 'Questions? Email info@dataaischool.com or call +44 207 0990 956.\n\n' +
 'Kind regards,\n' +
 'Sheherbano Khan\n' +
 'Registrar & Learner Support Lead\n' +
 'The Data and AI School of London\n' +
 'www.dataaischool.com';

 var html = _admBuildConfirmationHtml(firstName, fullName, course);

 MailApp.sendEmail(toEmail, subject, plain, {
 htmlBody: html,
 name: 'The Data and AI School of London',
 replyTo: 'info@dataaischool.com'
 });
 } catch (err) {
 Logger.log('Confirmation email failed: ' + err.message);
 }
}

function _admBuildConfirmationHtml(firstName, fullName, course) {
 var navy   = '#0A2240';
 var gold   = '#C89930';
 var goldDk = '#A8690A';
 var cream  = '#F4F1EA';
 var text   = '#1F1F1F';
 var muted  = '#5A5A5A';
 var green  = '#1B6B3A';
 var serif  = "Georgia, 'Times New Roman', Times, serif";

 // Course confirmation block
 var courseBlock = course
 ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border-collapse:collapse;background:' + cream + ';border-left:4px solid ' + gold + ';">' +
 '<tr><td style="padding:16px 20px;font-family:' + serif + ';">' +
 '<div style="font-size:11px;color:' + goldDk + ';font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 8px 0;">Course applied for</div>' +
 '<div style="font-size:16px;color:' + navy + ';font-weight:700;">' + _admEscape(course) + '</div>' +
 '</td></tr>' +
 '</table>'
 : '';

 // "What happens next" steps
 function step(num, label, detail) {
 return '<tr>' +
 '<td valign="top" style="padding:0 14px 0 0;font-family:' + serif + ';">' +
 '<div style="width:32px;height:32px;border-radius:50%;background:' + navy + ';text-align:center;line-height:32px;font-size:14px;font-weight:700;color:' + gold + ';font-family:' + serif + ';">' + num + '</div>' +
 '</td>' +
 '<td style="padding:0 0 20px 0;font-family:' + serif + ';border-bottom:1px solid #E5DFD3;">' +
 '<div style="font-size:15px;font-weight:700;color:' + navy + ';margin:4px 0 4px 0;">' + label + '</div>' +
 '<div style="font-size:14px;color:' + muted + ';line-height:1.6;">' + detail + '</div>' +
 '</td>' +
 '</tr>' +
 '<tr><td colspan="2" style="padding:8px 0;"></td></tr>';
 }

 var stepsTable =
 '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border-collapse:collapse;">' +
 step('1',
 'Application review (within 3 working days)',
 'Our admissions team will assess your application and documents.'
 ) +
 step('2',
 'Formal offer or further information request',
 'You will receive either a conditional/unconditional offer letter or a request for any missing documents.'
 ) +
 step('3',
 'Enrolment confirmation',
 'Once you accept your offer, we will send your enrolment confirmation and access details for our online learning platform (VLE).'
 ) +
 '</table>';

 return (
 '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">' +
 '<html xmlns="http://www.w3.org/1999/xhtml">' +
 '<head>' +
 '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />' +
 '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
 '<title>Application received</title>' +
 '</head>' +
 '<body style="margin:0;padding:0;background-color:' + cream + ';font-family:' + serif + ';">' +

 '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + cream + '" style="background-color:' + cream + ';">' +
 '<tr><td align="center" style="padding:32px 16px;">' +

 '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:600px;background-color:#FFFFFF;border:1px solid #E5DFD3;">' +

 // Header
 '<tr><td bgcolor="' + navy + '" align="center" style="background-color:' + navy + ';padding:32px 24px;border-bottom:4px solid ' + gold + ';">' +
 '<div style="font-family:' + serif + ';color:#FFFFFF;font-size:22px;font-weight:700;line-height:1.2;">The Data and AI</div>' +
 '<div style="font-family:' + serif + ';color:' + gold + ';font-size:13px;font-weight:600;letter-spacing:3px;text-transform:uppercase;margin-top:6px;">School of London</div>' +
 '</td></tr>' +

 // Green confirmation banner
 '<tr><td bgcolor="' + green + '" align="center" style="background-color:' + green + ';padding:14px 24px;">' +
 '<div style="font-family:' + serif + ';color:#FFFFFF;font-size:15px;font-weight:600;letter-spacing:0.5px;">&#10003;&nbsp; Application successfully received</div>' +
 '</td></tr>' +

 // Body
 '<tr><td style="padding:40px 36px 24px;font-family:' + serif + ';">' +

 '<h1 style="margin:0 0 20px 0;font-family:' + serif + ';font-size:24px;font-weight:700;color:' + navy + ';line-height:1.3;">Thank you for your application</h1>' +

 '<p style="margin:0 0 16px 0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">Dear ' + _admEscape(fullName) + ',</p>' +

 '<p style="margin:0 0 16px 0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">Thank you for submitting your application to <strong style="color:' + navy + ';">The Data and AI School of London</strong>. We have received your application and supporting documents and will be in touch shortly.</p>' +

 courseBlock +

 '<h2 style="margin:28px 0 16px 0;font-family:' + serif + ';font-size:18px;font-weight:700;color:' + navy + ';">What happens next</h2>' +

 stepsTable +

 '<p style="margin:16px 0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">If you have any questions in the meantime, please do not hesitate to contact us:</p>' +

 // Contact rows
 '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 20px 0;border-collapse:collapse;">' +
 '<tr><td style="padding:6px 0;font-family:' + serif + ';font-size:15px;color:' + text + ';">' +
 '<strong style="color:' + navy + ';">Email:</strong> &nbsp;' +
 '<a href="mailto:info@dataaischool.com" style="color:' + goldDk + ';text-decoration:none;font-weight:600;">info@dataaischool.com</a>' +
 '</td></tr>' +
 '<tr><td style="padding:6px 0;font-family:' + serif + ';font-size:15px;color:' + text + ';">' +
 '<strong style="color:' + navy + ';">Phone:</strong> &nbsp;' +
 '<a href="tel:+442070990956" style="color:' + goldDk + ';text-decoration:none;font-weight:600;">+44 207 0990 956</a>' +
 '</td></tr>' +
 '</table>' +

 // CTA button
 '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border-collapse:collapse;">' +
 '<tr><td bgcolor="' + navy + '" align="center" style="background-color:' + navy + ';border-radius:4px;">' +
 '<a href="https://www.dataaischool.com/courses.html" style="display:inline-block;padding:14px 32px;font-family:' + serif + ';font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;letter-spacing:0.5px;">Explore our courses &rarr;</a>' +
 '</td></tr>' +
 '</table>' +

 '<p style="margin:24px 0 4px 0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">Kind regards,</p>' +
 '<p style="margin:0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">' +
 '<strong style="color:' + navy + ';">Sheherbano Khan</strong><br/>' +
 '<span style="font-size:14px;color:' + muted + ';">Registrar &amp; Learner Support Lead</span><br/>' +
 '<span style="font-size:14px;color:' + muted + ';">The Data and AI School of London</span>' +
 '</p>' +

 '</td></tr>' +

 // Footer
 '<tr><td bgcolor="' + cream + '" align="center" style="background-color:' + cream + ';padding:20px 36px;border-top:1px solid #E5DFD3;font-family:' + serif + ';">' +
 '<div style="font-size:13px;color:' + navy + ';line-height:1.6;">' +
 '<a href="https://www.dataaischool.com" style="color:' + navy + ';text-decoration:none;font-weight:600;">www.dataaischool.com</a>' +
 ' &nbsp;&#183;&nbsp; ' +
 '<a href="tel:+442070990956" style="color:' + navy + ';text-decoration:none;">+44 207 0990 956</a>' +
 ' &nbsp;&#183;&nbsp; ' +
 '<a href="mailto:info@dataaischool.com" style="color:' + navy + ';text-decoration:none;">info@dataaischool.com</a>' +
 '</div>' +
 '<div style="font-size:11px;color:' + muted + ';margin-top:10px;line-height:1.6;">' +
 'The Data and AI School of London &nbsp;&#183;&nbsp; ICO Registration <strong>ZC086597</strong>' +
 '</div>' +
 '<div style="font-size:11px;color:' + muted + ';margin-top:8px;line-height:1.6;">' +
 'This is an automated confirmation of your application submitted on dataaischool.com.' +
 '</div>' +
 '</td></tr>' +

 '</table>' +

 '</td></tr>' +
 '</table>' +

 '</body></html>'
 );
}

function _admEscape(s) {
 return String(s || '')
 .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _admSendAdminAlert(data, folderUrl, savedFiles, ssUrl) {
 try {
 function s(v) { return String(v || '').replace(/<[^>]*>/g, '').trim(); }
 var name = s(data.firstName) + ' ' + s(data.lastName);
 MailApp.sendEmail({
 to: 'info@dataaischool.com',
 subject: 'New Admission Application: ' + name + ', ' + s(data.course),
 body:
 'New admission application received.\n\n' +
 'Name: ' + name + '\n' +
 'DOB: ' + s(data.dob) + '\n' +
 'Email: ' + s(data.email) + '\n' +
 'Phone: ' + s(data.phone) + '\n' +
 'Course: ' + s(data.course) + '\n' +
 'Preferred Start: ' + s(data.preferredStart) + '\n' +
 'Postcode: ' + s(data.postcode) + '\n\n' +
 'Files saved to Drive:\n' +
 savedFiles.map(function(f) { return ' • ' + f; }).join('\n') + '\n\n' +
 'Drive folder:\n ' + folderUrl + '\n\n' +
 'Admissions spreadsheet:\n ' + ssUrl
 });
 } catch (err) {
 Logger.log('Admin alert failed: ' + err.message);
 }
}

// ── Validation ────────────────────────────────────────────────────────────────

function _admValidate(d, photo, idDoc) {
 var required = [
 [d.firstName, 'First name'],
 [d.lastName, 'Last name'],
 [d.dob, 'Date of birth'],
 [d.gender, 'Gender'],
 [d.email, 'Email address'],
 [d.phone, 'Phone number'],
 [d.address1, 'Address line 1'],
 [d.city, 'City / Town'],
 [d.postcode, 'Postcode'],
 [d.ethnicity, 'Ethnicity'],
 [d.disability, 'Disability / LDD declaration'],
 [d.highestQual, 'Highest qualification'],
 [d.englishGrade, 'English qualification grade'],
 [d.mathsGrade, 'Maths qualification grade'],
 [d.employmentStatus, 'Employment status'],
 [d.course, 'Course applied for'],
 [d.emergencyName, 'Emergency contact name'],
 [d.emergencyRelationship, 'Emergency contact relationship'],
 [d.emergencyPhone, 'Emergency contact phone']
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
// MANUAL SETUP, run this ONCE from the Apps Script editor.
//
// Select 'setupAdmissionsInfrastructure' from the dropdown → ▶ Run.
// Authorise when prompted (Drive + Sheets + Mail). After it succeeds:
// • A "DAIS Admissions" folder will exist in your My Drive root
// • A "DAIS Admissions Database" spreadsheet will exist with headers
// • Logger shows both URLs
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
 var yr = new Date().getFullYear().toString();
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
 _admSaveToSheet({}, '(setup)', '(setup)'); // creates the sheet + headers
 var newSheet = ss.getSheetByName(ADMISSIONS_SHEET_NAME);
 newSheet.deleteRow(2); // remove the dummy row
 Logger.log('✓ Created Admissions tab with headers');
 } else {
 Logger.log('Admissions tab already exists');
 }

 Logger.log('═══════════════════════════════════════════════');
 Logger.log('SETUP COMPLETE');
 Logger.log('Drive folder: ' + root.getUrl());
 Logger.log('Spreadsheet: ' + ss.getUrl());
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

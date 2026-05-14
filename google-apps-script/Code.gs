/**
 * The Data and AI School of London
 * Google Apps Script, Form-to-Spreadsheet handler
 *
 * Routes incoming POST requests:
 * • JSON body with formType = "admission" → Admission.gs → handleAdmissionPost()
 * • URL-encoded params (existing iframe technique) → contact / enquiry handler
 *
 * RE-DEPLOY STEPS:
 * 1. Paste this file into Apps Script → Save
 * 2. Add the Drive API service (+ icon → Google Drive API → Add)
 * 3. Deploy → Manage deployments → Edit → New version → Deploy
 *
 * ⚠️ Do NOT click "Run" on doPost from the editor, it requires an HTTP POST.
 * To authorise Drive, open the deployment URL in a browser (calls doGet).
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY: SPREADSHEET_ID is loaded from Script Properties at runtime so the
// ID is NOT committed to the public source repository.
//
// One-time setup:
// Apps Script editor → Project Settings (⚙️) → Script Properties
// Add a property: Name = SPREADSHEET_ID Value = <your sheet id>
// ─────────────────────────────────────────────────────────────────────────────
function SPREADSHEET_ID() {
 var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
 if (!id) {
 throw new Error('SPREADSHEET_ID is not set. Add it in Project Settings → Script Properties.');
 }
 return id;
}

var SHEET_NAME = "Submissions";
var RATE_LIMIT = 30;

var HEADERS = [
 "Timestamp", "Form Type", "Full Name",
 "Email", "Phone", "Course / Subject", "Message / Background",
];

// ── doPost ────────────────────────────────────────────────────────────────────

function doPost(e) {

 // Guard: doPost requires an HTTP POST. Editor Run button passes no event.
 if (!e) {
 Logger.log('doPost was run from the editor, it requires an HTTP POST request.');
 return ContentService.createTextOutput(
 'doPost requires an HTTP POST. Use the live form on apply.html instead.'
 );
 }

 var p = e.parameter || {};

 // Route admission form → Admission.gs
 // Detection: explicit formType, OR presence of admission-only fields
 // (firstName/lastName/dob/ethnicity/photo_data, the contact form has none of these).
 if (p.formType === 'admission' ||
 p.firstName || p.lastName || p.dob || p.ethnicity || p.photo_data) {
 return handleAdmissionPost(p);
 }

 // ── Contact / enquiry form handler ──────────────────────────────────────────
 try {
 if (p.hp_website && p.hp_website.trim() !== "") {
 return _json({ result: "success" });
 }

 var props = PropertiesService.getScriptProperties();
 var hourKey = "count_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMddHH");
 var count = parseInt(props.getProperty(hourKey) || "0");
 if (count >= RATE_LIMIT) {
 return _json({ result: "error", message: "Too many submissions. Please try again later or call us on +44 207 0990 956." });
 }
 props.setProperty(hourKey, String(count + 1));

 var name = (p.name || "").trim();
 var email = (p.email || "").trim();
 var phone = (p.phone || "").trim();
 var msg = (p.message || p.background || "").trim();
 var subj = (p.subject || p.course || "").trim();

 if (!name || !email) return _json({ result: "error", message: "Name and email are required." });
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return _json({ result: "error", message: "Please enter a valid email address." });

 // Length caps per field, defence against payload abuse
 if (name.length > 100) return _json({ result: "error", message: "Name too long." });
 if (email.length > 200) return _json({ result: "error", message: "Email too long." });
 if (phone.length > 40) return _json({ result: "error", message: "Phone too long." });
 if (subj.length > 200) return _json({ result: "error", message: "Subject too long." });
 if (msg.length > 5000) return _json({ result: "error", message: "Message too long." });

 var ss = SpreadsheetApp.openById(SPREADSHEET_ID());
 var sheet = ss.getSheetByName(SHEET_NAME);
 if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

 if (sheet.getLastRow() === 0) {
 sheet.appendRow(HEADERS);
 var hr = sheet.getRange(1, 1, 1, HEADERS.length);
 hr.setFontWeight("bold").setBackground("#0A2240").setFontColor("#FFFFFF").setHorizontalAlignment("center");
 sheet.setFrozenRows(1);
 sheet.setColumnWidth(1, 160);
 sheet.setColumnWidth(2, 150);
 sheet.setColumnWidth(3, 160);
 sheet.setColumnWidth(4, 220);
 sheet.setColumnWidth(5, 140);
 sheet.setColumnWidth(6, 180);
 sheet.setColumnWidth(7, 360);
 }

 function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, "").trim(); }

 var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
 sheet.appendRow([
 timestamp,
 stripTags(p.formType) || "Unknown",
 stripTags(p.name),
 stripTags(p.email),
 stripTags(p.phone),
 stripTags(p.subject || p.course),
 stripTags(p.message || p.background),
 ]);

 var lastRow = sheet.getLastRow();
 if (lastRow % 2 === 0) {
 sheet.getRange(lastRow, 1, 1, HEADERS.length).setBackground("#EBE4D8");
 }

 // Send branded auto-reply to the enquirer
 _sendEnquiryAutoReply({
 name: stripTags(p.name),
 email: stripTags(p.email),
 subject: stripTags(p.subject || p.course),
 message: stripTags(p.message || p.background)
 });

 return _json({ result: "success", row: lastRow });

 } catch (err) {
 return _json({ result: "error", message: "Server error. Please call +44 207 0990 956." });
 }
}

// ── Branded auto-reply to enquiry submissions ─────────────────────────────────

function _sendEnquiryAutoReply(d) {
 if (!d.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) return;
 try {
 var firstName = (d.name || '').split(' ')[0] || 'there';
 var subject = "We've received your enquiry, The Data and AI School of London";

 // Plain-text fallback
 var plain =
 'Hi ' + firstName + ',\n\n' +
 'Thank you for getting in touch with The Data and AI School of London.\n' +
 'We have received your message and a member of our team will respond ' +
 'within 2 working days.\n\n' +
 (d.subject ? 'Your enquiry was about: ' + d.subject + '\n' : '') +
 (d.message ? 'A copy of your message:\n"' + d.message + '"\n\n' : '\n') +
 'If your enquiry is urgent, call us on +44 207 0990 956.\n\n' +
 'Kind regards,\n' +
 'The Data and AI School of London\n' +
 'www.dataaischool.com';

 // Branded HTML, table-based for maximum email client compatibility
 var html = _buildEnquiryHtml(firstName, d.subject, d.message);

 // Use the 4-argument signature, most reliable for HTML emails
 MailApp.sendEmail(d.email, subject, plain, {
 htmlBody: html,
 name: 'The Data and AI School of London',
 replyTo: 'info@dataaischool.com'
 });
 } catch (err) {
 Logger.log('Auto-reply failed: ' + err.message);
 }
}

function _buildEnquiryHtml(firstName, enquirySubject, enquiryMessage) {
 var navy = '#0A2240';
 var gold = '#C89930';
 var goldDk = '#A8690A';
 var cream = '#F4F1EA';
 var text = '#1F1F1F';
 var muted = '#5A5A5A';
 var serif = "Georgia, 'Times New Roman', Times, serif";

 var enquiryBlock = '';
 if (enquirySubject || enquiryMessage) {
 enquiryBlock =
 '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border-collapse:collapse;background:' + cream + ';border-left:4px solid ' + gold + ';">' +
 '<tr><td style="padding:16px 20px;font-family:' + serif + ';">' +
 '<div style="font-size:11px;color:' + goldDk + ';font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 8px 0;">Your enquiry</div>' +
 (enquirySubject ? '<div style="font-size:15px;color:' + text + ';font-weight:700;margin:0 0 8px 0;">' + _escape(enquirySubject) + '</div>' : '') +
 (enquiryMessage ? '<div style="font-size:14px;color:' + muted + ';line-height:1.6;font-style:italic;">"' + _escape(enquiryMessage) + '"</div>' : '') +
 '</td></tr>' +
 '</table>';
 }

 return (
 '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">' +
 '<html xmlns="http://www.w3.org/1999/xhtml">' +
 '<head>' +
 '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />' +
 '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
 '<title>Enquiry received</title>' +
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

 // Body
 '<tr><td style="padding:40px 36px 24px;font-family:' + serif + ';">' +

 '<h1 style="margin:0 0 20px 0;font-family:' + serif + ';font-size:24px;font-weight:700;color:' + navy + ';line-height:1.3;">Thank you for your enquiry</h1>' +

 '<p style="margin:0 0 16px 0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">Hi ' + _escape(firstName) + ',</p>' +

 '<p style="margin:0 0 16px 0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">Thank you for getting in touch with <strong style="color:' + navy + ';">The Data and AI School of London</strong>. We have received your message and a member of our team will respond within <strong style="color:' + navy + ';">2 working days</strong>.</p>' +

 enquiryBlock +

 '<p style="margin:16px 0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">If your enquiry is urgent, you can reach us directly:</p>' +

 // Contact rows
 '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 20px 0;border-collapse:collapse;">' +
 '<tr><td style="padding:6px 0;font-family:' + serif + ';font-size:15px;color:' + text + ';">' +
 '<strong style="color:' + navy + ';">Phone:</strong> &nbsp;' +
 '<a href="tel:+442070990956" style="color:' + goldDk + ';text-decoration:none;font-weight:600;">+44 207 0990 956</a>' +
 '</td></tr>' +
 '<tr><td style="padding:6px 0;font-family:' + serif + ';font-size:15px;color:' + text + ';">' +
 '<strong style="color:' + navy + ';">Email:</strong> &nbsp;' +
 '<a href="mailto:info@dataaischool.com" style="color:' + goldDk + ';text-decoration:none;font-weight:600;">info@dataaischool.com</a>' +
 '</td></tr>' +
 '</table>' +

 // CTA button (bulletproof)
 '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border-collapse:collapse;">' +
 '<tr><td bgcolor="' + navy + '" align="center" style="background-color:' + navy + ';border-radius:4px;">' +
 '<a href="https://www.dataaischool.com/courses.html" style="display:inline-block;padding:14px 32px;font-family:' + serif + ';font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;letter-spacing:0.5px;">View our courses &rarr;</a>' +
 '</td></tr>' +
 '</table>' +

 '<p style="margin:24px 0 0 0;font-family:' + serif + ';font-size:16px;color:' + text + ';line-height:1.6;">Kind regards,<br/>' +
 '<strong style="color:' + navy + ';">The Data and AI School of London</strong>' +
 '</p>' +

 '</td></tr>' +

 // Footer
 '<tr><td bgcolor="' + cream + '" align="center" style="background-color:' + cream + ';padding:20px 36px;border-top:1px solid #E5DFD3;font-family:' + serif + ';">' +
 '<div style="font-size:13px;color:' + navy + ';line-height:1.6;">' +
 '<a href="https://www.dataaischool.com" style="color:' + navy + ';text-decoration:none;font-weight:600;">www.dataaischool.com</a>' +
 ' &nbsp;·&nbsp; ' +
 '<a href="tel:+442070990956" style="color:' + navy + ';text-decoration:none;">+44 207 0990 956</a>' +
 '</div>' +
 '<div style="font-size:11px;color:' + muted + ';margin-top:10px;line-height:1.6;">' +
 'The Data and AI School of London · ICO Registration <strong>ZC086597</strong>' +
 '</div>' +
 '<div style="font-size:11px;color:' + muted + ';margin-top:8px;line-height:1.6;">' +
 'This is an automated confirmation of your enquiry submitted on dataaischool.com.' +
 '</div>' +
 '</td></tr>' +

 '</table>' +

 '</td></tr>' +
 '</table>' +

 '</body></html>'
 );
}

function _escape(s) {
 return String(s || '')
 .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── doGet, authorises Drive on first browser visit ───────────────────────────

function doGet(e) {
 try {
 DriveApp.getRootFolder();
 return ContentService.createTextOutput("Drive authorised successfully. You can close this tab.");
 } catch (err) {
 return ContentService.createTextOutput("Error: " + err.message);
 }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function _json(obj) {
 return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

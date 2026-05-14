/**
 * The Data and AI School of London
 * Google Apps Script — Form-to-Spreadsheet handler
 *
 * Routes incoming POST requests:
 *   • JSON body with formType = "admission" → Admission.gs → handleAdmissionPost()
 *   • URL-encoded params (existing iframe technique) → contact / enquiry handler
 *
 * RE-DEPLOY STEPS:
 *  1. Paste this file into Apps Script → Save
 *  2. Add the Drive API service (+ icon → Google Drive API → Add)
 *  3. Deploy → Manage deployments → Edit → New version → Deploy
 *
 * ⚠️  Do NOT click "Run" on doPost from the editor — it requires an HTTP POST.
 *     To authorise Drive, open the deployment URL in a browser (calls doGet).
 */

var SPREADSHEET_ID = "<REDACTED>";
var SHEET_NAME     = "Submissions";
var RATE_LIMIT     = 30;

var HEADERS = [
  "Timestamp", "Form Type", "Full Name",
  "Email", "Phone", "Course / Subject", "Message / Background",
];

// ── doPost ────────────────────────────────────────────────────────────────────

function doPost(e) {

  // Guard: doPost requires an HTTP POST. Editor Run button passes no event.
  if (!e) {
    Logger.log('doPost was run from the editor — it requires an HTTP POST request.');
    return ContentService.createTextOutput(
      'doPost requires an HTTP POST. Use the live form on apply.html instead.'
    );
  }

  var p = e.parameter || {};

  // Route admission form → Admission.gs
  // Detection: explicit formType, OR presence of admission-only fields
  // (firstName/lastName/dob/ethnicity/photo_data — the contact form has none of these).
  if (p.formType === 'admission' ||
      p.firstName || p.lastName || p.dob || p.ethnicity || p.photo_data) {
    return handleAdmissionPost(p);
  }

  // ── Contact / enquiry form handler ──────────────────────────────────────────
  try {
    if (p.hp_website && p.hp_website.trim() !== "") {
      return _json({ result: "success" });
    }

    var props   = PropertiesService.getScriptProperties();
    var hourKey = "count_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMddHH");
    var count   = parseInt(props.getProperty(hourKey) || "0");
    if (count >= RATE_LIMIT) {
      return _json({ result: "error", message: "Too many submissions. Please try again later or call us on +44 207 0990 956." });
    }
    props.setProperty(hourKey, String(count + 1));

    var name  = (p.name  || "").trim();
    var email = (p.email || "").trim();
    if (!name || !email) return _json({ result: "error", message: "Name and email are required." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return _json({ result: "error", message: "Please enter a valid email address." });
    if (name.length > 200 || email.length > 200) return _json({ result: "error", message: "Input too long." });

    var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
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
      name:    stripTags(p.name),
      email:   stripTags(p.email),
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

    // Plain-text fallback for clients that block HTML
    var plain =
      'Hi ' + firstName + ',\n\n' +
      'Thank you for getting in touch with The Data and AI School of London.\n\n' +
      'We have received your message and a member of our team will respond within ' +
      '2 working days.\n\n' +
      (d.subject ? 'Your enquiry was about: ' + d.subject + '\n' : '') +
      (d.message ? 'A copy of your message:\n"' + d.message + '"\n\n' : '\n') +
      'If your enquiry is urgent, call us on +44 207 0990 956.\n\n' +
      'Kind regards,\n' +
      'The Data and AI School of London\n' +
      'www.dataaischool.com';

    // Branded HTML body — Oxford Navy + Academic Gold theme
    var html =
      '<!doctype html><html><body style="margin:0;padding:0;background:#f4f1ea;font-family:Georgia,\'Times New Roman\',serif;color:#1f1f1f;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f1ea;padding:32px 16px;">' +
          '<tr><td align="center">' +
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(10,34,64,0.08);">' +

              // Header
              '<tr><td style="background:#0A2240;padding:28px 32px;text-align:center;border-bottom:3px solid #C89930;">' +
                '<div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.02em;font-family:Georgia,\'Times New Roman\',serif;">The Data and AI</div>' +
                '<div style="color:#C89930;font-size:14px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;margin-top:4px;font-family:Georgia,\'Times New Roman\',serif;">School of London</div>' +
              '</td></tr>' +

              // Body
              '<tr><td style="padding:36px 36px 12px;">' +
                '<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0A2240;font-family:Georgia,\'Times New Roman\',serif;">Thank you for your enquiry</h1>' +
                '<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3a3a3a;">Hi ' + _escape(firstName) + ',</p>' +
                '<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3a3a3a;">Thank you for getting in touch with The Data and AI School of London. We have received your message and a member of our team will respond within <strong style="color:#0A2240;">2 working days</strong>.</p>' +

                (d.subject ?
                  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0;background:#f4f1ea;border-left:4px solid #C89930;border-radius:4px;">' +
                    '<tr><td style="padding:14px 18px;">' +
                      '<div style="font-size:12px;color:#a8690a;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Your enquiry</div>' +
                      '<div style="font-size:14px;color:#1f1f1f;font-weight:600;">' + _escape(d.subject) + '</div>' +
                      (d.message ? '<div style="font-size:14px;color:#5a5a5a;line-height:1.6;margin-top:10px;font-style:italic;">&ldquo;' + _escape(d.message) + '&rdquo;</div>' : '') +
                    '</td></tr>' +
                  '</table>'
                : '') +

                '<p style="margin:16px 0;font-size:15px;line-height:1.65;color:#3a3a3a;">If your enquiry is urgent, you can reach us directly:</p>' +

                // Contact card
                '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0 24px;">' +
                  '<tr>' +
                    '<td width="50%" style="padding:6px 0;font-size:14px;color:#3a3a3a;">' +
                      '<strong style="color:#0A2240;">Phone:</strong> <a href="tel:+442070990956" style="color:#C89930;text-decoration:none;">+44 207 0990 956</a>' +
                    '</td>' +
                    '<td width="50%" style="padding:6px 0;font-size:14px;color:#3a3a3a;">' +
                      '<strong style="color:#0A2240;">Email:</strong> <a href="mailto:info@dataaischool.com" style="color:#C89930;text-decoration:none;">info@dataaischool.com</a>' +
                    '</td>' +
                  '</tr>' +
                '</table>' +

                // CTA
                '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 12px;">' +
                  '<tr><td style="background:#0A2240;border-radius:4px;">' +
                    '<a href="https://www.dataaischool.com/courses.html" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;font-family:Georgia,\'Times New Roman\',serif;letter-spacing:0.02em;">View our courses →</a>' +
                  '</td></tr>' +
                '</table>' +

                '<p style="margin:24px 0 0;font-size:15px;line-height:1.65;color:#3a3a3a;">Kind regards,<br/>' +
                  '<strong style="color:#0A2240;">The Data and AI School of London</strong>' +
                '</p>' +
              '</td></tr>' +

              // Footer
              '<tr><td style="background:#f4f1ea;padding:20px 36px;border-top:1px solid #e5dfd3;text-align:center;font-family:Georgia,\'Times New Roman\',serif;">' +
                '<div style="font-size:12px;color:#7a7468;line-height:1.65;">' +
                  '<a href="https://www.dataaischool.com" style="color:#0A2240;text-decoration:none;font-weight:600;">www.dataaischool.com</a>' +
                  ' &nbsp;&middot;&nbsp; <a href="tel:+442070990956" style="color:#7a7468;text-decoration:none;">+44 207 0990 956</a>' +
                '</div>' +
                '<div style="font-size:11px;color:#9a9387;margin-top:8px;">' +
                  'The Data and AI School of London &middot; ICO Registration <strong>ZC086597</strong>' +
                '</div>' +
                '<div style="font-size:11px;color:#9a9387;margin-top:8px;line-height:1.6;">' +
                  'This is an automated confirmation. You are receiving it because you submitted an enquiry on dataaischool.com.' +
                '</div>' +
              '</td></tr>' +

            '</table>' +
          '</td></tr>' +
        '</table>' +
      '</body></html>';

    MailApp.sendEmail({
      to:       d.email,
      subject:  'We\'ve received your enquiry — The Data and AI School of London',
      body:     plain,
      htmlBody: html,
      name:     'The Data and AI School of London',
      replyTo:  'info@dataaischool.com'
    });
  } catch (err) {
    Logger.log('Auto-reply failed: ' + err.message);
  }
}

function _escape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── doGet — authorises Drive on first browser visit ───────────────────────────

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

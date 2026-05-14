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

    return _json({ result: "success", row: lastRow });

  } catch (err) {
    return _json({ result: "error", message: "Server error. Please call +44 207 0990 956." });
  }
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

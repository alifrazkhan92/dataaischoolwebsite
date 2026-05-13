/**
 * The Data and AI School of London
 * Google Apps Script — Form-to-Spreadsheet handler
 *
 * TARGET SPREADSHEET:
 *   https://docs.google.com/spreadsheets/d/<REDACTED>
 *
 * ⚠️  SECURITY: Ensure the Google Sheet sharing is set to "Restricted"
 *     (only people explicitly shared can view it). Go to Share → Settings.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * RE-DEPLOY STEPS (required after every code change):
 * ═══════════════════════════════════════════════════════════════════════════════
 *  1. Open your spreadsheet → Extensions → Apps Script
 *  2. Select all code → delete → paste this entire file → Save (💾)
 *  3. Deploy → Manage deployments → Edit (pencil icon)
 *     → Version: "New version" → Deploy
 * ═══════════════════════════════════════════════════════════════════════════════
 */

var SPREADSHEET_ID = "<REDACTED>";
var SHEET_NAME     = "Submissions";
var RATE_LIMIT     = 30;   // max legitimate submissions per hour across all users

var HEADERS = [
  "Timestamp",
  "Form Type",
  "Full Name",
  "Email",
  "Phone",
  "Course / Subject",
  "Message / Background",
];

// ── doPost — receives form submissions ─────────────────────────────────────────
//
// Routes incoming POST requests:
//   • JSON body with formType = "admission" → Admission.gs → handleAdmissionPost()
//   • URL-encoded params (existing iframe technique) → contact / enquiry handler below
//
// After adding Admission.gs, enable Drive API:
//   Services (+ icon) → Google Drive API → Add
// Then: Deploy → Manage deployments → Edit → New version → Deploy  (URL unchanged)

function doPost(e) {

  // ── Route: admission form sends JSON via fetch (no-cors, text/plain body) ────
  if (e.postData && e.postData.contents) {
    try {
      var parsed = JSON.parse(e.postData.contents);
      if (parsed.formType === 'admission') {
        return handleAdmissionPost(parsed);   // defined in Admission.gs
      }
    } catch (routeErr) {
      // Not valid JSON — fall through to contact handler
    }
  }

  // ── Existing contact / enquiry form handler ───────────────────────────────────
  try {
    var p = e.parameter || {};

    // ── 1. Honeypot check ───────────────────────────────────────────────────────
    // hp_website is a hidden field invisible to real users. Bots fill it in.
    if (p.hp_website && p.hp_website.trim() !== "") {
      // Return fake success so bots don't retry
      return _json({ result: "success" });
    }

    // ── 2. Rate limiting ────────────────────────────────────────────────────────
    // Counts total submissions per hour. Resets automatically each new hour.
    var props   = PropertiesService.getScriptProperties();
    var hourKey = "count_" + Utilities.formatDate(
      new Date(), Session.getScriptTimeZone(), "yyyyMMddHH"
    );
    var count = parseInt(props.getProperty(hourKey) || "0");
    if (count >= RATE_LIMIT) {
      return _json({ result: "error", message: "Too many submissions. Please try again later or call us on +44 207 0990 956." });
    }
    props.setProperty(hourKey, String(count + 1));

    // ── 3. Server-side validation ───────────────────────────────────────────────
    var name  = (p.name  || "").trim();
    var email = (p.email || "").trim();

    if (!name || !email) {
      return _json({ result: "error", message: "Name and email are required." });
    }

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return _json({ result: "error", message: "Please enter a valid email address." });
    }

    // Reject suspiciously long fields (prevents payload injection)
    if (name.length > 200 || email.length > 200) {
      return _json({ result: "error", message: "Input too long." });
    }

    // ── 4. Write to spreadsheet ─────────────────────────────────────────────────
    var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
    }

    // Write styled header row on first use
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      var hr = sheet.getRange(1, 1, 1, HEADERS.length);
      hr.setFontWeight("bold")
        .setBackground("#0A2240")
        .setFontColor("#FFFFFF")
        .setHorizontalAlignment("center");
      sheet.setFrozenRows(1);
      sheet.setColumnWidth(1, 160);
      sheet.setColumnWidth(2, 150);
      sheet.setColumnWidth(3, 160);
      sheet.setColumnWidth(4, 220);
      sheet.setColumnWidth(5, 140);
      sheet.setColumnWidth(6, 180);
      sheet.setColumnWidth(7, 360);
    }

    var timestamp = Utilities.formatDate(
      new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss"
    );

    // Sanitise: strip any HTML tags from free-text fields before storing
    function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, "").trim(); }

    var row = [
      timestamp,
      stripTags(p.formType)   || "Unknown",
      stripTags(p.name),
      stripTags(p.email),
      stripTags(p.phone),
      stripTags(p.subject || p.course),
      stripTags(p.message || p.background),
    ];

    sheet.appendRow(row);

    // Alternate row shading for readability
    var lastRow = sheet.getLastRow();
    if (lastRow % 2 === 0) {
      sheet.getRange(lastRow, 1, 1, HEADERS.length).setBackground("#EBE4D8");
    }

    return _json({ result: "success", row: lastRow });

  } catch (err) {
    return _json({ result: "error", message: "Server error. Please call +44 207 0990 956." });
  }
}

// ── doGet — health-check ───────────────────────────────────────────────────────

function doGet(e) {
  return _json({ result: "ok", service: "DAIS Form Handler" });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

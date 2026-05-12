/**
 * The Data and AI School of London
 * Google Apps Script — Form-to-Spreadsheet handler
 *
 * TARGET SPREADSHEET:
 *   https://docs.google.com/spreadsheets/d/<REDACTED>
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * RE-DEPLOY STEPS (required after every code change):
 * ═══════════════════════════════════════════════════════════════════════════════
 *  1. Open your spreadsheet → Extensions → Apps Script
 *  2. Select all code → delete → paste this entire file → Save (💾)
 *  3. Deploy → Manage deployments → Edit (pencil icon)
 *     → Version: "New version" → Deploy
 *  No need to change any other settings or copy a new URL.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

var SPREADSHEET_ID = "<REDACTED>";
var SHEET_NAME     = "Submissions";

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

function doPost(e) {
  try {
    // Parse JSON sent as text/plain (survives Google's no-cors redirect chain)
    var p = {};
    try {
      p = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      // Fallback: try URL-encoded parameters
      p = e.parameter || {};
    }

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
      new Date(),
      Session.getScriptTimeZone(),
      "dd/MM/yyyy HH:mm:ss"
    );

    var row = [
      timestamp,
      p.formType    || "Unknown",
      p.name        || "",
      p.email       || "",
      p.phone       || "",
      p.subject     || p.course || "",
      p.message     || p.background || "",
    ];

    sheet.appendRow(row);

    // Alternate row shading
    var lastRow = sheet.getLastRow();
    if (lastRow % 2 === 0) {
      sheet.getRange(lastRow, 1, 1, HEADERS.length).setBackground("#EBE4D8");
    }

    return _json({ result: "success", row: lastRow });

  } catch (err) {
    return _json({ result: "error", message: err.toString() });
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

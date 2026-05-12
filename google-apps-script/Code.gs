/**
 * The Data and AI School of London
 * Google Apps Script — Form-to-Spreadsheet handler
 *
 * TARGET SPREADSHEET (already configured):
 *   https://docs.google.com/spreadsheets/d/<REDACTED>
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ONE-TIME DEPLOYMENT STEPS (takes ~2 minutes):
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * STEP 1 — Open your spreadsheet:
 *   https://docs.google.com/spreadsheets/d/<REDACTED>
 *
 * STEP 2 — Open Apps Script:
 *   Click  Extensions  →  Apps Script
 *
 * STEP 3 — Paste this code:
 *   Select all existing code in the editor (Ctrl+A / Cmd+A) and delete it.
 *   Paste ALL of this file. Click Save (💾).
 *   Give the project a name, e.g. "DAIS Form Handler".
 *
 * STEP 4 — Deploy as a Web App:
 *   Click  Deploy  →  New deployment
 *   ┌──────────────────────────────────────┐
 *   │  Type:            Web app            │
 *   │  Execute as:      Me                 │
 *   │  Who has access:  Anyone             │
 *   └──────────────────────────────────────┘
 *   Click Deploy → click Authorise → sign in with your Google account
 *   → Allow → COPY the Web app URL (looks like https://script.google.com/macros/s/…/exec)
 *
 * STEP 5 — Activate the forms on the website:
 *   In contact.html AND apply.html, find:
 *       data-spreadsheet="YOUR_APPS_SCRIPT_URL"
 *   Replace  YOUR_APPS_SCRIPT_URL  with the URL you just copied.
 *   Save both files, commit and push to GitHub.
 *
 * DONE — every form submission will appear as a new row in your spreadsheet.
 *
 * ─── To re-deploy after editing this script ───────────────────────────────────
 *   Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ── Configuration ──────────────────────────────────────────────────────────────

var SPREADSHEET_ID = "<REDACTED>";
var SHEET_NAME     = "Submissions";

// ── Column headers (written once when the sheet is first used) ─────────────────

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
    var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);

    // Create the Submissions tab if it doesn't exist yet
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
    }

    // Write styled header row on first use
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);

      var headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
      headerRange
        .setFontWeight("bold")
        .setBackground("#0A2240")
        .setFontColor("#FFFFFF")
        .setHorizontalAlignment("center");

      sheet.setFrozenRows(1);
      sheet.setColumnWidth(1, 160); // Timestamp
      sheet.setColumnWidth(2, 140); // Form Type
      sheet.setColumnWidth(3, 160); // Name
      sheet.setColumnWidth(4, 220); // Email
      sheet.setColumnWidth(5, 140); // Phone
      sheet.setColumnWidth(6, 180); // Course / Subject
      sheet.setColumnWidth(7, 340); // Message
    }

    // Read submitted fields
    var p = e.parameter || {};

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

    // Alternate row shading for readability
    var lastRow = sheet.getLastRow();
    if (lastRow % 2 === 0) {
      sheet.getRange(lastRow, 1, 1, HEADERS.length)
        .setBackground("#EBE4D8");
    }

    return _json({ result: "success", row: lastRow });

  } catch (err) {
    return _json({ result: "error", message: err.toString() });
  }
}

// ── doGet — health-check endpoint ─────────────────────────────────────────────

function doGet(e) {
  return _json({ result: "ok", service: "DAIS Form Handler", spreadsheetId: SPREADSHEET_ID });
}

// ── Helper ─────────────────────────────────────────────────────────────────────

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

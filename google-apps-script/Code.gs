/**
 * The Data and AI School of London
 * Google Apps Script — Form-to-Spreadsheet handler
 *
 * HOW TO DEPLOY (one-time setup):
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Open Google Sheets → create a new spreadsheet → name it
 *    "DAIS Website Enquiries" (or anything you like)
 *
 * 2. In the spreadsheet: Extensions → Apps Script
 *
 * 3. Delete any code in the editor and paste ALL of this file.
 *
 * 4. Click "Save" (floppy disk icon), give the project a name.
 *
 * 5. Click "Deploy" → "New deployment":
 *      Type:               Web app
 *      Execute as:         Me  (your Google account)
 *      Who has access:     Anyone
 *    Click "Deploy" → authorise when prompted → copy the Web app URL.
 *
 * 6. In contact.html AND apply.html find the attribute:
 *      data-spreadsheet="YOUR_APPS_SCRIPT_URL"
 *    Replace  YOUR_APPS_SCRIPT_URL  with the URL you just copied.
 *
 * 7. Commit and push to GitHub — forms are now live and writing to your sheet.
 *
 * To RE-DEPLOY after editing this script:
 *    Deploy → Manage deployments → Edit → Version: New version → Deploy
 * ─────────────────────────────────────────────────────────────────────────────
 */

var SHEET_NAME = "Submissions"; // Tab name — created automatically on first run

/**
 * Handles POST requests from the website contact and application forms.
 * Appends one row per submission to the spreadsheet.
 */
function doPost(e) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

    // Add header row if the sheet is brand new
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Timestamp",
        "Form",
        "Name",
        "Email",
        "Phone",
        "Course / Subject",
        "Message / Background",
      ]);
      sheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#0A2240").setFontColor("#FFFFFF");
      sheet.setFrozenRows(1);
    }

    // Parse the submitted data (sent as URL-encoded form data)
    var p = e.parameter || {};

    var timestamp = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "dd/MM/yyyy HH:mm:ss"
    );

    sheet.appendRow([
      timestamp,
      p.formType   || "Unknown",
      p.name       || "",
      p.email      || "",
      p.phone      || "",
      p.subject    || p.course || "",
      p.message    || p.background || "",
    ]);

    // Auto-resize columns for readability
    sheet.autoResizeColumns(1, 7);

    return ContentService
      .createTextOutput(JSON.stringify({ result: "success" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Handles GET requests — used to verify the deployment is live.
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ result: "ok", service: "DAIS Form Handler" }))
    .setMimeType(ContentService.MimeType.JSON);
}

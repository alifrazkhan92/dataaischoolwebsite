# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in this website
or the supporting Google Apps Script, please email **info@dataaischool.com**
with subject line `SECURITY` and a description of the issue.

Please do **not** open a public GitHub issue for security reports.

We will acknowledge receipt within 2 working days and aim to provide an
initial response within 5 working days.

---

## What data is collected and where it is stored

| Form | Data collected | Stored in |
|------|---------------|-----------|
| Contact / Enquiry | Name, email, phone, course of interest, free-text message | A private Google Sheet (Restricted access) |
| NCFE Admission | Personal details, contact details, equality monitoring data, prior education, employment, course, emergency contact, photo, ID document, qualification certificates | A separate private Google Sheet + a private Google Drive folder, both Restricted access |
| Auto-reply email | Email address + first name (for personalisation) | Sent once via Apps Script `MailApp`; not stored after sending |

**Data controller:** The Data and AI School of London
**ICO registration:** ZC086597
**DPO contact:** dpo@dataaischool.com

---

## Security model

The site is a static HTML/CSS/JS site hosted on GitHub Pages.
Form submissions are received by a Google Apps Script web app that
runs as the script owner (the school's Google account).

Defence-in-depth layers in place:

1. **HTTPS-only** — enforced by GitHub Pages
2. **Honeypot field** (`hp_website`) — invisible to humans, populated
   by bots, silently dropped server-side
3. **Rate limiting** — 30 contact submissions/hour and 10 admissions/hour
   across all clients, tracked in `PropertiesService`
4. **Server-side validation** — required fields, email format, length
   caps on every text field
5. **Server-side file validation** for admissions — MIME allowlist
   (JPG/PNG/WebP/PDF), extension must match MIME, max 12 MB per file,
   base64 character validation
6. **HTML sanitisation** — all stored text is run through a tag-stripper
   before being written to the spreadsheet
7. **HTML email escaping** — all user-controlled values are HTML-escaped
   before being injected into the auto-reply template
8. **Script properties** — sensitive identifiers (SPREADSHEET_ID) are
   stored in Apps Script's Script Properties, not committed to the repo
9. **CSP + security meta tags** — every page includes a Content-Security-Policy,
   referrer policy, and Permissions-Policy meta tag
10. **Restricted Google resources** — destination spreadsheets and the
    DAIS Admissions Drive folder are set to "Restricted" (not public,
    not findable by link)

---

## Deployment checklist (must be true in production)

- [ ] Apps Script project `SPREADSHEET_ID` set in **Project Settings → Script Properties**
- [ ] Apps Script deployed as **Execute as: Me · Who has access: Anyone**
- [ ] Drive API service added to the Apps Script project
- [ ] Contact-form Google Sheet sharing: **Restricted** (only the school's account)
- [ ] `DAIS Admissions Database` Google Sheet sharing: **Restricted**
- [ ] `DAIS Admissions` Google Drive folder sharing: **Restricted**
- [ ] Script owner Google account has 2-factor authentication enabled
- [ ] CNAME / DNS configured so all traffic resolves over HTTPS only

---

## Sensitive data handling (UK GDPR Article 9)

The admission form collects **special category data**:
- Ethnicity
- Disability / learning difficulty / health condition

This data is collected solely for statutory equality monitoring as required
by NCFE and Ofsted. It must:

- Never be shown to assessors
- Never influence application decisions
- Be aggregated for reporting only
- Be retained only for the period required by the awarding organisation

The admission form also collects:
- **National Insurance number** (optional) — used only for qualification
  registration with the awarding body
- **Date of birth** — used to verify the 16+ enrolment requirement and for
  ULN matching

---

## What is NOT in this repository

- API keys, OAuth tokens, service account JSON files
- Database connection strings
- Email server credentials
- Production user data

`.gitignore` covers `.env*` files and common secret patterns.
The Google Apps Script deployment URL **is** visible in the client-side
HTML — this is unavoidable for browser-to-Apps-Script POSTs — but is
protected by the defence-in-depth layers above.

---

## Periodic review

This security policy should be reviewed annually or after any material
change to data handling. Last reviewed: 2026-05-14.

# Salesforce Case Exporter — Installation Guide

## Requirements

- Microsoft Edge (any recent version — Chromium-based)
- An active Salesforce session in Edge (Okta SSO login already completed)

---

## Step 1 — Download or clone the extension files

All files must be in a single folder on your local machine:

```
case-exporter-extension/
├── manifest.json
├── popup.html
├── popup.js
├── content.js
└── background.js
```

---

## Step 2 — Enable Developer Mode in Edge

1. Open Edge and go to: `edge://extensions`
2. Toggle **Developer mode** ON (top-right corner)

---

## Step 3 — Load the unpacked extension

1. Click **Load unpacked**
2. Browse to and select the `case-exporter-extension` folder
3. The extension appears in your toolbar as **Case Exporter**

> If you don't see it, click the puzzle-piece icon in the Edge toolbar and pin it.

---

## Step 4 — Use the extension

1. Log in to Salesforce (Okta SSO as normal)
2. Navigate to **Cases** → open any **List View**, **Split View**, or **Kanban View**
3. Make sure the cases you want are visible on screen
   - For large lists, scroll down or click **Load More** before exporting
4. Click the **Case Exporter** toolbar button
5. Optionally enter a case limit (leave blank for all visible, max 100)
6. Click **Export Cases**
7. A zip file named `salesforce-cases-YYYY-MM-DD.zip` downloads automatically

---

## What's in the zip

| File | Contents |
|---|---|
| `XXXXXXX.json` | Full Salesforce Case record (one file per case, named by CaseNumber) |
| `export-summary.json` | Metadata: export timestamp, total count, case numbers, view type, any failures |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Navigate to a Salesforce Case List View" error | You must be on a Salesforce page showing cases |
| "No case IDs found" | Scroll to load cases first; confirm you're in a List/Split/Kanban view |
| "Session expired" | Refresh your Salesforce tab, then reopen the popup and try again |
| "Access denied" | Your Salesforce profile may need API access — contact your Salesforce admin |
| Popup says "Only X cases found" (yellow warning) | Scroll down or click Load More in Salesforce before exporting to capture all records |
| Extension not visible | Go to `edge://extensions`, confirm it's enabled, and pin it from the puzzle-piece menu |

---

## Updating the extension

If you receive updated extension files, replace the files in the same folder and click the **refresh** icon next to the extension on `edge://extensions`.

---

## Security note

This extension operates entirely within your browser using your existing authenticated session. It never stores credentials, never sends data to third-party servers, and only communicates with your Salesforce org's REST API. The only external network call is loading JSZip from cdnjs.cloudflare.com when you click Export.

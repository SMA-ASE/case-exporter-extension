# Salesforce Case Exporter — Edge Extension

## Project Goal
Build a Microsoft Edge extension that exports Salesforce support cases from a
Case List View to a downloadable zip of JSON files. The extension must work
with an already-authenticated Salesforce session (no programmatic login), because
the org uses Okta SSO with MFA, which makes headless automation impossible.

## Output Directory
Write all extension files to: C:\Users\BlakeLetzler\Downloads\case-exporter-extension\

## Technical Context

**Why an extension (not a script):**
- Salesforce login uses Okta SSO with MFA push notifications — no way to automate auth
- Extension operates inside the user's already-authenticated browser session
- Makes direct Salesforce REST API calls using the session cookie already present
- Target: 20-60 cases at a time (never more than 100)

**Target environment:**
- Microsoft Edge (Chromium), Manifest V3
- Salesforce Lightning Experience (*.lightning.force.com)
- REST API version: v57.0 or higher

## Files to Create

Build a complete, installable extension with these files:

### manifest.json
- Manifest V3
- Permissions: activeTab, scripting, downloads
- Host permissions: https://*.salesforce.com/*, https://*.lightning.force.com/*
- Content script: content.js targeting both Salesforce domains, run_at document_end
- Background service worker: background.js
- Popup: popup.html

### popup.html + popup.js
- Clean, minimal UI (no external CSS frameworks)
- Input field: number of cases to export (default 20, max 100, blank = all visible)
- Export button and Cancel button
- Status area showing current operation (e.g. "Fetching case 3 of 22...")
- Progress bar
- Error states with clear messages
- Pagination warning area: if content.js returns a paginationWarning flag, show
  a yellow notice: "Only X cases were found in the current view. If you have more
  cases, scroll down or load all records before exporting."
- Loads JSZip from cdnjs.cloudflare.com to build the zip in-browser
- On export:
  1. Sends message to content.js to extract case IDs from current page
  2. If paginationWarning is true, show the warning but still proceed with
     whatever IDs were found
  3. Loops through IDs, fetching each via Salesforce REST API using session auth
  4. Adds 200ms delay between requests to avoid rate limiting
  5. Writes each case as CaseNumber.json inside a JSZip instance
  6. Adds an export-summary.json with: exportedAt, totalCases, caseNumbers
     array, viewType (detected by content.js), paginationWarning boolean,
     and failedCaseIds array (empty if all succeeded)
  7. Downloads the zip as: salesforce-cases-YYYY-MM-DD.zip

### content.js
- Listens for extractCaseIds message from popup
- Detects which view type is active (list, kanban, split) — see View
  Compatibility section below
- Runs the appropriate selector strategy for that view type
- Deduplicates extracted IDs
- Respects the limit parameter if provided
- Checks for pagination controls and sets paginationWarning accordingly
- Returns: { caseIds: [...], viewType: "list"|"kanban"|"split"|"unknown",
  paginationWarning: true|false }

### background.js
- Service worker stub
- Logs extension install event
- No active logic needed for v1

## View Compatibility

The content.js selector strategy must handle three view types. Each renders
the DOM differently. Write extractCaseIdsFromPage to try all three strategies
and merge/deduplicate results.

**List View**
- Cases are table rows with anchor tags
- Primary selector: a[href*="/lightning/r/Case/"]
- Fallback selectors: [data-row-key-value] links, tr[data-row-index] links
- Detect this view by presence of: table.slds-table, [data-list-view-type="list"],
  or role="grid" with case row elements

**Split View**
- Left panel is a narrow list, structurally similar to List View
- Use the same selectors as List View
- Only cases loaded in the left panel will be present in the DOM
- Detect this view by presence of: [data-split-view="true"],
  .split-view-container, or a narrow left-rail list alongside a detail panel

**Kanban View**
- Cases are cards, not rows — completely different DOM structure
- Primary selector: article[data-record-id], div[data-record-id]
- Fallback selectors: .kanban-card a[href*="/lightning/r/Case/"],
  [data-target-record-id]
- data-record-id may be on the card container element, not the anchor tag —
  extract it directly from the container attribute, not just from hrefs
- Detect this view by presence of: [data-view-type="kanban"],
  .forceKanbanColumnContent, or a grid of card elements

**Unknown / Fallback**
- If no view type is detected, run all selector strategies and merge results
- Log which selectors returned matches for debugging
- Set viewType to "unknown" in the response

**Important:** Salesforce uses dynamic CSS class names that change across
releases. Avoid relying on generated .slds- component class names or any
class that looks auto-generated. Prefer: data-* attributes, role attributes,
aria attributes, and href patterns — these are far more stable across
Salesforce releases.

## Pagination Handling

All three views are paginated. The DOM only contains currently rendered cases.
Do NOT attempt to auto-paginate or auto-scroll — Salesforce's virtual DOM
rendering makes this unreliable and risky.

Instead:

1. After extracting visible case IDs, check whether pagination controls exist:
   - List/Split: look for a "Load More" button, next-page button, or a record
     count indicator showing partial results (e.g. "Showing 1-20 of 47")
   - Kanban: look for a "Load More Cards" button or column scroll indicators
2. If any pagination control is found, set paginationWarning: true in the response
3. The popup will surface a visible warning to the user but still proceed with
   whatever IDs were found
4. Export summary JSON must include paginationWarning so the user knows the
   export may be incomplete

## API Call Pattern

In popup.js, fetch case data like this:

```javascript
// Derive the REST API base URL from the current tab's Lightning URL
// e.g. https://mycompany.lightning.force.com -> https://mycompany.my.salesforce.com
function getApiBase(tabUrl) {
  const match = tabUrl.match(/https:\/\/([^.]+)\.lightning\.force\.com/);
  if (match) return `https://${match[1]}.my.salesforce.com`;
  const sfMatch = tabUrl.match(/https:\/\/([^/]+\.salesforce\.com)/);
  if (sfMatch) return `https://${sfMatch[1]}`;
  throw new Error('Could not determine Salesforce org URL from current tab');
}

const apiUrl = `${apiBase}/services/data/v57.0/sobjects/Case/${caseId}`;
const response = await fetch(apiUrl, { credentials: 'include' });
```

IMPORTANT: The credentials: 'include' flag is what makes this work — it sends
the existing session cookie. Do not attempt to add Authorization headers or
handle login. If fetch returns 401, surface a clear error: "Session expired.
Refresh your Salesforce tab and try again." If fetch returns 403, surface:
"Access denied. Your Salesforce profile may not have API access enabled."

## Error Handling

- User not on Salesforce: show error before attempting anything
- No case IDs found: explain which view types are supported and suggest
  navigating to a Case List View
- 401 from API: session expired message, do not continue
- 403 from API: API access denied message, do not continue
- Individual case fetch failure: log to failedCaseIds in summary, continue
  with remaining cases
- All cases fail: do not download a zip, show error
- Partial success: download the zip with successful cases, include
  failedCaseIds in export-summary.json, show "Exported X of Y cases" in popup

## Installation Instructions File

Also create INSTALL.md in the output directory:
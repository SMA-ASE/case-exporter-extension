'use strict';

// JSZip is loaded statically via popup.html → jszip.min.js

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function getOrgPrefix(tabUrl) {
  const m = tabUrl.match(/https:\/\/([^.]+)\.lightning\.force\.com/);
  if (m) return m[1];
  const s = tabUrl.match(/https:\/\/([^.]+)\.my\.salesforce\.com/);
  if (s) return s[1];
  throw new Error('Could not determine Salesforce org from current tab URL');
}

function isSalesforceTab(url) {
  return /https:\/\/.+\.(salesforce|lightning\.force)\.com/.test(url || '');
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Session cookie
//
// Diagnostic confirmed: lightning.force.com/services/data/... redirects
// cross-origin to my.salesforce.com, and my.salesforce.com returns
// Access-Control-Allow-Credentials: false, so credentialed fetches are
// blocked at the CORS layer regardless of context.
//
// Solution: call my.salesforce.com directly from the extension popup.
// Extension pages bypass CORS for host_permission URLs entirely, so we only
// need a valid session token. The 'sid' cookie on my.salesforce.com is the
// Salesforce session ID, which doubles as a REST API Bearer token.
// Extensions can read HttpOnly cookies via chrome.cookies — normal JS cannot.
// ---------------------------------------------------------------------------

async function getSalesforceSessionId(orgPrefix) {
  const apiDomain = `https://${orgPrefix}.my.salesforce.com`;

  // Try the API domain first — this is the session token that works for REST calls.
  const direct = await chrome.cookies.get({ url: apiDomain, name: 'sid' });
  if (direct?.value) {
    const sid = decodeURIComponent(direct.value);
    console.log('[CaseExporter] sid found on my.salesforce.com, length:', sid.length, 'prefix:', sid.slice(0, 10));
    return sid;
  }

  // Fallback: scan all cookies on the API domain (in case name differs).
  const all = await chrome.cookies.getAll({ url: apiDomain });
  console.log('[CaseExporter] Cookies on my.salesforce.com:', all.map(c => c.name));
  const sid = all.find(c => c.name === 'sid');
  if (sid?.value) return decodeURIComponent(sid.value);

  throw new Error(
    'Salesforce session cookie not found on my.salesforce.com. ' +
    'Make sure you are logged in to Salesforce in this browser. ' +
    `Cookies found: [${all.map(c => c.name).join(', ')}]`
  );
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function setStatus(msg) { $('statusText').textContent = msg; }

function setProgress(done, total) {
  $('progressBar').style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;
}

function showError(msg) {
  const b = $('errorBox');
  b.textContent = msg;
  b.style.display = 'block';
}

function hideError() { $('errorBox').style.display = 'none'; }

function showSuccess(msg) {
  const b = $('successBox');
  b.textContent = msg;
  b.style.display = 'block';
}

function hideSuccess() { $('successBox').style.display = 'none'; }

function showPaginationWarning(msg) {
  const b = $('paginationWarning');
  b.textContent = msg;
  b.style.display = 'block';
}

function hidePaginationWarning() { $('paginationWarning').style.display = 'none'; }

function setExporting(active) {
  $('exportBtn').disabled = active;
  $('cancelBtn').style.display = active ? 'block' : 'none';
  $('progressSection').style.display = active ? 'block' : 'none';
  if (!active) setProgress(0, 1);
}

// ---------------------------------------------------------------------------
// Cancellation token
// ---------------------------------------------------------------------------

let cancelled = false;

// ---------------------------------------------------------------------------
// Case fetch — runs directly from the popup to my.salesforce.com.
// Extension pages bypass CORS for host_permission URLs, so no credentials
// flag needed; the session ID from the cookie is sent as a Bearer token.
// ---------------------------------------------------------------------------

async function fetchCase(orgPrefix, caseId, sessionId) {
  const url = `https://${orgPrefix}.my.salesforce.com/services/data/v57.0/sobjects/Case/${caseId}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${sessionId}` },
  });

  if (!response.ok) {
    // Parse Salesforce's error body for a precise error code
    let sfError = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (Array.isArray(body) && body[0]?.errorCode) {
        sfError = `${body[0].errorCode}: ${body[0].message}`;
      }
    } catch (_) {}

    console.warn('[CaseExporter] API error for', caseId, sfError);

    if (response.status === 401) throw new Error(`SESSION_EXPIRED (${sfError})`);
    if (response.status === 403) throw new Error(`ACCESS_DENIED (${sfError})`);
    throw new Error(sfError);
  }

  return response.json();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Ask content.js for case IDs. Auto-inject if the tab predates extension load.
// ---------------------------------------------------------------------------

async function extractCaseIds(tabId, limit) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'extractCaseIds', limit });
  try {
    return await ask();
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await delay(150);
      return await ask();
    } catch (e2) {
      throw new Error(
        'Could not communicate with the page. Try refreshing your Salesforce tab and reopening this popup.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main export flow
// ---------------------------------------------------------------------------

async function runExport() {
  cancelled = false;
  hideError();
  hideSuccess();
  hidePaginationWarning();

  const limitInput = $('caseLimit').value.trim();
  let limit = 0;
  if (limitInput !== '') {
    limit = parseInt(limitInput, 10);
    if (isNaN(limit) || limit < 1) {
      showError('Please enter a valid number of cases (1–100), or leave blank for all visible.');
      return;
    }
    if (limit > 100) {
      showError('Maximum 100 cases per export.');
      return;
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isSalesforceTab(tab.url)) {
    showError('Navigate to a Salesforce Case List View and try again.');
    return;
  }

  let orgPrefix, sessionId;
  try {
    orgPrefix = getOrgPrefix(tab.url);
  } catch (e) {
    showError(e.message);
    return;
  }
  try {
    sessionId = await getSalesforceSessionId(orgPrefix);
  } catch (e) {
    showError(e.message);
    return;
  }

  setExporting(true);
  setProgress(0, 1);
  setStatus('Scanning page for case IDs…');

  let extraction;
  try {
    extraction = await extractCaseIds(tab.id, limit);
  } catch (e) {
    setExporting(false);
    showError(e.message);
    return;
  }

  if (!extraction.success) {
    setExporting(false);
    showError(`Failed to extract cases: ${extraction.error}`);
    return;
  }

  const { caseIds, viewType, paginationWarning } = extraction;

  if (paginationWarning) {
    showPaginationWarning(
      `Only ${caseIds.length} case${caseIds.length !== 1 ? 's' : ''} were found in the current view. ` +
      `If you have more cases, scroll down or load all records before exporting.`
    );
  }

  if (caseIds.length === 0) {
    setExporting(false);
    showError(
      'No case IDs found on this page. Make sure you are on a Salesforce Case List View ' +
      '(list, split, or kanban). Detected view type: ' + viewType + '.'
    );
    return;
  }

  const zip = new JSZip();
  const failedCaseIds = [];
  const successfulCaseNumbers = [];
  const total = caseIds.length;

  for (let i = 0; i < total; i++) {
    if (cancelled) break;

    const caseId = caseIds[i];
    setStatus(`Fetching case ${i + 1} of ${total}…`);
    setProgress(i, total);

    try {
      const data = await fetchCase(orgPrefix, caseId, sessionId);
      zip.file((data.CaseNumber || caseId) + '.json', JSON.stringify(data, null, 2));
      successfulCaseNumbers.push(data.CaseNumber || caseId);
    } catch (err) {
      if (err.message.startsWith('SESSION_EXPIRED')) {
        setExporting(false);
        showError(`Session expired or invalid — ${err.message}. Refresh your Salesforce tab and try again.`);
        return;
      }
      if (err.message.startsWith('ACCESS_DENIED')) {
        setExporting(false);
        showError('Access denied. Your Salesforce profile may not have API access enabled.');
        return;
      }
      console.warn('[CaseExporter] Failed to fetch case', caseId, err.message);
      failedCaseIds.push(caseId);
    }

    if (i < total - 1 && !cancelled) await delay(200);
  }

  setProgress(total, total);

  if (cancelled) {
    setExporting(false);
    setStatus('Export cancelled.');
    return;
  }

  if (successfulCaseNumbers.length === 0) {
    setExporting(false);
    showError('All case fetches failed. Check your Salesforce session and try again.');
    return;
  }

  zip.file('export-summary.json', JSON.stringify({
    exportedAt: new Date().toISOString(),
    totalCases: successfulCaseNumbers.length,
    caseNumbers: successfulCaseNumbers,
    viewType,
    paginationWarning,
    failedCaseIds,
  }, null, 2));

  setStatus('Building zip file…');
  const blob = await zip.generateAsync({ type: 'blob' });
  const blobUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url: blobUrl,
    filename: `salesforce-cases-${formatDate(new Date())}.zip`,
    saveAs: false,
  });
  URL.revokeObjectURL(blobUrl);
  window.close();

  setExporting(false);

  if (failedCaseIds.length > 0) {
    showSuccess(
      `Exported ${successfulCaseNumbers.length} of ${total} cases. ` +
      `${failedCaseIds.length} failed — see export-summary.json for details.`
    );
  } else {
    showSuccess(
      `Exported ${successfulCaseNumbers.length} case${successfulCaseNumbers.length !== 1 ? 's' : ''} successfully.`
    );
  }
  setStatus('Done.');
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  $('exportBtn').addEventListener('click', runExport);
  $('cancelBtn').addEventListener('click', () => { cancelled = true; });
});

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

async function sfGet(orgPrefix, pathOrUrl, sessionId) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `https://${orgPrefix}.my.salesforce.com${pathOrUrl}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${sessionId}` },
  });
  if (!response.ok) {
    let sfError = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (Array.isArray(body) && body[0]?.errorCode) {
        sfError = `${body[0].errorCode}: ${body[0].message}`;
      }
    } catch (_) {}
    if (response.status === 401) throw new Error(`SESSION_EXPIRED (${sfError})`);
    if (response.status === 403) throw new Error(`ACCESS_DENIED (${sfError})`);
    throw new Error(sfError);
  }
  return response.json();
}

async function fetchCase(orgPrefix, caseId, sessionId) {
  return sfGet(orgPrefix, `/services/data/v57.0/sobjects/Case/${caseId}`, sessionId);
}

// Binary fetch for attachment/file bytes. Same Bearer auth as sfGet, but returns
// a Blob. Uses the REST VersionData / Body endpoints rather than replaying the
// browser's cookie-based file.force.com download redirect.
async function sfGetBlob(orgPrefix, pathOrUrl, sessionId) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `https://${orgPrefix}.my.salesforce.com${pathOrUrl}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${sessionId}` },
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error(`SESSION_EXPIRED (HTTP 401)`);
    if (response.status === 403) throw new Error(`ACCESS_DENIED (HTTP 403)`);
    throw new Error(`HTTP ${response.status}`);
  }
  return response.blob();
}

// Follows nextRecordsUrl until exhausted; returns flat array of all records.
async function fetchAllSoqlPages(orgPrefix, soql, sessionId) {
  let result = await sfGet(
    orgPrefix,
    `/services/data/v57.0/query?q=${encodeURIComponent(soql)}`,
    sessionId
  );
  const records = [...result.records];
  while (result.nextRecordsUrl) {
    result = await sfGet(orgPrefix, result.nextRecordsUrl, sessionId);
    records.push(...result.records);
  }
  return records;
}

// Follows Chatter nextPageUrl until exhausted; returns flat array of elements.
async function fetchAllChatterPages(orgPrefix, caseId, sessionId) {
  let result = await sfGet(
    orgPrefix,
    `/services/data/v57.0/chatter/records/${caseId}/feed-elements?pageSize=100&sort=CreatedDateAsc`,
    sessionId
  );
  const elements = [...(result.elements || [])];
  while (result.nextPageUrl) {
    result = await sfGet(orgPrefix, result.nextPageUrl, sessionId);
    elements.push(...(result.elements || []));
  }
  return elements;
}

// Fetches CaseComments, EmailMessages, and Chatter feed elements in parallel.
// Individual failures are caught so a missing permission on one type does not
// abort the whole export; the field is omitted from the output on failure.
async function fetchCaseActivity(orgPrefix, caseId, sessionId) {
  const [comments, emails, feed, files, attachments] = await Promise.allSettled([
    fetchAllSoqlPages(
      orgPrefix,
      `SELECT Id, CommentBody, IsPublished, IsDeleted, CreatedDate, CreatedById, CreatedBy.Name, SystemModstamp ` +
      `FROM CaseComment WHERE ParentId = '${caseId}' ORDER BY CreatedDate ASC`,
      sessionId
    ),
    fetchAllSoqlPages(
      orgPrefix,
      `SELECT Id, Subject, TextBody, HtmlBody, FromAddress, FromName, ToAddress, CcAddress, BccAddress, ` +
      `MessageDate, Status, Incoming, IsDeleted, CreatedDate, CreatedById ` +
      `FROM EmailMessage WHERE ParentId = '${caseId}' ORDER BY MessageDate ASC`,
      sessionId
    ),
    fetchAllChatterPages(orgPrefix, caseId, sessionId),
    fetchAllSoqlPages(
      orgPrefix,
      `SELECT Id, ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension, ` +
      `ContentDocument.ContentSize, ContentDocument.ContentModifiedDate, ` +
      `ContentDocument.CreatedDate, ContentDocument.CreatedBy.Name, ShareType ` +
      `FROM ContentDocumentLink WHERE LinkedEntityId = '${caseId}'`,
      sessionId
    ),
    fetchAllSoqlPages(
      orgPrefix,
      `SELECT Id, Name, ContentType, BodyLength, Description, CreatedDate, CreatedById, CreatedBy.Name ` +
      `FROM Attachment WHERE ParentId = '${caseId}' ORDER BY CreatedDate ASC`,
      sessionId
    ),
  ]);

  const activity = {};
  if (comments.status === 'fulfilled') {
    activity.caseComments = comments.value;
  } else {
    console.log('[CaseExporter] CaseComment fetch failed for', caseId, comments.reason?.message);
  }
  if (emails.status === 'fulfilled') {
    activity.emailMessages = emails.value;
  } else {
    console.log('[CaseExporter] EmailMessage fetch failed for', caseId, emails.reason?.message);
  }
  if (feed.status === 'fulfilled') {
    activity.feedElements = feed.value;
  } else {
    console.log('[CaseExporter] Chatter feed fetch failed for', caseId, feed.reason?.message);
  }
  if (files.status === 'fulfilled') {
    activity.files = files.value;
  } else {
    console.log('[CaseExporter] ContentDocumentLink fetch failed for', caseId, files.reason?.message);
  }
  if (attachments.status === 'fulfilled') {
    activity.attachments = attachments.value;
  } else {
    console.log('[CaseExporter] Attachment fetch failed for', caseId, attachments.reason?.message);
  }
  return activity;
}

// Downloads the actual binary content of a case's attachments into an
// `attachments/` folder inside the zip. Handles both modern Files
// (ContentDocument → latest ContentVersion → VersionData) and classic
// Attachments (Attachment → Body). Each download is isolated so one failure
// does not abort the rest; failures are returned for the summary.
async function addCaseFilesToZip(zip, orgPrefix, sessionId, caseData, onProgress) {
  const folder = zip.folder('attachments');
  const usedNames = new Set();
  const downloaded = [];
  const failed = [];

  // Ensure a unique, collision-free filename within the attachments folder.
  function uniqueName(rawName) {
    const name = (rawName || 'file').replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
    let candidate = name;
    let i = 1;
    while (usedNames.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      candidate = dot > 0
        ? `${name.slice(0, dot)} (${i})${name.slice(dot)}`
        : `${name} (${i})`;
      i++;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  }

  // 1. Modern Files: resolve ContentDocumentIds → latest ContentVersion rows.
  const docIds = (caseData.files || []).map(f => f.ContentDocumentId).filter(Boolean);
  if (docIds.length) {
    let versions = [];
    try {
      const inList = [...new Set(docIds)].map(id => `'${id}'`).join(',');
      versions = await fetchAllSoqlPages(
        orgPrefix,
        `SELECT Id, Title, FileExtension, ContentSize, ContentDocumentId ` +
        `FROM ContentVersion WHERE ContentDocumentId IN (${inList}) AND IsLatest = true`,
        sessionId
      );
    } catch (e) {
      console.log('[CaseExporter] ContentVersion lookup failed:', e.message);
    }

    for (const v of versions) {
      if (onProgress) onProgress(v.Title || v.Id);
      try {
        const blob = await sfGetBlob(
          orgPrefix,
          `/services/data/v57.0/sobjects/ContentVersion/${v.Id}/VersionData`,
          sessionId
        );
        const ext = v.FileExtension ? `.${v.FileExtension}` : '';
        const base = v.Title || v.Id;
        const fileName = uniqueName(ext && !base.toLowerCase().endsWith(ext.toLowerCase()) ? base + ext : base);
        folder.file(fileName, blob);
        downloaded.push(fileName);
      } catch (e) {
        if (e.message.startsWith('SESSION_EXPIRED') || e.message.startsWith('ACCESS_DENIED')) throw e;
        console.log('[CaseExporter] File download failed:', v.Id, e.message);
        failed.push({ id: v.Id, title: v.Title, error: e.message });
      }
    }
  }

  // 2. Classic Attachments: download each Body directly.
  for (const a of (caseData.attachments || [])) {
    if (onProgress) onProgress(a.Name || a.Id);
    try {
      const blob = await sfGetBlob(
        orgPrefix,
        `/services/data/v57.0/sobjects/Attachment/${a.Id}/Body`,
        sessionId
      );
      folder.file(uniqueName(a.Name || a.Id), blob);
      downloaded.push(a.Name || a.Id);
    } catch (e) {
      if (e.message.startsWith('SESSION_EXPIRED') || e.message.startsWith('ACCESS_DENIED')) throw e;
      console.log('[CaseExporter] Attachment download failed:', a.Id, e.message);
      failed.push({ id: a.Id, name: a.Name, error: e.message });
    }
  }

  return { downloaded, failed };
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

  // On a single case record page we additionally download the attachment
  // binaries. We deliberately skip this for multi-case list exports, where it
  // could mean hundreds of large downloads.
  const isSingleCase = viewType === 'record';

  const zip = new JSZip();
  const failedCaseIds = [];
  const successfulCaseNumbers = [];
  let attachmentsDownloaded = 0;
  let attachmentsFailed = 0;
  const total = caseIds.length;

  for (let i = 0; i < total; i++) {
    if (cancelled) break;

    const caseId = caseIds[i];
    setStatus(`Fetching case ${i + 1} of ${total}…`);
    setProgress(i, total);

    try {
      const caseData = await fetchCase(orgPrefix, caseId, sessionId);
      const activity = await fetchCaseActivity(orgPrefix, caseId, sessionId);
      const data = { ...caseData, ...activity };
      zip.file((data.CaseNumber || caseId) + '.json', JSON.stringify(data, null, 2));
      successfulCaseNumbers.push(data.CaseNumber || caseId);

      if (isSingleCase) {
        const result = await addCaseFilesToZip(
          zip, orgPrefix, sessionId, data,
          (name) => setStatus(`Downloading attachment: ${name}…`)
        );
        attachmentsDownloaded += result.downloaded.length;
        attachmentsFailed += result.failed.length;
      }
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
      console.log('[CaseExporter] Failed to fetch case', caseId, err.message);
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
    attachmentsDownloaded,
    attachmentsFailed,
  }, null, 2));

  setStatus('Building zip file…');
  const blob = await zip.generateAsync({ type: 'blob' });
  const blobUrl = URL.createObjectURL(blob);
  const zipName = isSingleCase
    ? `salesforce-case-${successfulCaseNumbers[0]}-${formatDate(new Date())}.zip`
    : `salesforce-cases-${formatDate(new Date())}.zip`;
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: zipName,
      saveAs: false,
    });
  } catch (dlErr) {
    URL.revokeObjectURL(blobUrl);
    showError(`Download failed: ${dlErr.message}`);
    setExporting(false);
    return;
  }
  // Revoke once Chrome signals it has started reading the blob.
  // Do not call window.close() here — closing the popup destroys the blob URL's
  // execution context before Chrome can read it (especially when "Ask where to
  // save" is enabled and the file dialog briefly collapses the popup).
  chrome.downloads.onChanged.addListener(function onDownloadStart(delta) {
    if (delta.id === downloadId && (delta.state || delta.error)) {
      URL.revokeObjectURL(blobUrl);
      chrome.downloads.onChanged.removeListener(onDownloadStart);
    }
  });

  setExporting(false);

  const attachmentNote = isSingleCase
    ? ` ${attachmentsDownloaded} attachment${attachmentsDownloaded !== 1 ? 's' : ''} included` +
      (attachmentsFailed > 0 ? `, ${attachmentsFailed} failed.` : '.')
    : '';

  if (failedCaseIds.length > 0) {
    showSuccess(
      `Exported ${successfulCaseNumbers.length} of ${total} cases. ` +
      `${failedCaseIds.length} failed — see export-summary.json for details.` + attachmentNote
    );
  } else {
    showSuccess(
      `Exported ${successfulCaseNumbers.length} case${successfulCaseNumbers.length !== 1 ? 's' : ''} successfully.` +
      attachmentNote
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
  try {
    $('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (_) {}
});

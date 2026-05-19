'use strict';

// Guard against double-registration when popup injects this script into a tab
// that already has it loaded from the manifest content_script declaration.
if (!window.__caseExporterReady) {
  window.__caseExporterReady = true;

  // -------------------------------------------------------------------------
  // Shadow DOM–piercing querySelector
  // Salesforce Lightning Web Components use native Shadow DOM, so standard
  // querySelectorAll stops at each shadow boundary. This recurses into every
  // shadow root found on the page.
  // -------------------------------------------------------------------------

  function pierceQueryAll(selector) {
    const results = [];
    function search(root) {
      try { root.querySelectorAll(selector).forEach(el => results.push(el)); } catch (e) {}
      try {
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) search(el.shadowRoot);
        });
      } catch (e) {}
    }
    search(document);
    return results;
  }

  // -------------------------------------------------------------------------
  // View detection
  // -------------------------------------------------------------------------

  function detectViewType() {
    // Kanban: dedicated data attribute or known kanban container
    if (
      document.querySelector('[data-view-type="kanban"]') ||
      document.querySelector('.forceKanbanColumnContent') ||
      document.querySelector('[data-kanban-column]') ||
      document.querySelector('force-kanban') ||
      pierceQueryAll('[data-view-type="kanban"]').length > 0
    ) return 'kanban';

    // Split view: dedicated attribute, class, or custom element tag
    if (
      document.querySelector('[data-split-view="true"]') ||
      document.querySelector('.split-view-container') ||
      document.querySelector('[data-component-id="forceListViewSplitView"]') ||
      document.querySelector('force-split-view') ||
      document.querySelector('.forceListViewSplitViewContainer') ||
      document.querySelector('.listViewSplitView') ||
      pierceQueryAll('force-split-view').length > 0
    ) return 'split';

    // List view: standard table or role="grid"
    if (
      document.querySelector('table.slds-table') ||
      document.querySelector('[data-list-view-type="list"]') ||
      document.querySelector('[role="grid"]')
    ) return 'list';

    // URL-based fallback: if we're on a Case list URL, assume list view
    if (
      window.location.pathname.includes('/lightning/o/Case/') ||
      window.location.search.includes('filterName=')
    ) return 'list';

    return 'unknown';
  }

  // -------------------------------------------------------------------------
  // ID extraction strategies
  // -------------------------------------------------------------------------

  const CASE_HREF_RE = /\/r\/Case\/([a-zA-Z0-9]{15,18})(?:\/|$|\?|#)/;

  function extractFromHrefs(elements) {
    const ids = new Set();
    (elements || [...document.querySelectorAll('a[href]')]).forEach(a => {
      const attrHref = a.getAttribute('href') || '';
      const m = attrHref.match(CASE_HREF_RE) || (a.href || '').match(CASE_HREF_RE);
      if (m) ids.add(m[1]);
    });
    return ids;
  }

  const DATA_ID_ATTRS = [
    'data-record-id',
    'data-row-key-value',
    'data-record-key-value',
    'data-target-record-id',
    'data-key',
    'data-record-key',
    'data-id',
    'data-entity-id',
    'data-recordid',
    'data-lookup-record-id',
  ];

  function extractFromDataAttributes(elements) {
    const ids = new Set();
    (elements || []).forEach(el => {
      DATA_ID_ATTRS.forEach(attr => {
        const val = el.getAttribute(attr);
        // '500' is the universal Salesforce Case key prefix. Filter here to
        // avoid collecting user IDs (005), contact IDs (003), queue IDs (00G), etc.
        if (val && val.startsWith('500') && /^[a-zA-Z0-9]{15,18}$/.test(val)) ids.add(val);
      });
    });
    return ids;
  }

  function extractFromTableRows() {
    const ids = new Set();
    document.querySelectorAll('tr[data-row-index]').forEach(row => {
      extractFromHrefs([...row.querySelectorAll('a[href]')]).forEach(id => ids.add(id));
    });
    return ids;
  }

  function extractFromKanbanCards(elements) {
    const ids = new Set();
    (elements || []).forEach(card => {
      const id = card.getAttribute('data-record-id') || card.getAttribute('data-target-record-id');
      if (id && id.startsWith('500') && /^[a-zA-Z0-9]{15,18}$/.test(id)) ids.add(id);
      // Also check anchor hrefs inside each card
      extractFromHrefs([...card.querySelectorAll('a[href]')]).forEach(i => ids.add(i));
    });
    return ids;
  }

  // -------------------------------------------------------------------------
  // Pagination detection
  // -------------------------------------------------------------------------

  function hasPaginationControls() {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase().trim();
      if (text.includes('load more') || text.includes('show more') || text.includes('next page')) {
        return true;
      }
    }
    if (document.querySelector('[data-infinite-load-trigger]')) return true;
    if (document.querySelector('[title="Next Page"]') || document.querySelector('[title="next page"]')) return true;
    if (/showing\s+[\d,]+\s*[–\-]\s*[\d,]+\s+of\s+[\d,]+/i.test(document.body.innerText || '')) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Main extraction — try all strategies, regular DOM first, shadow DOM second
  // -------------------------------------------------------------------------

  function extractCaseIdsFromPage(limit) {
    const viewType = detectViewType();
    const allIds = new Set();

    if (viewType === 'kanban') {
      // Kanban: data-record-id on card containers
      const regularCards = [
        ...document.querySelectorAll('article[data-record-id], div[data-record-id]'),
        ...document.querySelectorAll('[data-target-record-id]'),
      ];
      extractFromKanbanCards(regularCards).forEach(id => allIds.add(id));

      // Href scan as supplement
      extractFromHrefs().forEach(id => allIds.add(id));

      if (allIds.size === 0) {
        console.log('[CaseExporter] Kanban: piercing shadow DOM');
        const shadowCards = pierceQueryAll('article[data-record-id], div[data-record-id], [data-target-record-id]');
        extractFromKanbanCards(shadowCards).forEach(id => allIds.add(id));
        extractFromHrefs(pierceQueryAll('a[href]')).forEach(id => allIds.add(id));
      }
    } else {
      // List, split, or unknown: run all strategies in order

      // 1. Anchor hrefs (works in standard list view)
      extractFromHrefs().forEach(id => allIds.add(id));

      // 2. Data attributes on all elements (works in split view tile items)
      extractFromDataAttributes([...document.querySelectorAll(DATA_ID_ATTRS.map(a => `[${a}]`).join(','))]).forEach(id => allIds.add(id));

      // 3. Table rows
      extractFromTableRows().forEach(id => allIds.add(id));

      // 4. If still nothing, pierce shadow DOM — split view LWC components
      //    render their left-panel tiles inside shadow roots
      if (allIds.size === 0) {
        console.log('[CaseExporter] Regular DOM returned 0 — piercing shadow DOM');

        extractFromHrefs(pierceQueryAll('a[href]')).forEach(id => allIds.add(id));

        const allDataEls = DATA_ID_ATTRS.flatMap(attr => pierceQueryAll(`[${attr}]`));
        extractFromDataAttributes(allDataEls).forEach(id => allIds.add(id));

        // Also try kanban selectors in case view type was misdetected
        const shadowCards = pierceQueryAll('article[data-record-id], div[data-record-id], [data-target-record-id]');
        extractFromKanbanCards(shadowCards).forEach(id => allIds.add(id));
      }
    }

    const paginationWarning = hasPaginationControls();
    let caseIds = Array.from(allIds);
    if (limit && limit > 0) caseIds = caseIds.slice(0, limit);

    console.log('[CaseExporter]', caseIds.length, 'case IDs, viewType:', viewType, 'paginationWarning:', paginationWarning);
    return { caseIds, viewType, paginationWarning };
  }

  // -------------------------------------------------------------------------
  // Message listener
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'extractCaseIds') return;
    try {
      const result = extractCaseIdsFromPage(message.limit || 0);
      sendResponse({ success: true, ...result });
    } catch (err) {
      console.error('[CaseExporter] Error extracting case IDs:', err);
      sendResponse({ success: false, error: err.message });
    }
    return true;
  });
}

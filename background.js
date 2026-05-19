chrome.runtime.onInstalled.addListener((details) => {
  console.log('[CaseExporter] Extension installed:', details.reason);
});

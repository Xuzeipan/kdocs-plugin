/**
 * Service Worker — enables Side Panel on action click.
 */
chrome.runtime.onInstalled.addListener(function () {
  // Allow the side panel to be opened by clicking the extension icon
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {
    // Fallback: sidePanel API might not be available in all Chromium versions
    console.warn('[WPSBatch BG] sidePanel.setPanelBehavior failed — side panel may require manual opening');
  });
});

// Keep service worker alive for side panel communication
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  // Forward messages that target the side panel (if needed later)
  sendResponse({ ok: true });
  return true;
});

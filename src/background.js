/**
 * Service Worker — enables Side Panel + handles chrome.downloads queue.
 */

// ---- Side Panel entry ----

chrome.runtime.onInstalled.addListener(function () {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {
    console.warn('[WPSBatch BG] sidePanel.setPanelBehavior failed');
  });
});

// ---- Download queue ----

var downloadQueue = [];
var downloading = false;
var DOWNLOAD_DELAY_MS = 600;
var pendingDownloadNames = {}; // downloadUrl → filename

// Force Chrome to use our filename instead of the server's Content-Disposition
chrome.downloads.onDeterminingFilename.addListener(function (downloadItem, suggest) {
  var targetFilename = pendingDownloadNames[downloadItem.url] || pendingDownloadNames[downloadItem.finalUrl || ''];
  if (targetFilename) {
    console.log('[WPSBatch BG] onDeterminingFilename override:', downloadItem.url, '→', targetFilename);
    suggest({ filename: targetFilename, conflictAction: 'uniquify' });
    // Clean up after the download starts
    setTimeout(function () {
      delete pendingDownloadNames[downloadItem.url];
      if (downloadItem.finalUrl) delete pendingDownloadNames[downloadItem.finalUrl];
    }, 10000);
    return;
  }
  suggest();
});

async function processQueue() {
  if (downloading) return;
  downloading = true;

  while (downloadQueue.length) {
    var task = downloadQueue.shift();
    try {
      // Store the desired filename before starting the download
      pendingDownloadNames[task.downloadUrl] = task.filename;
      console.log('[WPSBatch BG] queueing download:', task.address, '→', task.filename);

      var downloadId = await new Promise(function (resolve, reject) {
        chrome.downloads.download(
          {
            url: task.downloadUrl,
            filename: task.filename,
            conflictAction: 'uniquify',
            saveAs: false,
          },
          function (id) {
            if (chrome.runtime.lastError) {
              delete pendingDownloadNames[task.downloadUrl];
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (id == null) {
              delete pendingDownloadNames[task.downloadUrl];
              reject(new Error('downloads.download 返回 null'));
              return;
            }
            resolve(id);
          }
        );
      });
      if (task.resolve) {
        task.resolve({ status: 'queued', downloadId: downloadId, filename: task.filename, address: task.address, subFileId: task.subFileId });
      }
    } catch (e) {
      if (task.resolve) {
        task.resolve({ status: 'download-error', filename: task.filename, address: task.address, subFileId: task.subFileId, error: e.message || String(e) });
      }
    }
    // Throttle between downloads
    if (downloadQueue.length) {
      await new Promise(function (r) { setTimeout(r, DOWNLOAD_DELAY_MS); });
    }
  }

  downloading = false;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.action === 'downloadAttachments' && msg.items && msg.items.length) {
    var results = [];
    var items = msg.items;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.downloadUrl || !item.filename) {
        results.push({ status: 'download-error', filename: item.filename || '', error: '缺少 downloadUrl 或 filename' });
        continue;
      }
      downloadQueue.push({
        downloadUrl: item.downloadUrl,
        filename: item.filename,
        subFileId: item.subFileId || '',
        address: item.address || '',
        resolve: function (result) { results.push(result); },
      });
    }

    processQueue().then(function () {
      sendResponse({ ok: true, results: results });
    });

    return true; // async
  }

  // Generic passthrough
  sendResponse({ ok: true });
  return true;
});

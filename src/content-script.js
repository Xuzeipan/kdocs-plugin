/**
 * Content Script — bridges popup and page main world.
 * Runs in isolated world. Injects page-bridge.js + kernel into MAIN world.
 */
(function () {
  'use strict';

  var BRIDGE_SCRIPTS = ['src/wps-batch-rename-download.js', 'src/page-bridge.js'];
  var bridgeReady = false;
  var pendingRequests = {};
  var requestIdCounter = 0;
  var injectPromise = null;

  // -------- Listen for messages from page main world --------

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== 'kdocs-plugin-page') return;

    if (msg.action === 'bridge-ready') {
      bridgeReady = true;
      return;
    }

    if (msg.requestId == null) return;

    var entry = pendingRequests[msg.requestId];
    if (!entry) return;
    delete pendingRequests[msg.requestId];

    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      entry.reject(new Error((msg.error && msg.error.message) || 'Unknown error'));
    }
  });

  // -------- Script injection --------

  function injectScript(url) {
    return new Promise(function (resolve, reject) {
      // Check if already injected
      var existing = document.querySelector('script[data-kdocs-plugin="' + url + '"]');
      if (existing) { resolve(); return; }

      var script = document.createElement('script');
      script.src = chrome.runtime.getURL(url);
      script.setAttribute('data-kdocs-plugin', url);
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('Failed to load: ' + url)); };
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function injectAll() {
    if (bridgeReady) return Promise.resolve();
    if (injectPromise) return injectPromise;

    injectPromise = (async function () {
      for (var i = 0; i < BRIDGE_SCRIPTS.length; i++) {
        await injectScript(BRIDGE_SCRIPTS[i]);
      }

      // Wait for bridge ready signal with timeout
      await new Promise(function (resolve, reject) {
        var timeout = setTimeout(function () {
          reject(new Error('页面脚本注入超时（10 秒），请刷新页面后重试'));
        }, 10000);

        var check = setInterval(function () {
          if (bridgeReady) {
            clearTimeout(timeout);
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
    })();

    injectPromise.catch(function () { injectPromise = null; });
    return injectPromise;
  }

  // -------- Request relay --------

  function sendToBridge(action, options) {
    return injectAll().then(function () {
      return new Promise(function (resolve, reject) {
        var requestId = ++requestIdCounter;
        var timeout = setTimeout(function () {
          delete pendingRequests[requestId];
          reject(new Error('请求超时（60 秒）: ' + action));
        }, 60000);

        pendingRequests[requestId] = {
          resolve: function (result) { clearTimeout(timeout); resolve(result); },
          reject: function (error) { clearTimeout(timeout); reject(error); },
        };

        window.postMessage({
          source: 'kdocs-plugin-cs',
          action: action,
          requestId: requestId,
          options: options || {},
        }, '*');
      });
    });
  }

  // -------- Listen for popup messages --------

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.action) return;

    (async function () {
      try {
        var result = await sendToBridge(msg.action, msg.options);
        sendResponse({ ok: true, result: result });
      } catch (error) {
        sendResponse({
          ok: false,
          error: { message: error.message || String(error) },
        });
      }
    })();

    return true; // keep channel open for async
  });
})();

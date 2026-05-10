/**
 * Page Bridge — runs in page MAIN world.
 * Receives commands from content-script, calls WPSBatch kernel, returns results.
 */
(function () {
  'use strict';

  if (window.__kdocsPluginBridgeInstalled) return;
  window.__kdocsPluginBridgeInstalled = true;

  var CS_SOURCE = 'kdocs-plugin-cs';
  var REPLY_SOURCE = 'kdocs-plugin-page';

  // -------- Check page environment --------

  async function checkPage() {
    var env = {
      url: location.href,
      title: document.title,
      isKdocs: /kdocs\.cn/.test(location.href),
      hasWPSBatch: !!window.WPSBatch,
      hasApp: !!window.APP,
    };

    if (window.WPSBatch && typeof window.WPSBatch.selfTest === 'function') {
      try {
        env.selfTest = await window.WPSBatch.selfTest();
      } catch (e) {
        env.selfTestError = e.message || String(e);
      }
    }

    return env;
  }

  // -------- Message handler --------

  window.addEventListener('message', async function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== CS_SOURCE) return;

    var action = msg.action;
    var requestId = msg.requestId;
    var options = msg.options || {};

    function reply(ok, payload) {
      window.postMessage({
        source: REPLY_SOURCE,
        requestId: requestId,
        ok: ok,
        result: ok ? payload : undefined,
        error: ok ? undefined : payload,
      }, '*');
    }

    if (!window.WPSBatch) {
      reply(false, { message: 'WPSBatch 未加载。请确保页面脚本已注入' });
      return;
    }

    try {
      var result;

      switch (action) {
        case 'checkPage':
          result = await checkPage();
          break;

        case 'scan':
          result = await window.WPSBatch.scan(options);
          break;

        case 'preview':
          result = await window.WPSBatch.preview(options);
          break;

        case 'matchAttachments':
          result = await window.WPSBatch.matchAttachments(options);
          break;

        case 'execute':
          result = await window.WPSBatch.execute(options);
          break;

        case 'report':
          result = window.WPSBatch.report(options);
          break;

        default:
          throw new Error('未识别的命令: ' + action);
      }

      reply(true, result);
    } catch (error) {
      reply(false, {
        message: error.message || String(error),
        stack: error.stack || '',
      });
    }
  });

  // -------- Signal ready --------

  window.postMessage({ source: REPLY_SOURCE, action: 'bridge-ready' }, '*');
})();

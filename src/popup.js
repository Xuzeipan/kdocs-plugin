/**
 * Popup UI — manages state, user actions, and communication with page kernel.
 */
(function () {
  'use strict';

  // -------- DOM refs --------
  var $ = function (id) { return document.getElementById(id); };

  var statusPage = $('status-page');
  var statusBridge = $('status-bridge');
  var statusApp = $('status-app');
  var statusSheetName = $('status-sheet-name');

  var btnCheck = $('btn-check');
  var btnScan = $('btn-scan');
  var btnMatch = $('btn-match');
  var btnExecute = $('btn-execute');
  var btnReport = $('btn-report');

  var loading = $('loading');
  var loadingText = $('loading-text');
  var errorBanner = $('error-banner');
  var errorText = $('error-text');

  var scanSection = $('scan-section');
  var scanSummary = $('scan-summary');
  var previewBody = $('preview-body');
  var previewEmpty = $('preview-empty');

  var matchSection = $('match-section');
  var matchMatchedCount = $('match-matched-count');
  var matchMissingCount = $('match-missing-count');
  var matchRiskyCount = $('match-risky-count');
  var matchRiskLevel = $('match-risk-level');
  var missingItemsWrap = $('missing-items-wrap');
  var missingItemsBody = $('missing-items-body');
  var riskyItemsWrap = $('risky-items-wrap');
  var riskyItemsBody = $('risky-items-body');

  var executeSection = $('execute-section');
  var optCells = $('opt-cells');
  var optRename = $('opt-rename');
  var optDownload = $('opt-download');
  var optAllowRisk = $('opt-allow-risk');
  var labelOrderRisk = $('label-order-risk');
  var executeResult = $('execute-result');
  var execCellsUpdated = $('exec-cells-updated');
  var execRenamed = $('exec-renamed');
  var execDownloaded = $('exec-downloaded');
  var execErrors = $('exec-errors');

  var reportSection = $('report-section');
  var reportText = $('report-text');
  var reportHint = $('report-hint');
  var reportEmpty = $('report-empty');

  // -------- State --------
  var state = {
    pageChecked: false,
    bridgeReady: false,
    hasApp: false,
    scanned: false,
    matched: false,
    executed: false,
    lastMatchResult: null,
  };

  // -------- Helpers --------

  function showLoading(msg) {
    loadingText.textContent = msg || '加载中...';
    loading.classList.remove('hidden');
  }

  function hideLoading() {
    loading.classList.add('hidden');
  }

  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.classList.remove('hidden');
  }

  function hideError() {
    errorBanner.classList.add('hidden');
  }

  $('error-dismiss').addEventListener('click', hideError);

  function setBadge(el, status, text) {
    el.textContent = text || status;
    el.className = 'status-badge status-' + status;
  }

  function setButton(el, enabled, isPrimary) {
    el.disabled = !enabled;
    if (isPrimary && enabled) el.classList.add('btn-primary');
    else if (isPrimary) el.classList.remove('btn-primary');
  }

  function typeLabel(type) {
    return type === 'outer' ? '外箱标' : '预约信';
  }

  function statusTagClass(status) {
    if (status === 'ok') return 'status-tag-ok';
    if (status === 'no-source') return 'status-tag-no-source';
    return 'status-tag-unusual';
  }

  function truncate(text, max) {
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  // -------- Communication --------

  async function sendCommand(action, options) {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) throw new Error('无法获取当前标签页');
    var tabId = tabs[0].id;

    return new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tabId, { action: action, options: options || {} }, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || '与页面通信失败'));
          return;
        }
        if (!response) {
          reject(new Error('未收到页面响应'));
          return;
        }
        if (!response.ok) {
          reject(new Error((response.error && response.error.message) || '未知错误'));
          return;
        }
        resolve(response.result);
      });
    });
  }

  // -------- Actions --------

  async function doCheckPage() {
    hideError();
    showLoading('检查页面环境...');
    try {
      var env = await sendCommand('checkPage');
      state.pageChecked = true;
      state.hasApp = env.hasApp;
      state.bridgeReady = !!(env.hasWPSBatch);

      setBadge(statusPage, env.isKdocs ? 'ok' : 'warn', env.isKdocs ? 'KDocs' : '非KDocs');
      setBadge(statusBridge, env.hasWPSBatch ? 'ok' : 'error', env.hasWPSBatch ? '已注入' : '未注入');
      setBadge(statusApp, env.hasApp ? 'ok' : 'warn', env.hasApp ? '可用' : '无');
      statusSheetName.textContent = '';

      if (env.selfTest && env.selfTest.sheetName) {
        statusSheetName.textContent = env.selfTest.sheetName;
      }

      if (!env.isKdocs) {
        showError('当前页面不是 WPS/KDocs 表格页面');
        setButton(btnScan, false);
        setButton(btnMatch, false);
        return;
      }

      if (!env.hasWPSBatch) {
        showError('页面脚本未注入。请刷新页面后重试，或检查扩展是否已正确加载');
        setButton(btnScan, false);
        setButton(btnMatch, false);
        return;
      }

      setButton(btnScan, true);
      setButton(btnMatch, true);
      setButton(btnReport, true);
    } catch (error) {
      showError('检查页面失败: ' + error.message);
      setBadge(statusPage, 'error', '错误');
      setBadge(statusBridge, 'error', '未知');
    } finally {
      hideLoading();
    }
  }

  async function doScan() {
    hideError();
    showLoading('扫描表格数据...');
    try {
      var result = await sendCommand('scan');
      state.scanned = true;

      scanSummary.textContent = '任务 ' + result.planCount + ' 行，数据源 ' + result.source + '，行数 ' + result.rowCount;
      scanSection.classList.remove('hidden');

      // Render preview table
      var preview = await sendCommand('preview');
      renderPreview(preview);

      setButton(btnMatch, true);
      setButton(btnExecute, false); // need to re-match after scan
    } catch (error) {
      showError('扫描失败: ' + error.message);
    } finally {
      hideLoading();
    }
  }

  function renderPreview(preview) {
    previewBody.innerHTML = '';
    if (!preview.items || !preview.items.length) {
      previewEmpty.classList.remove('hidden');
      return;
    }
    previewEmpty.classList.add('hidden');

    var maxRows = 200;
    var items = preview.items.slice(0, maxRows);

    items.forEach(function (item) {
      var tr = document.createElement('tr');

      var tdRow = document.createElement('td');
      tdRow.textContent = item.row || '-';
      tr.appendChild(tdRow);

      var tdType = document.createElement('td');
      tdType.textContent = item.typeLabel;
      tr.appendChild(tdType);

      var tdSource = document.createElement('td');
      tdSource.textContent = truncate(item.sourceText, 26);
      tdSource.title = item.sourceText || '';
      tr.appendChild(tdSource);

      var tdTarget = document.createElement('td');
      tdTarget.textContent = truncate(item.targetName, 32);
      tdTarget.title = item.targetName || '';
      tr.appendChild(tdTarget);

      var tdStatus = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'status-tag ' + statusTagClass(item.status);
      tag.textContent = item.status === 'ok' ? '正常' : item.status === 'no-source' ? '无源' : '异常';
      tdStatus.appendChild(tag);
      tr.appendChild(tdStatus);

      previewBody.appendChild(tr);
    });

    if (preview.items.length > maxRows) {
      var trMore = document.createElement('tr');
      var tdMore = document.createElement('td');
      tdMore.colSpan = 5;
      tdMore.style.textAlign = 'center';
      tdMore.style.color = '#9ca3af';
      tdMore.textContent = '... 还有 ' + (preview.items.length - maxRows) + ' 条';
      trMore.appendChild(tdMore);
      previewBody.appendChild(trMore);
    }
  }

  async function doMatchAttachments() {
    hideError();
    showLoading('匹配附件 ID...');
    try {
      var result = await sendCommand('matchAttachments');
      state.matched = true;
      state.lastMatchResult = result;
      state.scanned = true; // match implies scan was done
      renderMatchResult(result);
      matchSection.classList.remove('hidden');

      // Update execute button state
      updateExecuteButton();
    } catch (error) {
      showError('附件匹配失败: ' + error.message);
    } finally {
      hideLoading();
    }
  }

  function renderMatchResult(result) {
    matchMatchedCount.textContent = result.matchedCount;
    matchMissingCount.textContent = result.missingCount;
    matchRiskyCount.textContent = result.riskyItems ? result.riskyItems.length : 0;

    // Risk level badge
    matchRiskLevel.textContent = '';
    matchRiskLevel.className = 'risk-badge';
    if (result.riskLevel === 'safe') {
      matchRiskLevel.textContent = '安全 — 全部匹配';
      matchRiskLevel.classList.add('risk-badge-safe');
    } else if (result.riskLevel === 'risky') {
      matchRiskLevel.textContent = '有风险 — 存在顺序兜底匹配';
      matchRiskLevel.classList.add('risk-badge-risky');
    } else {
      matchRiskLevel.textContent = '已阻止 — 存在缺失附件';
      matchRiskLevel.classList.add('risk-badge-blocked');
    }

    // Missing items
    if (result.missingItems && result.missingItems.length > 0) {
      missingItemsWrap.classList.remove('hidden');
      missingItemsBody.innerHTML = '';
      result.missingItems.forEach(function (item) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + typeLabel(item.type) + '</td>' +
          '<td>' + (item.key || '-') + '</td>' +
          '<td title="' + (item.source || '') + '">' + truncate(item.source || '', 22) + '</td>' +
          '<td title="' + (item.target || '') + '">' + truncate(item.target || '', 26) + '</td>';
        missingItemsBody.appendChild(tr);
      });
    } else {
      missingItemsWrap.classList.add('hidden');
    }

    // Risky items
    if (result.riskyItems && result.riskyItems.length > 0) {
      riskyItemsWrap.classList.remove('hidden');
      riskyItemsBody.innerHTML = '';
      result.riskyItems.forEach(function (item) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + typeLabel(item.type) + '</td>' +
          '<td>' + (item.key || '-') + '</td>' +
          '<td title="' + (item.matchedText || '') + '">' + truncate(item.matchedText || '', 22) + '</td>' +
          '<td title="' + (item.target || '') + '">' + truncate(item.target || '', 26) + '</td>';
        riskyItemsBody.appendChild(tr);
      });
    } else {
      riskyItemsWrap.classList.add('hidden');
    }
  }

  function updateExecuteButton() {
    var mr = state.lastMatchResult;
    var canExecute = mr && mr.riskLevel !== 'blocked';

    if (canExecute && mr.riskLevel === 'risky') {
      // Can execute only if user confirms risk
      labelOrderRisk.classList.remove('hidden');
      setButton(btnExecute, optAllowRisk.checked, true);
    } else if (canExecute) {
      labelOrderRisk.classList.add('hidden');
      optAllowRisk.checked = false;
      setButton(btnExecute, true, true);
    } else {
      labelOrderRisk.classList.add('hidden');
      setButton(btnExecute, false, true);
    }

    executeSection.classList.remove('hidden');
  }

  optAllowRisk.addEventListener('change', function () {
    updateExecuteButton();
  });

  async function doExecute() {
    hideError();

    var mr = state.lastMatchResult;
    if (!mr) {
      showError('请先匹配附件');
      return;
    }

    if (mr.riskLevel === 'blocked') {
      showError('还有 ' + mr.missingCount + ' 个附件未匹配，无法执行');
      return;
    }

    if (mr.riskLevel === 'risky' && !optAllowRisk.checked) {
      showError('请先勾选确认"我已确认顺序兜底匹配正确"');
      return;
    }

    showLoading('执行中...');
    try {
      var options = {
        updateSheetCells: optCells.checked,
        renameAttachments: optRename.checked,
        download: optDownload.checked,
        allowRiskyOrderMatch: optAllowRisk.checked,
      };

      var result = await sendCommand('execute', options);
      state.executed = true;

      renderExecuteResult(result);
    } catch (error) {
      showError('执行失败: ' + error.message);
    } finally {
      hideLoading();
    }
  }

  function renderExecuteResult(result) {
    executeResult.classList.remove('hidden');

    if (result.status === 'rejected') {
      showError(result.message || '执行被拒绝');
      execCellsUpdated.textContent = '0';
      execRenamed.textContent = '0';
      execDownloaded.textContent = '0';
      execErrors.textContent = '1';
      return;
    }

    var s = result.summary || {};
    execCellsUpdated.textContent = s.cellsUpdated || 0;
    execRenamed.textContent = s.renamed || 0;
    execDownloaded.textContent = s.downloaded || 0;
    execErrors.textContent = s.errors || 0;
  }

  async function doCopyReport() {
    hideError();
    showLoading('获取报告...');
    try {
      var report = await sendCommand('report');
      var jsonText = JSON.stringify(report, null, 2);
      await navigator.clipboard.writeText(jsonText);
      showLoading('');
      loadingText.textContent = '报告已复制到剪贴板 (JSON)';
      setTimeout(hideLoading, 2000);

      // Also show in report section
      reportSection.classList.remove('hidden');
      reportText.textContent = report.textReport || jsonText;
      reportHint.textContent = new Date().toLocaleTimeString();
      reportEmpty.classList.add('hidden');
    } catch (error) {
      // Fallback: try to copy text report from kernel
      try {
        var fallback = await sendCommand('report');
        var text = fallback.textReport || JSON.stringify(fallback);
        await navigator.clipboard.writeText(text);
        showLoading('');
        loadingText.textContent = '报告已复制 (文本)';
        setTimeout(hideLoading, 2000);
      } catch (e2) {
        showError('复制报告失败: ' + error.message);
      }
    } finally {
      if (loading.classList.contains('hidden')) hideLoading();
    }
  }

  // -------- Event listeners --------

  btnCheck.addEventListener('click', doCheckPage);
  btnScan.addEventListener('click', doScan);
  btnMatch.addEventListener('click', doMatchAttachments);
  btnExecute.addEventListener('click', doExecute);
  btnReport.addEventListener('click', doCopyReport);

  // -------- Initialize --------
  // Auto-check page when popup opens
  doCheckPage();
})();

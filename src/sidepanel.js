/**
 * Side Panel UI — column explorer and template-based batch rename.
 */
(function () {
  'use strict';

  // -------- DOM refs --------
  var $ = function (id) { return document.getElementById(id); };

  var statusPage = $('status-page');
  var statusBridge = $('status-bridge');
  var statusApp = $('status-app');
  var statusSheetRow = $('status-sheet-row');

  var btnCheck = $('btn-check');
  var btnScan = $('btn-scan');
  var btnRenameSelected = $('btn-rename-selected');

  var loading = $('loading');
  var loadingText = $('loading-text');
  var errorBanner = $('error-banner');
  var errorText = $('error-text');
  var infoBanner = $('info-banner');
  var infoText = $('info-text');

  var scanSection = $('scan-section');
  var scanSummary = $('scan-summary');
  var colTabsScroll = $('col-tabs-scroll');
  var tabArrowLeft = $('tab-arrow-left');
  var tabArrowRight = $('tab-arrow-right');
  var colDataSection = $('col-data-section');
  var colDataTitle = $('col-data-title');
  var colDataCount = $('col-data-count');
  var colDataBody = $('col-data-body');
  var colDataEmpty = $('col-data-empty');

  var renameSection = $('rename-section');
  var renameStatusBar = $('rename-status-bar');
  var inputRangeOverride = $('input-range-override');
  var diagnoseWrap = $('diagnose-wrap');
  var btnDiagnoseSelection = $('btn-diagnose-selection');
  var btnDiagnoseAttachment = $('btn-diagnose-attachment');
  var selectionDiagnosisWrap = $('selection-diagnosis-wrap');
  var selectionDiagnosisText = $('selection-diagnosis-text');
  var ruleColumnList = $('rule-column-list');
  var selectedChipsRow = $('selected-chips-row');
  var colChips = $('col-chips');
  var inputTemplate = $('input-template');
  var templateHint = $('template-hint');
  var rulePreviewText = $('rule-preview-text');
  var btnPreviewRename = $('btn-preview-rename');
  var btnResetTemplate = $('btn-reset-template');
  var renamePreviewWrap = $('rename-preview-wrap');
  var renamePreviewSummary = $('rename-preview-summary');
  var renamePreviewBody = $('rename-preview-body');
  var btnConfirmRename = $('btn-confirm-rename');
  var renameConfirmHint = $('rename-confirm-hint');
  var renameResult = $('rename-result');
  var renameSuccessCount = $('rename-success-count');
  var renameFailCount = $('rename-fail-count');

  // -------- State --------
  var state = {
    pageChecked: false,
    bridgeReady: false,
    hasApp: false,
    columns: [],
    activeColumnIndex: -1,
    selectedColumnIndexes: [], // for naming rule, in order
    renamePreview: null,
    templateDirty: false, // true if user manually edited template
  };

  // -------- Helpers --------

  function showLoading(msg) {
    loadingText.textContent = msg || '...';
    loading.classList.remove('hidden');
  }

  function hideLoading() { loading.classList.add('hidden'); }

  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.classList.remove('hidden');
  }

  function hideError() { errorBanner.classList.add('hidden'); }

  function showInfo(msg) {
    infoText.textContent = msg;
    infoBanner.classList.remove('hidden');
  }

  function hideInfo() { infoBanner.classList.add('hidden'); }

  $('error-dismiss').addEventListener('click', hideError);
  $('info-dismiss').addEventListener('click', hideInfo);

  function setBadge(el, status, text) {
    el.textContent = text || status;
    el.className = 'status-badge status-' + status;
  }

  function truncate(text, max) {
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  // -------- Communication --------

  function isKdocsUrl(url) {
    return /^https:\/\/(www\.)?kdocs\.cn\//.test(url || '');
  }

  function isMissingReceiverError(message) {
    return /Receiving end does not exist|Could not establish connection/i.test(message || '');
  }

  function sendMessageToTab(tabId, action, options) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tabId, { action: action, options: options || {} }, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) { reject(new Error('未收到页面响应')); return; }
        if (!response.ok) {
          reject(new Error((response.error && response.error.message) || '未知错误'));
          return;
        }
        resolve(response.result);
      });
    });
  }

  async function ensureContentScript(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['src/content-script.js'],
    });
  }

  async function sendCommand(action, options) {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) throw new Error('无法获取当前标签页');
    var tab = tabs[0];
    var tabId = tab.id;

    if (!isKdocsUrl(tab.url)) {
      throw new Error('当前活动标签页不是 KDocs 页面，请先切到 https://www.kdocs.cn/ 表格页面');
    }

    try {
      return await sendMessageToTab(tabId, action, options);
    } catch (error) {
      if (!isMissingReceiverError(error.message)) throw error;
      await ensureContentScript(tabId);
      return sendMessageToTab(tabId, action, options);
    }
  }

  // -------- Check Page --------

  async function doCheckPage() {
    hideError(); hideInfo();
    showLoading('检查页面环境...');
    try {
      var env = await sendCommand('checkPage');
      state.pageChecked = true;
      state.bridgeReady = !!(env.hasWPSBatch);
      state.hasApp = env.hasApp;

      setBadge(statusPage, env.isKdocs ? 'ok' : 'warn', env.isKdocs ? 'KDocs' : '非KDocs');
      setBadge(statusBridge, env.hasWPSBatch ? 'ok' : 'error', env.hasWPSBatch ? '已注入' : '未注入');
      setBadge(statusApp, env.hasApp ? 'ok' : 'warn', env.hasApp ? '可用' : '无');

      statusSheetRow.classList.add('hidden');
      if (env.selfTest) {
        var t = env.selfTest;
        if (t.sheetName) {
          statusSheetRow.textContent = 'Sheet: ' + t.sheetName;
          statusSheetRow.classList.remove('hidden');
        }
      }

      if (!env.isKdocs) {
        showError('当前页面不是 WPS/KDocs 表格页面');
        return;
      }
      if (!env.hasWPSBatch) {
        showError('页面脚本未注入。请刷新页面后重试');
        return;
      }

      btnScan.disabled = false;
      showInfo('页面就绪，可以扫描');
    } catch (error) {
      showError('检查页面失败: ' + error.message);
      setBadge(statusPage, 'error', '错误');
      setBadge(statusBridge, 'error', '未知');
    } finally {
      hideLoading();
    }
  }

  // -------- Scan --------

  async function doScan() {
    hideError(); hideInfo();
    showLoading('扫描表格数据...');
    try {
      var result = await sendCommand('scan');
      state.columns = result.columns || [];
      state.activeColumnIndex = -1;

      scanSummary.textContent = result.planCount + ' 任务, ' + result.rowCount + ' 行, 源: ' + result.source;
      scanSection.classList.remove('hidden');
      colDataSection.classList.add('hidden');

      renderColumnTabs();

      btnRenameSelected.disabled = false;
      showInfo('扫描完成。点击列名查看该列数据');
    } catch (error) {
      showError('扫描失败: ' + error.message);
    } finally {
      hideLoading();
    }
  }

  // -------- Column Tabs (view only, no rule selection) --------

  function renderColumnTabs() {
    colTabsScroll.innerHTML = '';

    state.columns.forEach(function (col, index) {
      var btn = document.createElement('button');
      btn.className = 'col-tab';
      btn.textContent = col.name || ('列' + (index + 1));
      btn.title = col.name + ' (' + col.values.length + ' 条数据)';

      if (index === state.activeColumnIndex) btn.classList.add('active');

      btn.addEventListener('click', function () {
        state.activeColumnIndex = index;
        renderColumnTabs();
        renderColumnData(index);
      });

      colTabsScroll.appendChild(btn);
    });

    updateTabArrows();
  }

  function updateTabArrows() {
    var canScrollLeft = colTabsScroll.scrollLeft > 0;
    var canScrollRight = colTabsScroll.scrollLeft + colTabsScroll.clientWidth < colTabsScroll.scrollWidth - 2;
    if (canScrollLeft) tabArrowLeft.classList.remove('hidden'); else tabArrowLeft.classList.add('hidden');
    if (canScrollRight) tabArrowRight.classList.remove('hidden'); else tabArrowRight.classList.add('hidden');
  }

  tabArrowLeft.addEventListener('click', function () {
    colTabsScroll.scrollBy({ left: -160, behavior: 'smooth' });
    setTimeout(updateTabArrows, 200);
  });

  tabArrowRight.addEventListener('click', function () {
    colTabsScroll.scrollBy({ left: 160, behavior: 'smooth' });
    setTimeout(updateTabArrows, 200);
  });

  colTabsScroll.addEventListener('scroll', updateTabArrows);

  // -------- Column Data --------

  function renderColumnData(colIndex) {
    var col = state.columns[colIndex];
    if (!col) return;

    colDataSection.classList.remove('hidden');
    colDataTitle.textContent = col.name || ('列 ' + (colIndex + 1));
    colDataCount.textContent = col.values.length + ' 条数据';
    colDataBody.innerHTML = '';

    if (!col.values.length) {
      colDataEmpty.classList.remove('hidden');
      return;
    }

    colDataEmpty.classList.add('hidden');

    var maxRows = 300;
    var values = col.values.slice(0, maxRows);

    values.forEach(function (v) {
      var tr = document.createElement('tr');
      var tdRow = document.createElement('td');
      tdRow.textContent = v.rowNumber;
      tr.appendChild(tdRow);
      var tdVal = document.createElement('td');
      tdVal.textContent = truncate(v.value, 120);
      tdVal.title = v.value;
      tr.appendChild(tdVal);
      colDataBody.appendChild(tr);
    });

    if (col.values.length > maxRows) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 2;
      td.style.cssText = 'text-align:center;color:#9ca3af;';
      td.textContent = '... 还有 ' + (col.values.length - maxRows) + ' 条';
      tr.appendChild(td);
      colDataBody.appendChild(tr);
    }
  }

  // -------- Naming Rule Column List --------

  function renderRuleColumnList() {
    ruleColumnList.innerHTML = '';

    if (!state.columns.length) {
      var span = document.createElement('span');
      span.className = 'placeholder-text';
      span.textContent = '请先扫描，然后在此勾选列';
      ruleColumnList.appendChild(span);
      return;
    }

    state.columns.forEach(function (col, index) {
      var item = document.createElement('label');
      item.className = 'rule-column-item';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selectedColumnIndexes.indexOf(index) >= 0;
      cb.addEventListener('change', function () {
        toggleRuleColumn(index);
      });

      var nameSpan = document.createElement('span');
      nameSpan.className = 'col-name';
      nameSpan.textContent = col.name || ('列' + (index + 1));
      nameSpan.title = col.name || '';

      var countSpan = document.createElement('span');
      countSpan.className = 'col-count';
      countSpan.textContent = col.values.length;

      item.appendChild(cb);
      item.appendChild(nameSpan);
      item.appendChild(countSpan);
      ruleColumnList.appendChild(item);
    });
  }

  function toggleRuleColumn(colIndex) {
    var pos = state.selectedColumnIndexes.indexOf(colIndex);
    if (pos >= 0) {
      state.selectedColumnIndexes.splice(pos, 1);
    } else {
      state.selectedColumnIndexes.push(colIndex);
    }
    renderSelectedChips();
    autoUpdateTemplate();

    // Sync checkboxes
    var checkboxes = ruleColumnList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(function (cb, index) {
      if (state.columns[index]) {
        cb.checked = state.selectedColumnIndexes.indexOf(state.columns[index].index) >= 0;
      }
    });
  }

  function renderSelectedChips() {
    colChips.innerHTML = '';

    if (!state.selectedColumnIndexes.length) {
      selectedChipsRow.classList.add('hidden');
    } else {
      selectedChipsRow.classList.remove('hidden');
    }

    state.selectedColumnIndexes.forEach(function (ci, order) {
      var col = null;
      for (var i = 0; i < state.columns.length; i++) {
        if (state.columns[i].index === ci) { col = state.columns[i]; break; }
      }
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = col ? col.name : '';

      var orderBadge = document.createElement('span');
      orderBadge.className = 'chip-order';
      orderBadge.textContent = order + 1;
      chip.appendChild(orderBadge);

      var nameSpan = document.createElement('span');
      nameSpan.textContent = truncate(col ? col.name : '', 14);
      chip.appendChild(nameSpan);

      var remove = document.createElement('span');
      remove.className = 'chip-remove';
      remove.textContent = '×';
      remove.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleRuleColumn(ci);
      });
      chip.appendChild(remove);

      colChips.appendChild(chip);
    });
  }

  // -------- Template --------

  function buildTemplateFromColumns() {
    if (!state.selectedColumnIndexes.length) return '';
    var indexMap = {};
    for (var i = 0; i < state.columns.length; i++) {
      indexMap[state.columns[i].index] = state.columns[i].name;
    }
    var parts = [];
    for (var j = 0; j < state.selectedColumnIndexes.length; j++) {
      var name = indexMap[state.selectedColumnIndexes[j]];
      if (name) parts.push('{' + name + '}');
    }
    return parts.join('-');
  }

  function autoUpdateTemplate() {
    if (state.templateDirty) {
      // User has edited template; don't overwrite, but show hint
      var auto = buildTemplateFromColumns();
      if (auto && auto !== inputTemplate.value) {
        btnResetTemplate.classList.remove('hidden');
      } else {
        btnResetTemplate.classList.add('hidden');
      }
      return;
    }
    var template = buildTemplateFromColumns();
    inputTemplate.value = template;
    btnResetTemplate.classList.add('hidden');
    updateRulePreview();
    updatePreviewButton();
  }

  function doResetTemplate() {
    state.templateDirty = false;
    var template = buildTemplateFromColumns();
    inputTemplate.value = template;
    btnResetTemplate.classList.add('hidden');
    updateRulePreview();
    updatePreviewButton();
  }

  inputTemplate.addEventListener('input', function () {
    state.templateDirty = true;
    updateRulePreview();
    updatePreviewButton();
  });

  btnResetTemplate.addEventListener('click', doResetTemplate);

  function updateRulePreview() {
    var template = inputTemplate.value.trim();
    if (!template) {
      rulePreviewText.textContent = '—';
      return;
    }
    rulePreviewText.textContent = template;
  }

  function updatePreviewButton() {
    var template = inputTemplate.value.trim();
    if (template || state.selectedColumnIndexes.length > 0) {
      btnPreviewRename.disabled = false;
    } else {
      btnPreviewRename.disabled = true;
    }
  }

  // -------- Rename Flow --------

  async function doOpenRenamePanel() {
    hideError(); hideInfo();
    renameSection.classList.remove('hidden');

    if (!state.columns.length) {
      renameStatusBar.textContent = '请先扫描表格';
      return;
    }

    // Reset dirty flag when first opening
    state.templateDirty = false;
    state.selectedColumnIndexes = [];

    renameStatusBar.textContent = '框选 WPS 表格中的附件单元格，勾选下方列，填写命名规则后预览。当前仅修改表格内附件显示名';
    renderRuleColumnList();
    renderSelectedChips();
    inputTemplate.value = '';
    btnResetTemplate.classList.add('hidden');
    updateRulePreview();
    updatePreviewButton();

    renamePreviewWrap.classList.add('hidden');
    renameResult.classList.add('hidden');
    btnConfirmRename.disabled = true;

    // Scroll to rename section
    renameSection.scrollIntoView({ behavior: 'smooth' });
  }

  async function doPreviewRename() {
    hideError(); hideInfo();

    var template = inputTemplate.value.trim();

    if (!template && !state.selectedColumnIndexes.length) {
      showError('请至少选择一个列，或填写自定义模板');
      return;
    }

    if (template && !/\{[^}]+\}/.test(template)) {
      showError('模板中没有任何 {列名} 占位符，请添加如 {货件号}');
      return;
    }

    // Build selectedColumns from state
    var selectedColumns = state.selectedColumnIndexes.map(function (ci) {
      for (var i = 0; i < state.columns.length; i++) {
        if (state.columns[i].index === ci) {
          return { index: ci, name: state.columns[i].name };
        }
      }
      return { index: ci, name: '' };
    });

    var rule = {
      template: template,
      selectedColumns: selectedColumns,
      columnIndexes: state.selectedColumnIndexes.slice(),
      rangeOverride: inputRangeOverride.value.trim(),
    };

    showLoading('检查选区并生成预览...');
    try {
      var result = await sendCommand('previewRenameSelectedAttachments', rule);
      state.renamePreview = result;

      renamePreviewWrap.classList.remove('hidden');
      renameResult.classList.add('hidden');
      renderRenamePreview(result);

      if (!result.ok) {
        var errMsg = result.error || '预览失败';
        var hasManualRange = !!(inputRangeOverride.value.trim());
        // Check if it's a selection failure
        if (/无法读取当前选区/.test(errMsg)) {
          if (hasManualRange) {
            showError('手动范围格式不正确，请输入类似 F2:F20 或 A1:C3');
          } else {
            showError('无法自动读取当前选区。请在"手动指定范围"中输入类似 F2:F20，或复制选区诊断报告给开发者。');
          }
          diagnoseWrap.classList.remove('hidden');
        } else if (/无法反查附件/.test(errMsg)) {
          showError(errMsg);
          diagnoseWrap.classList.remove('hidden');
        } else if (/没有识别到可改名附件/.test(errMsg)) {
          if (hasManualRange) {
            showError('已使用手动范围 ' + inputRangeOverride.value.trim() + '，但没有识别到附件。请输入单个单元格地址如 C6 并点击[诊断当前附件单元格]，或复制选区诊断报告。');
          } else {
            showError(errMsg);
          }
          diagnoseWrap.classList.remove('hidden');
        } else if (/非附件单元格/.test(errMsg)) {
          showError(errMsg);
          diagnoseWrap.classList.add('hidden');
        } else {
          showError(errMsg);
          diagnoseWrap.classList.add('hidden');
        }
        btnConfirmRename.disabled = true;
        renameConfirmHint.textContent = errMsg;
        return;
      }

      if (result.hasError) {
        btnConfirmRename.disabled = true;
        renameConfirmHint.textContent = '预览存在错误项，无法执行';
      } else {
        btnConfirmRename.disabled = false;
        renameConfirmHint.textContent = '确认后将修改 ' + result.summary.total + ' 个附件显示名';
      }
    } catch (error) {
      showError('预览改名失败: ' + error.message);
      btnConfirmRename.disabled = true;
    } finally {
      hideLoading();
    }
  }

  function renderRenamePreview(result) {
    // Update rule preview with sample if available
    if (result.sample) {
      rulePreviewText.textContent = result.sample;
    } else if (result.template) {
      rulePreviewText.textContent = result.template;
    }

    if (!result.ok) {
      renamePreviewSummary.textContent = '错误: ' + (result.error || '未知');
      renamePreviewBody.innerHTML = '';
      return;
    }

    var s = result.summary || {};
    renamePreviewSummary.textContent = '共 ' + s.total + ' 项, 正常 ' + (s.okCount || 0) + ' 项, 错误 ' + (s.errorCount || 0) + ' 项';

    renamePreviewBody.innerHTML = '';

    (result.preview || []).forEach(function (item) {
      var tr = document.createElement('tr');

      var tdRow = document.createElement('td');
      tdRow.textContent = item.rowNumber || '-';
      tr.appendChild(tdRow);

      var tdOrig = document.createElement('td');
      tdOrig.textContent = truncate(item.originalDisplayName || '', 30);
      tdOrig.title = item.originalDisplayName || '';
      tr.appendChild(tdOrig);

      var tdNew = document.createElement('td');
      tdNew.textContent = truncate(item.newDisplayName || '', 35);
      tdNew.title = item.newDisplayName || '';
      tr.appendChild(tdNew);

      var tdStatus = document.createElement('td');
      var tag = document.createElement('span');
      if (item.status === 'ok') {
        tag.className = 'status-tag status-tag-ok';
        tag.textContent = '正常';
      } else {
        tag.className = 'status-tag status-tag-error';
        var errText = '错误';
        if (item.status === 'error-empty-column') {
          errText = '空值: ' + (item.missingColumns || []).join(',');
        } else if (item.status === 'error-template') {
          errText = '模板错误';
        }
        tag.textContent = errText;
        tag.title = errText;
      }
      tdStatus.appendChild(tag);
      tr.appendChild(tdStatus);

      renamePreviewBody.appendChild(tr);
    });
  }

  async function doConfirmRename() {
    hideError(); hideInfo();

    if (!state.renamePreview || !state.renamePreview.ok) {
      showError('请先成功预览');
      return;
    }

    if (state.renamePreview.hasError) {
      showError('预览存在错误项，无法执行');
      return;
    }

    var template = inputTemplate.value.trim();

    var selectedColumns = state.selectedColumnIndexes.map(function (ci) {
      for (var i = 0; i < state.columns.length; i++) {
        if (state.columns[i].index === ci) {
          return { index: ci, name: state.columns[i].name };
        }
      }
      return { index: ci, name: '' };
    });

    var rule = {
      template: template,
      selectedColumns: selectedColumns,
      columnIndexes: state.selectedColumnIndexes.slice(),
      rangeOverride: inputRangeOverride.value.trim(),
    };

    showLoading('正在修改表格附件显示名...');
    try {
      var result = await sendCommand('renameSelectedAttachmentCells', rule);

      renameResult.classList.remove('hidden');
      var summary = result.summary || {};
      renameSuccessCount.textContent = summary.successCount || 0;
      renameFailCount.textContent = summary.failCount || 0;
      btnConfirmRename.disabled = true;

      if (summary.successCount > 0) {
        showInfo('改名完成：成功 ' + summary.successCount + ' 个');
      }
      if (summary.failCount > 0) {
        showError('改名部分失败: ' + summary.failCount + ' 个');
      }
    } catch (error) {
      showError('改名执行失败: ' + error.message);
    } finally {
      hideLoading();
    }
  }

  // -------- Selection Diagnosis --------

  async function doDiagnoseSelection() {
    hideError(); hideInfo();
    showLoading('诊断选区 API...');
    try {
      var diag = await sendCommand('diagnoseSelectionApis');
      var json = JSON.stringify(diag, null, 2);
      // Display report
      selectionDiagnosisText.value = json;
      selectionDiagnosisWrap.classList.remove('hidden');
      // Try to copy
      var copied = false;
      try {
        await navigator.clipboard.writeText(json);
        copied = true;
      } catch (_) {}
      if (copied) {
        showInfo('诊断报告已复制到剪贴板，同时展示在下方');
      } else {
        showInfo('诊断报告已展示在下方（复制失败，请手动选中后复制）');
      }
    } catch (error) {
      showError('诊断失败: ' + error.message);
    } finally {
      hideLoading();
    }
  }

  // -------- Event Listeners --------

  btnCheck.addEventListener('click', doCheckPage);
  btnScan.addEventListener('click', doScan);
  btnRenameSelected.addEventListener('click', doOpenRenamePanel);
  btnPreviewRename.addEventListener('click', doPreviewRename);
  btnConfirmRename.addEventListener('click', doConfirmRename);
  btnDiagnoseSelection.addEventListener('click', doDiagnoseSelection);
  btnDiagnoseAttachment.addEventListener('click', doDiagnoseSelectedAttachmentCells);

  // -------- Attachment Cell Deep Diagnosis --------

  async function doDiagnoseSelectedAttachmentCells() {
    hideError(); hideInfo();
    showLoading('诊断附件单元格...');
    try {
      var opts = { rangeOverride: inputRangeOverride.value.trim() };
      var diag = await sendCommand('diagnoseSelectedAttachmentCells', opts);
      var json = JSON.stringify(diag, null, 2);
      // Display report
      selectionDiagnosisText.value = json;
      selectionDiagnosisWrap.classList.remove('hidden');
      diagnoseWrap.classList.remove('hidden');
      // Try to copy
      var copied = false;
      try {
        await navigator.clipboard.writeText(json);
        copied = true;
      } catch (_) {}
      if (copied) {
        showInfo('附件诊断报告已生成，已复制到剪贴板并展示在下方');
      } else {
        showInfo('附件诊断报告已生成并展示在下方（复制失败，请手动选中后复制）');
      }
    } catch (error) {
      showError('附件诊断失败: ' + error.message);
    } finally {
      hideLoading();
    }
  }

  // -------- Init --------
  doCheckPage();
})();

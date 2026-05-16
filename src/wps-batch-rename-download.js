/**
 * WPS online sheet attachment batch downloader.
 *
 * Paste this whole file into the DevTools console on:
 * https://www.kdocs.cn/l/cseRFttnVD3M
 *
 * Recommended flow:
 * 1. Paste this script into the console.
 * 2. Run: await WPSBatch.run()
 *
 * The script first tries to discover data directly from the current WPS page:
 * - DOM text and attributes.
 * - WPS in-memory JavaScript state.
 * - Already-loaded network resource URLs that can be refetched from the page.
 *
 * If direct discovery fails, it falls back to asking for copied TSV data.
 *
 * What it can do automatically:
 * - Build target names:
 *   外箱标-货件号-箱数
 *   预约信-货件号-时间
 * - If WPS exposes attachment URLs in the DOM, download them with the target names.
 *
 * Browser-console limitation:
 * If WPS keeps attachments only inside its internal canvas/app state and does not expose
 * URLs in DOM attributes, a normal console script cannot force the browser download
 * manager to rename files clicked through the WPS UI. In that case this script prints
 * a clear diagnostic and the generated rename plan.
 */
(function () {
  const CONFIG = {
    defaultExt: ".pdf",
    downloadDelayMs: 700,
    maxDomCandidates: 300,
    preferTableCells: true,
    windowScanMaxNodes: 80000,
    windowScanMaxMs: 3500,
    windowScanMaxDepth: 7,
    enableNetworkProbe: false,
    allowCrossOriginNetworkProbe: false,
    networkProbeMaxUrls: 40,
    networkProbeMaxChars: 2500000,
    maxTableRows: 10000,
    maxTableCols: 60,
    stopAfterEmptyRows: 120,
    debug: true,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const STORAGE_KEY = "WPSBatchState:v3";

  function log(...args) {
    console.log("[WPSBatch]", ...args);
  }

  function warn(...args) {
    console.warn("[WPSBatch]", ...args);
  }

  function loadPersistedState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function savePersistedState(patch) {
    try {
      const state = { ...loadPersistedState(), ...patch, updatedAt: new Date().toISOString() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return state;
    } catch (error) {
      warn("持久化状态失败：", error.message || error);
      return null;
    }
  }

  function restorePersistedProbeInto(probe) {
    const state = loadPersistedState();
    if (!state.probe) return;
    probe.records = Array.isArray(state.probe.records) ? state.probe.records : [];
    probe.opens = Array.isArray(state.probe.opens) ? state.probe.opens : [];
    probe.commands = Array.isArray(state.probe.commands) ? state.probe.commands : [];
    probe.nextId = Number(state.probe.nextId || 1);
  }

  function persistProbe(probe) {
    if (!probe) return;
    savePersistedState({
      probe: {
        records: (probe.records || []).slice(-300),
        opens: (probe.opens || []).slice(-100),
        commands: (probe.commands || []).slice(-300),
        nextId: probe.nextId || 1,
      },
    });
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "")
      .trim();
  }

  function sanitizeFilename(name) {
    return cleanText(name)
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, "")
      .replace(/-+/g, "-")
      .replace(/^\.+/, "")
      .replace(/\.+$/, "");
  }

  function ensureExt(name, url) {
    if (/\.[a-z0-9]{2,8}$/i.test(name)) return name;
    const fromUrl = String(url || "").match(/\.([a-z0-9]{2,8})(?:[?#]|$)/i);
    return name + (fromUrl ? "." + fromUrl[1] : CONFIG.defaultExt);
  }

  function splitTsv(text) {
    return String(text || "")
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("\t").map(cleanText))
      .filter((row) => row.some(Boolean));
  }

  function normalizeDataText(text) {
    return String(text || "")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
        try {
          return String.fromCharCode(parseInt(hex, 16));
        } catch (_) {
          return _;
        }
      })
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "")
      .replace(/[－–—_]+/g, "-")
      .trim();
  }

  function unique(list) {
    return Array.from(new Set(list.map(normalizeDataText).filter(Boolean)));
  }

  function extractAttachmentStringsFromText(text) {
    const normalized = normalizeDataText(text);
    const outer = normalized.match(/外箱标\s*-\s*\d{7,12}\s*-\s*\d+\s*箱/g) || [];
    const appointment =
      normalized.match(/预约信\s*-\s*\d{7,12}\s*-\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g) || [];

    return {
      outer: unique(outer),
      appointment: unique(appointment),
    };
  }

  function mergeStringBuckets(...buckets) {
    return {
      outer: unique(buckets.flatMap((bucket) => bucket.outer || [])),
      appointment: unique(buckets.flatMap((bucket) => bucket.appointment || [])),
    };
  }

  function buildPlanFromAttachmentStrings(bucket) {
    const plan = [];

    for (const text of bucket.outer || []) {
      const shipment = parseShipmentNo(text);
      const boxCount = parseBoxCount(text);
      if (!shipment || !boxCount) continue;
      plan.push({
        row: "",
        type: "outer",
        sourceText: text,
        key: shipment,
        targetBase: sanitizeFilename(`外箱标-${shipment}-${boxCount}箱`),
        raw: { directSource: text },
      });
    }

    for (const text of bucket.appointment || []) {
      const shipment = parseShipmentNo(text);
      const timeText = parseDateText(text);
      if (!shipment || !timeText) continue;
      plan.push({
        row: "",
        type: "appointment",
        sourceText: text,
        key: shipment,
        targetBase: sanitizeFilename(`预约信-${shipment}-${timeText}`),
        raw: { directSource: text },
      });
    }

    const seen = new Set();
    return plan.filter((item) => {
      const id = `${item.type}:${item.targetBase}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function normalizeGridValue(value) {
    if (value == null) return "";
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return cleanText(value);
    if (typeof value === "object") {
      for (const key of ["text", "value", "v", "m", "name", "label", "display", "formattedValue"]) {
        if (value[key] != null && typeof value[key] !== "object") return cleanText(value[key]);
      }
    }
    return "";
  }

  function buildPlanFromTableRows(tableRows) {
    const rows = (tableRows || []).map((row) => row.map(normalizeGridValue));
    if (rows.length < 2) return [];

    const headers = rows[0];
    const idx = {
      shipment: findColumn(headers, ["货件号", "货件编号", "货件ID", "shipment", "shipment no", "shipment id"]),
      time: findColumn(headers, ["时间", "日期", "预约时间", "预约日期", "date", "time"]),
      outerFile: findColumn(headers, ["外箱标文件", "外箱标附件", "外箱标", "箱标文件", "箱标附件", "箱唛文件", "箱唛附件"]),
      boxCount: findColumn(headers, ["箱数", "件数", "箱量", "数量", "carton", "cartons", "box count"]),
      appointmentFile: findColumn(headers, ["预约信文件", "预约信附件", "预约信", "预约文件", "appointment"]),
    };

    if (idx.shipment < 0 || idx.time < 0 || idx.boxCount < 0 || (idx.outerFile < 0 && idx.appointmentFile < 0)) return [];

    const plan = [];
    let lastShipment = "";
    let lastTime = "";

    rows.slice(1).forEach((row, rowIndex) => {
      const shipmentCell = row[idx.shipment] || "";
      const timeCell = row[idx.time] || "";
      const boxCell = row[idx.boxCount] || "";
      const outerText = idx.outerFile >= 0 ? row[idx.outerFile] || "" : "";
      const appointmentText = idx.appointmentFile >= 0 ? row[idx.appointmentFile] || "" : "";

      const shipment = parseShipmentNo(shipmentCell) || lastShipment;
      const timeText = parseDateText(timeCell) || lastTime;
      const boxCount = parseBoxCount(boxCell, outerText);

      if (parseShipmentNo(shipmentCell)) lastShipment = parseShipmentNo(shipmentCell);
      if (parseDateText(timeCell)) lastTime = parseDateText(timeCell);

      if (!shipment || !timeText || !boxCount) return;

      const rowNumber = rowIndex + 2;
      const outerSource = outerText || `外箱标-${shipment}-${boxCount}箱`;
      const appointmentSource = appointmentText || `预约信-${shipment}-${timeText}`;

      if (idx.outerFile >= 0 && outerText) {
        plan.push({
          row: rowNumber,
          rowIndex: rowNumber - 1,
          colIndex: idx.outerFile,
          type: "outer",
          sourceText: outerSource,
          key: shipment,
          targetBase: sanitizeFilename(`外箱标-${shipment}-${boxCount}箱`),
          raw: { row },
        });
      }

      if (idx.appointmentFile >= 0 && appointmentText) {
        plan.push({
          row: rowNumber,
          rowIndex: rowNumber - 1,
          colIndex: idx.appointmentFile,
          type: "appointment",
          sourceText: appointmentSource,
          key: shipment,
          targetBase: sanitizeFilename(`预约信-${shipment}-${timeText}`),
          raw: { row },
        });
      }
    });

    const seen = new Set();
    return plan.filter((item) => {
      const id = `${item.type}:${item.row}:${item.targetBase}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function extractRowsFromPlainText(text) {
    const normalized = String(text || "").replace(/\u00a0/g, " ");
    if (!/(货件号|时间|箱数)/.test(normalized)) return [];

    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const tsvLines = lines.filter((line) => line.includes("\t"));
    if (tsvLines.length >= 2) return splitTsv(tsvLines.join("\n"));

    return [];
  }

  function columnNameFromIndex(index) {
    let value = index + 1;
    let name = "";
    while (value > 0) {
      const mod = (value - 1) % 26;
      name = String.fromCharCode(65 + mod) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  }

  function tryWorkbookApiRows() {
    const endCol = columnNameFromIndex(Math.max(0, Number(CONFIG.maxTableCols || 60) - 1));
    const endRow = Math.max(200, Math.min(Number(CONFIG.maxTableRows || 10000), 2000));
    const ranges = [`A1:${endCol}${endRow}`, "A1:AX1000", "A1:J500"];
    const roots = [
      window.APP && window.APP.workbook,
      window.workbook,
      window.APP && window.APP._workbook,
      window.et && window.et.workbook,
    ].filter(Boolean);

    const methodSets = [
      ["getActiveSheet", "getRange", "getValues"],
      ["activeSheet", "getRange", "getValues"],
      ["getActiveSheet", "range", "values"],
      ["activeSheet", "range", "values"],
    ];

    for (const root of roots) {
      for (const range of ranges) {
        for (const methods of methodSets) {
          try {
            const sheetGetter = root[methods[0]];
            const sheet = typeof sheetGetter === "function" ? sheetGetter.call(root) : sheetGetter;
            if (!sheet) continue;
            const rangeGetter = sheet[methods[1]];
            const rangeObj = typeof rangeGetter === "function" ? rangeGetter.call(sheet, range) : rangeGetter;
            if (!rangeObj) continue;
            const valuesMember = rangeObj[methods[2]];
            const values = typeof valuesMember === "function" ? valuesMember.call(rangeObj) : valuesMember;
            if (Array.isArray(values) && Array.isArray(values[0])) return values;
          } catch (_) {}
        }
      }
    }

    return [];
  }

  function callStringMethod(obj, names) {
    if (!obj) return "";
    for (const name of names) {
      try {
        const value = typeof obj[name] === "function" ? obj[name]() : obj[name];
        if (value != null && typeof value !== "object") {
          const text = cleanText(value);
          if (text) return text;
        }
      } catch (_) {}
    }
    return "";
  }

  function getWpsCellText(row, col) {
    const attempts = [];

    attempts.push(() => window.APP && window.APP.util && window.APP.util().sheetHelper().getCellValStr(row, col, true));
    attempts.push(() => window.APP && window.APP.util && window.APP.util().sheetHelper().getCellValStr(row, col, false));
    attempts.push(() => window.APP && window.APP.getUilCmdTool && window.APP.getUilCmdTool().getCellValue(row, col));
    attempts.push(() => window.APP && window.APP.getCell && normalizeGridValue(window.APP.getCell(row, col)));
    attempts.push(() => {
      const cell = window.APP && window.APP.getCell && window.APP.getCell(row, col);
      return callStringMethod(cell, [
        "getText",
        "getDisplayText",
        "getValue",
        "getValue2",
        "getStr",
        "getString",
        "getFormula",
        "getName",
      ]);
    });
    attempts.push(() => {
      const sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
      const cell = sheet && sheet.sheetData && sheet.sheetData.getCell(row, col);
      return normalizeGridValue(cell) || callStringMethod(cell, ["getText", "getDisplayText", "getValue", "getStr"]);
    });

    for (const attempt of attempts) {
      try {
        const text = normalizeGridValue(attempt());
        if (text) return text;
      } catch (_) {}
    }

    return "";
  }

  function hasWpsCellReadApi() {
    const app = window.APP;
    if (!app) return false;
    if (app.getCell || app.getUilCmdTool || app.util) return true;
    try {
      const sheet = app.getActiveSheet && app.getActiveSheet();
      return !!(sheet && sheet.sheetData && sheet.sheetData.getCell);
    } catch (_) {
      return false;
    }
  }

  function tryWpsNativeCellRows(maxRows = CONFIG.maxTableRows, maxCols = CONFIG.maxTableCols) {
    if (!hasWpsCellReadApi()) return [];

    const rows = [];
    let headerSeen = false;
    let anyDataSeen = false;
    let dataSeenAfterHeader = false;
    let emptyStreak = 0;
    const stopAfterEmptyRows = Math.max(20, Number(CONFIG.stopAfterEmptyRows || 120));
    const stopAfterLeadingEmptyRows = Math.max(200, stopAfterEmptyRows * 2);

    for (let row = 0; row < maxRows; row += 1) {
      const values = [];
      for (let col = 0; col < maxCols; col += 1) {
        values.push(getWpsCellText(row, col));
      }
      const hasValue = values.some(Boolean);
      const looksHeader =
        values.some((cell) => cleanText(cell) === "货件号") &&
        values.some((cell) => cleanText(cell).includes("箱数"));

      if (looksHeader) headerSeen = true;
      if (hasValue) {
        rows.push(values);
        anyDataSeen = true;
        if (headerSeen && !looksHeader) dataSeenAfterHeader = true;
        emptyStreak = 0;
      } else {
        emptyStreak += 1;
        if (dataSeenAfterHeader && emptyStreak >= stopAfterEmptyRows) break;
        if (anyDataSeen && emptyStreak >= stopAfterEmptyRows) break;
        if (!anyDataSeen && emptyStreak >= stopAfterLeadingEmptyRows) break;
      }
    }

    const headerIndex = rows.findIndex(
      (row) => row.some((cell) => cleanText(cell) === "货件号") && row.some((cell) => cleanText(cell).includes("箱数"))
    );

    return headerIndex >= 0 ? rows.slice(headerIndex) : rows;
  }

  function extractCellLikeRecordsFromState() {
    const started = Date.now();
    const seen = new WeakSet();
    const queue = [];
    const records = [];
    let scanned = 0;

    const rowKeys = ["row", "r", "ri", "rowIndex", "rowidx"];
    const colKeys = ["col", "c", "ci", "colIndex", "colidx"];
    const valueKeys = ["text", "value", "v", "m", "name", "label", "display", "formattedValue"];

    function enqueue(value, depth) {
      if (value == null) return;
      const type = typeof value;
      if (type !== "object" && type !== "function") return;
      if (seen.has(value)) return;
      if (depth > CONFIG.windowScanMaxDepth + 2) return;
      if (value instanceof Node || value === window || value === document) return;
      seen.add(value);
      queue.push({ value, depth });
    }

    function pick(obj, keys) {
      for (const key of keys) {
        if (obj[key] != null) return obj[key];
      }
      return undefined;
    }

    let descriptors = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(window);
    } catch (_) {
      descriptors = {};
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (shouldSkipWindowKey(key)) continue;
      if (!("value" in descriptor)) continue;
      enqueue(descriptor.value, 0);
    }

    while (queue.length) {
      if (++scanned > CONFIG.windowScanMaxNodes * 2) break;
      if (Date.now() - started > CONFIG.windowScanMaxMs * 2) break;

      const { value, depth } = queue.shift();
      let objDescriptors = {};
      try {
        objDescriptors = Object.getOwnPropertyDescriptors(value);
      } catch (_) {
        objDescriptors = {};
      }

      const shallow = {};
      for (const [key, descriptor] of Object.entries(objDescriptors).slice(0, 120)) {
        if ("value" in descriptor) shallow[key] = descriptor.value;
      }

      const row = Number(pick(shallow, rowKeys));
      const col = Number(pick(shallow, colKeys));
      const text = normalizeGridValue(pick(shallow, valueKeys));
      if (Number.isFinite(row) && Number.isFinite(col) && text && /(货件号|时间|箱数|外箱标|预约信|\d{7,12}|\d+\s*箱|\d{1,2}\s*月\s*\d{1,2}\s*日)/.test(text)) {
        records.push({ row, col, text });
      }

      if (Array.isArray(value)) {
        for (let index = 0; index < value.length && index < 3000; index += 1) enqueue(value[index], depth + 1);
        continue;
      }

      if (value instanceof Map) {
        let index = 0;
        for (const [mapKey, mapValue] of value.entries()) {
          enqueue(mapKey, depth + 1);
          enqueue(mapValue, depth + 1);
          if (++index > 3000) break;
        }
        continue;
      }

      if (value instanceof Set) {
        let index = 0;
        for (const setValue of value.values()) {
          enqueue(setValue, depth + 1);
          if (++index > 3000) break;
        }
        continue;
      }

      for (const [key, descriptor] of Object.entries(objDescriptors)) {
        if (!("value" in descriptor)) continue;
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        enqueue(descriptor.value, depth + 1);
      }
    }

    if (CONFIG.debug) log(`单元格状态扫描：扫描节点 ${scanned} 个，命中 ${records.length} 个 cell-like 记录。`);
    return records;
  }

  function rowsFromCellLikeRecords(records) {
    if (!records || !records.length) return [];

    const candidateOffsets = [
      { row: 0, col: 0 },
      { row: 1, col: 1 },
      { row: -1, col: -1 },
    ];

    for (const offset of candidateOffsets) {
      const grid = new Map();
      let minRow = Infinity;
      let maxRow = -Infinity;
      let minCol = Infinity;
      let maxCol = -Infinity;

      for (const record of records) {
        const row = record.row + offset.row;
        const col = record.col + offset.col;
        if (row < 0 || col < 0 || row > 10000 || col > 200) continue;
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
        minCol = Math.min(minCol, col);
        maxCol = Math.max(maxCol, col);
        grid.set(`${row}:${col}`, record.text);
      }

      if (!Number.isFinite(minRow)) continue;

      const rows = [];
      for (let r = minRow; r <= Math.min(maxRow, minRow + 300); r += 1) {
        const row = [];
        for (let c = minCol; c <= Math.min(maxCol, minCol + 30); c += 1) {
          row.push(grid.get(`${r}:${c}`) || "");
        }
        if (row.some(Boolean)) rows.push(row);
      }

      const headerIndex = rows.findIndex((row) => row.some((cell) => cleanText(cell) === "货件号") && row.some((cell) => cleanText(cell).includes("箱数")));
      if (headerIndex >= 0) return rows.slice(headerIndex);
    }

    return [];
  }

  function trimTableRows(rows) {
    rows = (rows || []).filter((row) => Array.isArray(row) && row.some((cell) => cleanText(normalizeGridValue(cell))));
    let lastUsedCol = -1;

    for (const row of rows) {
      for (let col = row.length - 1; col >= 0; col -= 1) {
        if (cleanText(normalizeGridValue(row[col]))) {
          lastUsedCol = Math.max(lastUsedCol, col);
          break;
        }
      }
    }

    if (lastUsedCol < 0) return [];
    return rows.map((row) => row.slice(0, lastUsedCol + 1));
  }

  function buildPlanFromTableDataDirectly() {
    const nativeRows = trimTableRows(tryWpsNativeCellRows());
    let plan = buildPlanFromTableRows(nativeRows);
    if (plan.length) {
      log(`表格数据读取成功：WPS 原生单元格接口，生成任务 ${plan.length} 个。`);
      return { plan, source: "wps-native-cell-api", rows: nativeRows };
    }
    let bestRowsResult = nativeRows.length
      ? { plan, source: "wps-native-cell-api", rows: nativeRows }
      : null;

    const apiRows = trimTableRows(tryWorkbookApiRows());
    plan = buildPlanFromTableRows(apiRows);
    if (plan.length) {
      log(`表格数据读取成功：workbook API，生成任务 ${plan.length} 个。`);
      return { plan, source: "workbook-api", rows: apiRows };
    }
    if (!bestRowsResult && apiRows.length) {
      bestRowsResult = { plan, source: "workbook-api", rows: apiRows };
    }

    const records = extractCellLikeRecordsFromState();
    const stateRows = trimTableRows(rowsFromCellLikeRecords(records));
    plan = buildPlanFromTableRows(stateRows);
    if (plan.length) {
      log(`表格数据读取成功：内部单元格状态，生成任务 ${plan.length} 个。`);
      return { plan, source: "cell-state", rows: stateRows, records };
    }
    if (!bestRowsResult && stateRows.length) {
      bestRowsResult = { plan, source: "cell-state", rows: stateRows, records };
    }

    const domRows = trimTableRows(extractRowsFromPlainText(document.body.innerText || document.body.textContent || ""));
    plan = buildPlanFromTableRows(domRows);
    if (plan.length) {
      log(`表格数据读取成功：页面文本，生成任务 ${plan.length} 个。`);
      return { plan, source: "dom-text", rows: domRows };
    }
    if (!bestRowsResult && domRows.length) {
      bestRowsResult = { plan, source: "dom-text", rows: domRows };
    }

    if (bestRowsResult) {
      log(`表格行读取成功：${bestRowsResult.source}，但未匹配到旧业务任务。`);
      return bestRowsResult;
    }

    return { plan: [], source: "none", rows: [], records };
  }

  function extractFromDomText() {
    const pieces = [];

    for (const el of Array.from(document.querySelectorAll("*"))) {
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;

      for (const attr of ["textContent", "innerText"]) {
        const value = el[attr];
        if (value && /(外箱标|预约信|\d{7,12})/.test(value)) pieces.push(value);
      }

      for (const attr of ["title", "aria-label", "data-title", "data-name", "data-url", "href"]) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (value && /(外箱标|预约信|\d{7,12})/.test(value)) pieces.push(value);
      }
    }

    return extractAttachmentStringsFromText(pieces.join("\n"));
  }

  function shouldSkipWindowKey(key) {
    return /^(window|self|top|parent|frames|document|location|history|navigator|screen|visualViewport|localStorage|sessionStorage|indexedDB|crypto|performance|customElements)$/i.test(
      key
    );
  }

  function deepScanWindowStrings() {
    const started = Date.now();
    const seen = new WeakSet();
    const queue = [];
    const strings = [];
    let scanned = 0;

    function enqueue(value, path, depth) {
      if (value == null) return;
      const type = typeof value;
      if (type === "string") {
        if (/(外箱标|预约信|\d{7,12})/.test(value)) strings.push(value);
        return;
      }
      if (type !== "object" && type !== "function") return;
      if (seen.has(value)) return;
      if (depth > CONFIG.windowScanMaxDepth) return;

      if (value instanceof Node || value === window || value === document) return;

      seen.add(value);
      queue.push({ value, path, depth });
    }

    let descriptors = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(window);
    } catch (_) {
      descriptors = {};
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (shouldSkipWindowKey(key)) continue;
      if (!("value" in descriptor)) continue;
      enqueue(descriptor.value, key, 0);
    }

    while (queue.length) {
      if (++scanned > CONFIG.windowScanMaxNodes) break;
      if (Date.now() - started > CONFIG.windowScanMaxMs) break;

      const { value, path, depth } = queue.shift();

      if (Array.isArray(value)) {
        for (let index = 0; index < value.length && index < 2000; index += 1) {
          enqueue(value[index], `${path}[${index}]`, depth + 1);
        }
        continue;
      }

      if (value instanceof Map) {
        let index = 0;
        for (const [mapKey, mapValue] of value.entries()) {
          enqueue(mapKey, `${path}.mapKey${index}`, depth + 1);
          enqueue(mapValue, `${path}.mapValue${index}`, depth + 1);
          if (++index > 1000) break;
        }
        continue;
      }

      if (value instanceof Set) {
        let index = 0;
        for (const setValue of value.values()) {
          enqueue(setValue, `${path}.set${index}`, depth + 1);
          if (++index > 1000) break;
        }
        continue;
      }

      let objectDescriptors = {};
      try {
        objectDescriptors = Object.getOwnPropertyDescriptors(value);
      } catch (_) {
        continue;
      }

      for (const [key, descriptor] of Object.entries(objectDescriptors)) {
        if (!("value" in descriptor)) continue;
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        enqueue(descriptor.value, `${path}.${key}`, depth + 1);
      }
    }

    const bucket = extractAttachmentStringsFromText(strings.join("\n"));
    if (CONFIG.debug) {
      log(`内部状态扫描：扫描节点 ${scanned} 个，命中字符串 ${strings.length} 条。`);
    }
    return bucket;
  }

  function summarizeValue(value) {
    if (value == null) return value;
    if (typeof value === "string") return value.slice(0, 500);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return `[Array(${value.length})]`;
    if (value instanceof Map) return `[Map(${value.size})]`;
    if (value instanceof Set) return `[Set(${value.size})]`;
    if (value instanceof Blob) return `[Blob(${value.type || "unknown"}, ${value.size})]`;
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value === "object") return `[${value.constructor && value.constructor.name ? value.constructor.name : "Object"}]`;
    return String(value);
  }

  function summarizeObject(obj) {
    const out = {};
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return out;

    let descriptors = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(obj);
    } catch (_) {
      return out;
    }

    for (const [key, descriptor] of Object.entries(descriptors).slice(0, 80)) {
      if (!("value" in descriptor)) continue;
      try {
        out[key] = summarizeValue(descriptor.value);
      } catch (_) {
        out[key] = "[unreadable]";
      }
    }
    return out;
  }

  function summarizeObjectDeep(obj, depth = 2, seen = new WeakSet()) {
    if (obj == null) return obj;
    const type = typeof obj;
    if (type === "string") return obj.slice(0, 500);
    if (type === "number" || type === "boolean") return obj;
    if (type !== "object" && type !== "function") return summarizeValue(obj);
    if (obj instanceof Node || obj === window || obj === document) return `[${obj.constructor.name}]`;
    if (seen.has(obj)) return "[Circular]";
    if (depth < 0) return summarizeValue(obj);

    seen.add(obj);

    if (Array.isArray(obj)) {
      return obj.slice(0, 25).map((item) => summarizeObjectDeep(item, depth - 1, seen));
    }

    if (obj instanceof Map) {
      const out = {};
      let index = 0;
      for (const [key, value] of obj.entries()) {
        out[`map:${summarizeValue(key)}`] = summarizeObjectDeep(value, depth - 1, seen);
        if (++index >= 25) break;
      }
      return out;
    }

    if (obj instanceof Set) {
      return Array.from(obj.values())
        .slice(0, 25)
        .map((item) => summarizeObjectDeep(item, depth - 1, seen));
    }

    const out = {};
    let descriptors = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(obj);
    } catch (_) {
      return summarizeValue(obj);
    }

    for (const [key, descriptor] of Object.entries(descriptors).slice(0, 80)) {
      if (!("value" in descriptor)) continue;
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      try {
        out[key] = summarizeObjectDeep(descriptor.value, depth - 1, seen);
      } catch (_) {
        out[key] = "[unreadable]";
      }
    }

    return out;
  }

  function findIdsInText(text) {
    return unique(String(text || "").match(/\b[A-Z0-9]{10,24}\b/g) || []).filter((id) => /[A-Z]/.test(id));
  }

  function deepScanStateDetails() {
    const started = Date.now();
    const seen = new WeakSet();
    const queue = [];
    const hits = [];
    let scanned = 0;

    function enqueue(value, path, depth, parent) {
      if (value == null) return;
      const type = typeof value;
      if (type === "string") {
        if (/(外箱标|预约信|\d{7,12})/.test(value)) {
          hits.push({
            path,
            value: value.slice(0, 500),
            parentPath: parent ? parent.path : "",
            parentSummary: parent ? summarizeObject(parent.value) : {},
          });
        }
        return;
      }
      if (type !== "object" && type !== "function") return;
      if (seen.has(value)) return;
      if (depth > CONFIG.windowScanMaxDepth) return;
      if (value instanceof Node || value === window || value === document) return;

      seen.add(value);
      queue.push({ value, path, depth });
    }

    let descriptors = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(window);
    } catch (_) {
      descriptors = {};
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (shouldSkipWindowKey(key)) continue;
      if (!("value" in descriptor)) continue;
      enqueue(descriptor.value, key, 0, null);
    }

    while (queue.length) {
      if (++scanned > CONFIG.windowScanMaxNodes) break;
      if (Date.now() - started > CONFIG.windowScanMaxMs) break;

      const current = queue.shift();
      const { value, path, depth } = current;

      if (Array.isArray(value)) {
        for (let index = 0; index < value.length && index < 2000; index += 1) {
          enqueue(value[index], `${path}[${index}]`, depth + 1, current);
        }
        continue;
      }

      if (value instanceof Map) {
        let index = 0;
        for (const [mapKey, mapValue] of value.entries()) {
          enqueue(mapKey, `${path}.mapKey${index}`, depth + 1, current);
          enqueue(mapValue, `${path}.mapValue${index}`, depth + 1, current);
          if (++index > 1000) break;
        }
        continue;
      }

      if (value instanceof Set) {
        let index = 0;
        for (const setValue of value.values()) {
          enqueue(setValue, `${path}.set${index}`, depth + 1, current);
          if (++index > 1000) break;
        }
        continue;
      }

      let objectDescriptors = {};
      try {
        objectDescriptors = Object.getOwnPropertyDescriptors(value);
      } catch (_) {
        continue;
      }

      for (const [key, descriptor] of Object.entries(objectDescriptors)) {
        if (!("value" in descriptor)) continue;
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        enqueue(descriptor.value, `${path}.${key}`, depth + 1, current);
      }
    }

    return { scanned, hits: hits.slice(0, 120) };
  }

  function deepScanAttachmentDetails() {
    const started = Date.now();
    const seen = new WeakSet();
    const queue = [];
    const hits = [];
    let scanned = 0;

    function enqueue(value, path, depth, ancestors) {
      if (value == null) return;
      const type = typeof value;
      if (type === "string") {
        if (/(外箱标|预约信)/.test(value)) {
          const ancestorSummaries = (ancestors || []).slice(-4).map((ancestor) => ({
            path: ancestor.path,
            summary: summarizeObjectDeep(ancestor.value, 2),
          }));
          const textBlob = JSON.stringify(ancestorSummaries);
          hits.push({
            path,
            value: value.slice(0, 800),
            ids: findIdsInText(value + "\n" + textBlob),
            ancestors: ancestorSummaries,
          });
        }
        return;
      }
      if (type !== "object" && type !== "function") return;
      if (seen.has(value)) return;
      if (depth > CONFIG.windowScanMaxDepth + 2) return;
      if (value instanceof Node || value === window || value === document) return;

      seen.add(value);
      queue.push({ value, path, depth, ancestors });
    }

    let descriptors = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(window);
    } catch (_) {
      descriptors = {};
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (shouldSkipWindowKey(key)) continue;
      if (!("value" in descriptor)) continue;
      enqueue(descriptor.value, key, 0, []);
    }

    while (queue.length) {
      if (++scanned > CONFIG.windowScanMaxNodes * 2) break;
      if (Date.now() - started > CONFIG.windowScanMaxMs * 3) break;

      const current = queue.shift();
      const { value, path, depth, ancestors } = current;
      const nextAncestors = [...(ancestors || []), { path, value }];

      if (Array.isArray(value)) {
        for (let index = 0; index < value.length && index < 5000; index += 1) {
          enqueue(value[index], `${path}[${index}]`, depth + 1, nextAncestors);
        }
        continue;
      }

      if (value instanceof Map) {
        let index = 0;
        for (const [mapKey, mapValue] of value.entries()) {
          enqueue(mapKey, `${path}.mapKey${index}`, depth + 1, nextAncestors);
          enqueue(mapValue, `${path}.mapValue${index}`, depth + 1, nextAncestors);
          if (++index > 3000) break;
        }
        continue;
      }

      if (value instanceof Set) {
        let index = 0;
        for (const setValue of value.values()) {
          enqueue(setValue, `${path}.set${index}`, depth + 1, nextAncestors);
          if (++index > 3000) break;
        }
        continue;
      }

      let objectDescriptors = {};
      try {
        objectDescriptors = Object.getOwnPropertyDescriptors(value);
      } catch (_) {
        continue;
      }

      for (const [key, descriptor] of Object.entries(objectDescriptors)) {
        if (!("value" in descriptor)) continue;
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        enqueue(descriptor.value, `${path}.${key}`, depth + 1, nextAncestors);
      }
    }

    return { scanned, hits: hits.slice(0, 200) };
  }

  function performanceCandidateUrls() {
    const entries = performance.getEntriesByType("resource") || [];
    const likely = /(sheet|cell|workbook|attachment|file|download|link|docs|api|record|content|metadata|object)/i;
    return unique(
      entries
        .map((entry) => entry.name)
        .filter((url) => {
          try {
            const parsed = new URL(url, location.href);
            if (!/^https?:$/.test(parsed.protocol)) return false;
            if (!CONFIG.allowCrossOriginNetworkProbe && parsed.origin !== location.origin) return false;
            return likely.test(parsed.href);
          } catch (_) {
            return false;
          }
        })
    ).slice(0, CONFIG.networkProbeMaxUrls);
  }

  async function extractFromNetworkResources() {
    const urls = performanceCandidateUrls();
    const buckets = [];

    if (CONFIG.debug) log(`网络资源探测：准备尝试 ${urls.length} 个已加载 URL。`);

    for (const url of urls) {
      try {
        const response = await fetch(url, { credentials: "include" });
        const type = response.headers.get("content-type") || "";
        if (!response.ok || !/(json|text|javascript|octet-stream|xml|html)/i.test(type)) continue;

        const text = await response.text();
        if (!/(外箱标|预约信|\d{7,12})/.test(text)) continue;

        buckets.push(extractAttachmentStringsFromText(text.slice(0, CONFIG.networkProbeMaxChars)));
        if (CONFIG.debug) log("网络资源命中：", url);
      } catch (_) {
        // Cross-origin or opaque responses are expected on some WPS resources.
      }
    }

    return mergeStringBuckets(...buckets);
  }

  async function buildPlanDirectlyFromPage() {
    if (CONFIG.preferTableCells !== false) {
      const tableResult = buildPlanFromTableDataDirectly();
      if (tableResult.plan.length) {
        window.WPSBatch.lastTableReadResult = tableResult;
        return tableResult.plan;
      }
      window.WPSBatch.lastTableReadResult = tableResult;
      if ((tableResult.rows || []).length) {
        log("已读到表格行数据，但未生成旧业务任务；侧栏仍可浏览列头和单元格。");
      } else {
        warn("没有直接读到表格行数据，退回到附件名解析。可运行 WPSBatch.reportTableState() 查看原因。");
      }
    }

    const domBucket = extractFromDomText();
    const stateBucket = deepScanWindowStrings();
    const networkBucket = CONFIG.enableNetworkProbe
      ? await extractFromNetworkResources()
      : { outer: [], appointment: [] };
    const bucket = mergeStringBuckets(domBucket, stateBucket, networkBucket);
    const plan = buildPlanFromAttachmentStrings(bucket);

    log(`自动发现：外箱标 ${bucket.outer.length} 个，预约信 ${bucket.appointment.length} 个，生成任务 ${plan.length} 个。`);
    if (CONFIG.debug) {
      console.table({
        domOuter: domBucket.outer.length,
        domAppointment: domBucket.appointment.length,
        stateOuter: stateBucket.outer.length,
        stateAppointment: stateBucket.appointment.length,
        networkOuter: networkBucket.outer.length,
        networkAppointment: networkBucket.appointment.length,
      });
    }

    return plan;
  }

  function makeTableStateReportText() {
    const result = buildPlanFromTableDataDirectly();
    window.WPSBatch.lastTableReadResult = result;

    const lines = [];
    lines.push("=== WPSBatch Table State Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`source: ${result.source}`);
    lines.push(`planCount: ${result.plan.length}`);
    lines.push(`rowCount: ${(result.rows || []).length}`);
    lines.push(`recordCount: ${(result.records || []).length}`);
    lines.push("");

    lines.push("ROWS:");
    (result.rows || []).slice(0, 80).forEach((row, index) => {
      lines.push(`ROW\t${index}\t${row.map(normalizeGridValue).join("\t")}`);
    });
    lines.push("");

    lines.push("PLAN:");
    result.plan.forEach((item) => {
      lines.push(
        ["PLAN", `row=${item.row}`, `type=${item.type}`, `key=${item.key}`, `source=${item.sourceText}`, `target=${item.targetBase}`].join("\t")
      );
    });
    lines.push("");

    lines.push("CELL_RECORDS_SAMPLE:");
    (result.records || []).slice(0, 120).forEach((record, index) => {
      lines.push(["CELL", `index=${index}`, `row=${record.row}`, `col=${record.col}`, `text=${record.text}`].join("\t"));
    });
    lines.push("");
    lines.push("=== End WPSBatch Table State Report ===");
    return lines.join("\n");
  }

  async function reportTableState() {
    const text = makeTableStateReportText();
    window.WPSBatch.lastTableStateReportText = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("表格状态报告已复制到剪贴板。");
    } catch (error) {
      warn("表格状态报告自动复制失败，请手动复制 WPSBatch.lastTableStateReportText。", error.message);
    }
    return text;
  }

  function makeAttachmentCellApiReportText(limit = 4) {
    const tableResult = buildPlanFromTableDataDirectly();
    const plan = tableResult.plan.slice(0, limit);
    const inspections = plan.map(inspectAttachmentCell);
    const lines = [];

    lines.push("=== WPSBatch Attachment Cell API Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`source: ${tableResult.source}`);
    lines.push(`inspectedCount: ${inspections.length}`);
    lines.push("");

    inspections.forEach((item, index) => {
      lines.push(
        [
          "CELL",
          `index=${index}`,
          `row=${item.row}`,
          `rowIndex=${item.rowIndex}`,
          `colIndex=${item.colIndex}`,
          `type=${item.type}`,
          `key=${item.key}`,
          `ctor=${item.cellCtor}`,
          `source=${item.sourceText}`,
          `target=${item.targetBase}`,
          `meta=${JSON.stringify(item.meta).slice(0, 2000)}`,
        ].join("\t")
      );
      lines.push(`OWN\tindex=${index}\tsummary=${JSON.stringify(item.ownSummary).slice(0, 3000)}`);
      item.methods.forEach((method) => {
        lines.push(
          [
            "METHOD",
            `cell=${index}`,
            `level=${method.level}`,
            `name=${method.name}`,
            `argc=${method.length}`,
            `preview=${method.preview}`,
          ].join("\t")
        );
      });
      item.calls.forEach((call) => {
        lines.push(
          [
            "CALL",
            `cell=${index}`,
            `name=${call.name}`,
            `result=${call.result || ""}`,
            `error=${call.error || ""}`,
          ].join("\t")
        );
      });
      lines.push("");
    });

    lines.push("=== End WPSBatch Attachment Cell API Report ===");
    return lines.join("\n");
  }

  async function reportAttachmentCellApis(limit = 4) {
    const text = makeAttachmentCellApiReportText(limit);
    window.WPSBatch.lastAttachmentCellApiReportText = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("附件单元格 API 报告已复制到剪贴板。");
    } catch (error) {
      warn("附件单元格 API 报告自动复制失败，请手动复制 WPSBatch.lastAttachmentCellApiReportText。", error.message);
    }
    return text;
  }

  async function reportAttachmentRangeQueries(limit = 4) {
    const tableResult = buildPlanFromTableDataDirectly();
    const plan = tableResult.plan.slice(0, limit);
    const inspections = [];
    for (const item of plan) {
      inspections.push(await inspectAttachmentCellRich(item));
    }

    const lines = [];
    lines.push("=== WPSBatch Attachment Range Query Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`source: ${tableResult.source}`);
    lines.push(`inspectedCount: ${inspections.length}`);
    lines.push("");

    inspections.forEach((item, index) => {
      lines.push(
        [
          "CELL",
          `index=${index}`,
          `row=${item.row}`,
          `rowIndex=${item.rowIndex}`,
          `colIndex=${item.colIndex}`,
          `type=${item.type}`,
          `key=${item.key}`,
          `source=${item.sourceText}`,
          `target=${item.targetBase}`,
        ].join("\t")
      );
      item.rangeQueries.forEach((query, queryIndex) => {
        lines.push(
          [
            "RANGE_QUERY",
            `cell=${index}`,
            `query=${queryIndex}`,
            `options=${JSON.stringify(query.options)}`,
            `meta=${JSON.stringify(query.meta).slice(0, 2000)}`,
            `summary=${JSON.stringify(query.summary).slice(0, 5000)}`,
          ].join("\t")
        );
      });
      lines.push("");
    });

    lines.push("=== End WPSBatch Attachment Range Query Report ===");
    const text = lines.join("\n");
    window.WPSBatch.lastAttachmentRangeQueryReportText = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("附件 range query 报告已复制到剪贴板。");
    } catch (_) {}
    return text;
  }

  async function reportAttachmentApiProbe() {
    const result = await fetchAttachmentApiCandidates();
    const lines = [];
    lines.push("=== WPSBatch Attachment API Probe Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`endpointCount: ${result.endpointResults.length}`);
    lines.push(`candidateCount: ${result.candidates.length}`);
    lines.push("");

    result.endpointResults.forEach((item, index) => {
      lines.push(
        [
          "ENDPOINT",
          `index=${index}`,
          `status=${item.status}`,
          `contentType=${item.contentType}`,
          `url=${item.url}`,
          `snippet=${String(item.snippet || "").replace(/\s+/g, " ").slice(0, 1000)}`,
        ].join("\t")
      );
    });
    lines.push("");

    result.candidates.forEach((item, index) => {
      lines.push(
        [
          "CANDIDATE",
          `index=${index}`,
          `type=${item.type}`,
          `key=${item.key}`,
          `id=${item.id}`,
          `text=${item.text}`,
          `fileSize=${item.fileSize || ""}`,
          `source=${item.source || ""}`,
        ].join("\t")
      );
    });
    lines.push("");
    lines.push("=== End WPSBatch Attachment API Probe Report ===");

    const text = lines.join("\n");
    window.WPSBatch.lastAttachmentApiProbeReportText = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("附件接口探测报告已复制到剪贴板。");
    } catch (_) {}
    return text;
  }

  async function reportProbeAttachmentCandidates() {
    const result = collectAttachmentCandidatesFromProbe();
    const lines = [];
    lines.push("=== WPSBatch Probe Attachment Candidate Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`candidateCount: ${result.candidates.length}`);
    lines.push(`downloadIdCount: ${result.downloadIds.length}`);
    lines.push("");

    result.candidates.forEach((item, index) => {
      lines.push(
        [
          "CANDIDATE",
          `index=${index}`,
          `type=${item.type}`,
          `key=${item.key}`,
          `id=${item.id}`,
          `text=${item.text}`,
          `fileSize=${item.fileSize || ""}`,
          `source=${item.source || ""}`,
        ].join("\t")
      );
    });
    lines.push("");

    result.downloadIds.forEach((item, index) => {
      lines.push(["DOWNLOAD_ID", `index=${index}`, `id=${item.id}`, `source=${item.source}`].join("\t"));
    });
    lines.push("");
    lines.push("=== End WPSBatch Probe Attachment Candidate Report ===");

    const text = lines.join("\n");
    window.WPSBatch.lastProbeAttachmentCandidateReportText = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("probe 附件候选报告已复制到剪贴板。");
    } catch (_) {}
    return text;
  }

  function functionSourcePreview(fn) {
    try {
      return Function.prototype.toString.call(fn).slice(0, 220).replace(/\s+/g, " ");
    } catch (_) {
      return "";
    }
  }

  function inspectObjectSurface(name, obj, depth = 1, seen = new WeakSet()) {
    const rows = [];
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return rows;
    if (seen.has(obj)) return rows;
    seen.add(obj);

    let descriptors = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(obj);
    } catch (_) {
      return rows;
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      let value;
      if ("value" in descriptor) value = descriptor.value;
      const valueType = typeof value;
      const interesting =
        /cell|range|sheet|book|work|value|text|formula|selection|select|active|cmd|command|query|exec|get|set|row|col|addr|address|attachment|annex|hyper|link/i.test(
          key
        );

      if (interesting || valueType === "function") {
        rows.push({
          path: `${name}.${key}`,
          type: valueType,
          ctor: value && value.constructor && value.constructor.name ? value.constructor.name : "",
          preview: valueType === "function" ? functionSourcePreview(value) : summarizeValue(value),
        });
      }

      if (depth > 0 && value && (valueType === "object" || valueType === "function")) {
        if (/store|workbook|sheet|window|session|cmd|command|selection|range|cell|api|core|model/i.test(key)) {
          rows.push(...inspectObjectSurface(`${name}.${key}`, value, depth - 1, seen));
        }
      }
    }

    const proto = Object.getPrototypeOf(obj);
    if (proto && proto !== Object.prototype && proto !== Function.prototype) {
      rows.push(...inspectObjectSurface(`${name}.__proto__`, proto, depth - 1, seen));
    }

    return rows;
  }

  function findInterestingGlobalSurfaces() {
    const roots = {
      APP: window.APP,
      workbook: window.workbook,
      sheet: window.sheet,
      et: window.et,
      WPSOpenApi: window.WPSOpenApi,
      WebOfficeSDK: window.WebOfficeSDK,
      kso: window.kso,
      Kso: window.Kso,
      app: window.app,
      fileInfo: window.fileInfo,
      session: window.session,
    };

    const rows = [];
    for (const [name, obj] of Object.entries(roots)) {
      if (!obj) continue;
      rows.push({
        path: name,
        type: typeof obj,
        ctor: obj && obj.constructor && obj.constructor.name ? obj.constructor.name : "",
        preview: summarizeValue(obj),
      });
      rows.push(...inspectObjectSurface(name, obj, 2));
    }
    return rows.slice(0, 1200);
  }

  async function tryCallNoArgMethodsForCellClues() {
    const candidates = findInterestingGlobalSurfaces()
      .filter((row) => row.type === "function")
      .filter((row) => /active|selection|select|range|cell|sheet|value|text|formula|addr|address/i.test(row.path))
      .slice(0, 250);

    function resolvePath(path) {
      const parts = path.split(".");
      let obj = window;
      if (parts[0] === "window") parts.shift();
      for (const part of parts) {
        if (part === "__proto__") obj = Object.getPrototypeOf(obj);
        else obj = obj && obj[part];
      }
      return obj;
    }

    function resolveThis(path) {
      const parts = path.split(".");
      parts.pop();
      let obj = window;
      for (const part of parts) {
        if (part === "__proto__") obj = Object.getPrototypeOf(obj);
        else obj = obj && obj[part];
      }
      return obj;
    }

    const results = [];
    for (const item of candidates) {
      const fn = resolvePath(item.path);
      const thisArg = resolveThis(item.path);
      if (typeof fn !== "function") continue;
      if (fn.length > 0) continue;

      try {
        let value = fn.call(thisArg);
        if (value && typeof value.then === "function") {
          value = await Promise.race([value, sleep(300).then(() => "[timeout]")]);
        }
        const summary = summarizeObjectDeep(value, 2);
        const text = JSON.stringify(summary);
        if (/(A1|货件号|时间|箱数|外箱标|预约信|row|col|range|cell|sheet|6250|6262)/i.test(text)) {
          results.push({
            path: item.path,
            result: text.slice(0, 3000),
          });
        }
      } catch (error) {
        if (/cell|range|selection|sheet/i.test(item.path)) {
          results.push({
            path: item.path,
            error: String(error && error.message ? error.message : error).slice(0, 500),
          });
        }
      }
    }

    return results;
  }

  async function makeWpsApiReportText() {
    const surfaces = findInterestingGlobalSurfaces();
    const callResults = await tryCallNoArgMethodsForCellClues();
    const lines = [];
    lines.push("=== WPSBatch API Surface Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`surfaceCount: ${surfaces.length}`);
    lines.push(`callResultCount: ${callResults.length}`);
    lines.push("");

    lines.push("SURFACES:");
    surfaces.forEach((row, index) => {
      lines.push(
        [
          "SURFACE",
          `index=${index}`,
          `path=${row.path}`,
          `type=${row.type}`,
          `ctor=${row.ctor}`,
          `preview=${String(row.preview || "").slice(0, 800)}`,
        ].join("\t")
      );
    });
    lines.push("");

    lines.push("CALL_RESULTS:");
    callResults.forEach((row, index) => {
      lines.push(
        [
          "CALL",
          `index=${index}`,
          `path=${row.path}`,
          `result=${row.result || ""}`,
          `error=${row.error || ""}`,
        ].join("\t")
      );
    });

    lines.push("");
    lines.push("=== End WPSBatch API Surface Report ===");
    return lines.join("\n");
  }

  async function reportWpsApiState() {
    const text = await makeWpsApiReportText();
    window.WPSBatch.lastWpsApiReportText = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("WPS API 探测报告已复制到剪贴板。");
    } catch (error) {
      warn("WPS API 探测报告自动复制失败，请手动复制 WPSBatch.lastWpsApiReportText。", error.message);
    }
    return text;
  }

  function rowObject(headers, row) {
    const out = {};
    headers.forEach((header, index) => {
      out[cleanText(header)] = cleanText(row[index]);
    });
    return out;
  }

  function findColumn(headers, names) {
    const normalized = headers.map(cleanText);
    for (const name of names) {
      const index = normalized.findIndex((header) => header === name || header.includes(name));
      if (index >= 0) return index;
    }
    return -1;
  }

  function parseShipmentNo(...values) {
    const joined = values.map(cleanText).join(" ");
    const match = joined.match(/\b\d{7,12}\b/);
    return match ? match[0] : "";
  }

  function parseBoxCount(...values) {
    const joined = values.map(cleanText).join(" ");
    const match = joined.match(/(?:-|^|\s)(\d+)\s*箱/);
    if (match) return match[1];
    const numberOnly = joined.match(/^\d+$/);
    return numberOnly ? numberOnly[0] : "";
  }

  function parseDateText(...values) {
    const joined = values.map(cleanText).join(" ");
    const match = joined.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (!match) return "";
    return `${Number(match[1])}月${Number(match[2])}日`;
  }

  function buildPlanFromTsv(tsvText) {
    const rows = splitTsv(tsvText);
    if (rows.length < 2) {
      throw new Error("没有读到有效表格数据。请先在 WPS 里选中 A1:F11 或完整数据区域，然后复制。");
    }

    const headers = rows[0];
    const idx = {
      shipment: findColumn(headers, ["货件号"]),
      time: findColumn(headers, ["时间"]),
      outerFile: findColumn(headers, ["外箱标文件"]),
      boxCount: findColumn(headers, ["箱数"]),
      appointmentFile: findColumn(headers, ["预约信文件"]),
    };

    if (idx.outerFile < 0 || idx.appointmentFile < 0) {
      throw new Error(`没有找到“外箱标文件”和“预约信文件”列。当前表头：${headers.join(" | ")}`);
    }

    const plan = [];
    let lastShipment = "";

    rows.slice(1).forEach((row, rowIndex) => {
      const raw = rowObject(headers, row);
      const shipmentCell = idx.shipment >= 0 ? row[idx.shipment] : "";
      if (parseShipmentNo(shipmentCell)) lastShipment = parseShipmentNo(shipmentCell);

      const outerText = row[idx.outerFile];
      const appointmentText = row[idx.appointmentFile];
      const boxCell = idx.boxCount >= 0 ? row[idx.boxCount] : "";
      const timeCell = idx.time >= 0 ? row[idx.time] : "";

      const outerShipment = parseShipmentNo(outerText) || lastShipment;
      const appointmentShipment = parseShipmentNo(appointmentText) || parseShipmentNo(outerText) || lastShipment;
      const boxCount = parseBoxCount(outerText, boxCell);
      const timeText = parseDateText(appointmentText, timeCell);

      if (!outerText && !appointmentText) return;

      if (outerText && outerShipment && boxCount) {
        plan.push({
          row: rowIndex + 2,
          type: "outer",
          sourceText: outerText,
          key: outerShipment,
          targetBase: sanitizeFilename(`外箱标-${outerShipment}-${boxCount}箱`),
          raw,
        });
      }

      if (appointmentText && appointmentShipment && timeText) {
        plan.push({
          row: rowIndex + 2,
          type: "appointment",
          sourceText: appointmentText,
          key: appointmentShipment,
          targetBase: sanitizeFilename(`预约信-${appointmentShipment}-${timeText}`),
          raw,
        });
      }
    });

    return plan;
  }

  async function readTsvFromClipboardOrPrompt() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.includes("\t")) return text;
      }
    } catch (error) {
      warn("剪贴板读取失败，会改用手动粘贴。", error.message);
    }

    const pasted = prompt("请先复制 WPS 表格数据区域，然后在这里粘贴 TSV 内容：");
    if (!pasted) throw new Error("没有提供表格数据。");
    return pasted;
  }

  function getElementText(el) {
    return cleanText(
      [
        el.innerText,
        el.textContent,
        el.getAttribute("title"),
        el.getAttribute("aria-label"),
        el.getAttribute("data-title"),
        el.getAttribute("data-name"),
        el.getAttribute("href"),
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  function findDomAttachmentCandidates() {
    const selector = [
      "a[href]",
      "[role='link']",
      "[data-url]",
      "[data-href]",
      "[data-link]",
      "[data-fileid]",
      "[data-file-id]",
      "[data-id]",
      "button",
      "span",
      "div",
    ].join(",");

    const seen = new Set();
    const candidates = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (seen.has(el)) continue;
      seen.add(el);

      const text = getElementText(el);
      if (!/(外箱标|预约信|\d{7,12})/.test(text)) continue;

      const href =
        el.href ||
        el.getAttribute("href") ||
        el.getAttribute("data-url") ||
        el.getAttribute("data-href") ||
        el.getAttribute("data-link") ||
        "";

      const rect = el.getBoundingClientRect();
      candidates.push({
        el,
        text,
        href,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });

      if (candidates.length >= CONFIG.maxDomCandidates) break;
    }

    return candidates;
  }

  function matchCandidate(item, candidates) {
    const source = cleanText(item.sourceText);
    const key = item.key;
    const typed = item.type === "outer" ? "外箱标" : "预约信";

    const exact = candidates.find((candidate) => {
      const text = cleanText(candidate.text);
      return text.includes(source) || (text.includes(typed) && text.includes(key));
    });
    if (exact) return exact;

    return candidates.find((candidate) => {
      const text = cleanText(candidate.text);
      return text.includes(typed) && text.includes(key);
    });
  }

  function normalizeAttachmentDisplayName(value) {
    return normalizeDataText(value)
      .replace(/^[\s📄📎]+/u, "")
      .replace(/\.(pdf|docx?|xlsx?|xls|png|jpe?g)$/i, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function getPlanSourceAliases(item) {
    const aliases = [
      item.sourceText,
      item.targetBase,
      `${item.type === "outer" ? "外箱标" : "预约信"}-${item.key}`,
    ];

    const bucket = extractAttachmentStringsFromText(item.sourceText || "");
    for (const text of bucket.outer || []) aliases.push(text);
    for (const text of bucket.appointment || []) aliases.push(text);

    return unique(aliases.map(normalizeAttachmentDisplayName));
  }

  function collectAttachmentIdCandidates() {
    const details = deepScanAttachmentDetails();
    const candidates = [];
    const seen = new Set();

    function addCandidate({ type, key, id, ids, text, fileSize, aType, fileName, path, source }) {
      if (!type || !id || !text) return;
      const dedupeKey = `${type}:${normalizeAttachmentDisplayName(text)}:${id}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      candidates.push({
        type,
        key: key || parseShipmentNo(text),
        id,
        ids: ids || [id],
        text,
        normalizedText: normalizeAttachmentDisplayName(text),
        fileSize: fileSize || "",
        aType: aType || "pdf",
        fileName: fileName || "",
        path: path || "",
        source: source || "state",
      });
    }

    for (const hit of details.hits || []) {
      const value = cleanText(hit.value || "");
      const ids = unique(hit.ids || []).filter(Boolean);
      if (!value || !ids.length) continue;

      const context = `${value}\n${JSON.stringify(hit.ancestors || [])}`;
      const fileSize = (context.match(/[?&]fileSize=(\d+)/) || context.match(/"fileSize"\s*:\s*"?(\d+)/) || [])[1] || "";
      const aType = (context.match(/[?&]aType=([a-z0-9]+)/i) || [])[1] || "pdf";
      const fileName = decodeURIComponentSafe((context.match(/[?&]fileName=([^&"\\]+)/) || [])[1] || "");

      const types = [];
      if (/外箱标/.test(value)) types.push("outer");
      if (/预约信/.test(value)) types.push("appointment");
      if (!types.length) continue;

      for (const type of types) {
        addCandidate({
          type,
          key: parseShipmentNo(value),
          id: ids[0],
          ids,
          text: value,
          fileSize,
          aType,
          fileName,
          path: hit.path,
          source: "state",
        });
      }
    }

    return { scanned: details.scanned, candidates };
  }

  function getCurrentLinkId() {
    return (location.pathname.match(/\/l\/([^/?#]+)/) || [])[1] || (window.fileInfo && window.fileInfo.link_id) || "";
  }

  function getCurrentFileId() {
    return (
      (window.fileInfo && (window.fileInfo.id || window.fileInfo.fileid || window.fileInfo.unique_id)) ||
      (window.__WPSENV__ && window.__WPSENV__.root_file_id) ||
      ""
    );
  }

  function extractAttachmentCandidatesFromApiPayload(payload, sourceUrl) {
    const candidates = [];
    const seen = new WeakSet();
    const queue = [{ value: payload, path: "" }];
    let scanned = 0;

    function enqueue(value, path) {
      if (value == null) return;
      const type = typeof value;
      if (type === "string") {
        const text = cleanText(value);
        if (!/(外箱标|预约信|kw:annex|oId=)/.test(text)) return;
        const id = (text.match(/[?&]oId=([A-Z0-9]{10,24})/i) || text.match(/\b[A-Z0-9]{10,24}\b/) || [])[1] || "";
        const fileSize = (text.match(/[?&]fileSize=(\d+)/) || [])[1] || "";
        const aType = (text.match(/[?&]aType=([a-z0-9]+)/i) || [])[1] || "pdf";
        const fileName = decodeURIComponentSafe((text.match(/[?&]fileName=([^&"\\\n]+)/) || [])[1] || "");
        const nameText = fileName || text;
        const typeName = /预约信/.test(nameText) ? "appointment" : /外箱标/.test(nameText) ? "outer" : "";
        if (id && typeName) {
          candidates.push({
            type: typeName,
            key: parseShipmentNo(nameText),
            id,
            ids: [id],
            text: nameText,
            normalizedText: normalizeAttachmentDisplayName(nameText),
            fileSize,
            aType,
            fileName,
            path,
            source: sourceUrl,
          });
        }
        return;
      }
      if (type !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);
      queue.push({ value, path });
    }

    while (queue.length) {
      const { value, path } = queue.shift();
      if (++scanned > 20000) break;

      if (Array.isArray(value)) {
        value.forEach((item, index) => enqueue(item, `${path}[${index}]`));
        continue;
      }

      const objectText = (() => {
        try {
          return JSON.stringify(value);
        } catch (_) {
          return "";
        }
      })();

      const name =
        value.attachment_name ||
        value.attachmentName ||
        value.fileName ||
        value.filename ||
        value.name ||
        value.title ||
        value.text ||
        "";
      const id =
        value.oId ||
        value.oid ||
        value.sub_file_id ||
        value.subFileId ||
        value.attachment_id ||
        value.attachmentId ||
        value.file_id ||
        value.fileId ||
        value.id ||
        "";
      const text = cleanText(name || "");
      const typeName = /预约信/.test(text || objectText) ? "appointment" : /外箱标/.test(text || objectText) ? "outer" : "";
      const idText = String(id || "");
      const idFromText = (objectText.match(/[?&]oId=([A-Z0-9]{10,24})/i) || objectText.match(/\b[A-Z0-9]{10,24}\b/) || [])[1] || "";
      const finalId = /^[A-Z0-9]{10,24}$/i.test(idText) ? idText : idFromText;

      if (finalId && typeName && (text || objectText)) {
        const fileSize = (objectText.match(/[?&]fileSize=(\d+)/) || objectText.match(/"fileSize"\s*:\s*"?(\d+)/) || [])[1] || "";
        const aType = (objectText.match(/[?&]aType=([a-z0-9]+)/i) || [])[1] || "pdf";
        const fileName = decodeURIComponentSafe((objectText.match(/[?&]fileName=([^&"\\]+)/) || [])[1] || "");
        const finalText = text || fileName || objectText.slice(0, 300);
        candidates.push({
          type: typeName,
          key: parseShipmentNo(finalText),
          id: finalId,
          ids: [finalId],
          text: finalText,
          normalizedText: normalizeAttachmentDisplayName(finalText),
          fileSize,
          aType,
          fileName,
          path,
          source: sourceUrl,
        });
      }

      for (const [key, child] of Object.entries(value)) {
        enqueue(child, path ? `${path}.${key}` : key);
      }
    }

    return candidates;
  }

  async function fetchAttachmentApiCandidates() {
    const linkId = getCurrentLinkId();
    const fileId = getCurrentFileId();
    const ids = unique([linkId, fileId]).filter(Boolean);
    const urls = [];

    for (const id of ids) {
      urls.push(
        `/api/v3/office/file/${id}/attachment`,
        `/api/v3/office/file/${id}/attachments`,
        `/api/v3/office/file/${id}/attachment/list`,
        `/api/v3/office/file/${id}/attachment/list?offset=0&limit=200`,
        `/api/v3/office/file/${id}/annex`,
        `/api/v3/office/file/${id}/annex/list`
      );
    }

    urls.push(
      `/api/v3/office/comment/list?fileId=${encodeURIComponent(fileId || linkId)}`,
      `/api/v3/office/comment/list?file_id=${encodeURIComponent(fileId || linkId)}`,
      `/api/v3/office/comment?fileId=${encodeURIComponent(fileId || linkId)}`
    );

    const candidates = [];
    const endpointResults = [];
    for (const url of unique(urls)) {
      try {
        const response = await fetch(url, { credentials: "include" });
        const contentType = response.headers.get("content-type") || "";
        const text = await response.text();
        endpointResults.push({ url, status: response.status, contentType, snippet: text.slice(0, 500) });
        if (!response.ok || !/(json|text)/i.test(contentType)) continue;
        let payload = text;
        try {
          payload = JSON.parse(text);
        } catch (_) {}
        candidates.push(...extractAttachmentCandidatesFromApiPayload(payload, url));
      } catch (error) {
        endpointResults.push({ url, status: "ERROR", contentType: "", snippet: String(error && error.message ? error.message : error) });
      }
    }

    window.WPSBatch.lastAttachmentApiProbe = { endpointResults, candidates };
    return { endpointResults, candidates };
  }

  async function collectAttachmentIdCandidatesAsync() {
    const stateResult = collectAttachmentIdCandidates();
    const apiResult = await fetchAttachmentApiCandidates();
    const probeResult = collectAttachmentCandidatesFromProbe();
    const all = [];
    const seen = new Set();

    for (const candidate of [...stateResult.candidates, ...apiResult.candidates, ...probeResult.candidates]) {
      const key = `${candidate.type}:${candidate.id}:${candidate.normalizedText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(candidate);
    }

    return {
      scanned: stateResult.scanned,
      candidates: all,
      endpointResults: apiResult.endpointResults,
      probeCandidates: probeResult.candidates,
    };
  }

  function candidateFromAnnexText(text, source) {
    const raw = String(text || "");
    const oId = (raw.match(/[?&]oId=([A-Z0-9]{10,24})/i) || [])[1] || "";
    if (!oId) return null;

    const beforeAnnex = cleanText(raw.split("kw:annex")[0] || "");
    const fileName = decodeURIComponentSafe((raw.match(/[?&]fileName=([^&"\\\]\}\n]+)/) || [])[1] || "");
    const fileSize = (raw.match(/[?&]fileSize=(\d+)/) || [])[1] || "";
    const aType = (raw.match(/[?&]aType=([a-z0-9]+)/i) || [])[1] || "pdf";
    const textName = beforeAnnex || fileName || raw.slice(0, 200);
    const type = /预约信/.test(textName) ? "appointment" : /外箱标/.test(textName) ? "outer" : "";
    if (!type) return null;

    return {
      type,
      key: parseShipmentNo(textName),
      id: oId,
      ids: [oId],
      text: textName,
      normalizedText: normalizeAttachmentDisplayName(textName),
      fileSize,
      aType,
      fileName,
      path: source || "probe",
      source: source || "probe",
    };
  }

  function collectAttachmentCandidatesFromProbe() {
    const probe = window.WPSBatch && window.WPSBatch.probe ? window.WPSBatch.probe : {};
    const candidates = [];
    const downloadIds = [];
    const seen = new Set();

    function add(candidate) {
      if (!candidate || !candidate.id) return;
      const key = `${candidate.type || "unknown"}:${candidate.id}:${candidate.normalizedText || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    }

    for (const record of probe.records || []) {
      const url = String(record.url || "");
      const downloadId = (url.match(/\/attachment\/([A-Z0-9]{10,24})\/download/i) || [])[1] || "";
      if (downloadId) downloadIds.push({ id: downloadId, source: `request:${record.id}` });

      add(candidateFromAnnexText(record.body, `request-body:${record.id}`));
      add(candidateFromAnnexText(record.responseSnippet, `request-response:${record.id}`));
    }

    for (const command of probe.commands || []) {
      add(candidateFromAnnexText(command.args, `command:${command.id}`));
    }

    return { candidates, downloadIds };
  }

  async function makeAttachmentMapFromProbe(options = {}) {
    const plan = await buildPlanDirectlyFromPage();
    const probeResult = collectAttachmentCandidatesFromProbe();
    const candidates = probeResult.candidates;
    const usedIds = new Set();
    const attachmentMap = { outer: {}, appointment: {}, _diagnostics: [] };

    window.WPSBatch.lastAutoAttachmentPlan = plan;

    for (let index = 0; index < plan.length; index += 1) {
      const item = plan[index];
      const { candidate, match } = pickAttachmentIdForPlanItem(item, candidates, usedIds);
      let picked = candidate;
      let pickedMatch = match;

      if (!picked && options.allowDownloadOrder && probeResult.downloadIds[index]) {
        picked = {
          type: item.type,
          key: item.key,
          id: probeResult.downloadIds[index].id,
          text: item.sourceText,
          normalizedText: normalizeAttachmentDisplayName(item.sourceText),
          source: probeResult.downloadIds[index].source,
        };
        pickedMatch = "download-order";
      }

      if (!picked) {
        attachmentMap._diagnostics.push({
          type: item.type,
          key: item.key,
          source: item.sourceText,
          target: item.targetBase,
          status: "missing-id",
          match: pickedMatch,
        });
        continue;
      }

      attachmentMap[item.type][item.key] = picked.id;
      attachmentMap._diagnostics.push({
        type: item.type,
        key: item.key,
        source: item.sourceText,
        target: item.targetBase,
        subFileId: picked.id,
        matchedText: picked.text,
        fileSize: picked.fileSize || "",
        aType: picked.aType || "pdf",
        fileName: picked.fileName || "",
        match: pickedMatch,
        status: pickedMatch === "download-order" ? "matched-by-download-order-check-before-run" : "matched",
      });
      usedIds.add(picked.id);
    }

    window.WPSBatch.lastAutoAttachmentMap = attachmentMap;
    window.WPSBatch.lastProbeAttachmentCandidates = candidates;
    window.WPSBatch.lastProbeDownloadIds = probeResult.downloadIds;
    savePersistedState({
      lastAutoAttachmentMap: attachmentMap,
      lastProbeAttachmentCandidates: candidates,
      lastProbeDownloadIds: probeResult.downloadIds,
    });

    console.table(
      attachmentMap._diagnostics.map((item) => ({
        type: item.type === "outer" ? "外箱标" : "预约信",
        key: item.key,
        target: item.target,
        subFileId: item.subFileId || "",
        match: item.match,
        status: item.status,
        matchedText: item.matchedText || "",
      }))
    );

    const missing = attachmentMap._diagnostics.filter((item) => item.status === "missing-id");
    log(`probe 附件 ID 配对：候选 ${candidates.length} 个，下载 ID ${probeResult.downloadIds.length} 个，缺失 ${missing.length} 个。`);
    if (missing.length && !options.allowDownloadOrder && probeResult.downloadIds.length) {
      warn("probe 里有下载 ID，但没有名称。若你是按表格计划顺序下载的，可运行：await WPSBatch.makeAttachmentMapFromProbe({allowDownloadOrder:true})");
    }

    return attachmentMap;
  }

  function loadPersistedAttachmentMap() {
    const state = loadPersistedState();
    const map = state.lastAutoAttachmentMap || null;
    if (map) {
      window.WPSBatch.lastAutoAttachmentMap = map;
      window.WPSBatch.lastProbeAttachmentCandidates = state.lastProbeAttachmentCandidates || [];
      window.WPSBatch.lastProbeDownloadIds = state.lastProbeDownloadIds || [];
      log("已从 localStorage 恢复附件 ID 映射。");
    } else {
      warn("localStorage 中没有已保存的附件 ID 映射。");
    }
    return map;
  }

  function pickAttachmentIdForPlanItem(item, candidates, usedIds) {
    const aliases = getPlanSourceAliases(item);

    const exact = candidates.find(
      (candidate) =>
        candidate.type === item.type &&
        !usedIds.has(candidate.id) &&
        aliases.some((alias) => alias && (candidate.normalizedText.includes(alias) || alias.includes(candidate.normalizedText)))
    );
    if (exact) return { candidate: exact, match: "source-text" };

    const keyed = candidates.filter((candidate) => candidate.type === item.type && candidate.key === item.key && !usedIds.has(candidate.id));
    if (keyed.length === 1) return { candidate: keyed[0], match: "type-key" };

    const sameTypePlan = (window.WPSBatch.lastAutoAttachmentPlan || []).filter((planItem) => planItem.type === item.type);
    const ordinal = sameTypePlan.findIndex((planItem) => planItem === item);
    const byType = candidates.filter((candidate) => candidate.type === item.type);
    if (ordinal >= 0 && byType[ordinal] && !usedIds.has(byType[ordinal].id)) {
      return { candidate: byType[ordinal], match: "type-order" };
    }

    return { candidate: null, match: "missing" };
  }

  function decodeURIComponentSafe(value) {
    if (!value) return "";
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function scanObjectForAttachmentMeta(root, maxDepth = 6) {
    const seen = new WeakSet();
    const queue = [{ value: root, depth: 0, path: "" }];
    const strings = [];
    let scanned = 0;

    function enqueue(value, depth, path) {
      if (value == null) return;
      const type = typeof value;
      if (type === "string") {
        if (/(kw:annex|外箱标|预约信|fileName|fileSize|oId=)/.test(value)) strings.push(value);
        return;
      }
      if (type !== "object" && type !== "function") return;
      if (seen.has(value)) return;
      if (value instanceof Node || value === window || value === document) return;
      if (depth > maxDepth) return;
      seen.add(value);
      queue.push({ value, depth, path });
    }

    while (queue.length) {
      const current = queue.shift();
      const { value, depth, path } = current;
      if (++scanned > 12000) break;

      if (Array.isArray(value)) {
        value.slice(0, 500).forEach((item, index) => enqueue(item, depth + 1, `${path}[${index}]`));
        continue;
      }

      if (value instanceof Map) {
        let index = 0;
        for (const [mapKey, mapValue] of value.entries()) {
          enqueue(mapKey, depth + 1, `${path}.mapKey${index}`);
          enqueue(mapValue, depth + 1, `${path}.mapValue${index}`);
          if (++index > 500) break;
        }
        continue;
      }

      if (value instanceof Set) {
        let index = 0;
        for (const setValue of value.values()) {
          enqueue(setValue, depth + 1, `${path}.set${index}`);
          if (++index > 500) break;
        }
        continue;
      }

      let descriptors = {};
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch (_) {
        continue;
      }

      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!("value" in descriptor)) continue;
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        const childPath = path ? `${path}.${key}` : key;
        enqueue(descriptor.value, depth + 1, childPath);
      }

      const proto = Object.getPrototypeOf(value);
      if (proto && proto !== Object.prototype && proto !== Function.prototype) {
        enqueue(proto, depth + 1, path ? `${path}.__proto__` : "__proto__");
      }
    }

    const context = strings.join("\n");
    const id =
      (context.match(/[?&]oId=([A-Z0-9]{10,24})/i) || context.match(/\b[A-Z0-9]{10,24}\b/) || [])[1] || "";
    const fileSize = (context.match(/[?&]fileSize=(\d+)/) || context.match(/"fileSize"\s*:\s*"?(\d+)/) || [])[1] || "";
    const aType = (context.match(/[?&]aType=([a-z0-9]+)/i) || [])[1] || "pdf";
    const fileName = decodeURIComponentSafe((context.match(/[?&]fileName=([^&"\\\n]+)/) || [])[1] || "");

    return {
      id,
      fileSize,
      aType,
      fileName,
      text: cleanText(strings.find((item) => /(外箱标|预约信)/.test(item)) || fileName || ""),
      scanned,
      stringCount: strings.length,
      contextSample: context.slice(0, 1000),
    };
  }

  // ===== Exact-cell link run extraction (no plan matching) =====

  function extractAttachmentMetaFromExactCellLinkRuns(rawValue, cellText, source) {
    if (!rawValue) return null;

    // Collect all strings from the raw value (same traversal as scanLinkRunValueForAttachmentMeta)
    var seen = new WeakSet();
    var queue = [{ value: rawValue, depth: 0 }];
    var strings = [];
    var scanned = 0;

    function addString(value) {
      var text = String(value || "");
      if (/(kw:annex|外箱标|预约信|fileName|fileSize|oId=|address|subFileId)/i.test(text)) strings.push(text);
    }

    function enqueue(value, depth) {
      if (value == null || depth > 7) return;
      var type = typeof value;
      if (type === "string" || type === "number") { addString(value); return; }
      if (type !== "object" && type !== "function") return;
      if (value instanceof Node || value === window || value === document) return;
      if (seen.has(value)) return;
      seen.add(value);
      queue.push({ value: value, depth: depth });
    }

    while (queue.length && scanned < 6000) {
      var item = queue.shift();
      var val = item.value;
      var depth = item.depth;
      scanned += 1;

      if (Array.isArray(val)) {
        for (var ai = 0; ai < Math.min(val.length, 300); ai++) enqueue(val[ai], depth + 1);
        continue;
      }
      if (val instanceof Map) {
        var mi = 0;
        val.forEach(function (mv, mk) { if (mi++ < 300) { enqueue(mk, depth + 1); enqueue(mv, depth + 1); } });
        continue;
      }
      if (val instanceof Set) {
        var si = 0;
        val.forEach(function (sv) { if (si++ < 300) enqueue(sv, depth + 1); });
        continue;
      }

      var desc = {};
      try { desc = Object.getOwnPropertyDescriptors(val); } catch (_) { desc = {}; }
      for (var key in desc) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        if ("value" in desc[key]) {
          enqueue(desc[key].value, depth + 1);
        }
      }
      // Also try for-in for inherited properties
      try {
        for (var fk in val) {
          if (!(fk in desc) && fk !== "__proto__" && fk !== "constructor") {
            enqueue(val[fk], depth + 1);
          }
        }
      } catch (_) {}
    }

    var context = strings.join("\n");

    // Extract ID — prefer oId= from kw:annex URLs, then subFileId, then generic 10-32 char ID
    var id = (context.match(/[?&]oId=([A-Z0-9]{10,24})/i) || [])[1] ||
             (context.match(/"subFileId"\s*:\s*"([A-Z0-9]{10,24})"/i) || [])[1] ||
             (context.match(/"subFileId"\s*:\s*([A-Z0-9]{10,24})/i) || [])[1] ||
             "";

    // Fall back to scanObjectForAttachmentMeta for object-level ID
    if (!id) {
      try {
        var objMeta = scanObjectForAttachmentMeta(rawValue, 10);
        if (objMeta && objMeta.id) id = objMeta.id;
      } catch (_) {}
    }

    // If we STILL don't have an ID, also try a generic 10-32 char pattern BUT only if it looks like a WPS ID (starts with letter, mixed case)
    if (!id) {
      var genericMatch = context.match(/\b([A-Z][A-Z0-9]{9,31})\b/);
      if (genericMatch && !/^(true|false|null|undefined|NaN|Infinity)$/i.test(genericMatch[1])) {
        id = genericMatch[1];
      }
    }

    if (!id) return null;

    // Extract metadata
    var fileSize = (context.match(/[?&]fileSize=(\d+)/) || context.match(/"fileSize"\s*:\s*"?(\d+)/) || [])[1] || "";
    var aType = (context.match(/[?&]aType=([a-z0-9]+)/i) || [])[1] || "pdf";
    var fileName = decodeURIComponentSafe((context.match(/[?&]fileName=([^&"\\\n]+)/) || [])[1] || "");
    var text = cleanText(strings.find(function (s) { return /(外箱标|预约信)/.test(s); }) || "");

    // displayName: prefer cellText stripped of 📄, then fileName stripped of extension
    var displayName = "";
    if (cellText) {
      displayName = cellText.replace(/^📄/, "").trim();
    }
    if (!displayName && fileName) {
      displayName = fileName.replace(/\.(pdf|docx?|xlsx?|png|jpe?g)$/i, "");
    }

    return {
      subFileId: id,
      id: id,
      fileSize: fileSize,
      aType: aType,
      fileName: fileName || (displayName ? displayName + ".pdf" : ""),
      text: text || cellText || "",
      displayName: displayName,
      source: source,
    };
  }

  function scanLinkRunValueForAttachmentMeta(root, item, matchName) {
    const seen = new WeakSet();
    const queue = [{ value: root, depth: 0, path: "" }];
    const strings = [];
    let scanned = 0;

    function addString(value) {
      const text = String(value || "");
      if (/(kw:annex|外箱标|预约信|fileName|fileSize|oId=|address|subFileId)/i.test(text)) strings.push(text);
    }

    function enqueue(value, depth, path) {
      if (value == null || depth > 7) return;
      const type = typeof value;
      if (type === "string" || type === "number") {
        addString(value);
        return;
      }
      if (type !== "object" && type !== "function") return;
      if (value instanceof Node || value === window || value === document) return;
      if (seen.has(value)) return;
      seen.add(value);
      queue.push({ value, depth, path });
    }

    while (queue.length && scanned < 6000) {
      const { value, depth, path } = queue.shift();
      scanned += 1;

      if (Array.isArray(value)) {
        value.slice(0, 300).forEach((entry, index) => enqueue(entry, depth + 1, `${path}[${index}]`));
        continue;
      }

      if (value instanceof Map) {
        let index = 0;
        for (const [key, mapValue] of value.entries()) {
          enqueue(key, depth + 1, `${path}.mapKey${index}`);
          enqueue(mapValue, depth + 1, `${path}.mapValue${index}`);
          if (++index > 300) break;
        }
        continue;
      }

      if (value instanceof Set) {
        let index = 0;
        for (const setValue of value.values()) {
          enqueue(setValue, depth + 1, `${path}.set${index}`);
          if (++index > 300) break;
        }
        continue;
      }

      let descriptors = {};
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch (_) {
        descriptors = {};
      }

      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        const childPath = path ? `${path}.${key}` : key;
        if ("value" in descriptor) {
          enqueue(descriptor.value, depth + 1, childPath);
          if (
            typeof descriptor.value === "function" &&
            descriptor.value.length === 0 &&
            /^(getData|getAddress|getSubAddress|getLinkRuns|getTextLinkRuns|getLinkRunsType|getFileName|getFileSize|getText|getValue|toJSON)$/i.test(key)
          ) {
            try {
              enqueue(descriptor.value.call(value), depth + 1, `${childPath}()`);
            } catch (_) {}
          }
        } else if (typeof descriptor.get === "function" && /address|link|annex|attach|file|text|data|id/i.test(key)) {
          try {
            enqueue(descriptor.get.call(value), depth + 1, `${childPath}[get]`);
          } catch (_) {}
        }
      }
    }

    const context = strings.join("\n");
    const scan = {
      id: (context.match(/[?&]oId=([A-Z0-9]{10,24})/i) || context.match(/"subFileId"\s*:\s*"([A-Z0-9]{10,24})"/i) || context.match(/\b[A-Z0-9]{10,24}\b/) || [])[1] || "",
      fileSize: (context.match(/[?&]fileSize=(\d+)/) || context.match(/"fileSize"\s*:\s*"?(\d+)/) || [])[1] || "",
      aType: (context.match(/[?&]aType=([a-z0-9]+)/i) || [])[1] || "pdf",
      fileName: decodeURIComponentSafe((context.match(/[?&]fileName=([^&"\\\n]+)/) || [])[1] || ""),
      text: cleanText(strings.find((entry) => /(外箱标|预约信)/.test(entry)) || ""),
      scanned,
      stringCount: strings.length,
      contextSample: context.slice(0, 1200),
    };

    return metaFromSelectedScan(scan, item, matchName);
  }

  async function downloadByUrl(url, filename) {
    const absoluteUrl = new URL(url, location.href).href;
    const response = await fetch(absoluteUrl, {
      credentials: "include",
      mode: "cors",
    });
    if (!response.ok) {
      throw new Error(`下载失败 HTTP ${response.status}: ${absoluteUrl}`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = ensureExt(filename, absoluteUrl);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      a.remove();
    }, 2000);
  }

  async function downloadPlan(plan, candidates) {
    const results = [];

    for (const item of plan) {
      const candidate = matchCandidate(item, candidates);
      if (!candidate) {
        results.push({ ...item, status: "no-dom-candidate" });
        continue;
      }

      if (!candidate.href || candidate.href.startsWith("javascript:")) {
        results.push({
          ...item,
          status: "candidate-has-no-direct-url",
          candidateText: candidate.text,
          candidateBox: `${candidate.x},${candidate.y},${candidate.w},${candidate.h}`,
        });
        continue;
      }

      try {
        await downloadByUrl(candidate.href, item.targetBase);
        results.push({ ...item, status: "downloaded", url: candidate.href });
        log("已触发下载：", item.targetBase, candidate.href);
        await sleep(CONFIG.downloadDelayMs);
      } catch (error) {
        results.push({ ...item, status: "download-error", error: error.message, url: candidate.href });
        warn("下载失败：", item.targetBase, error);
      }
    }

    return results;
  }

  function printPlan(plan) {
    const rows = plan.map((item) => ({
      row: item.row,
      type: item.type === "outer" ? "外箱标" : "预约信",
      source: item.sourceText,
      target: item.targetBase + CONFIG.defaultExt,
    }));
    console.table(rows);
  }

  function printCandidates(candidates) {
    console.table(
      candidates.slice(0, 80).map((candidate, index) => ({
        index,
        text: candidate.text.slice(0, 120),
        href: candidate.href ? candidate.href.slice(0, 160) : "",
        box: `${candidate.x},${candidate.y},${candidate.w},${candidate.h}`,
      }))
    );
  }

  function makeReportText(payload) {
    const { plan = [], candidates = [], results = [], error = null } = payload || {};
    const lines = [];
    lines.push("=== WPSBatch Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push("");

    if (error) {
      lines.push("ERROR:");
      lines.push(String(error && error.stack ? error.stack : error));
      lines.push("");
    }

    lines.push(`PLAN_COUNT: ${plan.length}`);
    for (const item of plan) {
      lines.push(
        [
          "PLAN",
          `row=${item.row || ""}`,
          `type=${item.type}`,
          `key=${item.key || ""}`,
          `source=${item.sourceText || ""}`,
          `target=${item.targetBase || ""}${CONFIG.defaultExt}`,
        ].join("\t")
      );
    }
    lines.push("");

    lines.push(`CANDIDATE_COUNT: ${candidates.length}`);
    candidates.slice(0, 120).forEach((candidate, index) => {
      lines.push(
        [
          "CANDIDATE",
          `index=${index}`,
          `text=${(candidate.text || "").slice(0, 220)}`,
          `href=${(candidate.href || "").slice(0, 300)}`,
          `box=${candidate.x},${candidate.y},${candidate.w},${candidate.h}`,
        ].join("\t")
      );
    });
    lines.push("");

    lines.push(`RESULT_COUNT: ${results.length}`);
    for (const item of results) {
      lines.push(
        [
          "RESULT",
          `row=${item.row || ""}`,
          `type=${item.type}`,
          `key=${item.key || ""}`,
          `target=${item.targetBase || ""}${CONFIG.defaultExt}`,
          `status=${item.status || ""}`,
          `url=${item.url || ""}`,
          `note=${item.error || item.candidateText || item.candidateBox || ""}`,
        ].join("\t")
      );
    }
    lines.push("");
    lines.push("=== End WPSBatch Report ===");
    return lines.join("\n");
  }

  async function publishReport(payload) {
    const text = makeReportText(payload);
    window.WPSBatch.lastReportText = text;
    window.WPSBatch.lastReport = payload;

    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("诊断报告已复制到剪贴板。你可以直接粘贴给我。");
    } catch (error) {
      warn("自动复制到剪贴板失败。请运行 WPSBatch.copyReport()，或手动复制 WPSBatch.lastReportText。", error.message);
    }

    return text;
  }

  function makeProbeReportText() {
    const probe = window.WPSBatch && window.WPSBatch.probe ? window.WPSBatch.probe : {};
    const lines = [];
    lines.push("=== WPSBatch Probe Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push("");

    lines.push(`REQUEST_COUNT: ${(probe.records || []).length}`);
    for (const record of probe.records || []) {
      lines.push(
        [
          "REQUEST",
          `id=${record.id}`,
          `kind=${record.kind}`,
          `method=${record.method || ""}`,
          `url=${record.url || ""}`,
          `status=${record.status || ""}`,
          `contentType=${record.contentType || ""}`,
          `disposition=${record.disposition || ""}`,
          `body=${record.body || ""}`,
          `responseSnippet=${record.responseSnippet || ""}`,
        ].join("\t")
      );
    }
    lines.push("");

    lines.push(`OPEN_COUNT: ${(probe.opens || []).length}`);
    for (const item of probe.opens || []) {
      lines.push(["OPEN", `url=${item.url || ""}`, `target=${item.target || ""}`].join("\t"));
    }
    lines.push("");

    lines.push(`COMMAND_COUNT: ${(probe.commands || []).length}`);
    for (const item of probe.commands || []) {
      lines.push(
        [
          "COMMAND",
          `id=${item.id}`,
          `object=${item.object || ""}`,
          `method=${item.method || ""}`,
          `args=${item.args || ""}`,
          `result=${item.result || ""}`,
          `error=${item.error || ""}`,
        ].join("\t")
      );
    }
    lines.push("");

    const stateDetails = deepScanStateDetails();
    lines.push(`STATE_SCAN_NODES: ${stateDetails.scanned}`);
    lines.push(`STATE_HIT_COUNT: ${stateDetails.hits.length}`);
    stateDetails.hits.slice(0, 80).forEach((hit, index) => {
      lines.push(
        [
          "STATE_HIT",
          `index=${index}`,
          `path=${hit.path}`,
          `value=${hit.value}`,
          `parentPath=${hit.parentPath}`,
          `parentSummary=${JSON.stringify(hit.parentSummary).slice(0, 1200)}`,
        ].join("\t")
      );
    });
    lines.push("");
    lines.push("=== End WPSBatch Probe Report ===");
    return lines.join("\n");
  }

  function makeAttachmentStateReportText() {
    const details = deepScanAttachmentDetails();
    const lines = [];
    lines.push("=== WPSBatch Attachment State Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`SCAN_NODES: ${details.scanned}`);
    lines.push(`HIT_COUNT: ${details.hits.length}`);
    lines.push("");

    details.hits.forEach((hit, index) => {
      lines.push(
        [
          "ATTACHMENT_HIT",
          `index=${index}`,
          `path=${hit.path}`,
          `value=${hit.value}`,
          `ids=${hit.ids.join(",")}`,
        ].join("\t")
      );
      hit.ancestors.forEach((ancestor, ancestorIndex) => {
        lines.push(
          [
            "ANCESTOR",
            `hit=${index}`,
            `level=${ancestorIndex}`,
            `path=${ancestor.path}`,
            `summary=${JSON.stringify(ancestor.summary).slice(0, 5000)}`,
          ].join("\t")
        );
      });
    });

    lines.push("");
    lines.push("=== End WPSBatch Attachment State Report ===");
    return lines.join("\n");
  }

  async function reportAttachmentState() {
    const text = makeAttachmentStateReportText();
    window.WPSBatch.lastAttachmentStateReportText = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("附件状态报告已复制到剪贴板。");
    } catch (error) {
      warn("附件状态报告自动复制失败，请手动复制 WPSBatch.lastAttachmentStateReportText。", error.message);
    }
    return text;
  }

  async function resolveAttachmentDownloadUrl(subFileId) {
    const linkId = (location.pathname.match(/\/l\/([^/?#]+)/) || [])[1] || (window.fileInfo && window.fileInfo.link_id);
    if (!linkId) throw new Error("无法识别当前 WPS 链接 ID。");
    const response = await fetch(`/api/v3/office/file/${linkId}/attachment/${subFileId}/download`, {
      credentials: "include",
    });
    if (!response.ok) throw new Error(`附件下载接口失败：${response.status} ${subFileId}`);
    const data = await response.json();
    if (!data.download_url) throw new Error(`附件接口没有返回 download_url：${subFileId}`);
    return data;
  }

  async function downloadAttachmentById(subFileId, filename) {
    const info = await resolveAttachmentDownloadUrl(subFileId);
    await downloadByUrl(info.download_url, filename);
    return info;
  }

  async function downloadByIdMap(idMap) {
    const plan = await buildPlanDirectlyFromPage();
    const results = [];
    for (const item of plan) {
      const id =
        idMap[item.sourceText] ||
        idMap[item.targetBase] ||
        idMap[`${item.type}:${item.key}`] ||
        (idMap[item.type] && idMap[item.type][item.key]);
      if (!id) {
        results.push({ ...item, status: "missing-id" });
        continue;
      }
      try {
        const info = await downloadAttachmentById(id, item.targetBase);
        results.push({ ...item, status: "downloaded", subFileId: id, downloadUrl: info.download_url });
        log("已触发下载：", item.targetBase, id);
        await sleep(CONFIG.downloadDelayMs);
      } catch (error) {
        results.push({ ...item, status: "download-error", subFileId: id, error: error.message });
        warn("下载失败：", item.targetBase, id, error);
      }
    }
    console.table(results.map((item) => ({
      type: item.type,
      key: item.key,
      target: item.targetBase + CONFIG.defaultExt,
      subFileId: item.subFileId || "",
      status: item.status,
      error: item.error || "",
    })));
    return results;
  }

  async function makeDesiredNameMap() {
    const plan = await buildPlanDirectlyFromPage();
    const map = { outer: {}, appointment: {}, flat: {} };

    for (const item of plan) {
      const filename = item.targetBase + CONFIG.defaultExt;
      map[item.type][item.key] = filename;
      map.flat[`${item.type}:${item.key}`] = filename;
      map.flat[item.sourceText] = filename;
      map.flat[item.targetBase] = filename;
    }

    console.table(
      plan.map((item) => ({
        type: item.type === "outer" ? "外箱标" : "预约信",
        key: item.key,
        source: item.sourceText,
        downloadName: item.targetBase + CONFIG.defaultExt,
        tableName: item.targetBase,
      }))
    );

    return map;
  }

  async function downloadByAttachmentMap(attachmentMap) {
    const normalized = {};
    for (const [type, byKey] of Object.entries(attachmentMap || {})) {
      if (type !== "outer" && type !== "appointment") continue;
      normalized[type] = {};
      for (const [key, value] of Object.entries(byKey || {})) {
        normalized[type][key] = typeof value === "string" ? value : value && value.id;
      }
    }
    return downloadByIdMap(normalized);
  }

  async function renameAttachmentById(subFileId, attachmentName) {
    const linkId = (location.pathname.match(/\/l\/([^/?#]+)/) || [])[1] || (window.fileInfo && window.fileInfo.link_id);
    if (!linkId) throw new Error("无法识别当前 WPS 链接 ID。");

    const cleanName = sanitizeFilename(attachmentName).replace(/\.pdf$/i, "");
    const response = await fetch(`/api/v3/office/file/${linkId}/attachment/${subFileId}/name`, {
      method: "PUT",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ attachment_name: cleanName }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`重命名失败 HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    return text ? JSON.parse(text) : { result: "ok" };
  }

  function normalizeAttachmentMap(attachmentMap) {
    const normalized = { outer: {}, appointment: {}, flat: {} };

    for (const [type, byKey] of Object.entries(attachmentMap || {})) {
      if (type === "outer" || type === "appointment") {
        for (const [key, value] of Object.entries(byKey || {})) {
          normalized[type][key] = typeof value === "string" ? value : value && value.id;
          normalized.flat[`${type}:${key}`] = normalized[type][key];
        }
      } else {
        normalized.flat[type] = typeof byKey === "string" ? byKey : byKey && byKey.id;
      }
    }

    return normalized;
  }

  async function renameByAttachmentMap(attachmentMap) {
    const plan = await buildPlanDirectlyFromPage();
    const normalized = normalizeAttachmentMap(attachmentMap);
    const results = [];

    for (const item of plan) {
      const id =
        normalized[item.type][item.key] ||
        normalized.flat[`${item.type}:${item.key}`] ||
        normalized.flat[item.sourceText] ||
        normalized.flat[item.targetBase];

      if (!id) {
        results.push({ ...item, status: "missing-id" });
        continue;
      }

      try {
        const response = await renameAttachmentById(id, item.targetBase);
        results.push({ ...item, status: "renamed", subFileId: id, response });
        log("已重命名表格附件：", id, "=>", item.targetBase);
        await sleep(CONFIG.downloadDelayMs);
      } catch (error) {
        results.push({ ...item, status: "rename-error", subFileId: id, error: error.message });
        warn("重命名失败：", id, item.targetBase, error);
      }
    }

    console.table(
      results.map((item) => ({
        type: item.type === "outer" ? "外箱标" : "预约信",
        key: item.key,
        targetName: item.targetBase,
        subFileId: item.subFileId || "",
        status: item.status,
        error: item.error || "",
      }))
    );

    return results;
  }

  function getSheetCommandMeta() {
    const sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
    const session = window.APP && window.APP.session;
    return {
      sheetStId: callStringMethod(sheet, ["getStId"]) || 1,
      sheetIdx: Number(callStringMethod(sheet, ["getIndex"]) || 0),
      sheetName: callStringMethod(sheet, ["getName"]) || "Sheet1",
      userId: window.APP && window.APP.getUserid ? String(window.APP.getUserid() || "") : "",
      connId: session && session.getConnId ? String(session.getConnId() || "") : "",
      refStyle: window.APP && window.APP.getRefStyle ? String(window.APP.getRefStyle() || "A1") : "A1",
    };
  }

  function findAttachmentMetaForItem(item, attachmentMap, id) {
    const diagnostic = (attachmentMap && attachmentMap._diagnostics || []).find(
      (entry) => entry.type === item.type && entry.key === item.key && (!id || entry.subFileId === id)
    );
    if (diagnostic) return diagnostic;

    const candidates = window.WPSBatch.lastAutoAttachmentCandidates && window.WPSBatch.lastAutoAttachmentCandidates.length
      ? window.WPSBatch.lastAutoAttachmentCandidates
      : collectAttachmentIdCandidates().candidates;
    return candidates.find((candidate) => candidate.id === id) || {};
  }

  function clonePlain(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function getCellObjectAt(rowIndex, colIndex) {
    const attempts = [
      () => window.APP && window.APP.getCell && window.APP.getCell(rowIndex, colIndex),
      () => {
        const sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
        return sheet && sheet.sheetData && sheet.sheetData.getCell(rowIndex, colIndex);
      },
      () => {
        const sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
        return sheet && sheet.getSheet && sheet.getSheet().getCell(rowIndex, colIndex);
      },
    ];

    for (const attempt of attempts) {
      try {
        const cell = attempt();
        if (cell) return cell;
      } catch (_) {}
    }
    return null;
  }

  function createWpsRange(rowFrom, rowTo, colFrom, colTo) {
    const sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
    const tool = window.APP && window.APP.getUilCmdTool && window.APP.getUilCmdTool();
    const attempts = [
      () => sheet && sheet.createRANGE && sheet.createRANGE(rowFrom, rowTo, colFrom, colTo),
      () => tool && tool.createRANGE && tool.createRANGE(sheet, rowFrom, rowTo, colFrom, colTo),
      () => sheet && sheet.createRange && sheet.createRange(sheet.createRANGE(rowFrom, rowTo, colFrom, colTo)),
    ];

    for (const attempt of attempts) {
      try {
        const range = attempt();
        if (range) return range;
      } catch (_) {}
    }
    return null;
  }

  async function queryRangeValuesViaUil(range, options = {}) {
    const tool = window.APP && window.APP.getUilCmdTool && window.APP.getUilCmdTool();
    if (!tool || typeof tool.queryRangeValues !== "function" || !range) return null;

    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        const result = tool.queryRangeValues(range, options, done);
        if (result && typeof result.then === "function") result.then(done).catch((error) => done({ error: error.message || String(error) }));
        else if (result !== undefined) done(result);
      } catch (error) {
        done({ error: error.message || String(error) });
      }

      setTimeout(() => done(null), 3000);
    });
  }

  function metaFromScanResult(scan, item, matchName) {
    if (!scan || !scan.id) return null;
    return {
      type: item.type,
      key: item.key,
      id: scan.id,
      subFileId: scan.id,
      fileSize: scan.fileSize,
      aType: scan.aType,
      fileName: scan.fileName,
      text: scan.text || item.sourceText,
      matchedText: scan.text || item.sourceText,
      match: matchName,
      status: "matched",
    };
  }

  async function getAttachmentMetaFromRangeQuery(item) {
    const rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
    const colIndex = Number.isFinite(item.colIndex) ? item.colIndex : item.type === "outer" ? 2 : 6;
    const range = createWpsRange(rowIndex, rowIndex, colIndex, colIndex);
    if (!range) return null;

    const optionVariants = [
      {},
      { includeTextLinkRuns: true, includeRuns: true },
      { needTextLinkRuns: true, needRuns: true },
      { withTextLinkRuns: true, withRuns: true },
      { ignoreFrozenArea: true, includeTextLinkRuns: true, includeRuns: true },
    ];

    for (const options of optionVariants) {
      const value = await queryRangeValuesViaUil(range, options);
      const scan = scanObjectForAttachmentMeta(value, 8);
      const meta = metaFromScanResult(scan, item, "range-query");
      if (meta) {
        meta.queryOptions = options;
        return meta;
      }
    }

    return null;
  }

  function getActiveSheetViewLoose() {
    const app = window.APP;
    const attempts = [
      () => app && app.getActiveSheetView && app.getActiveSheetView(),
      () => app && app.getActiveView && app.getActiveView(),
      () => app && app.workbook && app.workbook.getActiveView && app.workbook.getActiveView(),
      () => app && app.workbook && app.workbook._etwindow && app.workbook._etwindow.getActiveView && app.workbook._etwindow.getActiveView(),
      () => app && app.workbook && app.workbook._etwindow && app.workbook._etwindow.getActiveMainView && app.workbook._etwindow.getActiveMainView(),
    ];

    for (const attempt of attempts) {
      try {
        const value = attempt();
        if (value) return value;
      } catch (_) {}
    }
    return null;
  }

  function getActiveSheetRelatedObjects() {
    const app = window.APP;
    const sheet = app && app.getActiveSheet && app.getActiveSheet();
    const objects = [
      { name: "activeSheet", value: sheet },
      { name: "activeSheet.getSheet()", value: null },
      { name: "activeSheet.sheetData", value: sheet && sheet.sheetData },
      { name: "activeSheet.getWorksheetView()", value: null },
      { name: "activeView", value: getActiveSheetViewLoose() },
      { name: "workbook.bookData", value: app && app.workbook && app.workbook.bookData },
    ];

    try {
      objects[1].value = sheet && sheet.getSheet && sheet.getSheet();
    } catch (_) {}
    try {
      objects[3].value = sheet && sheet.getWorksheetView && sheet.getWorksheetView();
    } catch (_) {}

    return objects.filter((item) => item.value);
  }

  function findHyperlinkProvider() {
    const methodNames = [
      "getHyperlink",
      "getHyperLink",
      "getCellHyperlink",
      "getCellHyperLink",
      "getTextLink",
      "getCellTextLink",
      "getTextLinkRuns",
      "getHyperlinks",
      "getHyperLinks",
    ];

    for (const objectInfo of getActiveSheetRelatedObjects()) {
      for (const methodName of methodNames) {
        const fn = objectInfo.value && objectInfo.value[methodName];
        if (typeof fn === "function") {
          return { objectName: objectInfo.name, object: objectInfo.value, methodName, fn };
        }
      }
    }
    return null;
  }

  function withActiveSheetHyperlinkShim(callback) {
    const holder = window.APP && window.APP.getActiveSheet;
    if (!holder || typeof holder !== "function") return callback(null);

    const hadOwn = Object.prototype.hasOwnProperty.call(holder, "getHyperlink");
    const previous = holder.getHyperlink;
    const provider = typeof previous === "function" ? null : findHyperlinkProvider();

    if (provider) {
      holder.getHyperlink = function shimmedGetActiveSheetHyperlink() {
        return provider.fn.apply(provider.object, arguments);
      };
    }

    try {
      return callback(provider);
    } finally {
      if (provider) {
        if (hadOwn) holder.getHyperlink = previous;
        else {
          try {
            delete holder.getHyperlink;
          } catch (_) {
            holder.getHyperlink = previous;
          }
        }
      }
    }
  }

  function collectHyperlinkMethodSurface() {
    const rows = [];
    const methodPattern = /hyper|link|annex|attach|mention/i;
    for (const objectInfo of [
      { name: "APP", value: window.APP },
      { name: "tool", value: window.APP && window.APP.getUilCmdTool && window.APP.getUilCmdTool() },
      ...getActiveSheetRelatedObjects(),
    ]) {
      const methods = listObjectMethods(objectInfo.value)
        .filter((item) => methodPattern.test(item.name) || methodPattern.test(item.preview || ""))
        .slice(0, 80);
      rows.push({ object: objectInfo.name, methods });
    }
    return rows;
  }

  function makeHyperlinkMethodSurfaceReportText() {
    const rows = collectHyperlinkMethodSurface();
    const lines = [];
    lines.push("=== WPSBatch Hyperlink Method Surface Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`objectCount: ${rows.length}`);
    lines.push("");

    rows.forEach((row, objectIndex) => {
      lines.push(["OBJECT", `index=${objectIndex}`, `name=${row.object}`, `methodCount=${row.methods.length}`].join("\t"));
      row.methods.forEach((method, methodIndex) => {
        lines.push(
          [
            "METHOD",
            `object=${objectIndex}`,
            `index=${methodIndex}`,
            `level=${method.level}`,
            `name=${method.name}`,
            `argc=${method.length}`,
            `preview=${method.preview}`,
          ].join("\t")
        );
      });
      lines.push("");
    });

    lines.push("=== End WPSBatch Hyperlink Method Surface Report ===");
    window.WPSBatch.lastHyperlinkMethodSurface = rows;
    window.WPSBatch.lastHyperlinkMethodSurfaceReportText = lines.join("\n");
    return window.WPSBatch.lastHyperlinkMethodSurfaceReportText;
  }

  async function reportHyperlinkMethodSurface() {
    const text = makeHyperlinkMethodSurfaceReportText();
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("Hyperlink 方法报告已复制到剪贴板。");
    } catch (_) {}
    return text;
  }

  async function copyHyperlinkMethodSurfaceReport() {
    const text = window.WPSBatch.lastHyperlinkMethodSurfaceReportText || makeHyperlinkMethodSurfaceReportText();
    await navigator.clipboard.writeText(text);
    log("Hyperlink 方法报告已复制到剪贴板。");
    return text;
  }

  async function getAttachmentMetaFromHyperlinkProviders(item) {
    const rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
    const colIndex = Number.isFinite(item.colIndex) ? item.colIndex : item.type === "outer" ? 2 : 6;
    const cell = getCellObjectAt(rowIndex, colIndex);
    const sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
    const directCalls = [
      {
        label: "activeSheet.getTextLinkRuns(row,col)",
        call: () => sheet && sheet.getTextLinkRuns && sheet.getTextLinkRuns(rowIndex, colIndex),
      },
      {
        label: "activeSheet.getTextLinkRunsByCell(row,col,cell)",
        call: () => sheet && sheet.getTextLinkRunsByCell && sheet.getTextLinkRunsByCell(rowIndex, colIndex, cell),
      },
      {
        label: "activeSheet.getHyperlink(row,col)",
        call: () => sheet && sheet.getHyperlink && sheet.getHyperlink(rowIndex, colIndex),
      },
      {
        label: "activeSheet.getCoreHyperlinks().getCellLinkRuns(row,col)",
        call: () => {
          const core = sheet && sheet.getCoreHyperlinks && sheet.getCoreHyperlinks();
          return core && core.getCellLinkRuns && core.getCellLinkRuns(rowIndex, colIndex);
        },
      },
      {
        label: "activeSheet.getCoreHyperlinks().getHyperlink(row,col)",
        call: () => {
          const core = sheet && sheet.getCoreHyperlinks && sheet.getCoreHyperlinks();
          return core && core.getHyperlink && core.getHyperlink(rowIndex, colIndex);
        },
      },
    ];

    for (const entry of directCalls) {
      let value;
      try {
        value = entry.call();
      } catch (_) {
        value = null;
      }
      const meta = scanLinkRunValueForAttachmentMeta(value, item, `direct-${entry.label}`);
      if (meta) return meta;
    }

    const range = createWpsRange(rowIndex, rowIndex, colIndex, colIndex);
    const selectionLike = { row: rowIndex, col: colIndex, rowFrom: rowIndex, rowTo: rowIndex, colFrom: colIndex, colTo: colIndex };
    const methodPattern = /hyper|link|annex|attach|mention/i;
    const argVariants = [
      [],
      [rowIndex, colIndex],
      [colIndex, rowIndex],
      [rowIndex, colIndex, range],
      [range],
      [selectionLike],
      [selectionLike, range],
    ];

    for (const objectInfo of getActiveSheetRelatedObjects()) {
      const methods = listObjectMethods(objectInfo.value)
        .filter((method) => methodPattern.test(method.name) || methodPattern.test(method.preview || ""))
        .slice(0, 80);

      for (const method of methods) {
        const fn = objectInfo.value && objectInfo.value[method.name];
        if (typeof fn !== "function") continue;
        for (const args of argVariants) {
          const value = await callMaybePromise((done) => {
            if (fn.length > args.length) return fn.apply(objectInfo.value, [...args, done]);
            return fn.apply(objectInfo.value, args);
          }, 1000);
          const scan = scanObjectForAttachmentMeta(value, 8);
          const meta = metaFromSelectedScan(scan, item, `provider-${objectInfo.name}.${method.name}`);
          if (meta) {
            meta.methodArgs = args.map((arg) => (arg === range ? "[range]" : summarizeObjectDeep(arg, 2)));
            meta.targetObject = objectInfo.name;
            return meta;
          }
        }
      }
    }

    return null;
  }

  function selectWpsCell(rowIndex, colIndex, options = {}) {
    const app = window.APP;
    const sheet = app && app.getActiveSheet && app.getActiveSheet();
    const view = getActiveSheetViewLoose();
    const tool = app && app.getUilCmdTool && app.getUilCmdTool();
    const range = createWpsRange(rowIndex, rowIndex, colIndex, colIndex);
    const selectionLike = {
      rowFrom: rowIndex,
      rowTo: rowIndex,
      colFrom: colIndex,
      colTo: colIndex,
      row: rowIndex,
      col: colIndex,
    };
    if (!options.allowMutation) {
      return {
        ok: false,
        method: "skipped-safe-mode",
        range,
        view,
        tool,
        selectionLike,
        results: [{ name: "selection mutation", ok: false, skipped: true, reason: "safe-mode" }],
      };
    }

    const attempts = [
      ["tool.setSelection(range)", () => tool && tool.setSelection && tool.setSelection(range)],
      ["tool.setSelectionRANGE(range)", () => tool && tool.setSelectionRANGE && tool.setSelectionRANGE(range)],
      ["tool.selectCell(row,col)", () => tool && tool.selectCell && tool.selectCell(rowIndex, colIndex)],
      ["app.setSelectionRANGE(range)", () => app && app.setSelectionRANGE && app.setSelectionRANGE(range)],
      ["app.setSelectionRange(range)", () => app && app.setSelectionRange && app.setSelectionRange(range)],
      ["view.setSelectionRANGE(range)", () => view && view.setSelectionRANGE && view.setSelectionRANGE(range)],
      ["view.setSelectionRange(range)", () => view && view.setSelectionRange && view.setSelectionRange(range)],
      ["view.setSelection(range)", () => view && view.setSelection && view.setSelection(range)],
      ["view.setActiveCell(row,col)", () => view && view.setActiveCell && view.setActiveCell(rowIndex, colIndex)],
      ["view.activateCell(row,col)", () => view && view.activateCell && view.activateCell(rowIndex, colIndex)],
      ["sheet.setSelection(range)", () => sheet && sheet.setSelection && sheet.setSelection(range)],
      ["sheet.setSelectionRANGE(range)", () => sheet && sheet.setSelectionRANGE && sheet.setSelectionRANGE(range)],
      ["sheet.setActiveCell(row,col)", () => sheet && sheet.setActiveCell && sheet.setActiveCell(rowIndex, colIndex)],
      ["tool.execute selectCell", () => tool && tool.execute && tool.execute("selectCell", selectionLike)],
    ];

    const results = [];
    for (const [name, attempt] of attempts) {
      try {
        const result = attempt();
        if (result !== undefined) results.push({ name, ok: true, result: summarizeObjectDeep(result, 2) });
        else results.push({ name, ok: true, result: undefined });
        return { ok: true, method: name, range, view, tool, selectionLike, results };
      } catch (error) {
        results.push({ name, ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
      }
    }

    return { ok: false, range, view, tool, selectionLike, results };
  }

  function isMetaLikelyForPlanItem(meta, item) {
    if (!meta || !meta.id) return false;
    const haystack = normalizeAttachmentDisplayName(
      [meta.text, meta.matchedText, meta.fileName, meta.contextSample].filter(Boolean).join(" ")
    );
    const aliases = getPlanSourceAliases(item).map(normalizeAttachmentDisplayName).filter(Boolean);
    if (!haystack) return true;
    if (item.key && haystack.includes(String(item.key))) return true;
    return aliases.some((alias) => alias && (haystack.includes(alias) || alias.includes(haystack)));
  }

  function metaFromSelectedScan(scan, item, matchName) {
    const meta = metaFromScanResult(scan, item, matchName);
    if (!meta) return null;
    meta.contextSample = scan && scan.contextSample;
    return isMetaLikelyForPlanItem(meta, item) ? meta : null;
  }

  function callMaybePromise(fn, timeoutMs = 1500) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        const value = fn(done);
        if (value && typeof value.then === "function") value.then(done).catch((error) => done({ error: error.message || String(error) }));
        else if (value !== undefined) done(value);
      } catch (error) {
        done({ error: error.message || String(error) });
      }

      setTimeout(() => done(null), timeoutMs);
    });
  }

  async function trySelectedHyperlinkMethod(target, methodName, item, context) {
    if (!target || typeof target[methodName] !== "function") return null;

    const rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
    const colIndex = Number.isFinite(item.colIndex) ? item.colIndex : item.type === "outer" ? 2 : 6;
    const range = context && context.range ? context.range : createWpsRange(rowIndex, rowIndex, colIndex, colIndex);
    const selectionLike = context && context.selectionLike
      ? context.selectionLike
      : { row: rowIndex, col: colIndex, rowFrom: rowIndex, rowTo: rowIndex, colFrom: colIndex, colTo: colIndex };
    let argVariants = [[]];
    if (/ByCell|CellHyperlink|CellTextLink|TextLinkByCell/i.test(methodName)) {
      argVariants = [[rowIndex, colIndex], [range], [selectionLike], []];
    } else if (/LinkData|LinkInfo/i.test(methodName) && !/Sel|Select|Selection/i.test(methodName)) {
      argVariants = [[], [range], [selectionLike]];
    }

    for (const args of argVariants) {
      const value = await withActiveSheetHyperlinkShim((provider) =>
        callMaybePromise((done) => {
          const result =
            target[methodName].length > args.length
              ? target[methodName].apply(target, [...args, done])
              : target[methodName].apply(target, args);
          if (provider && result && typeof result === "object") result.__wpsBatchShimProvider = `${provider.objectName}.${provider.methodName}`;
          return result;
        })
      );
      const scan = scanObjectForAttachmentMeta(value, 8);
      const meta = metaFromSelectedScan(scan, item, `selected-${methodName}`);
      if (meta) {
        meta.methodArgs = args.map((arg) => (arg === range ? "[range]" : summarizeObjectDeep(arg, 2)));
        return meta;
      }
    }

    return null;
  }

  async function getAttachmentMetaFromSelectedHyperlink(item, options = {}) {
    const rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
    const colIndex = Number.isFinite(item.colIndex) ? item.colIndex : item.type === "outer" ? 2 : 6;
    if (!Number.isFinite(rowIndex) || !Number.isFinite(colIndex)) return null;

    const selection = selectWpsCell(rowIndex, colIndex, { allowMutation: !!options.allowSelectionMutation });
    await sleep(options.waitMs || 120);

    const app = window.APP;
    const tool = selection.tool || (app && app.getUilCmdTool && app.getUilCmdTool());
    const view = selection.view || getActiveSheetViewLoose();
    const sheet = app && app.getActiveSheet && app.getActiveSheet();
    const targets = [
      { name: "tool", value: tool },
      { name: "view", value: view },
      { name: "sheet", value: sheet },
      { name: "app", value: app },
    ];
    const methodNames = [
      "getSelectHyperlink",
      "getSelLinkData",
      "getSelectedHyperlink",
      "getSelectionHyperlink",
      "getHyperlinkByCell",
      "getCellHyperlink",
      "getCellTextLink",
      "getTextLinkByCell",
      "getTextLinkData",
      "getLinkData",
      "getLinkInfo",
    ];

    if (options.allowUi) {
      methodNames.push("showHyperlinkBar", "activateTextLinkCell");
    }

    for (const target of targets) {
      for (const methodName of methodNames) {
        const meta = await trySelectedHyperlinkMethod(target.value, methodName, item, selection);
        if (meta) {
          meta.selectionMethod = selection.method || "";
          meta.selectionOk = selection.ok;
          meta.targetObject = target.name;
          return meta;
        }
      }
    }

    for (const target of targets) {
      const scan = scanObjectForAttachmentMeta(target.value, 5);
      const meta = metaFromSelectedScan(scan, item, `selected-scan-${target.name}`);
      if (meta) {
        meta.selectionMethod = selection.method || "";
        meta.selectionOk = selection.ok;
        return meta;
      }
    }

    return null;
  }

  function listObjectMethods(obj) {
    const rows = [];
    const seen = new Set();
    let current = obj;
    let level = 0;
    while (current && level < 5) {
      let descriptors = {};
      try {
        descriptors = Object.getOwnPropertyDescriptors(current);
      } catch (_) {
        descriptors = {};
      }
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (seen.has(name) || name === "constructor") continue;
        seen.add(name);
        if (typeof descriptor.value === "function") {
          rows.push({
            level,
            name,
            length: descriptor.value.length,
            preview: functionSourcePreview(descriptor.value),
          });
        }
      }
      current = Object.getPrototypeOf(current);
      level += 1;
    }
    return rows;
  }

  function inspectAttachmentCell(item) {
    const rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
    const colIndex = Number.isFinite(item.colIndex) ? item.colIndex : item.type === "outer" ? 2 : 6;
    const cell = getCellObjectAt(rowIndex, colIndex);
    const meta = cell ? scanObjectForAttachmentMeta(cell, 8) : null;
    const methods = cell ? listObjectMethods(cell) : [];
    const calls = [];

    for (const method of methods) {
      if (method.length > 0) continue;
      if (!/run|link|hyper|text|formula|value|cell|data|rich|comment|mention|attach|annex|str|display|format/i.test(method.name)) continue;
      try {
        const value = cell[method.name]();
        const summary = summarizeObjectDeep(value, 3);
        const text = JSON.stringify(summary);
        if (/(kw:annex|oId|fileName|fileSize|外箱标|预约信|run|link|text|formula)/i.test(text)) {
          calls.push({
            name: method.name,
            result: text.slice(0, 3000),
          });
        }
      } catch (error) {
        calls.push({
          name: method.name,
          error: String(error && error.message ? error.message : error).slice(0, 500),
        });
      }
      if (calls.length >= 60) break;
    }

    let ownSummary = {};
    try {
      ownSummary = summarizeObjectDeep(cell, 2);
    } catch (_) {}

    return {
      row: item.row,
      rowIndex,
      colIndex,
      type: item.type,
      key: item.key,
      sourceText: item.sourceText,
      targetBase: item.targetBase,
      cellCtor: cell && cell.constructor && cell.constructor.name ? cell.constructor.name : "",
      meta,
      ownSummary,
      methods: methods.slice(0, 120),
      calls,
    };
  }

  async function inspectAttachmentCellRich(item) {
    const base = inspectAttachmentCell(item);
    const rowIndex = base.rowIndex;
    const colIndex = base.colIndex;
    const range = createWpsRange(rowIndex, rowIndex, colIndex, colIndex);
    const rangeQueries = [];

    for (const options of [
      {},
      { includeTextLinkRuns: true, includeRuns: true },
      { needTextLinkRuns: true, needRuns: true },
      { withTextLinkRuns: true, withRuns: true },
      { ignoreFrozenArea: true, includeTextLinkRuns: true, includeRuns: true },
    ]) {
      const value = await queryRangeValuesViaUil(range, options);
      rangeQueries.push({
        options,
        summary: summarizeObjectDeep(value, 4),
        meta: scanObjectForAttachmentMeta(value, 8),
      });
    }

    return { ...base, rangeQueries };
  }

  async function inspectSelectedHyperlinkForItem(item, options = {}) {
    const rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
    const colIndex = Number.isFinite(item.colIndex) ? item.colIndex : item.type === "outer" ? 2 : 6;
    const selection = selectWpsCell(rowIndex, colIndex, { allowMutation: !!options.allowSelectionMutation });
    await sleep(options.waitMs || 120);

    const app = window.APP;
    const tool = selection.tool || (app && app.getUilCmdTool && app.getUilCmdTool());
    const view = selection.view || getActiveSheetViewLoose();
    const sheet = app && app.getActiveSheet && app.getActiveSheet();
    const targets = [
      { name: "tool", value: tool },
      { name: "view", value: view },
      { name: "sheet", value: sheet },
      { name: "app", value: app },
    ];
    const methodNames = [
      "getSelectHyperlink",
      "getSelLinkData",
      "getSelectedHyperlink",
      "getSelectionHyperlink",
      "getHyperlinkByCell",
      "getCellHyperlink",
      "getCellTextLink",
      "getTextLinkByCell",
      "getTextLinkData",
      "getLinkData",
      "getLinkInfo",
    ];
    if (options.allowUi) methodNames.push("showHyperlinkBar", "activateTextLinkCell");

    const calls = [];
    for (const target of targets) {
      for (const methodName of methodNames) {
        if (!target.value || typeof target.value[methodName] !== "function") continue;
        const value = await withActiveSheetHyperlinkShim((provider) =>
          callMaybePromise((done) => {
            const range = selection.range || createWpsRange(rowIndex, rowIndex, colIndex, colIndex);
            const selectionLike = selection.selectionLike || {
              row: rowIndex,
              col: colIndex,
              rowFrom: rowIndex,
              rowTo: rowIndex,
              colFrom: colIndex,
              colTo: colIndex,
            };
            let args = [];
            if (/ByCell|CellHyperlink|CellTextLink|TextLinkByCell/i.test(methodName)) args = [rowIndex, colIndex];
            else if (/LinkData|LinkInfo/i.test(methodName) && !/Sel|Select|Selection/i.test(methodName)) args = target.value[methodName].length > 0 ? [range || selectionLike] : [];
            const result = target.value[methodName].apply(target.value, target.value[methodName].length > args.length ? [...args, done] : args);
            if (provider && result && typeof result === "object") result.__wpsBatchShimProvider = `${provider.objectName}.${provider.methodName}`;
            return result;
          })
        );
        const summary = summarizeObjectDeep(value, 5);
        const meta = scanObjectForAttachmentMeta(value, 8);
        calls.push({
          target: target.name,
          method: methodName,
          summary,
          meta,
        });
      }
    }

    const providerMeta = await getAttachmentMetaFromHyperlinkProviders(item);
    const directMeta = providerMeta || (await getAttachmentMetaFromSelectedHyperlink(item, options));
    return {
      row: item.row,
      rowIndex,
      colIndex,
      type: item.type,
      key: item.key,
      sourceText: item.sourceText,
      targetBase: item.targetBase,
      selection: {
        ok: selection.ok,
        method: selection.method || "",
        attempts: selection.results || [],
      },
      directMeta,
      providerMeta,
      calls,
    };
  }

  async function reportSelectedHyperlinkApis(limit = 4, options = {}) {
    const plan = (await buildPlanDirectlyFromPage()).slice(0, limit);
    const inspections = [];
    for (const item of plan) {
      inspections.push(await inspectSelectedHyperlinkForItem(item, options));
    }

    const lines = [];
    lines.push("=== WPSBatch Selected Hyperlink API Report ===");
    lines.push(`url: ${location.href}`);
    lines.push(`title: ${document.title}`);
    lines.push(`time: ${new Date().toISOString()}`);
    lines.push(`source: wps-selected-hyperlink-api`);
    lines.push(`inspectedCount: ${inspections.length}`);
    lines.push("");

    inspections.forEach((inspection, index) => {
      lines.push(
        [
          "CELL",
          `index=${index}`,
          `row=${inspection.row}`,
          `rowIndex=${inspection.rowIndex}`,
          `colIndex=${inspection.colIndex}`,
          `type=${inspection.type}`,
          `key=${inspection.key}`,
          `source=${inspection.sourceText}`,
          `target=${inspection.targetBase}`,
        ].join("\t")
      );
      lines.push(`SELECT\tcell=${index}\tok=${inspection.selection.ok}\tmethod=${inspection.selection.method}\tattempts=${JSON.stringify(inspection.selection.attempts)}`);
      lines.push(`PROVIDER_META\tcell=${index}\tmeta=${JSON.stringify(inspection.providerMeta || null)}`);
      lines.push(`DIRECT_META\tcell=${index}\tmeta=${JSON.stringify(inspection.directMeta || null)}`);
      inspection.calls.forEach((call, callIndex) => {
        lines.push(
          [
            "CALL",
            `cell=${index}`,
            `call=${callIndex}`,
            `target=${call.target}`,
            `method=${call.method}`,
            `meta=${JSON.stringify(call.meta)}`,
            `summary=${JSON.stringify(call.summary).slice(0, 3000)}`,
          ].join("\t")
        );
      });
      lines.push("");
    });

    lines.push("=== End WPSBatch Selected Hyperlink API Report ===");
    const text = lines.join("\n");
    window.WPSBatch.lastSelectedHyperlinkApiReportText = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("已复制 Selected Hyperlink API 报告。");
    } catch (_) {}
    return inspections;
  }

  function getExistingCellRuns(rowIndex, colIndex) {
    const cell = getCellObjectAt(rowIndex, colIndex);
    if (!cell) return [];

    const methodNames = [
      "getRuns",
      "getTextRuns",
      "getRichTextRuns",
      "getRunList",
      "getRichText",
      "getTextLinkRuns",
    ];

    for (const name of methodNames) {
      try {
        if (typeof cell[name] !== "function") continue;
        const value = cell[name]();
        if (Array.isArray(value) && value.length) return clonePlain(value);
        if (value && Array.isArray(value.runs) && value.runs.length) return clonePlain(value.runs);
      } catch (_) {}
    }

    try {
      const descriptors = Object.getOwnPropertyDescriptors(cell);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!("value" in descriptor)) continue;
        const value = descriptor.value;
        if (!Array.isArray(value) || !value.length) continue;
        if (/run|font|rich/i.test(key) || value.some((item) => item && typeof item === "object" && ("begin" in item || "font" in item))) {
          return clonePlain(value);
        }
      }
    } catch (_) {}

    return [];
  }

  function getAttachmentMetaFromCell(item) {
    const rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
    const colIndex = Number.isFinite(item.colIndex) ? item.colIndex : item.type === "outer" ? 2 : 6;
    const cell = getCellObjectAt(rowIndex, colIndex);
    if (!cell) return null;

    return metaFromScanResult(scanObjectForAttachmentMeta(cell), item, "cell-link");
  }

  async function getAttachmentMetaForPlanItem(item, options = {}) {
    return (
      (await getAttachmentMetaFromHyperlinkProviders(item)) ||
      (await getAttachmentMetaFromSelectedHyperlink(item, options)) ||
      (await getAttachmentMetaFromRangeQuery(item)) ||
      getAttachmentMetaFromCell(item)
    );
  }

  function makeAttachmentCellCommandParam(item, id, meta) {
    const rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
    const colIndex =
      Number.isFinite(item.colIndex) ? item.colIndex : item.type === "outer" ? 2 : 6;
    if (!Number.isFinite(rowIndex) || !Number.isFinite(colIndex) || rowIndex < 0 || colIndex < 0) {
      throw new Error(`无法定位附件单元格：${item.type}:${item.key}`);
    }

    const sheetMeta = getSheetCommandMeta();
    const ext = (meta && meta.aType) || "pdf";
    const fileSize = (meta && meta.fileSize) || "";
    const displayName = item.targetBase;
    const formula = `📄${displayName}`;
    const filename = `${displayName}.${ext}`;
    const address = `kw:annex?aType=${encodeURIComponent(ext)}&oId=${encodeURIComponent(id)}&fileName=${encodeURIComponent(filename)}${
      fileSize ? `&fileSize=${encodeURIComponent(fileSize)}` : ""
    }`;

    const param = {
      sheetStId: Number(sheetMeta.sheetStId),
      sheetIdx: Number(sheetMeta.sheetIdx),
      sheetName: sheetMeta.sheetName,
      rowFrom: rowIndex,
      rowTo: rowIndex,
      colFrom: colIndex,
      colTo: colIndex,
      independentViewId: -1,
      independentViewInfo: {
        viewId: -1,
        userId: sheetMeta.userId,
        viewName: "",
        isTemp: false,
        sharedChanged: false,
        forceExit: false,
        connId: sheetMeta.connId,
      },
      enableDynamicArray: true,
      formula,
      textLinkRuns: [{ pos: 0, length: formula.length, address, linkRunsType: "LRTMention" }],
      changeFlags: { formula: true },
      refSheetStId: Number(sheetMeta.sheetStId),
      refSheetIdx: Number(sheetMeta.sheetIdx),
      refRow: rowIndex,
      refCol: colIndex,
      refStyle: sheetMeta.refStyle,
      isForceAsText4Decimal: false,
    };

    const runs = getExistingCellRuns(rowIndex, colIndex);
    if (runs.length) {
      runs[0] = { ...runs[0], begin: 0 };
      param.runs = runs;
      param.changeFlags.runs = true;
    }

    return param;
  }

  async function updateSheetAttachmentCellsByAttachmentMap(attachmentMap) {
    const plan = await buildPlanDirectlyFromPage();
    const normalized = normalizeAttachmentMap(attachmentMap);
    const results = [];

    for (const item of plan) {
      const id =
        normalized[item.type][item.key] ||
        normalized.flat[`${item.type}:${item.key}`] ||
        normalized.flat[item.sourceText] ||
        normalized.flat[item.targetBase];

      if (!id) {
        results.push({ ...item, status: "missing-id" });
        continue;
      }

      try {
        const meta = findAttachmentMetaForItem(item, attachmentMap, id);
        const param = makeAttachmentCellCommandParam(item, id, meta);
        const ok = window.APP.execCommand("range.setFormula", param);
        results.push({ ...item, status: ok ? "cell-updated" : "cell-update-rejected", subFileId: id, param });
        log("已更新表格附件显示名：", item.row, item.type, id, "=>", item.targetBase);
        await sleep(CONFIG.downloadDelayMs);
      } catch (error) {
        results.push({ ...item, status: "cell-update-error", subFileId: id, error: error.message });
        warn("更新表格附件显示名失败：", item.row, item.type, id, item.targetBase, error);
      }
    }

    console.table(
      results.map((item) => ({
        row: item.row,
        type: item.type === "outer" ? "外箱标" : "预约信",
        key: item.key,
        targetName: item.targetBase,
        subFileId: item.subFileId || "",
        status: item.status,
        error: item.error || "",
      }))
    );

    return results;
  }

  async function updateSheetAttachmentCellsAuto() {
    const attachmentMap = window.WPSBatch.lastAutoAttachmentMap || loadPersistedAttachmentMap() || (await makeAutoAttachmentMap());
    const missing = (attachmentMap._diagnostics || []).filter((item) => item.status === "missing-id");
    if (missing.length) {
      console.table(
        missing.map((item) => ({
          type: item.type === "outer" ? "外箱标" : "预约信",
          key: item.key,
          source: item.source,
          target: item.target,
        }))
      );
      throw new Error(`还有 ${missing.length} 个附件没有自动匹配到 ID。请先检查 WPSBatch.lastAutoAttachmentMap._diagnostics。`);
    }
    return updateSheetAttachmentCellsByAttachmentMap(attachmentMap);
  }

  async function renameAndDownloadByAttachmentMap(attachmentMap) {
    log("先批量重命名 WPS 表格内附件显示名。");
    const renameResults = await renameByAttachmentMap(attachmentMap);
    log("再按目标文件名批量下载。");
    const downloadResults = await downloadByAttachmentMap(attachmentMap);
    return { renameResults, downloadResults };
  }

  async function makeAttachmentMapTemplate() {
    const plan = await buildPlanDirectlyFromPage();
    const template = { outer: {}, appointment: {} };

    for (const item of plan) {
      template[item.type][item.key] = "";
    }

    const text = JSON.stringify(template, null, 2);
    window.WPSBatch.lastAttachmentMapTemplate = text;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      log("附件 ID 映射模板已复制到剪贴板。把空字符串填成附件 ID 后即可使用。");
    } catch (_) {}
    return template;
  }

  async function makeAutoAttachmentMap(options = {}) {
    const plan = await buildPlanDirectlyFromPage();
    const { scanned, candidates, endpointResults } = await collectAttachmentIdCandidatesAsync();
    const usedIds = new Set();
    const attachmentMap = { outer: {}, appointment: {}, _diagnostics: [] };

    window.WPSBatch.lastAutoAttachmentPlan = plan;

    for (const item of plan) {
      const { candidate, match } = pickAttachmentIdForPlanItem(item, candidates, usedIds);
      const cellMeta = candidate ? null : await getAttachmentMetaForPlanItem(item, options);
      const picked = candidate || cellMeta;
      const pickedMatch = candidate ? match : cellMeta ? cellMeta.match : match;

      if (!picked) {
        attachmentMap._diagnostics.push({
          type: item.type,
          key: item.key,
          source: item.sourceText,
          target: item.targetBase,
          status: "missing-id",
          match,
        });
        continue;
      }

      attachmentMap[item.type][item.key] = picked.id;
      attachmentMap._diagnostics.push({
        type: item.type,
        key: item.key,
        source: item.sourceText,
        target: item.targetBase,
        subFileId: picked.id,
        matchedText: picked.text || picked.matchedText,
        fileSize: picked.fileSize || "",
        aType: picked.aType || "pdf",
        fileName: picked.fileName || "",
        match: pickedMatch,
        status: pickedMatch === "type-order" ? "matched-by-order-check-before-run" : "matched",
      });
      usedIds.add(picked.id);
    }

    window.WPSBatch.lastAutoAttachmentMap = attachmentMap;
    window.WPSBatch.lastAutoAttachmentCandidates = candidates;
    window.WPSBatch.lastAttachmentApiEndpointResults = endpointResults;
    savePersistedState({
      lastAutoAttachmentMap: attachmentMap,
      lastAutoAttachmentCandidates: candidates,
      lastAttachmentApiEndpointResults: endpointResults,
    });

    console.table(
      attachmentMap._diagnostics.map((item) => ({
        type: item.type === "outer" ? "外箱标" : "预约信",
        key: item.key,
        target: item.target,
        subFileId: item.subFileId || "",
        fileSize: item.fileSize || "",
        match: item.match,
        status: item.status,
        matchedText: item.matchedText || "",
      }))
    );

    const missing = attachmentMap._diagnostics.filter((item) => item.status === "missing-id");
    const byOrder = attachmentMap._diagnostics.filter((item) => item.match === "type-order");
    const okEndpoints = (endpointResults || []).filter((item) => Number(item.status) >= 200 && Number(item.status) < 300).length;
    log(
      `自动附件 ID 配对：状态扫描 ${scanned} 个节点，接口探测 ${okEndpoints}/${(endpointResults || []).length} 个成功，候选 ${candidates.length} 个，已配 ${
        attachmentMap._diagnostics.length - missing.length
      } 个，缺失 ${missing.length} 个。`
    );
    if (byOrder.length) {
      warn("有项目使用了同类型顺序兜底匹配，请先检查表格里的 matchedText 和 target 是否一一对应。");
    }
    if (missing.length) {
      warn("有项目没有自动找到附件 ID，可运行 await WPSBatch.reportAttachmentState() 查看更详细状态。");
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(attachmentMap, null, 2));
      log("自动附件 ID 映射已复制到剪贴板，也保存在 WPSBatch.lastAutoAttachmentMap。");
    } catch (_) {}

    return attachmentMap;
  }

  async function renameAndDownloadAuto(options = {}) {
    const attachmentMap = await makeAutoAttachmentMap(options);
    var matchResult = buildMatchResult(attachmentMap);
    if (matchResult.missingCount > 0) {
      throw new Error("还有 " + matchResult.missingCount + " 个附件没有自动匹配到 ID。请先检查 _diagnostics。");
    }
    if (matchResult.riskLevel === "risky" && !options.allowRiskyOrderMatch) {
      throw new Error(
        "有 " + matchResult.riskyItems.length + " 个项目使用了 type-order 顺序兜底匹配，存在高风险。请检查后设置 options.allowRiskyOrderMatch: true 再执行。"
      );
    }
    log("先更新表格里的附件显示名。");
    const cellResults = await updateSheetAttachmentCellsByAttachmentMap(attachmentMap);
    const renameDownloadResults = await renameAndDownloadByAttachmentMap(attachmentMap);
    return { cellResults: cellResults, renameResults: renameDownloadResults.renameResults, downloadResults: renameDownloadResults.downloadResults };
  }

  async function installRenameProbeHooks() {
    const probe = installProbeHooks();
    probe.reset();
    log("重命名探测已准备好。请在 WPS 页面手动把 1 个表格里的附件显示名改成目标格式，然后运行：await WPSBatch.probe.report()");
    log("注意：不要直接覆盖单元格文字；请使用附件自身的重命名/编辑名称入口。报告会同时记录网络请求和 WPS 内部 execCommand 命令。");
    return probe;
  }

  async function renameByCapturedRequest(renameConfig, attachmentMap) {
    if (!renameConfig || typeof renameConfig !== "object") {
      throw new Error("缺少 renameConfig。需要先通过 installRenameProbeHooks 捕获 WPS 的重命名接口。");
    }
    if (!renameConfig.urlTemplate || !renameConfig.method) {
      throw new Error("renameConfig 至少需要 method 和 urlTemplate。");
    }

    const plan = await buildPlanDirectlyFromPage();
    const results = [];

    for (const item of plan) {
      const id =
        (attachmentMap && attachmentMap[item.type] && attachmentMap[item.type][item.key]) ||
        (attachmentMap && attachmentMap[`${item.type}:${item.key}`]);
      if (!id) {
        results.push({ ...item, status: "missing-id" });
        continue;
      }

      const name = item.targetBase;
      const url = renameConfig.urlTemplate
        .replaceAll("{linkId}", (location.pathname.match(/\/l\/([^/?#]+)/) || [])[1] || "")
        .replaceAll("{subFileId}", id)
        .replaceAll("{name}", encodeURIComponent(name));

      const body = renameConfig.bodyTemplate
        ? renameConfig.bodyTemplate
            .replaceAll("{subFileId}", id)
            .replaceAll("{name}", name)
            .replaceAll("{filename}", name + CONFIG.defaultExt)
        : undefined;

      try {
        const response = await fetch(url, {
          method: renameConfig.method,
          credentials: "include",
          headers: {
            "content-type": "application/json",
            ...(renameConfig.headers || {}),
          },
          body,
        });
        const text = await response.text();
        results.push({
          ...item,
          status: response.ok ? "renamed" : "rename-error",
          subFileId: id,
          httpStatus: response.status,
          response: text.slice(0, 500),
        });
        await sleep(CONFIG.downloadDelayMs);
      } catch (error) {
        results.push({ ...item, status: "rename-error", subFileId: id, error: error.message });
      }
    }

    console.table(
      results.map((item) => ({
        type: item.type,
        key: item.key,
        targetName: item.targetBase,
        subFileId: item.subFileId || "",
        status: item.status,
        httpStatus: item.httpStatus || "",
        error: item.error || item.response || "",
      }))
    );
    return results;
  }

  function installProbeHooks() {
    const existing = window.WPSBatch && window.WPSBatch.probe;
    if (existing && existing.installed) {
      log("probe hooks 已安装。");
      return existing;
    }

    const probe = {
      installed: true,
      records: [],
      opens: [],
      commands: [],
      nextId: 1,
      originalFetch: window.fetch,
      originalOpen: window.open,
      originalXhrOpen: XMLHttpRequest.prototype.open,
      originalXhrSend: XMLHttpRequest.prototype.send,
      originalMethods: [],
    };
    restorePersistedProbeInto(probe);

    function shouldRecordUrl(url) {
      return /(kdocs|wps|docer|qing|kso|kingsoft|wpscdn|file|download|attach|upload|office|weboffice)/i.test(String(url || ""));
    }

    function normalizeBody(body) {
      if (!body) return "";
      if (typeof body === "string") return body.slice(0, 1200);
      if (body instanceof URLSearchParams) return body.toString().slice(0, 1200);
      if (body instanceof FormData) {
        const parts = [];
        for (const [key, value] of body.entries()) {
          parts.push(`${key}=${value instanceof File ? `[File ${value.name} ${value.size}]` : String(value).slice(0, 200)}`);
        }
        return parts.join("&").slice(0, 1200);
      }
      if (body instanceof Blob) return `[Blob ${body.type || "unknown"} ${body.size}]`;
      try {
        return JSON.stringify(body).slice(0, 1200);
      } catch (_) {
        return String(body).slice(0, 1200);
      }
    }

    window.fetch = async function patchedFetch(input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || "GET";
      const shouldRecord = shouldRecordUrl(url);
      const id = probe.nextId++;
      const record = shouldRecord
        ? {
            id,
            kind: "fetch",
            method,
            url: String(url || ""),
            body: normalizeBody(init && init.body),
            status: "",
            contentType: "",
            disposition: "",
            responseSnippet: "",
          }
        : null;

      try {
        const response = await probe.originalFetch.apply(this, arguments);
        if (record) {
          record.status = response.status;
          record.contentType = response.headers.get("content-type") || "";
          record.disposition = response.headers.get("content-disposition") || "";
          if (/(json|text|javascript|xml|html)/i.test(record.contentType)) {
            response
              .clone()
              .text()
              .then((text) => {
                record.responseSnippet = text.slice(0, 1600);
                persistProbe(probe);
              })
              .catch(() => {});
          }
          probe.records.push(record);
          persistProbe(probe);
        }
        return response;
      } catch (error) {
        if (record) {
          record.status = "ERROR";
          record.responseSnippet = error.message || String(error);
          probe.records.push(record);
          persistProbe(probe);
        }
        throw error;
      }
    };

    XMLHttpRequest.prototype.open = function patchedXhrOpen(method, url) {
      this.__wpsBatchProbe = {
        id: probe.nextId++,
        kind: "xhr",
        method,
        url: String(url || ""),
        body: "",
        status: "",
        contentType: "",
        disposition: "",
        responseSnippet: "",
        shouldRecord: shouldRecordUrl(url),
      };
      return probe.originalXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedXhrSend(body) {
      const meta = this.__wpsBatchProbe;
      if (meta && meta.shouldRecord) {
        meta.body = normalizeBody(body);
        this.addEventListener("loadend", function () {
          meta.status = this.status;
          try {
            meta.contentType = this.getResponseHeader("content-type") || "";
            meta.disposition = this.getResponseHeader("content-disposition") || "";
          } catch (_) {}
          try {
            if (typeof this.responseText === "string") meta.responseSnippet = this.responseText.slice(0, 1600);
          } catch (_) {}
          probe.records.push(meta);
          persistProbe(probe);
        });
      }
      return probe.originalXhrSend.apply(this, arguments);
    };

    window.open = function patchedOpen(url, target, features) {
      if (shouldRecordUrl(url)) {
        probe.opens.push({ url: String(url || ""), target: String(target || "") });
        persistProbe(probe);
      }
      return probe.originalOpen.apply(this, arguments);
    };

    function summarizeArgs(args) {
      try {
        return JSON.stringify(Array.from(args).map((item) => summarizeObjectDeep(item, 2))).slice(0, 3000);
      } catch (_) {
        return Array.from(args)
          .map((item) => summarizeValue(item))
          .join(", ")
          .slice(0, 3000);
      }
    }

    function patchMethod(objectName, object, methodName) {
      if (!object || typeof object[methodName] !== "function") return;
      const original = object[methodName];
      if (original.__wpsBatchProbePatched) return;

      function patchedMethod() {
        const record = {
          id: probe.nextId++,
          kind: "command",
          object: objectName,
          method: methodName,
          args: summarizeArgs(arguments),
          result: "",
          error: "",
        };
        try {
          const result = original.apply(this, arguments);
          record.result = summarizeValue(result);
          probe.commands.push(record);
          persistProbe(probe);
          return result;
        } catch (error) {
          record.error = String(error && error.message ? error.message : error).slice(0, 1000);
          probe.commands.push(record);
          persistProbe(probe);
          throw error;
        }
      }

      patchedMethod.__wpsBatchProbePatched = true;
      probe.originalMethods.push({ object, methodName, original });
      object[methodName] = patchedMethod;
    }

    [
      "execCommand",
      "execCommandPromise",
      "execCommands",
      "execCommandBatchMode",
      "execQueryCommand",
      "execQueryCommandPromise",
      "sendLocalCmdRes",
      "updateDirtyRange",
      "updateBookDirty",
    ].forEach((methodName) => patchMethod("APP", window.APP, methodName));

    [
      "sendCommandBlock",
      "sendCommandQueue",
      "sendCommandsQueue",
      "updateShapes",
      "pushCommand",
      "_pushCommand",
    ].forEach((methodName) => patchMethod("APP.session", window.APP && window.APP.session, methodName));

    probe.report = async function reportProbe() {
      const text = makeProbeReportText();
      window.WPSBatch.lastProbeReportText = text;
      console.log(text);
      try {
        await navigator.clipboard.writeText(text);
        log("probe 报告已复制到剪贴板。");
      } catch (error) {
        warn("probe 报告自动复制失败，请手动复制 WPSBatch.lastProbeReportText。", error.message);
      }
      return text;
    };

    probe.reset = function resetProbe() {
      probe.records.length = 0;
      probe.opens.length = 0;
      probe.commands.length = 0;
      probe.nextId = 1;
      persistProbe(probe);
      log("probe 记录已清空。");
    };

    probe.uninstall = function uninstallProbe() {
      window.fetch = probe.originalFetch;
      window.open = probe.originalOpen;
      XMLHttpRequest.prototype.open = probe.originalXhrOpen;
      XMLHttpRequest.prototype.send = probe.originalXhrSend;
      for (const item of probe.originalMethods || []) {
        item.object[item.methodName] = item.original;
      }
      probe.originalMethods.length = 0;
      probe.installed = false;
      log("probe hooks 已卸载。");
    };

    window.WPSBatch.probe = probe;
    log("probe hooks 已安装。请在 WPS 页面手动打开/下载 1 个外箱标附件和 1 个预约信附件，然后运行：await WPSBatch.probe.report()");
    return probe;
  }

  function checkPageEnvironment() {
    var sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
    var result = {
      hasWindowApp: !!window.APP,
      hasActiveSheet: !!(window.APP && window.APP.getActiveSheet),
      sheetName: "",
      keyApis: {},
      config: JSON.parse(JSON.stringify(CONFIG)),
      pageUrl: location.href,
      pageTitle: document.title,
      time: new Date().toISOString(),
    };
    try {
      result.sheetName = sheet && sheet.getName ? sheet.getName() : "";
    } catch (_) {}
    result.keyApis = {
      getCell: !!(
        (window.APP && window.APP.getCell) ||
        (sheet && sheet.sheetData && sheet.sheetData.getCell)
      ),
      execCommand: !!(window.APP && window.APP.execCommand),
      getTextLinkRuns: !!(sheet && sheet.getTextLinkRuns),
      getCoreHyperlinks: !!(sheet && sheet.getCoreHyperlinks),
      getActiveSheet: !!(window.APP && window.APP.getActiveSheet),
      rangeSetFormula: !!(window.APP && window.APP.execCommand),
      getUilCmdTool: !!(window.APP && window.APP.getUilCmdTool),
    };
    return result;
  }

  async function selfTest() {
    var result = checkPageEnvironment();
    console.log("[WPSBatch] Self Test Result:");
    console.table([result]);
    console.table([result.keyApis]);
    return result;
  }

  async function run(options = {}) {
    let plan = [];
    let candidates = [];
    let results = [];

    try {
      log("开始自动读取当前 WPS 页面数据。");

      if (options.tsv) {
        plan = buildPlanFromTsv(options.tsv);
      } else {
        plan = await buildPlanDirectlyFromPage();
      }

      if (!plan.length && options.allowClipboardFallback !== false) {
        warn("自动读取没有生成任务，退回到剪贴板/手动粘贴方式。");
        const tsv = await readTsvFromClipboardOrPrompt();
        plan = buildPlanFromTsv(tsv);
      }

      if (!plan.length) {
        throw new Error("没有生成任何下载/重命名任务。请检查复制的数据区域。");
      }

      log(`生成 ${plan.length} 个文件任务：`);
      printPlan(plan);

      candidates = findDomAttachmentCandidates();
      log(`扫描到 ${candidates.length} 个可能的 DOM 附件节点。`);
      if (CONFIG.debug) printCandidates(candidates);

      results = await downloadPlan(plan, candidates);
      const downloaded = results.filter((item) => item.status === "downloaded").length;
      const noUrl = results.filter((item) => item.status === "candidate-has-no-direct-url").length;
      const missing = results.filter((item) => item.status === "no-dom-candidate").length;
      const errors = results.filter((item) => item.status === "download-error").length;

      log(`完成：成功触发 ${downloaded} 个下载；无直接 URL ${noUrl} 个；未找到 DOM 节点 ${missing} 个；错误 ${errors} 个。`);
      console.table(
        results.map((item) => ({
          row: item.row,
          type: item.type === "outer" ? "外箱标" : "预约信",
          target: item.targetBase + CONFIG.defaultExt,
          status: item.status,
          url: item.url || "",
          note: item.error || item.candidateBox || "",
        }))
      );

      if (downloaded === 0) {
        warn(
          "没有成功触发下载。这个 WPS 页面很可能把附件渲染在 canvas/内部状态里，没有向 DOM 暴露真实文件 URL。请把 WPSBatch.lastReportText 粘给我，我再给你写二阶段脚本：先 hook WPS 的下载接口，再批量调用接口。"
        );
      }

      await publishReport({ plan, candidates, results });
      return { plan, candidates, results, reportText: window.WPSBatch.lastReportText };
    } catch (error) {
      await publishReport({ plan, candidates, results, error });
      throw error;
    }
  }

  async function copyReport() {
    if (!window.WPSBatch.lastReportText) {
      throw new Error("还没有报告。请先运行 await WPSBatch.run()");
    }
    await navigator.clipboard.writeText(window.WPSBatch.lastReportText);
    log("已复制 WPSBatch.lastReportText。");
  }

  function buildMatchResult(attachmentMap) {
    var diagnostics = attachmentMap._diagnostics || [];
    var missingItems = [];
    var riskyItems = [];
    var matchedItems = [];
    for (var i = 0; i < diagnostics.length; i++) {
      var d = diagnostics[i];
      if (d.status === "missing-id") missingItems.push(d);
      else if (d.match === "type-order" || d.status === "matched-by-order-check-before-run") riskyItems.push(d);
      else matchedItems.push(d);
    }
    var riskLevel = "safe";
    if (missingItems.length > 0) riskLevel = "blocked";
    else if (riskyItems.length > 0) riskLevel = "risky";
    return {
      attachmentMap: attachmentMap,
      riskLevel: riskLevel,
      riskyItems: riskyItems,
      missingItems: missingItems,
      matchedItems: matchedItems,
      matchedCount: matchedItems.length,
      missingCount: missingItems.length,
      candidateCount: (window.WPSBatch.lastAutoAttachmentCandidates || []).length,
      candidates: window.WPSBatch.lastAutoAttachmentCandidates || [],
      timestamp: Date.now(),
    };
  }

  // ===== Selection-based Attachment APIs =====

  function getFieldNumber(obj, names) {
    if (!obj || typeof obj !== "object") return NaN;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      try {
        var value = obj[name];
        if (typeof value === "function") value = value.call(obj);
        var number = Number(value);
        if (Number.isFinite(number)) return number;
      } catch (_) {}
    }
    return NaN;
  }

  function extractRangeBoundsDeep(raw, depth, seen) {
    if (!raw || (typeof raw !== "object" && typeof raw !== "function")) return null;
    if (raw instanceof Node || raw === window || raw === document) return null;
    if (!seen) seen = new WeakSet();
    if (seen.has(raw)) return null;
    seen.add(raw);

    var direct = extractRangeBounds(raw);
    if (direct) return direct;
    if (depth <= 0) return null;

    var childKeys = [
      "range",
      "ranges",
      "selection",
      "selections",
      "selectionRange",
      "activeRange",
      "selectedRange",
      "currentRange",
      "cellRange",
      "ref",
      "rect",
      "start",
      "end",
      "_range",
      "_selection",
      "_activeRange",
      // WPS internal structures from diagnosis
      "windowInfo",
      "activeCell",
      "private",
      "arr",
      "row",
      "col",
    ];

    for (var i = 0; i < childKeys.length; i++) {
      try {
        var child = raw[childKeys[i]];
        if (typeof child === "function") child = child.call(raw);
        if (Array.isArray(child)) {
          for (var a = 0; a < child.length; a++) {
            var fromArray = extractRangeBoundsDeep(child[a], depth - 1, seen);
            if (fromArray) return fromArray;
          }
        } else {
          var fromChild = extractRangeBoundsDeep(child, depth - 1, seen);
          if (fromChild) return fromChild;
        }
      } catch (_) {}
    }

    var descriptors = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(raw);
    } catch (_) {
      return null;
    }

    for (var key in descriptors) {
      if (!/(range|selection|select|active|cell|cursor|focus|highlight)/i.test(key)) continue;
      if (!("value" in descriptors[key])) continue;
      var value = descriptors[key].value;
      var nested = extractRangeBoundsDeep(value, depth - 1, seen);
      if (nested) return nested;
    }

    return null;
  }

  function findSelectedRangeBySurfaceScan() {
    var app = window.APP;
    var sheet = app && app.getActiveSheet && app.getActiveSheet();
    var roots = [
      { name: "APP", value: app },
      { name: "tool", value: app && app.getUilCmdTool && app.getUilCmdTool() },
      { name: "activeView", value: getActiveSheetViewLoose() },
      { name: "activeSheet", value: sheet },
      { name: "activeSheet.sheetData", value: sheet && sheet.sheetData },
      { name: "workbook", value: app && app.workbook },
    ];
    var seen = new WeakSet();
    var queue = [];

    for (var i = 0; i < roots.length; i++) {
      if (roots[i].value) queue.push({ path: roots[i].name, value: roots[i].value, depth: 0 });
    }

    while (queue.length) {
      var current = queue.shift();
      var value = current.value;
      if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
      if (value instanceof Node || value === window || value === document) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      // Exclude pseudo-selection fields that are NOT the current user selection
      var pseudoFields = /\b(_maxUsedRANGE|_autoFillRange|_activeChartDataSource|_activeChartDataSourceIdxMap|_inquireRange|formatPaintRange|_copyingRange|_tmpCopyingRange|_pasteSelectRANGE|_lastSelRange|_lastCellRANGE|_mouseDownRANGE|_allColumnsRANGE|_allRowsRANGE)\b/i;

      if (/(selection|select|activeRange|selectedRange|currentRange|cursor|highlight)/i.test(current.path)) {
        if (!pseudoFields.test(current.path)) {
          var range = extractRangeBoundsDeep(value, 2);
          if (range) {
            range.method = "surface-scan:" + current.path;
            return range;
          }
        }
      }

      if (current.depth >= 4) continue;

      var descriptors = {};
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch (_) {
        continue;
      }

      for (var key in descriptors) {
        if (!/(selection|select|active|range|cursor|focus|highlight|view|sheet|tool|cell)/i.test(key)) continue;
        if (!("value" in descriptors[key])) continue;
        var child = descriptors[key].value;
        if (!child || (typeof child !== "object" && typeof child !== "function")) continue;
        queue.push({ path: current.path + "." + key, value: child, depth: current.depth + 1 });
      }
    }

    return null;
  }

  // ===== A1 Notation Range Parser =====

  function columnLettersToIndex(letters) {
    var s = String(letters || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (!s) return -1;
    var result = 0;
    for (var i = 0; i < s.length; i++) {
      result = result * 26 + (s.charCodeAt(i) - 64);
    }
    return result - 1; // 0-based
  }

  function parseA1CellRef(ref) {
    var text = String(ref || "").trim().toUpperCase();
    var match = text.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    var colIndex = columnLettersToIndex(match[1]);
    var rowIndex = parseInt(match[2], 10) - 1; // 0-based
    if (colIndex < 0 || rowIndex < 0) return null;
    return { rowIndex: rowIndex, colIndex: colIndex };
  }

  function parseA1Range(rangeText) {
    var text = String(rangeText || "").trim().toUpperCase();
    if (!text) return null;

    // Single cell e.g. "F2"
    var singleMatch = text.match(/^([A-Z]+)(\d+)$/);
    if (singleMatch) {
      var cell = parseA1CellRef(text);
      if (!cell) return null;
      return { rowFrom: cell.rowIndex, rowTo: cell.rowIndex, colFrom: cell.colIndex, colTo: cell.colIndex };
    }

    // Range e.g. "F2:F20" or "A1:C3"
    var rangeMatch = text.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!rangeMatch) return null;

    var colFrom = columnLettersToIndex(rangeMatch[1]);
    var rowFrom = parseInt(rangeMatch[2], 10) - 1;
    var colTo = columnLettersToIndex(rangeMatch[3]);
    var rowTo = parseInt(rangeMatch[4], 10) - 1;

    if (colFrom < 0 || rowFrom < 0 || colTo < 0 || rowTo < 0) return null;

    return {
      rowFrom: Math.min(rowFrom, rowTo),
      rowTo: Math.max(rowFrom, rowTo),
      colFrom: Math.min(colFrom, colTo),
      colTo: Math.max(colFrom, colTo),
    };
  }

  function parseA1Selection(selectionText) {
    var text = String(selectionText || "").trim();
    if (!text) return { ok: false, error: "空范围" };

    // Split by comma (English and Chinese)
    var parts = text.split(/[,，]/);
    var cellSet = {}; // "row:col" → true for dedup
    var cells = [];
    var minRow = Infinity;
    var maxRow = -Infinity;
    var minCol = Infinity;
    var maxCol = -Infinity;
    var MAX_CELLS = 2000;

    for (var pi = 0; pi < parts.length; pi++) {
      var part = parts[pi].trim();
      if (!part) continue;

      var parsed = parseA1Range(part);
      if (!parsed) {
        return {
          ok: false,
          error: "手动范围格式不正确，请输入类似 C3:C9 或 C3,C5,C8。错误片段：" + part,
          text: selectionText,
        };
      }

      // Expand the range into individual cells
      var rf = parsed.rowFrom;
      var rt = parsed.rowTo;
      var cf = parsed.colFrom;
      var ct = parsed.colTo;
      if (rf > rt) { var tmpR = rf; rf = rt; rt = tmpR; }
      if (cf > ct) { var tmpC = cf; cf = ct; ct = tmpC; }

      var expanded = (rt - rf + 1) * (ct - cf + 1);
      if (cells.length + expanded > MAX_CELLS) {
        return {
          ok: false,
          error: "手动范围单元格数量超过上限（" + MAX_CELLS + " 个）",
          text: selectionText,
        };
      }

      for (var r = rf; r <= rt; r++) {
        for (var c = cf; c <= ct; c++) {
          var key = r + ":" + c;
          if (cellSet[key]) continue; // dedup
          cellSet[key] = true;
          cells.push({ rowIndex: r, colIndex: c });
          if (r < minRow) minRow = r;
          if (r > maxRow) maxRow = r;
          if (c < minCol) minCol = c;
          if (c > maxCol) maxCol = c;
        }
      }
    }

    if (!cells.length) {
      return { ok: false, error: "手动范围为空", text: selectionText };
    }

    return {
      ok: true,
      method: "manual-selection",
      cells: cells,
      rowFrom: minRow === Infinity ? 0 : minRow,
      rowTo: maxRow === -Infinity ? 0 : maxRow,
      colFrom: minCol === Infinity ? 0 : minCol,
      colTo: maxCol === -Infinity ? 0 : maxCol,
      totalCells: cells.length,
      text: selectionText,
    };
  }

  // ===== Selection Diagnosis API =====

  function diagnoseSelectionApis() {
    var started = Date.now();
    var result = {
      url: location.href,
      title: document.title,
      time: new Date().toISOString(),
      hasWindowApp: !!window.APP,
      hasActiveSheet: !!(window.APP && window.APP.getActiveSheet),
      hasUilCmdTool: !!(window.APP && window.APP.getUilCmdTool),
      activeViewInfo: null,
      getSelectedRangeResult: null,
      triedMethods: [],
      surfaceScanHits: [],
      relevantKeys: [],
    };

    // Active view info
    try {
      var view = getActiveSheetViewLoose();
      if (view) {
        result.activeViewInfo = {
          ctor: view.constructor && view.constructor.name,
          keys: [],
        };
        var desc = {};
        try { desc = Object.getOwnPropertyDescriptors(view); } catch (_) {}
        for (var key in desc) {
          if (/(selection|select|range|active|cell|cursor|focus)/i.test(key)) {
            result.activeViewInfo.keys.push(key);
          }
        }
      }
    } catch (e) {
      result.activeViewInfo = { error: e.message || String(e) };
    }

    // Try each method and record results
    var app = window.APP;
    var sheet = app && app.getActiveSheet && app.getActiveSheet();
    var tool = app && app.getUilCmdTool && app.getUilCmdTool();
    var viewObj = view;

    var methodAttempts = [
      // Priority: confirmed WPS APIs from code traces and diagnosis
      { target: "view", obj: viewObj, name: "getSelectionRange", args: [] },
      { target: "view", obj: viewObj, name: "getSelection", args: [] },
      { target: "app", obj: app, name: "getActiveSheetView", args: [] },
      // view._selection sub-object
      { target: "view._selection", obj: viewObj && viewObj._selection, name: "getSelectionRange", args: [] },
      { target: "view._selection", obj: viewObj && viewObj._selection, name: "getSelection", args: [] },
      // Standard tool APIs
      { target: "tool", obj: tool, name: "getRangeSelection", args: [] },
      { target: "tool", obj: tool, name: "getSelection", args: [] },
      { target: "tool", obj: tool, name: "getSelectionRange", args: [] },
      { target: "tool", obj: tool, name: "getActiveRange", args: [] },
      { target: "tool", obj: tool, name: "getActiveSelection", args: [] },
      { target: "tool", obj: tool, name: "getCurrentSelection", args: [] },
      { target: "tool", obj: tool, name: "getSelectedRanges", args: [] },
      { target: "tool", obj: tool, name: "getSelectionRanges", args: [] },
      { target: "tool", obj: tool, name: "queryActiveRange", args: [] },
      // Other view APIs
      { target: "view", obj: viewObj, name: "getSelectionRANGE", args: [] },
      { target: "view", obj: viewObj, name: "getActiveRange", args: [] },
      { target: "view", obj: viewObj, name: "getSelectedRange", args: [] },
      { target: "view", obj: viewObj, name: "getActiveSelection", args: [] },
      { target: "view", obj: viewObj, name: "getCurrentSelection", args: [] },
      // Sheet APIs
      { target: "sheet", obj: sheet, name: "getSelectionRANGE", args: [] },
      { target: "sheet", obj: sheet, name: "getSelection", args: [] },
      { target: "sheet", obj: sheet, name: "getSelectionRange", args: [] },
      // App APIs
      { target: "app", obj: app, name: "getSelectionRange", args: [] },
      { target: "app", obj: app, name: "getSelection", args: [] },
      { target: "app", obj: app, name: "getActiveRange", args: [] },
      { target: "app", obj: app, name: "getActiveSelection", args: [] },
    ];

    for (var m = 0; m < methodAttempts.length; m++) {
      var attempt = methodAttempts[m];
      var entry = { label: attempt.target + "." + attempt.name + "()" };
      result.triedMethods.push(entry);

      if (!attempt.obj || typeof attempt.obj[attempt.name] !== "function") {
        entry.exists = false;
        entry.error = "方法不存在或对象为 null";
        continue;
      }

      entry.exists = true;
      try {
        var raw = attempt.obj[attempt.name].apply(attempt.obj, attempt.args);
        if (raw == null) {
          entry.result = null;
          entry.bounds = null;
        } else {
          var ctor = raw.constructor && raw.constructor.name;
          var summary = summarizeObjectDeep(raw, 2);
          entry.result = JSON.stringify(summary).slice(0, 2000);
          entry.ctor = ctor;
          entry.bounds = extractRangeBoundsDeep(raw, 3);
        }
      } catch (e) {
        entry.error = e.message || String(e);
      }
    }

    // Surface scan for selection-like keys
    var roots = [
      { name: "APP", value: app },
      { name: "tool", value: tool },
      { name: "activeView", value: viewObj },
      { name: "activeSheet", value: sheet },
      { name: "workbook", value: app && app.workbook },
    ];

    for (var r = 0; r < roots.length; r++) {
      if (!roots[r].value) continue;

      var desc2 = {};
      try { desc2 = Object.getOwnPropertyDescriptors(roots[r].value); } catch (_) { desc2 = {}; }

      for (var key2 in desc2) {
        if (/(selection|select|range|active|cell|cursor|focus|highlight|currentRange)/i.test(key2)) {
          var entry2 = { path: roots[r].name + "." + key2 };
          var val = desc2[key2].value;
          if (val) {
            var vt = typeof val;
            entry2.type = vt;
            if (vt === "function") {
              entry2.preview = functionSourcePreview(val);
              // Try calling zero-arg functions
              if (val.length === 0) {
                try {
                  var callResult = val.call(roots[r].value);
                  if (callResult != null) {
                    entry2.callResult = summarizeValue(callResult);
                    var callBounds = extractRangeBoundsDeep(callResult, 3);
                    if (callBounds) entry2.callBounds = callBounds;
                  }
                } catch (e2) {
                  entry2.callError = e2.message || String(e2);
                }
              }
            } else if (vt === "object") {
              entry2.summary = JSON.stringify(summarizeObjectDeep(val, 2)).slice(0, 800);
              var scanBounds = extractRangeBoundsDeep(val, 3);
              if (scanBounds) entry2.bounds = scanBounds;
            }
          }
          result.relevantKeys.push(entry2);
        }
      }

      // Also scan child properties that look like selection objects
      var descriptors = {};
      try { descriptors = Object.getOwnPropertyDescriptors(roots[r].value); } catch (_) { descriptors = {}; }

      for (var key3 in descriptors) {
        if (!("value" in descriptors[key3])) continue;
        var val3 = descriptors[key3].value;
        if (!val3 || (typeof val3 !== "object" && typeof val3 !== "function")) continue;
        if (/(selection|select|active|range|cursor|focus|highlight)/i.test(key3)) {
          // Skip known pseudo-fields
          if (/\b(_maxUsedRANGE|_autoFillRange|_activeChartDataSource|_activeChartDataSourceIdxMap|_inquireRange|formatPaintRange|_copyingRange|_tmpCopyingRange|_pasteSelectRANGE|_lastSelRange|_lastCellRANGE|_mouseDownRANGE|_allColumnsRANGE|_allRowsRANGE)\b/i.test(key3)) continue;

          try {
            var bounds3 = extractRangeBoundsDeep(val3, 2);
            if (bounds3 && Number.isFinite(bounds3.rowFrom)) {
              result.surfaceScanHits.push({
                path: roots[r].name + "." + key3,
                bounds: bounds3,
                summary: JSON.stringify(summarizeObjectDeep(val3, 2)).slice(0, 1200),
              });
            }
          } catch (_) {}
        }
      }
    }

    // Deep analysis: view.getSelection().windowInfo
    if (viewObj && typeof viewObj.getSelection === "function") {
      try {
        var vsResult = viewObj.getSelection();
        if (vsResult) {
          var wiEntry = { path: "activeView", key: "getSelection().windowInfo" };
          result.viewSelectionAnalysis = {};
          if (vsResult.windowInfo) {
            var wi = vsResult.windowInfo;
            result.viewSelectionAnalysis.hasWindowInfo = true;
            if (wi.selection) {
              result.viewSelectionAnalysis.selectionType = typeof wi.selection;
              result.viewSelectionAnalysis.selectionIsArray = Array.isArray(wi.selection);
              if (Array.isArray(wi.selection) && wi.selection.length) {
                result.viewSelectionAnalysis.selectionLength = wi.selection.length;
                result.viewSelectionAnalysis.selection0Summary = JSON.stringify(summarizeObjectDeep(wi.selection[0], 2)).slice(0, 2000);
                var sel0Bounds = extractRangeBoundsDeep(wi.selection[0], 3);
                if (sel0Bounds) result.viewSelectionAnalysis.selection0Bounds = sel0Bounds;
                else result.viewSelectionAnalysis.selection0Bounds = null;
              }
            }
            if (wi.activeCell) {
              result.viewSelectionAnalysis.activeCellSummary = JSON.stringify(summarizeObjectDeep(wi.activeCell, 2)).slice(0, 1200);
              var acBounds = extractRangeBoundsDeep(wi.activeCell, 3);
              result.viewSelectionAnalysis.activeCellBounds = acBounds || null;
            }
          }
        }
      } catch (e) {
        result.viewSelectionAnalysis = { error: e.message || String(e) };
      }
    }

    // Deep analysis: activeView.selections
    if (viewObj && viewObj.selections) {
      try {
        var selObj = viewObj.selections;
        result.selectionsAnalysis = {};
        if (selObj.private) {
          result.selectionsAnalysis.hasPrivate = true;
          if (selObj.private.arr && Array.isArray(selObj.private.arr)) {
            result.selectionsAnalysis.arrLength = selObj.private.arr.length;
            if (selObj.private.arr.length) {
              result.selectionsAnalysis.arr0Summary = JSON.stringify(summarizeObjectDeep(selObj.private.arr[0], 2)).slice(0, 2000);
              var arr0Bounds = extractRangeBoundsDeep(selObj.private.arr[0], 3);
              result.selectionsAnalysis.arr0Bounds = arr0Bounds || null;
            }
          }
          if (selObj.private.activeCell) {
            result.selectionsAnalysis.activeCellSummary = JSON.stringify(summarizeObjectDeep(selObj.private.activeCell, 2)).slice(0, 1200);
            var aacBounds = extractRangeBoundsDeep(selObj.private.activeCell, 3);
            result.selectionsAnalysis.activeCellBounds = aacBounds || null;
          }
        }
      } catch (e) {
        result.selectionsAnalysis = { error: e.message || String(e) };
      }
    }

    // Run getSelectedRange and record its result
    result.getSelectedRangeResult = getSelectedRange();

    result.elapsedMs = Date.now() - started;
    return result;
  }

  // ===== Deep Attachment ID Search (diagnostic only) =====

  function findAttachmentIdsDeep(value) {
    var result = {
      ids: [],
      paths: [],
      matchedStrings: [],
    };
    var seen = new WeakSet();
    var queue = [{ value: value, path: "", depth: 0 }];
    var maxItems = 5000;
    var scanned = 0;
    var maxDepth = 5;

    // ID field name patterns
    var idKeyPattern = /^(id|oId|oid|subFileId|fileId|attachmentId|annexId|linkId|_id|_oId|_subFileId|_fileId|_attachmentId)$/i;
    // Attachment-related key patterns to follow
    var followPattern = /(link|run|runs|textLink|hyper|annex|attach|address|formula|href|url|download|cell|range|selection|data|meta|value)/i;

    while (queue.length && scanned < maxItems) {
      var item = queue.shift();
      var val = item.value;
      if (val == null) continue;
      if (typeof val === "string") {
        // Search for ID-like strings
        var idMatches = val.match(/[A-Z0-9]{10,32}/g);
        if (idMatches) {
          for (var im = 0; im < idMatches.length; im++) {
            if (result.ids.indexOf(idMatches[im]) < 0) {
              result.ids.push(idMatches[im]);
              result.matchedStrings.push("string-match@" + item.path + ": " + idMatches[im]);
            }
          }
        }
        // Search for kw:annex URLs
        var annexMatches = val.match(/kw:annex[^\s"']*/gi);
        if (annexMatches) {
          for (var am = 0; am < annexMatches.length; am++) {
            var url = annexMatches[am];
            result.matchedStrings.push("annex-url@" + item.path + ": " + url.slice(0, 200));
            var oidMatch = url.match(/oId=([A-Z0-9]{10,32})/i);
            if (oidMatch && result.ids.indexOf(oidMatch[1]) < 0) {
              result.ids.push(oidMatch[1]);
            }
          }
        }
        continue;
      }
      if (typeof val !== "object") continue;
      if (val instanceof Node || val === window || val === document) continue;
      if (seen.has(val)) continue;
      seen.add(val);
      scanned++;

      if (item.depth >= maxDepth) continue;

      // Check for ID-like keys at this level
      var keys = [];
      try {
        if (Array.isArray(val)) {
          for (var ai = 0; ai < Math.min(val.length, 100); ai++) {
            queue.push({ value: val[ai], path: item.path + "[" + ai + "]", depth: item.depth + 1 });
          }
          continue;
        }
        // Get keys from both own properties and prototype descriptors
        var desc = {};
        try { desc = Object.getOwnPropertyDescriptors(val); } catch (_) { desc = {}; }
        keys = Object.keys(desc);
      } catch (_) {
        keys = [];
      }

      for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;

        var childPath = item.path ? item.path + "." + key : key;

        if (idKeyPattern.test(key)) {
          var descVal = desc[key];
          var rawVal = "value" in descVal ? descVal.value : undefined;
          if (typeof rawVal === "function") {
            try { rawVal = rawVal.call(val); } catch (_) {}
          }
          if (rawVal != null && typeof rawVal !== "object") {
            var strVal = String(rawVal);
            if (/^[A-Z0-9]{10,32}$/i.test(strVal)) {
              if (result.ids.indexOf(strVal) < 0) {
                result.ids.push(strVal);
                result.paths.push(childPath);
                result.matchedStrings.push("key-match@" + childPath + ": " + strVal);
              }
            }
          }
        }

        // Follow interesting children
        if (followPattern.test(key) || idKeyPattern.test(key)) {
          if ("value" in descVal) {
            var childVal = descVal.value;
            if (childVal != null && (typeof childVal === "object" || typeof childVal === "string")) {
              queue.push({ value: childVal, path: childPath, depth: item.depth + 1 });
            }
          }
        }
      }

      // Also follow properties from for-in (catches inherited getters)
      try {
        for (var fk in val) {
          if (followPattern.test(fk) && !(fk in desc)) {
            var fv = val[fk];
            if (fv != null) {
              var fp = item.path ? item.path + "." + fk : fk;
              queue.push({ value: fv, path: fp, depth: item.depth + 1 });
            }
          }
        }
      } catch (_) {}
    }

    // Deduplicate
    var uniqueIds = [];
    for (var ui = 0; ui < result.ids.length; ui++) {
      if (uniqueIds.indexOf(result.ids[ui]) < 0) uniqueIds.push(result.ids[ui]);
    }
    result.ids = uniqueIds;
    result.scannedNodes = scanned;

    return result;
  }

  // ===== Selected Attachment Cell Deep Diagnosis =====

  async function diagnoseSelectedAttachmentCells(options) {
    options = options || {};
    var started = Date.now();
    var rangeOverride = options.rangeOverride || "";

    var result = {
      ok: false,
      url: location.href,
      title: document.title,
      time: new Date().toISOString(),
      range: null,
      cells: [],
      summary: { total: 0, diagnosed: 0, truncated: false },
      elapsedMs: 0,
    };

    // Resolve range
    var rangeOpts = {};
    if (rangeOverride && String(rangeOverride).trim()) {
      rangeOpts.rangeOverride = rangeOverride;
    }
    var rangeResult = getSelectedRange(rangeOpts);
    if (!rangeResult.ok && !Number.isFinite(rangeResult.rowFrom)) {
      result.range = rangeResult;
      result.error = rangeResult.error || "无法读取范围";
      result.elapsedMs = Date.now() - started;
      return result;
    }

    var rowFrom = Number(rangeResult.rowFrom);
    var rowTo = Number(rangeResult.rowTo);
    var colFrom = Number(rangeResult.colFrom);
    var colTo = Number(rangeResult.colTo);
    result.range = { rowFrom: rowFrom, rowTo: rowTo, colFrom: colFrom, colTo: colTo, method: rangeResult.method };

    var totalCells = (rowTo - rowFrom + 1) * (colTo - colFrom + 1);
    result.summary.total = totalCells;
    var maxCells = 10;
    var cellCount = 0;
    var truncated = totalCells > maxCells;

    var sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();

    for (var r = rowFrom; r <= rowTo && cellCount < maxCells; r++) {
      for (var c = colFrom; c <= colTo && cellCount < maxCells; c++) {
        cellCount++;

        var cellEntry = {
          rowIndex: r,
          rowNumber: r + 1,
          colIndex: c,
          colName: columnNameFromIndex(c),
          address: columnNameFromIndex(c) + (r + 1),
          cellText: "",
          looksLikeAttachment: false,
          detectedByCurrentLogic: false,
          currentDetectAttempts: [],
          rawSources: {},
        };

        // Read cell text
        try {
          cellEntry.cellText = getWpsCellText(r, c);
          cellEntry.looksLikeAttachment = !!(cellEntry.cellText && /📄/.test(cellEntry.cellText));
        } catch (e) {
          cellEntry.cellText = "[error: " + (e.message || String(e)) + "]";
        }

        // Run current detection logic
        try {
          var currentResult = await detectAttachmentMetaAtCell(r, c);
          if (currentResult) {
            cellEntry.detectedByCurrentLogic = currentResult.isAttachment;
            cellEntry.currentDetectAttempts = currentResult.detectAttempts || [];
          }
        } catch (_) {}

        // === rawSources ===

        // 1. cell-object
        var cellObj = null;
        try {
          cellObj = getCellObjectAt(r, c);
          if (cellObj) {
            var coSummary = summarizeObjectDeep(cellObj, 5);
            var coMeta = scanObjectForAttachmentMeta(cellObj, 10);
            var coIdSearch = findAttachmentIdsDeep(cellObj);
            cellEntry.rawSources["cell-object"] = {
              summary: JSON.stringify(coSummary).slice(0, 5000),
              scanMeta: coMeta ? {
                id: coMeta.id || "",
                fileSize: coMeta.fileSize || "",
                aType: coMeta.aType || "",
                fileName: coMeta.fileName || "",
                text: coMeta.text || "",
              } : null,
              deepIdSearch: {
                ids: coIdSearch.ids,
                paths: coIdSearch.paths.slice(0, 20),
                matchedStrings: coIdSearch.matchedStrings.slice(0, 30),
              },
            };
          }
        } catch (e) {
          cellEntry.rawSources["cell-object"] = { error: e.message || String(e) };
        }

        // 2. activeSheet.getTextLinkRuns(r,c)
        if (sheet) {
          var textLinkMethods = [
            { label: "getTextLinkRuns", fn: function () { return sheet.getTextLinkRuns && sheet.getTextLinkRuns(r, c); } },
            { label: "getTextLinkRunsByCell", fn: function () { return sheet.getTextLinkRunsByCell && sheet.getTextLinkRunsByCell(r, c, cellObj); } },
            { label: "getHyperlink", fn: function () { return sheet.getHyperlink && sheet.getHyperlink(r, c); } },
            { label: "getCoreHyperlinks.getCellLinkRuns", fn: function () {
              if (!sheet.getCoreHyperlinks) return null;
              var core = sheet.getCoreHyperlinks();
              return core && core.getCellLinkRuns && core.getCellLinkRuns(r, c);
            }},
            { label: "getCoreHyperlinks.getHyperlink", fn: function () {
              if (!sheet.getCoreHyperlinks) return null;
              var core = sheet.getCoreHyperlinks();
              return core && core.getHyperlink && core.getHyperlink(r, c);
            }},
          ];

          for (var tm = 0; tm < textLinkMethods.length; tm++) {
            var tlm = textLinkMethods[tm];
            var sourceObj = {};
            try {
              var rawVal = tlm.fn();
              if (rawVal != null) {
                sourceObj.summary = JSON.stringify(summarizeObjectDeep(rawVal, 6)).slice(0, 5000);
                var itemLike = { rowIndex: r, colIndex: c, row: r + 1, type: "selected", key: r + ":" + c, sourceText: cellEntry.cellText, targetBase: cellEntry.cellText };
                var slvMeta = scanLinkRunValueForAttachmentMeta(rawVal, itemLike, "diag-" + tlm.label);
                sourceObj.scanLinkMeta = slvMeta ? {
                  id: slvMeta.id || "",
                  fileSize: slvMeta.fileSize || "",
                  aType: slvMeta.aType || "",
                  fileName: slvMeta.fileName || "",
                  text: slvMeta.text || "",
                  match: slvMeta.match || "",
                } : null;
                var scanObjMeta = scanObjectForAttachmentMeta(rawVal, 10);
                sourceObj.scanObjMeta = scanObjMeta ? {
                  id: scanObjMeta.id || "",
                  fileSize: scanObjMeta.fileSize || "",
                  aType: scanObjMeta.aType || "",
                  fileName: scanObjMeta.fileName || "",
                  text: scanObjMeta.text || "",
                } : null;
                var idSearch = findAttachmentIdsDeep(rawVal);
                sourceObj.deepIdSearch = {
                  ids: idSearch.ids,
                  paths: idSearch.paths.slice(0, 20),
                  matchedStrings: idSearch.matchedStrings.slice(0, 30),
                };
              } else {
                sourceObj.result = null;
              }
            } catch (e2) {
              sourceObj.error = e2.message || String(e2);
            }
            cellEntry.rawSources[tlm.label] = sourceObj;
          }
        }

        // 3. range-query with multiple option variants
        try {
          var range = createWpsRange(r, r, c, c);
          if (range) {
            var rqSources = {};
            var optionVariants = [
              { label: "default", opts: {} },
              { label: "includeTextLinkRuns", opts: { includeTextLinkRuns: true, includeRuns: true } },
              { label: "needTextLinkRuns", opts: { needTextLinkRuns: true, needRuns: true } },
              { label: "withTextLinkRuns", opts: { withTextLinkRuns: true, withRuns: true } },
            ];
            for (var ov = 0; ov < optionVariants.length; ov++) {
              var ovOpt = optionVariants[ov];
              try {
                var rv = await queryRangeValuesViaUil(range, ovOpt.opts);
                if (rv) {
                  var rqEntry = {
                    summary: JSON.stringify(summarizeObjectDeep(rv, 6)).slice(0, 5000),
                  };
                  var rqMeta = scanObjectForAttachmentMeta(rv, 10);
                  rqEntry.scanMeta = rqMeta ? {
                    id: rqMeta.id || "",
                    fileSize: rqMeta.fileSize || "",
                    aType: rqMeta.aType || "",
                    fileName: rqMeta.fileName || "",
                    text: rqMeta.text || "",
                  } : null;
                  var rqIdSearch = findAttachmentIdsDeep(rv);
                  rqEntry.deepIdSearch = {
                    ids: rqIdSearch.ids,
                    paths: rqIdSearch.paths.slice(0, 20),
                    matchedStrings: rqIdSearch.matchedStrings.slice(0, 30),
                  };
                  rqSources[ovOpt.label] = rqEntry;
                } else {
                  rqSources[ovOpt.label] = { result: null };
                }
              } catch (e3) {
                rqSources[ovOpt.label] = { error: e3.message || String(e3) };
              }
            }
            cellEntry.rawSources["range-query"] = rqSources;
          }
        } catch (e) {
          cellEntry.rawSources["range-query"] = { error: e.message || String(e) };
        }

        // 4. selected-hyperlink (read-only, only if single cell)
        if (totalCells === 1) {
          var selHyperSources = {};
          var targets = [];
          var tool2 = window.APP && window.APP.getUilCmdTool && window.APP.getUilCmdTool();
          if (tool2) targets.push({ name: "tool", value: tool2 });
          if (sheet) targets.push({ name: "activeSheet", value: sheet });
          var view2 = getActiveSheetViewLoose();
          if (view2) targets.push({ name: "activeView", value: view2 });
          if (window.APP) targets.push({ name: "APP", value: window.APP });

          var selMethodNames = [
            "getSelectHyperlink", "getSelectedHyperlink", "getSelectionHyperlink",
            "getSelectedLink", "getSelectionLink", "getSelectedTextLink",
            "getHyperlinkByCell", "getCellHyperlink", "getCellTextLink",
            "getTextLinkByCell", "getTextLinkData", "getLinkData", "getLinkInfo",
          ];

          for (var tgi = 0; tgi < targets.length; tgi++) {
            var tg = targets[tgi];
            for (var sm = 0; sm < selMethodNames.length; sm++) {
              var methodName = selMethodNames[sm];
              if (!tg.value || typeof tg.value[methodName] !== "function") continue;
              var entryKey = tg.name + "." + methodName + "()";
              try {
                var shVal = await callMaybePromise(function (done) {
                  var fn2 = tg.value[methodName];
                  if (fn2.length > 0) {
                    // Try with row/col args
                    return fn2.call(tg.value, r, c, done);
                  }
                  return fn2.call(tg.value);
                }, 2000);
                if (shVal != null) {
                  var shEntry = {
                    summary: JSON.stringify(summarizeObjectDeep(shVal, 6)).slice(0, 5000),
                  };
                  var shMeta = scanObjectForAttachmentMeta(shVal, 10);
                  shEntry.scanMeta = shMeta ? {
                    id: shMeta.id || "",
                    fileSize: shMeta.fileSize || "",
                    aType: shMeta.aType || "",
                    fileName: shMeta.fileName || "",
                    text: shMeta.text || "",
                  } : null;
                  var shIdSearch = findAttachmentIdsDeep(shVal);
                  shEntry.deepIdSearch = {
                    ids: shIdSearch.ids,
                    paths: shIdSearch.paths.slice(0, 20),
                    matchedStrings: shIdSearch.matchedStrings.slice(0, 30),
                  };
                  selHyperSources[entryKey] = shEntry;
                }
              } catch (e4) {
                selHyperSources[entryKey] = { error: e4.message || String(e4) };
              }
            }
          }
          cellEntry.rawSources["selected-hyperlink"] = selHyperSources;
        }

        result.cells.push(cellEntry);
      }
    }

    result.ok = true;
    result.summary.diagnosed = result.cells.length;
    result.summary.truncated = truncated;
    result.elapsedMs = Date.now() - started;
    return result;
  }

  function getSelectedRange(options) {
    options = options || {};

    // Manual range override
    var rangeOverride = options.rangeOverride || "";
    if (rangeOverride && String(rangeOverride).trim()) {
      var parsed = parseA1Selection(rangeOverride);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, rangeOverride: rangeOverride };
      }
      parsed.ok = true;
      return parsed;
    }

    var app = window.APP;
    var sheet = app && app.getActiveSheet && app.getActiveSheet();
    var view = getActiveSheetViewLoose();
    var tool = app && app.getUilCmdTool && app.getUilCmdTool();

    // Priority attempts — WPS current-version confirmed APIs first
    var attempts = [
      // == view.getSelectionRange() — confirmed via WPS source ==
      ["view.getSelectionRange()", function () {
        if (!view || typeof view.getSelectionRange !== "function") return null;
        return view.getSelectionRange();
      }],

      // == view.getSelection() — returns windowInfo.selection ==
      ["view.getSelection()", function () {
        if (!view || typeof view.getSelection !== "function") return null;
        return view.getSelection();
      }],

      // == app.getActiveSheetView().getSelectionRange() — confirmed via WPS source ==
      ["app.getActiveSheetView().getSelectionRange()", function () {
        if (!app || typeof app.getActiveSheetView !== "function") return null;
        var sv = app.getActiveSheetView();
        if (!sv || typeof sv.getSelectionRange !== "function") return null;
        return sv.getSelectionRange();
      }],

      // == view._selection sub-object ==
      ["view._selection.getSelectionRange()", function () {
        if (!view || !view._selection || typeof view._selection.getSelectionRange !== "function") return null;
        return view._selection.getSelectionRange();
      }],
      ["view._selection.getSelection()", function () {
        if (!view || !view._selection || typeof view._selection.getSelection !== "function") return null;
        return view._selection.getSelection();
      }],

      // == selections object (diagnosis found selections.private.arr) ==
      ["view.selections", function () {
        if (!view || !view.selections) return null;
        var selObj = view.selections;
        // selections.private.arr[0]
        if (selObj.private && selObj.private.arr && Array.isArray(selObj.private.arr) && selObj.private.arr.length) {
          return selObj.private.arr[0];
        }
        return selObj;
      }],

      // == tool APIs ==
      ["tool.getRangeSelection()", function () {
        if (!tool || typeof tool.getRangeSelection !== "function") return null;
        return tool.getRangeSelection();
      }],
      ["tool.getSelection()", function () {
        if (!tool || typeof tool.getSelection !== "function") return null;
        return tool.getSelection();
      }],
      ["tool.getSelectionRange()", function () {
        if (!tool || typeof tool.getSelectionRange !== "function") return null;
        return tool.getSelectionRange();
      }],
      ["tool.getActiveRange()", function () {
        if (!tool || typeof tool.getActiveRange !== "function") return null;
        return tool.getActiveRange();
      }],
      ["tool.getActiveSelection()", function () {
        if (!tool || typeof tool.getActiveSelection !== "function") return null;
        return tool.getActiveSelection();
      }],
      ["tool.getCurrentSelection()", function () {
        if (!tool || typeof tool.getCurrentSelection !== "function") return null;
        return tool.getCurrentSelection();
      }],
      ["tool.getSelectedRanges()", function () {
        if (!tool || typeof tool.getSelectedRanges !== "function") return null;
        return tool.getSelectedRanges();
      }],
      ["tool.getSelectionRanges()", function () {
        if (!tool || typeof tool.getSelectionRanges !== "function") return null;
        return tool.getSelectionRanges();
      }],

      // == remaining view APIs ==
      ["view.getSelectionRANGE()", function () {
        if (!view || typeof view.getSelectionRANGE !== "function") return null;
        return view.getSelectionRANGE();
      }],
      ["view.getActiveRange()", function () {
        if (!view || typeof view.getActiveRange !== "function") return null;
        return view.getActiveRange();
      }],
      ["view.getSelectedRange()", function () {
        if (!view || typeof view.getSelectedRange !== "function") return null;
        return view.getSelectedRange();
      }],
      ["view.getActiveSelection()", function () {
        if (!view || typeof view.getActiveSelection !== "function") return null;
        return view.getActiveSelection();
      }],
      ["view.getCurrentSelection()", function () {
        if (!view || typeof view.getCurrentSelection !== "function") return null;
        return view.getCurrentSelection();
      }],

      // == sheet APIs ==
      ["sheet.getSelectionRANGE()", function () {
        if (!sheet || typeof sheet.getSelectionRANGE !== "function") return null;
        return sheet.getSelectionRANGE();
      }],
      ["sheet.getSelection()", function () {
        if (!sheet || typeof sheet.getSelection !== "function") return null;
        return sheet.getSelection();
      }],
      ["sheet.getSelectionRange()", function () {
        if (!sheet || typeof sheet.getSelectionRange !== "function") return null;
        return sheet.getSelectionRange();
      }],

      // == app APIs ==
      ["app.getSelectionRange()", function () {
        if (!app || typeof app.getSelectionRange !== "function") return null;
        return app.getSelectionRange();
      }],
      ["app.getSelection()", function () {
        if (!app || typeof app.getSelection !== "function") return null;
        return app.getSelection();
      }],
      ["app.getActiveRange()", function () {
        if (!app || typeof app.getActiveRange !== "function") return null;
        return app.getActiveRange();
      }],
      ["app.getActiveSelection()", function () {
        if (!app || typeof app.getActiveSelection !== "function") return null;
        return app.getActiveSelection();
      }],

      ["tool.queryActiveRange()", function () {
        if (!tool || typeof tool.queryActiveRange !== "function") return null;
        return tool.queryActiveRange();
      }],
    ];

    function markSelectedRangeOk(range, method) {
      if (!range) return range;
      range.ok = true;
      if (method) range.method = method;
      return range;
    }

    var lastError = null;
    for (var i = 0; i < attempts.length; i++) {
      var label = attempts[i][0];
      var fn = attempts[i][1];
      try {
        var result = fn();
        if (result) {
          var rangeInfo = extractRangeBoundsDeep(result, 3);
          if (rangeInfo && Number.isFinite(rangeInfo.rowFrom) && Number.isFinite(rangeInfo.colFrom)) {
            return markSelectedRangeOk(rangeInfo, label);
          }

          // Special handling: view.getSelection() may return windowInfo.selection array
          if (/view\.getSelection/.test(label)) {
            var wiSel = result;
            // Try windowInfo.selection[0]
            try {
              if (wiSel.windowInfo && wiSel.windowInfo.selection && Array.isArray(wiSel.windowInfo.selection) && wiSel.windowInfo.selection.length) {
                var sel0 = wiSel.windowInfo.selection[0];
                var sel0Range = extractRangeBoundsDeep(sel0, 3);
                if (sel0Range && Number.isFinite(sel0Range.rowFrom) && Number.isFinite(sel0Range.colFrom)) {
                  return markSelectedRangeOk(sel0Range, label + ".windowInfo.selection[0]");
                }
              }
            } catch (_) {}
            // Try windowInfo.activeCell
            try {
              if (wiSel.windowInfo && wiSel.windowInfo.activeCell) {
                var ac = wiSel.windowInfo.activeCell;
                var acRange = extractRangeBoundsDeep(ac, 3);
                if (acRange && Number.isFinite(acRange.rowFrom) && Number.isFinite(acRange.colFrom)) {
                  return markSelectedRangeOk(acRange, label + ".windowInfo.activeCell");
                }
              }
            } catch (_) {}
            // Try activeCell on the result directly
            try {
              if (wiSel.activeCell) {
                var dac = wiSel.activeCell;
                var dacRange = extractRangeBoundsDeep(dac, 3);
                if (dacRange && Number.isFinite(dacRange.rowFrom) && Number.isFinite(dacRange.colFrom)) {
                  return markSelectedRangeOk(dacRange, label + ".activeCell");
                }
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        lastError = { method: label, message: e.message || String(e) };
      }
    }

    var scannedRange = findSelectedRangeBySurfaceScan();
    if (scannedRange && Number.isFinite(scannedRange.rowFrom) && Number.isFinite(scannedRange.colFrom)) {
      return markSelectedRangeOk(scannedRange, scannedRange.method);
    }

    return {
      ok: false,
      error: "无法读取当前选区：所有已知的选区 API 均失败",
      lastError: lastError,
      triedMethods: attempts.map(function (a) { return a[0]; }),
    };
  }

  function extractRangeBounds(raw) {
    if (!raw || typeof raw !== "object") return null;
    var bounds = {
      rowFrom: getFieldNumber(raw, ["rowFrom", "startRow", "rowStart", "firstRow", "fromRow", "topRow", "row1", "r1", "_rowFrom", "_startRow"]),
      rowTo: getFieldNumber(raw, ["rowTo", "endRow", "rowEnd", "lastRow", "toRow", "bottomRow", "row2", "r2", "_rowTo", "_endRow"]),
      colFrom: getFieldNumber(raw, ["colFrom", "startCol", "colStart", "firstCol", "fromCol", "leftCol", "col1", "c1", "_colFrom", "_startCol"]),
      colTo: getFieldNumber(raw, ["colTo", "endCol", "colEnd", "lastCol", "toCol", "rightCol", "col2", "c2", "_colTo", "_endCol"]),
    };

    var singleRow = getFieldNumber(raw, ["row", "ri", "rowIndex", "_row", "_ri"]);
    var singleCol = getFieldNumber(raw, ["col", "ci", "colIndex", "_col", "_ci"]);
    if (!Number.isFinite(bounds.rowFrom) && Number.isFinite(singleRow)) {
      bounds.rowFrom = singleRow;
      bounds.rowTo = singleRow;
    }
    if (!Number.isFinite(bounds.colFrom) && Number.isFinite(singleCol)) {
      bounds.colFrom = singleCol;
      bounds.colTo = singleCol;
    }

    // rowOff / colOff (WPS internal cell offset style)
    if (!Number.isFinite(bounds.rowFrom)) {
      var ro = getFieldNumber(raw, ["rowOff", "_rowOff"]);
      if (Number.isFinite(ro)) { bounds.rowFrom = ro; bounds.rowTo = ro; }
    }
    if (!Number.isFinite(bounds.colFrom)) {
      var co = getFieldNumber(raw, ["colOff", "_colOff"]);
      if (Number.isFinite(co)) { bounds.colFrom = co; bounds.colTo = co; }
    }

    // idxRg (WPS internal indexed range)
    if (!Number.isFinite(bounds.rowFrom)) {
      var idxRg = raw.idxRg;
      if (idxRg && typeof idxRg === "object") {
        var irFrom = getFieldNumber(idxRg, ["_start", "start", "first", "rowFrom"]);
        var irTo = getFieldNumber(idxRg, ["_end", "end", "last", "rowTo"]);
        if (Number.isFinite(irFrom)) { bounds.rowFrom = irFrom; bounds.rowTo = Number.isFinite(irTo) ? irTo : irFrom; }
      }
    }

    // Handle getter methods
    if (raw.getRowFrom && typeof raw.getRowFrom === "function") {
      try { bounds.rowFrom = Number(raw.getRowFrom()); } catch (_) {}
    }
    if (raw.getRowTo && typeof raw.getRowTo === "function") {
      try { bounds.rowTo = Number(raw.getRowTo()); } catch (_) {}
    }
    if (raw.getColFrom && typeof raw.getColFrom === "function") {
      try { bounds.colFrom = Number(raw.getColFrom()); } catch (_) {}
    }
    if (raw.getColTo && typeof raw.getColTo === "function") {
      try { bounds.colTo = Number(raw.getColTo()); } catch (_) {}
    }
    if (raw.getStartRow && typeof raw.getStartRow === "function") {
      try { bounds.rowFrom = Number(raw.getStartRow()); } catch (_) {}
    }
    if (raw.getEndRow && typeof raw.getEndRow === "function") {
      try { bounds.rowTo = Number(raw.getEndRow()); } catch (_) {}
    }
    if (raw.getStartCol && typeof raw.getStartCol === "function") {
      try { bounds.colFrom = Number(raw.getStartCol()); } catch (_) {}
    }
    if (raw.getEndCol && typeof raw.getEndCol === "function") {
      try { bounds.colTo = Number(raw.getEndCol()); } catch (_) {}
    }

    if (raw.getRow && typeof raw.getRow === "function") {
      try {
        var r = Number(raw.getRow());
        if (Number.isFinite(r)) { bounds.rowFrom = r; bounds.rowTo = r; }
      } catch (_) {}
    }
    if (raw.getCol && typeof raw.getCol === "function") {
      try {
        var c = Number(raw.getCol());
        if (Number.isFinite(c)) { bounds.colFrom = c; bounds.colTo = c; }
      } catch (_) {}
    }

    // If we have a selections array on the raw object, try the first element
    if (!Number.isFinite(bounds.rowFrom) && raw.selections) {
      try {
        var selArray = raw.selections;
        if (typeof selArray === "function") selArray = selArray.call(raw);
        if (Array.isArray(selArray) && selArray.length) {
          var selBounds = extractRangeBoundsDeep(selArray[0], 2);
          if (selBounds && Number.isFinite(selBounds.rowFrom)) {
            bounds.rowFrom = selBounds.rowFrom;
            bounds.rowTo = selBounds.rowTo;
            bounds.colFrom = selBounds.colFrom;
            bounds.colTo = selBounds.colTo;
          }
        }
      } catch (_) {}
    }

    if (Number.isFinite(bounds.rowFrom) && !Number.isFinite(bounds.rowTo)) bounds.rowTo = bounds.rowFrom;
    if (Number.isFinite(bounds.colFrom) && !Number.isFinite(bounds.colTo)) bounds.colTo = bounds.colFrom;

    if (Number.isFinite(bounds.rowTo) && !Number.isFinite(bounds.rowFrom)) bounds.rowFrom = bounds.rowTo;
    if (Number.isFinite(bounds.colTo) && !Number.isFinite(bounds.colFrom)) bounds.colFrom = bounds.colTo;

    if (!Number.isFinite(bounds.rowFrom) || !Number.isFinite(bounds.colFrom)) return null;
    if (!Number.isFinite(bounds.rowTo)) bounds.rowTo = bounds.rowFrom;
    if (!Number.isFinite(bounds.colTo)) bounds.colTo = bounds.colFrom;

    return {
      rowFrom: Math.min(bounds.rowFrom, bounds.rowTo),
      rowTo: Math.max(bounds.rowFrom, bounds.rowTo),
      colFrom: Math.min(bounds.colFrom, bounds.colTo),
      colTo: Math.max(bounds.colFrom, bounds.colTo),
    };
  }

  // ===== Enhanced Attachment Detection =====

  async function detectAttachmentMetaAtCell(rowIndex, colIndex) {
    var result = {
      rowIndex: rowIndex,
      colIndex: colIndex,
      cellText: "",
      isAttachment: false,
      attachmentMeta: null,
      detectSource: "",
      detectAttempts: [],
      error: null,
    };

    // Step 0: Read cell text
    try {
      result.cellText = getWpsCellText(rowIndex, colIndex);
    } catch (e) {
      result.error = "读取单元格文本失败: " + (e.message || String(e));
      return result;
    }

    // Step 1: Scan cell object
    var cellObj = null;
    try {
      cellObj = getCellObjectAt(rowIndex, colIndex);
      if (cellObj) {
        var cellMeta = scanObjectForAttachmentMeta(cellObj, 8);
        if (cellMeta && cellMeta.id) {
          result.isAttachment = true;
          result.attachmentMeta = {
            subFileId: cellMeta.id,
            fileSize: cellMeta.fileSize || "",
            aType: cellMeta.aType || "pdf",
            fileName: cellMeta.fileName || "",
            text: cellMeta.text || "",
            displayName: result.cellText.replace(/^📄/, ""),
          };
          result.detectSource = "cell-object";
          result.detectAttempts.push({ path: "cell-object", ok: true, id: cellMeta.id });
          return result;
        }
        result.detectAttempts.push({ path: "cell-object", ok: false, reason: "no-id" });
      } else {
        result.detectAttempts.push({ path: "cell-object", ok: false, reason: "no-cell-obj" });
      }
    } catch (e) {
      result.detectAttempts.push({ path: "cell-object", ok: false, reason: "error", error: e.message || String(e) });
    }

    // Step 2: Try hyperlink providers (direct calls only — fast path)
    var sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
    if (sheet) {
      var directCalls = [
        {
          label: "getTextLinkRuns",
          fn: function () {
            if (!sheet.getTextLinkRuns) return null;
            return sheet.getTextLinkRuns(rowIndex, colIndex);
          },
        },
        {
          label: "getTextLinkRunsByCell",
          fn: function () {
            if (!sheet.getTextLinkRunsByCell) return null;
            return sheet.getTextLinkRunsByCell(rowIndex, colIndex, cellObj);
          },
        },
        {
          label: "getHyperlink",
          fn: function () {
            if (!sheet.getHyperlink) return null;
            return sheet.getHyperlink(rowIndex, colIndex);
          },
        },
        {
          label: "getCoreHyperlinks.getCellLinkRuns",
          fn: function () {
            if (!sheet.getCoreHyperlinks) return null;
            var core = sheet.getCoreHyperlinks();
            if (!core || !core.getCellLinkRuns) return null;
            return core.getCellLinkRuns(rowIndex, colIndex);
          },
        },
        {
          label: "getCoreHyperlinks.getHyperlink",
          fn: function () {
            if (!sheet.getCoreHyperlinks) return null;
            var core = sheet.getCoreHyperlinks();
            if (!core || !core.getHyperlink) return null;
            return core.getHyperlink(rowIndex, colIndex);
          },
        },
      ];

      for (var dl = 0; dl < directCalls.length; dl++) {
        var dc = directCalls[dl];
        try {
          var rawValue = dc.fn();
          if (rawValue != null) {
            // First: direct extraction without plan matching (for user-selected cells)
            var exactMeta = extractAttachmentMetaFromExactCellLinkRuns(rawValue, result.cellText, "text-link-runs:" + dc.label);
            if (exactMeta && exactMeta.subFileId) {
              result.isAttachment = true;
              result.attachmentMeta = exactMeta;
              result.detectSource = exactMeta.source;
              result.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: true, id: exactMeta.subFileId, source: "exact-cell-link-run" });
              return result;
            }
            // Fallback: plan-matched extraction (for plan-based workflows)
            var linkMeta = scanLinkRunValueForAttachmentMeta(rawValue, { rowIndex: rowIndex, colIndex: colIndex }, "direct-" + dc.label);
            if (linkMeta && linkMeta.id) {
              result.isAttachment = true;
              result.attachmentMeta = {
                subFileId: linkMeta.id,
                fileSize: linkMeta.fileSize || "",
                aType: linkMeta.aType || "pdf",
                fileName: linkMeta.fileName || "",
                text: linkMeta.text || linkMeta.matchedText || "",
                displayName: result.cellText.replace(/^📄/, ""),
              };
              result.detectSource = "text-link-runs:" + dc.label;
              result.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: true, id: linkMeta.id, source: "plan-matched" });
              return result;
            }
            result.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: false, reason: "no-id-in-result" });
          } else {
            result.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: false, reason: "null-result" });
          }
        } catch (e) {
          result.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: false, reason: "error", error: e.message || String(e) });
        }
      }
    } else {
      result.detectAttempts.push({ path: "text-link-runs", ok: false, reason: "no-active-sheet" });
    }

    // Step 3: Try range query (slower — do last)
    try {
      var range = createWpsRange(rowIndex, rowIndex, colIndex, colIndex);
      if (range) {
        var optionVariants = [
          { includeTextLinkRuns: true, includeRuns: true },
          { needTextLinkRuns: true, needRuns: true },
          { withTextLinkRuns: true, withRuns: true },
          {},
        ];
        var found = false;
        for (var ov = 0; ov < optionVariants.length && !found; ov++) {
          try {
            var rv = await queryRangeValuesViaUil(range, optionVariants[ov]);
            if (rv) {
              var rqMeta = scanObjectForAttachmentMeta(rv, 8);
              if (rqMeta && rqMeta.id) {
                result.isAttachment = true;
                result.attachmentMeta = {
                  subFileId: rqMeta.id,
                  fileSize: rqMeta.fileSize || "",
                  aType: rqMeta.aType || "pdf",
                  fileName: rqMeta.fileName || "",
                  text: rqMeta.text || "",
                  displayName: result.cellText.replace(/^📄/, ""),
                };
                result.detectSource = "range-query";
                result.detectAttempts.push({ path: "range-query", ok: true, id: rqMeta.id });
                found = true;
              }
            }
          } catch (e2) {
            // individual query variant failure is non-fatal
          }
        }
        if (!found) {
          result.detectAttempts.push({ path: "range-query", ok: false, reason: "no-id" });
        }
      } else {
        result.detectAttempts.push({ path: "range-query", ok: false, reason: "no-range-object" });
      }
    } catch (e) {
      result.detectAttempts.push({ path: "range-query", ok: false, reason: "error", error: e.message || String(e) });
    }

    if (result.isAttachment) return result;

    // Step 4: Check cell text — if it looks like an attachment display (starts with 📄)
    // but has no id, mark as non-attachment with a specific reason
    if (result.cellText && /📄/.test(result.cellText)) {
      result.detectAttempts.push({
        path: "cell-text-heuristic",
        ok: false,
        reason: "looks-like-attachment-but-no-link-id",
      });
    }

    // Not an attachment
    result.isAttachment = false;
    return result;
  }

  // ===== Plan-Attachment-Map fallback for ID resolution =====

  function normalizeCellTextForMatching(text) {
    return normalizeAttachmentDisplayName(text)
      .replace(/^📄/u, "")
      .replace(/\.(pdf|docx?|xlsx?|xls|png|jpe?g)$/i, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function buildResolveContext() {
    return {
      plan: null,
      attachmentMap: null,
      normalizedPlanItems: null,
      _planLoaded: false,
      _mapLoaded: false,
    };
  }

  async function ensureResolveContext(ctx) {
    if (!ctx._planLoaded) {
      try {
        ctx.plan = await buildPlanDirectlyFromPage();
        ctx._planLoaded = true;
        // Build normalized index for plan items
        ctx.normalizedPlanItems = (ctx.plan || []).map(function (item) {
          return {
            item: item,
            normSource: normalizeCellTextForMatching(item.sourceText || ""),
            normTarget: normalizeCellTextForMatching(item.targetBase || ""),
          };
        });
      } catch (_) {
        ctx.plan = [];
        ctx.normalizedPlanItems = [];
        ctx._planLoaded = true;
      }
    }

    if (!ctx._mapLoaded) {
      try {
        ctx.attachmentMap = window.WPSBatch && window.WPSBatch.lastAutoAttachmentMap;
        if (!ctx.attachmentMap) {
          ctx.attachmentMap = loadPersistedAttachmentMap();
        }
        if (!ctx.attachmentMap) {
          ctx.attachmentMap = await makeAutoAttachmentMap({ allowSelectionMutation: false });
        }
        ctx._mapLoaded = true;
      } catch (_) {
        ctx.attachmentMap = null;
        ctx._mapLoaded = true;
      }
    }

    return ctx;
  }

  function resolveSelectedCellAttachmentByPlan(rowIndex, colIndex, cellText, ctx) {
    if (!ctx || !ctx.plan || !ctx.plan.length) {
      return { ok: false, reason: "no-plan" };
    }

    var normCell = normalizeCellTextForMatching(cellText || "");

    // Priority 1: exact rowIndex + colIndex match
    for (var i = 0; i < ctx.plan.length; i++) {
      var item = ctx.plan[i];
      var itemRi = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
      var itemCi = Number.isFinite(item.colIndex) ? item.colIndex : -1;
      if (itemRi === rowIndex && itemCi === colIndex) {
        return resolveFromPlanItem(item, ctx, "row-col-exact");
      }
    }

    // Priority 2: rowIndex matches (use first match in the column)
    for (var j = 0; j < ctx.plan.length; j++) {
      var item2 = ctx.plan[j];
      var itemRi2 = Number.isFinite(item2.rowIndex) ? item2.rowIndex : Number(item2.row) - 1;
      if (itemRi2 === rowIndex) {
        return resolveFromPlanItem(item2, ctx, "row-match");
      }
    }

    // Priority 3: normalized sourceText match
    for (var k = 0; k < (ctx.normalizedPlanItems || []).length; k++) {
      var npi = ctx.normalizedPlanItems[k];
      if (npi.normSource && npi.normSource === normCell) {
        return resolveFromPlanItem(npi.item, ctx, "source-text-match");
      }
    }

    // Priority 4: normalized targetBase match
    for (var l = 0; l < (ctx.normalizedPlanItems || []).length; l++) {
      var npi2 = ctx.normalizedPlanItems[l];
      if (npi2.normTarget && npi2.normTarget === normCell) {
        return resolveFromPlanItem(npi2.item, ctx, "target-match");
      }
    }

    // Priority 5: partial match — cell text contains source/target or vice versa
    if (normCell) {
      for (var m = 0; m < (ctx.normalizedPlanItems || []).length; m++) {
        var npi3 = ctx.normalizedPlanItems[m];
        if ((npi3.normSource && (npi3.normSource.indexOf(normCell) >= 0 || normCell.indexOf(npi3.normSource) >= 0)) ||
            (npi3.normTarget && (npi3.normTarget.indexOf(normCell) >= 0 || normCell.indexOf(npi3.normTarget) >= 0))) {
          return resolveFromPlanItem(npi3.item, ctx, "partial-match");
        }
      }
    }

    return { ok: false, reason: "no-plan-item-matched" };
  }

  function resolveFromPlanItem(item, ctx, matchSource) {
    var map = ctx.attachmentMap;
    if (!map) return { ok: false, reason: "no-attachment-map" };

    var id =
      (map[item.type] && map[item.type][item.key]) ||
      (map.flat && map.flat[item.type + ":" + item.key]) ||
      (map.flat && map.flat[item.sourceText]) ||
      (map.flat && map.flat[item.targetBase]);

    if (!id) {
      return { ok: false, reason: "no-id-in-map", type: item.type, key: item.key };
    }

    return {
      ok: true,
      subFileId: typeof id === "string" ? id : (id && id.id),
      type: item.type,
      key: item.key,
      sourceText: item.sourceText,
      targetBase: item.targetBase,
      matchSource: "plan-attachment-map:" + matchSource,
      planItem: item,
    };
  }

  // ===== Main Cell Inspection (sync best-effort) =====

  function inspectSelectedAttachmentCells(options) {
    options = options || {};
    var rangeResult = getSelectedRange(options);
    if (!rangeResult.ok && !Number.isFinite(rangeResult.rowFrom) && (!rangeResult.cells || !rangeResult.cells.length)) {
      return {
        ok: false,
        error: rangeResult.error || "无法读取当前选区",
        range: rangeResult,
        cells: [],
      };
    }

    var cells = [];
    var nonAttachmentCount = 0;
    var attachmentCount = 0;
    var errorCount = 0;
    var pendingAsyncCells = []; // cells that need async range-query detection

    // Build iteration list — either discrete cells or rectangular loop
    var iterCells = [];
    if (rangeResult.cells && rangeResult.cells.length) {
      iterCells = rangeResult.cells;
    } else {
      var rowFrom = Number(rangeResult.rowFrom);
      var rowTo = Number(rangeResult.rowTo);
      var colFrom = Number(rangeResult.colFrom);
      var colTo = Number(rangeResult.colTo);
      var totalCells = (rowTo - rowFrom + 1) * (colTo - colFrom + 1);
      if (totalCells > 2000) {
        return {
          ok: false,
          error: "选区过大（" + totalCells + " 个单元格），请缩小选区（最多 2000 个单元格）",
          range: { rowFrom: rowFrom, rowTo: rowTo, colFrom: colFrom, colTo: colTo },
          cells: [],
        };
      }
      for (var rr = rowFrom; rr <= rowTo; rr++) {
        for (var cc = colFrom; cc <= colTo; cc++) {
          iterCells.push({ rowIndex: rr, colIndex: cc });
        }
      }
    }

    var totalCells = iterCells.length;
    var actualRange = rangeResult.cells ? rangeResult : {
      rowFrom: Number(rangeResult.rowFrom), rowTo: Number(rangeResult.rowTo),
      colFrom: Number(rangeResult.colFrom), colTo: Number(rangeResult.colTo),
      method: rangeResult.method,
    };

    for (var ii = 0; ii < iterCells.length; ii++) {
      var r = iterCells[ii].rowIndex;
      var c = iterCells[ii].colIndex;
        var entry = {
          rowIndex: r,
          colIndex: c,
          rowNumber: r + 1,
          colName: columnNameFromIndex(c),
          cellText: "",
          isAttachment: false,
          attachmentMeta: null,
          detectSource: "",
          detectAttempts: [],
          error: null,
        };

        // Read cell text
        try {
          entry.cellText = getWpsCellText(r, c);
        } catch (e) {
          entry.error = "读取单元格文本失败: " + (e.message || String(e));
          entry.detectAttempts.push({ path: "cell-text", ok: false, error: e.message });
          errorCount++;
          cells.push(entry);
          continue;
        }

        // Try cell object (sync — fast path)
        var cellObj = null;
        try {
          cellObj = getCellObjectAt(r, c);
          if (cellObj) {
            var cellMeta = scanObjectForAttachmentMeta(cellObj, 8);
            if (cellMeta && cellMeta.id) {
              entry.isAttachment = true;
              entry.attachmentMeta = {
                subFileId: cellMeta.id,
                fileSize: cellMeta.fileSize || "",
                aType: cellMeta.aType || "pdf",
                fileName: cellMeta.fileName || "",
                text: cellMeta.text || "",
                displayName: entry.cellText.replace(/^📄/, ""),
              };
              entry.detectSource = "cell-object";
              entry.detectAttempts.push({ path: "cell-object", ok: true, id: cellMeta.id });
              attachmentCount++;
              cells.push(entry);
              continue;
            }
            entry.detectAttempts.push({ path: "cell-object", ok: false, reason: "no-id" });
          } else {
            entry.detectAttempts.push({ path: "cell-object", ok: false, reason: "no-cell-obj" });
          }
        } catch (e) {
          entry.detectAttempts.push({ path: "cell-object", ok: false, reason: "error", error: e.message || String(e) });
        }

        // Try hyperlink providers (sync — try direct calls)
        var sheet = window.APP && window.APP.getActiveSheet && window.APP.getActiveSheet();
        var foundViaLink = false;
        if (sheet) {
          var directCalls = [
            {
              label: "getTextLinkRuns",
              fn: function () { return sheet.getTextLinkRuns && sheet.getTextLinkRuns(r, c); },
            },
            {
              label: "getTextLinkRunsByCell",
              fn: function () { return sheet.getTextLinkRunsByCell && sheet.getTextLinkRunsByCell(r, c, cellObj); },
            },
            {
              label: "getHyperlink",
              fn: function () { return sheet.getHyperlink && sheet.getHyperlink(r, c); },
            },
            {
              label: "getCoreHyperlinks.getCellLinkRuns",
              fn: function () {
                if (!sheet.getCoreHyperlinks) return null;
                var core = sheet.getCoreHyperlinks();
                return core && core.getCellLinkRuns && core.getCellLinkRuns(r, c);
              },
            },
            {
              label: "getCoreHyperlinks.getHyperlink",
              fn: function () {
                if (!sheet.getCoreHyperlinks) return null;
                var core = sheet.getCoreHyperlinks();
                return core && core.getHyperlink && core.getHyperlink(r, c);
              },
            },
          ];

          for (var dl = 0; dl < directCalls.length; dl++) {
            var dc = directCalls[dl];
            try {
              var rawValue = dc.fn();
              if (rawValue != null) {
                // First: direct extraction without plan matching (for user-selected cells)
                var exactMeta = extractAttachmentMetaFromExactCellLinkRuns(rawValue, entry.cellText, "text-link-runs:" + dc.label);
                if (exactMeta && exactMeta.subFileId) {
                  entry.isAttachment = true;
                  entry.attachmentMeta = exactMeta;
                  entry.detectSource = exactMeta.source;
                  entry.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: true, id: exactMeta.subFileId, source: "exact-cell-link-run" });
                  attachmentCount++;
                  foundViaLink = true;
                  break;
                }
                // Fallback: plan-matched extraction
                var linkMeta = scanLinkRunValueForAttachmentMeta(
                  rawValue,
                  { rowIndex: r, colIndex: c },
                  "direct-" + dc.label
                );
                if (linkMeta && linkMeta.id) {
                  entry.isAttachment = true;
                  entry.attachmentMeta = {
                    subFileId: linkMeta.id,
                    fileSize: linkMeta.fileSize || "",
                    aType: linkMeta.aType || "pdf",
                    fileName: linkMeta.fileName || "",
                    text: linkMeta.text || linkMeta.matchedText || "",
                    displayName: entry.cellText.replace(/^📄/, ""),
                  };
                  entry.detectSource = "text-link-runs:" + dc.label;
                  entry.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: true, id: linkMeta.id, source: "plan-matched" });
                  attachmentCount++;
                  foundViaLink = true;
                  break;
                }
                entry.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: false, reason: "no-id-in-result" });
              } else {
                entry.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: false, reason: "null-result" });
              }
            } catch (e) {
              entry.detectAttempts.push({ path: "text-link-runs", method: dc.label, ok: false, reason: "error", error: e.message || String(e) });
            }
          }
        } else {
          entry.detectAttempts.push({ path: "text-link-runs", ok: false, reason: "no-active-sheet" });
        }

        if (foundViaLink) {
          cells.push(entry);
          continue;
        }

        // If not found yet, mark for async range-query
        if (!entry.isAttachment) {
          // Check cell text heuristic
          if (entry.cellText && /📄/.test(entry.cellText)) {
            entry.detectAttempts.push({ path: "cell-text-heuristic", ok: false, reason: "looks-like-attachment-but-no-link-id" });
          }
          pendingAsyncCells.push({ cellEntry: entry, cellObj: cellObj });
          nonAttachmentCount++;
        }

        cells.push(entry);
      }

    var result = {
      ok: true,
      range: actualRange,
      cells: cells,
      summary: {
        totalCells: totalCells,
        attachmentCount: attachmentCount,
        nonAttachmentCount: nonAttachmentCount,
        errorCount: errorCount,
      },
      _pendingAsyncCells: pendingAsyncCells,
    };

    return result;
  }

  // Async variant: re-checks cells via range-query
  async function inspectSelectedAttachmentCellsAsync(options) {
    var result = inspectSelectedAttachmentCells(options);
    if (!result.ok) return result;

    var pending = result._pendingAsyncCells || [];
    if (!pending.length) {
      delete result._pendingAsyncCells;
      return result;
    }

    for (var pa = 0; pa < pending.length; pa++) {
      var pc = pending[pa];
      var entry = pc.cellEntry;
      var rowIndex = entry.rowIndex;
      var colIndex = entry.colIndex;

      // Try range query
      try {
        var range = createWpsRange(rowIndex, rowIndex, colIndex, colIndex);
        if (range) {
          var optionVariants = [
            { includeTextLinkRuns: true, includeRuns: true },
            { needTextLinkRuns: true, needRuns: true },
          ];
          var foundViaRq = false;
          for (var ov = 0; ov < optionVariants.length && !foundViaRq; ov++) {
            try {
              var rv = await queryRangeValuesViaUil(range, optionVariants[ov]);
              if (rv) {
                var rqMeta = scanObjectForAttachmentMeta(rv, 8);
                if (rqMeta && rqMeta.id) {
                  entry.isAttachment = true;
                  entry.attachmentMeta = {
                    subFileId: rqMeta.id,
                    fileSize: rqMeta.fileSize || "",
                    aType: rqMeta.aType || "pdf",
                    fileName: rqMeta.fileName || "",
                    text: rqMeta.text || "",
                    displayName: entry.cellText.replace(/^📄/, ""),
                  };
                  entry.detectSource = "range-query";
                  entry.detectAttempts.push({ path: "range-query", ok: true, id: rqMeta.id });
                  result.summary.attachmentCount++;
                  result.summary.nonAttachmentCount--;
                  foundViaRq = true;
                }
              }
            } catch (e2) {}
          }
          if (!foundViaRq) {
            entry.detectAttempts.push({ path: "range-query", ok: false, reason: "no-id" });
          }
        } else {
          entry.detectAttempts.push({ path: "range-query", ok: false, reason: "no-range-object" });
        }
      } catch (e) {
        entry.detectAttempts.push({ path: "range-query", ok: false, reason: "error", error: e.message || String(e) });
      }
    }

    // ===== Plan-Attachment-Map fallback =====
    // For cells that still have no ID but look like attachments, try plan resolution
    var needsPlanCtx = false;
    for (var pb = 0; pb < result.cells.length; pb++) {
      var entry2 = result.cells[pb];
      if (!entry2.isAttachment && entry2.cellText && /📄/.test(entry2.cellText)) {
        needsPlanCtx = true;
        break;
      }
    }

    if (needsPlanCtx) {
      var planCtx = buildResolveContext();
      try {
        await ensureResolveContext(planCtx);
      } catch (_) {}

      for (var pc2 = 0; pc2 < result.cells.length; pc2++) {
        var entry3 = result.cells[pc2];
        if (entry3.isAttachment) continue;
        if (!entry3.cellText || !/📄/.test(entry3.cellText)) continue;

        var planResult = resolveSelectedCellAttachmentByPlan(
          entry3.rowIndex, entry3.colIndex, entry3.cellText, planCtx
        );

        if (planResult.ok) {
          entry3.isAttachment = true;
          entry3.attachmentMeta = {
            subFileId: planResult.subFileId,
            fileSize: "",
            aType: "pdf",
            fileName: (entry3.cellText.replace(/^📄/, "") || planResult.targetBase || "") + ".pdf",
            text: planResult.sourceText || entry3.cellText,
            displayName: entry3.cellText.replace(/^📄/, ""),
          };
          entry3.detectSource = "plan-attachment-map";
          entry3.detectAttempts.push({ path: "plan-attachment-map", ok: true, matchSource: planResult.matchSource, id: planResult.subFileId });
          result.summary.attachmentCount++;
          result.summary.nonAttachmentCount--;
        } else {
          entry3.detectAttempts.push({ path: "plan-attachment-map", ok: false, reason: planResult.reason || "unknown" });
        }
      }
    }

    delete result._pendingAsyncCells;
    return result;
  }

  // ===== Template-based Rename Helpers =====

  function getColumnsFromLastScan() {
    var kernel = window.WPSBatch && window.WPSBatch.kernel;
    var sr = kernel && kernel.getLastScanResult();
    return (sr && sr.columns) || [];
  }

  function parseRenameTemplate(template, columns) {
    if (!template || typeof template !== "string" || !template.trim()) {
      return { ok: false, error: "模板为空" };
    }
    var pattern = /\{([^}]+)\}/g;
    var parts = [];
    var match;
    var lastIndex = 0;
    var referencedColumns = [];
    var colMap = {};
    for (var c = 0; c < columns.length; c++) {
      colMap[columns[c].name] = columns[c];
    }

    while ((match = pattern.exec(template)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: "text", value: template.slice(lastIndex, match.index) });
      }
      var colName = match[1].trim();
      var col = colMap[colName];
      if (!col) {
        return { ok: false, error: "模板引用了不存在的列: \"" + colName + "\"。可用列: " + columns.map(function (c2) { return c2.name; }).join("、") };
      }
      parts.push({ type: "column", columnIndex: col.index, columnName: col.name, placeholder: match[0] });
      if (referencedColumns.indexOf(col.index) < 0) {
        referencedColumns.push(col.index);
      }
      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < template.length) {
      parts.push({ type: "text", value: template.slice(lastIndex) });
    }

    var hasPlaceholder = false;
    for (var p = 0; p < parts.length; p++) {
      if (parts[p].type === "column") { hasPlaceholder = true; break; }
    }
    if (!hasPlaceholder) {
      return { ok: false, error: "模板中没有任何 {列名} 占位符" };
    }

    return { ok: true, parts: parts, referencedColumns: referencedColumns };
  }

  function renderRenameTemplateForRow(template, rowIndex, columns) {
    var parseResult = parseRenameTemplate(template, columns);
    if (!parseResult.ok) return parseResult;

    var result = "";
    var missingColumns = [];

    for (var i = 0; i < parseResult.parts.length; i++) {
      var part = parseResult.parts[i];
      if (part.type === "text") {
        result += part.value;
      } else {
        var value = getWpsCellText(rowIndex, part.columnIndex);
        if (!value) {
          missingColumns.push(part.columnName);
        }
        result += value || "";
      }
    }

    return { ok: true, result: result, missingColumns: missingColumns };
  }

  function buildTemplateFromSelectedColumns(selectedColumnIndexes, columns) {
    if (!selectedColumnIndexes.length) return "";
    var indexMap = {};
    for (var i = 0; i < columns.length; i++) {
      indexMap[columns[i].index] = columns[i].name;
    }
    var names = [];
    for (var j = 0; j < selectedColumnIndexes.length; j++) {
      var n = indexMap[selectedColumnIndexes[j]];
      if (n) names.push("{" + n + "}");
    }
    return names.join("-");
  }

  async function previewRenameSelectedAttachments(rule) {
    var ruleObj = rule || {};
    var template = ruleObj.template || "";
    var columnIndexes = ruleObj.columnIndexes || [];
    var separator = ruleObj.separator != null ? ruleObj.separator : "-";
    var selectedColumns = ruleObj.selectedColumns || [];
    var rangeOverride = ruleObj.rangeOverride || "";

    // Use template if provided
    var useTemplate = !!template;
    var columns = getColumnsFromLastScan();

    if (useTemplate) {
      var parseCheck = parseRenameTemplate(template, columns);
      if (!parseCheck.ok) {
        return { ok: false, error: parseCheck.error, preview: [] };
      }
      // Derive columnIndexes from template for compatibility
      columnIndexes = parseCheck.referencedColumns;
    } else if (!columnIndexes.length && !selectedColumns.length) {
      return {
        ok: false,
        error: "请至少选择一个列作为命名来源，或填写自定义模板",
        preview: [],
      };
    }

    // If selectedColumns provided but no template, build template
    if (!useTemplate && selectedColumns.length && !columnIndexes.length) {
      columnIndexes = selectedColumns.map(function (s) { return s.index; });
      template = buildTemplateFromSelectedColumns(columnIndexes, columns);
      useTemplate = true;
    } else if (!useTemplate && selectedColumns.length) {
      template = buildTemplateFromSelectedColumns(columnIndexes, columns);
      useTemplate = true;
    }

    var inspectResult = await inspectSelectedAttachmentCellsAsync({ rangeOverride: rangeOverride });
    if (!inspectResult.ok) {
      return { ok: false, error: inspectResult.error, preview: [], range: inspectResult.range };
    }

    var attachmentCells = [];
    for (var i = 0; i < inspectResult.cells.length; i++) {
      if (inspectResult.cells[i].isAttachment) attachmentCells.push(inspectResult.cells[i]);
    }

    if (!attachmentCells.length) {
      // Check if cells look like attachments but all detection failed
      var hasAttachmentLike = false;
      for (var hl = 0; hl < inspectResult.cells.length; hl++) {
        if (inspectResult.cells[hl].cellText && /📄/.test(inspectResult.cells[hl].cellText)) {
          hasAttachmentLike = true; break;
        }
      }
      // Build detection summary for first few cells
      var detectSamples = [];
      for (var si = 0; si < Math.min(inspectResult.cells.length, 5); si++) {
        var sc = inspectResult.cells[si];
        if (sc) {
          var sources = [];
          for (var aj = 0; aj < (sc.detectAttempts || []).length; aj++) {
            var da = sc.detectAttempts[aj];
            if (da.ok) sources.push(da.path + "=ok");
            else sources.push(da.path + "=" + (da.reason || "fail"));
          }
          var cellTextShort = (sc.cellText || "(空)").slice(0, 30);
          detectSamples.push(sc.colName + (sc.rowNumber || (sc.rowIndex + 1)) + " 文本=" + cellTextShort + " [" + (sources.length ? sources.join(",") : "无检测结果") + "]");
        }
      }
      var diagMsg = "已检查 " + inspectResult.cells.length + " 个单元格";
      if (detectSamples.length) diagMsg += "，示例：" + detectSamples.join("; ");

      var errorMsg;
      if (hasAttachmentLike) {
        errorMsg = "选区中有附件显示文本，但无法反查附件 ID。请先运行匹配附件或自动附件映射，再重试。" + diagMsg;
      } else {
        errorMsg = "当前范围没有识别到可改名附件。" + diagMsg;
      }
      return {
        ok: false,
        error: errorMsg,
        preview: [],
        range: inspectResult.range,
        detectSamples: detectSamples,
        hasAttachmentLike: hasAttachmentLike,
      };
    }

    if (inspectResult.summary.nonAttachmentCount > 0) {
      var nonAttachSamples = [];
      for (var ns = 0; ns < inspectResult.cells.length && nonAttachSamples.length < 3; ns++) {
        var nc = inspectResult.cells[ns];
        if (nc && !nc.isAttachment) {
          nonAttachSamples.push(nc.colName + (nc.rowNumber || (nc.rowIndex + 1)));
        }
      }
      return {
        ok: false,
        error: "范围中有 " + inspectResult.summary.nonAttachmentCount + " 个非附件单元格（如 " + nonAttachSamples.join(",") + "），请只框选附件单元格",
        preview: [],
        range: inspectResult.range,
        nonAttachmentCount: inspectResult.summary.nonAttachmentCount,
      };
    }

    // Generate sample from first attachment cell
    var sample = null;
    if (useTemplate && attachmentCells.length > 0) {
      var sampleRowIndex = attachmentCells[0].rowIndex;
      var sampleRender = renderRenameTemplateForRow(template, sampleRowIndex, columns);
      if (sampleRender.ok) {
        sample = sampleRender.result;
      }
    }

    var previewItems = [];
    var hasError = false;

    for (var j = 0; j < attachmentCells.length; j++) {
      var cell = attachmentCells[j];
      var rowIndex = cell.rowIndex;
      var newName = "";
      var missingColumns = [];
      var status = "ok";

      if (useTemplate) {
        var renderResult = renderRenameTemplateForRow(template, rowIndex, columns);
        if (!renderResult.ok) {
          status = "error-template";
          missingColumns = [];
          hasError = true;
          newName = "[模板错误: " + renderResult.error + "]";
        } else {
          newName = renderResult.result;
          missingColumns = renderResult.missingColumns || [];
          if (missingColumns.length > 0) {
            status = "error-empty-column";
            hasError = true;
          }
        }
      } else {
        // Legacy: columnIndexes + separator
        var parts = [];
        for (var k = 0; k < columnIndexes.length; k++) {
          var ci = columnIndexes[k];
          var value = getWpsCellText(rowIndex, ci);
          if (!value) {
            // Resolve column name for legacy path
            var colName = "";
            for (var m = 0; m < columns.length; m++) {
              if (columns[m].index === ci) { colName = columns[m].name; break; }
            }
            missingColumns.push(colName || ("列" + ci));
          }
          parts.push(value || "");
        }
        newName = parts.join(separator);
        if (missingColumns.length > 0) {
          status = "error-empty-column";
          hasError = true;
        }
      }

      previewItems.push({
        rowIndex: rowIndex,
        rowNumber: rowIndex + 1,
        colIndex: cell.colIndex,
        originalDisplayName: cell.attachmentMeta ? cell.attachmentMeta.displayName : "",
        originalText: cell.cellText,
        newDisplayName: newName,
        subFileId: cell.attachmentMeta ? cell.attachmentMeta.subFileId : "",
        missingColumns: missingColumns,
        status: status,
      });
    }

    return {
      ok: true,
      template: template,
      rule: { columnIndexes: columnIndexes, separator: separator, template: template },
      preview: previewItems,
      sample: sample,
      summary: {
        total: previewItems.length,
        okCount: previewItems.filter(function (p) { return p.status === "ok"; }).length,
        errorCount: previewItems.filter(function (p) { return p.status !== "ok"; }).length,
      },
      hasError: hasError,
    };
  }

  async function renameSelectedAttachmentCells(rule) {
    var ruleObj = rule || {};

    // Must await — previewRenameSelectedAttachments is async (uses inspectSelectedAttachmentCellsAsync)
    var previewResult = await previewRenameSelectedAttachments(ruleObj);
    if (!previewResult.ok) {
      return { ok: false, error: previewResult.error, results: [], preview: previewResult };
    }

    if (previewResult.hasError) {
      return {
        ok: false,
        error: "预览中存在空列值错误（" + previewResult.summary.errorCount + " 个），无法执行。请调整选区或列选择",
        results: [],
        preview: previewResult,
      };
    }

    var results = [];
    var sheetMeta = getSheetCommandMeta();

    for (var i = 0; i < previewResult.preview.length; i++) {
      var item = previewResult.preview[i];

      // Use metadata from preview when available
      var subFileId = item.subFileId || "";
      var ext = "pdf";
      var fileSize = "";

      // If preview didn't have metadata, try to detect it now
      if (!subFileId) {
        try {
          var detectResult = await detectAttachmentMetaAtCell(item.rowIndex, item.colIndex);
          if (detectResult && detectResult.isAttachment && detectResult.attachmentMeta) {
            subFileId = detectResult.attachmentMeta.subFileId || "";
            ext = detectResult.attachmentMeta.aType || "pdf";
            fileSize = detectResult.attachmentMeta.fileSize || "";
          }
        } catch (_) {}
      }

      if (!subFileId) {
        results.push({
          rowIndex: item.rowIndex,
          rowNumber: item.rowNumber,
          colIndex: item.colIndex,
          originalDisplayName: item.originalDisplayName,
          newDisplayName: item.newDisplayName,
          status: "error",
          error: "无法获取附件 subFileId",
        });
        continue;
      }

      var displayName = item.newDisplayName;
      var formula = "📄" + displayName;
      var filename = displayName + "." + ext;
      var address = "kw:annex?aType=" + encodeURIComponent(ext) +
        "&oId=" + encodeURIComponent(subFileId) +
        "&fileName=" + encodeURIComponent(filename) +
        (fileSize ? "&fileSize=" + encodeURIComponent(fileSize) : "");

      var param = {
        sheetStId: Number(sheetMeta.sheetStId),
        sheetIdx: Number(sheetMeta.sheetIdx),
        sheetName: sheetMeta.sheetName,
        rowFrom: item.rowIndex,
        rowTo: item.rowIndex,
        colFrom: item.colIndex,
        colTo: item.colIndex,
        independentViewId: -1,
        independentViewInfo: {
          viewId: -1,
          userId: sheetMeta.userId,
          viewName: "",
          isTemp: false,
          sharedChanged: false,
          forceExit: false,
          connId: sheetMeta.connId,
        },
        enableDynamicArray: true,
        formula: formula,
        textLinkRuns: [{ pos: 0, length: formula.length, address: address, linkRunsType: "LRTMention" }],
        changeFlags: { formula: true },
        refSheetStId: Number(sheetMeta.sheetStId),
        refSheetIdx: Number(sheetMeta.sheetIdx),
        refRow: item.rowIndex,
        refCol: item.colIndex,
        refStyle: sheetMeta.refStyle,
        isForceAsText4Decimal: false,
      };

      try {
        var runs = getExistingCellRuns(item.rowIndex, item.colIndex);
        if (runs.length) {
          runs[0] = Object.assign({}, runs[0], { begin: 0 });
          param.runs = runs;
          param.changeFlags.runs = true;
        }
      } catch (_) {}

      try {
        var ok = window.APP.execCommand("range.setFormula", param);
        results.push({
          rowIndex: item.rowIndex,
          rowNumber: item.rowNumber,
          colIndex: item.colIndex,
          originalDisplayName: item.originalDisplayName,
          newDisplayName: item.newDisplayName,
          status: ok ? "renamed" : "rejected",
          error: ok ? null : "execCommand 返回 falsy",
        });
      } catch (e) {
        results.push({
          rowIndex: item.rowIndex,
          rowNumber: item.rowNumber,
          colIndex: item.colIndex,
          originalDisplayName: item.originalDisplayName,
          newDisplayName: item.newDisplayName,
          status: "error",
          error: e.message || String(e),
        });
      }
    }

    var successCount = results.filter(function (r) { return r.status === "renamed"; }).length;
    var failCount = results.filter(function (r) { return r.status !== "renamed"; }).length;

    log("批量改名完成：成功 " + successCount + " 个，失败 " + failCount + " 个");

    return {
      ok: true,
      results: results,
      summary: {
        total: results.length,
        successCount: successCount,
        failCount: failCount,
      },
    };
  }

  // ===== Selected Attachment Download Preparation =====

  async function prepareSelectedAttachmentDownloads(options) {
    options = options || {};
    var rangeOverride = options.rangeOverride || "";

    // Inspect selected cells
    var inspectResult = await inspectSelectedAttachmentCellsAsync({ rangeOverride: rangeOverride });
    if (!inspectResult.ok) {
      return { ok: false, error: inspectResult.error, range: inspectResult.range, items: [], summary: {} };
    }

    var attachmentCells = [];
    for (var i = 0; i < inspectResult.cells.length; i++) {
      if (inspectResult.cells[i].isAttachment) attachmentCells.push(inspectResult.cells[i]);
    }

    if (!attachmentCells.length) {
      return {
        ok: false,
        error: "当前范围没有识别到可改名附件，无法准备下载",
        range: inspectResult.range,
        items: [],
        summary: {},
      };
    }

    if (inspectResult.summary.nonAttachmentCount > 0) {
      return {
        ok: false,
        error: "范围中有 " + inspectResult.summary.nonAttachmentCount + " 个非附件单元格，请只框选附件单元格",
        range: inspectResult.range,
        items: [],
        summary: { nonAttachmentCount: inspectResult.summary.nonAttachmentCount },
      };
    }

    var items = [];
    var successCount = 0;
    var errorCount = 0;
    var delayMs = CONFIG.downloadDelayMs || 500;

    for (var j = 0; j < attachmentCells.length; j++) {
      var cell = attachmentCells[j];
      var subFileId = (cell.attachmentMeta && cell.attachmentMeta.subFileId) || "";
      // Always use current cell display text, never the original attachment file name
      var displayName = cell.cellText.replace(/^📄/, "").trim();
      var ext = (cell.attachmentMeta && cell.attachmentMeta.aType) || "pdf";
      var rawFilename = sanitizeFilename(displayName);
      var filename = ensureExt(rawFilename, "");
      // ensureExt with empty URL falls back to CONFIG.defaultExt (.pdf). Override if aType differs.
      if (!/\.[a-z0-9]{2,8}$/i.test(filename) || (cell.attachmentMeta && cell.attachmentMeta.aType && !filename.endsWith("." + cell.attachmentMeta.aType))) {
        filename = rawFilename;
        if (!/\.[a-z0-9]{2,8}$/i.test(filename)) filename = filename + "." + ext;
      }

      if (CONFIG.debug) {
        log("[download-prep]", cell.colName + (cell.rowNumber != null ? cell.rowNumber : (cell.rowIndex + 1)),
          "cellText=" + cell.cellText,
          "displayName=" + displayName,
          "meta.fileName=" + ((cell.attachmentMeta && cell.attachmentMeta.fileName) || ""),
          "filename=" + filename);
      }

      var item = {
        rowIndex: cell.rowIndex,
        rowNumber: cell.rowNumber,
        colIndex: cell.colIndex,
        colName: cell.colName,
        address: cell.colName + (cell.rowNumber != null ? cell.rowNumber : (cell.rowIndex + 1)),
        subFileId: subFileId,
        displayName: displayName,
        filename: filename,
        downloadUrl: "",
        status: "",
        error: "",
      };

      if (!subFileId) {
        item.status = "error";
        item.error = "无附件 subFileId";
        items.push(item);
        errorCount++;
        continue;
      }

      try {
        var info = await resolveAttachmentDownloadUrl(subFileId);
        item.downloadUrl = info.download_url || "";
        item.status = "ready";
        successCount++;
        items.push(item);
      } catch (e) {
        item.status = "error";
        item.error = e.message || String(e);
        items.push(item);
        errorCount++;
      }

      if (j < attachmentCells.length - 1) {
        await sleep(delayMs);
      }
    }

    return {
      ok: true,
      range: inspectResult.range,
      items: items,
      summary: {
        total: items.length,
        readyCount: successCount,
        errorCount: errorCount,
      },
    };
  }

  function createWpsBatchKernel() {
    var lastScanResult = null;
    var lastMatchResult = null;
    var lastExecuteResult = null;

    var kernel = {};

    kernel.scan = async function (options) {
      options = options || {};
      var plan = await buildPlanDirectlyFromPage();
      var tableResult = window.WPSBatch.lastTableReadResult || {};
      var rows = tableResult.rows || [];
      var headers = rows.length > 0 ? rows[0] : [];
      var columns = headers.map(function (h, ci) {
        var values = [];
        for (var ri = 1; ri < rows.length; ri++) {
          var rowArr = rows[ri];
          var val = rowArr && rowArr[ci] ? cleanText(rowArr[ci]) : "";
          if (val) {
            values.push({ rowIndex: ri - 1, rowNumber: ri + 1, value: val });
          }
        }
        return { index: ci, name: cleanText(h), values: values };
      });
      lastScanResult = {
        plan: plan,
        source: tableResult.source || "unknown",
        rows: rows,
        columns: columns,
        records: tableResult.records || [],
        planCount: plan.length,
        rowCount: rows.length,
        diagnostics: {
          hasWindowApp: !!window.APP,
          hasActiveSheet: !!(window.APP && window.APP.getActiveSheet),
          headers: headers,
          columnNames: headers.map(function (h) { return cleanText(h); }),
        },
        pageEnv: {
          url: location.href,
          title: document.title,
          time: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };
      log("扫描完成：生成 " + plan.length + " 个任务，数据来源 " + lastScanResult.source);
      return lastScanResult;
    };

    kernel.preview = async function (options) {
      options = options || {};
      var scanResult = lastScanResult;
      if (!scanResult) scanResult = await kernel.scan(options);
      var items = (scanResult.plan || []).map(function (item) {
        var status = "ok";
        if (!item.sourceText) status = "no-source";
        if (item.sourceText && /测试/.test(item.sourceText)) status = "unusual-name";
        return {
          row: item.row,
          colIndex: item.colIndex,
          rowIndex: item.rowIndex != null ? item.rowIndex : (Number(item.row) - 1),
          type: item.type,
          typeLabel: item.type === "outer" ? "外箱标" : "预约信",
          sourceText: item.sourceText,
          targetName: item.targetBase + CONFIG.defaultExt,
          key: item.key,
          status: status,
        };
      });
      var summary = {
        total: items.length,
        outer: items.filter(function (i) { return i.type === "outer"; }).length,
        appointment: items.filter(function (i) { return i.type === "appointment"; }).length,
        noSource: items.filter(function (i) { return i.status === "no-source"; }).length,
        unusualName: items.filter(function (i) { return i.status === "unusual-name"; }).length,
      };
      return { items: items, summary: summary, scanSource: scanResult.source, timestamp: Date.now() };
    };

    kernel.matchAttachments = async function (options) {
      options = options || {};
      var attachmentMap;
      if (options.useProbe) {
        attachmentMap = await makeAttachmentMapFromProbe(options);
      } else {
        attachmentMap = await makeAutoAttachmentMap(options);
      }
      lastMatchResult = buildMatchResult(attachmentMap);
      log(
        "附件匹配完成：已配 " + lastMatchResult.matchedCount + " 个，" +
        "缺失 " + lastMatchResult.missingCount + " 个，" +
        "顺序兜底 " + lastMatchResult.riskyItems.length + " 个，" +
        "风险等级 " + lastMatchResult.riskLevel
      );
      return lastMatchResult;
    };

    kernel.execute = async function (options) {
      options = options || {};
      if (!lastMatchResult) {
        lastMatchResult = await kernel.matchAttachments(options);
      }
      // Risk check: reject order-based matches by default
      if (lastMatchResult.riskLevel === "risky" && !options.allowRiskyOrderMatch) {
        return {
          status: "rejected",
          reason: "order-match-risk",
          message: "存在使用同类型顺序兜底匹配的项目（type-order），请先检查 riskyItems 确认正确后，设置 allowRiskyOrderMatch: true 再执行。",
          riskyItems: lastMatchResult.riskyItems,
        };
      }
      // Check missing items
      if (lastMatchResult.missingItems.length > 0 && !options.skipMissing) {
        return {
          status: "rejected",
          reason: "missing-attachments",
          message: "还有 " + lastMatchResult.missingItems.length + " 个附件没有匹配到 ID，请检查后重试。",
          missingItems: lastMatchResult.missingItems,
        };
      }
      // Save old values before any mutation
      var attachmentMap = options.attachmentMap || lastMatchResult.attachmentMap;
      var plan = lastScanResult ? lastScanResult.plan : await buildPlanDirectlyFromPage();
      var normalized = normalizeAttachmentMap(attachmentMap);
      var savedOldValues = [];
      for (var i = 0; i < plan.length; i++) {
        var item = plan[i];
        var id = normalized[item.type][item.key] ||
          normalized.flat[item.type + ":" + item.key] ||
          normalized.flat[item.sourceText] ||
          normalized.flat[item.targetBase];
        var rowIndex = Number.isFinite(item.rowIndex) ? item.rowIndex : Number(item.row) - 1;
        var colIndex = Number.isFinite(item.colIndex) ? item.colIndex : (item.type === "outer" ? 2 : 6);
        var oldCellText = "";
        if (Number.isFinite(rowIndex) && Number.isFinite(colIndex) && rowIndex >= 0 && colIndex >= 0) {
          oldCellText = getWpsCellText(rowIndex, colIndex);
        }
        var oldAttachmentName = "";
        try {
          var meta = await getAttachmentMetaForPlanItem(item, { allowSelectionMutation: false });
          oldAttachmentName = meta ? (meta.fileName || meta.text || "") : "";
        } catch (_) {}
        savedOldValues.push({
          row: item.row,
          rowIndex: rowIndex,
          colIndex: colIndex,
          type: item.type,
          key: item.key,
          oldCellText: oldCellText,
          oldAttachmentName: oldAttachmentName,
          subFileId: id || "",
          newTargetName: item.targetBase,
          status: id ? "will-execute" : "missing-id",
        });
      }
      var opts = {
        updateSheetCells: options.updateSheetCells !== false,
        renameAttachments: options.renameAttachments !== false,
        download: options.download !== false,
      };
      var cellResults = [];
      var renameResults = [];
      var downloadResults = [];
      if (opts.updateSheetCells) {
        log("更新表格附件显示名...");
        cellResults = await updateSheetAttachmentCellsByAttachmentMap(attachmentMap);
      }
      if (opts.renameAttachments) {
        log("修改 WPS 附件对象名...");
        renameResults = await renameByAttachmentMap(attachmentMap);
      }
      if (opts.download) {
        log("下载附件...");
        downloadResults = await downloadByAttachmentMap(attachmentMap);
      }
      // Update savedOldValues with actual results
      for (var j = 0; j < savedOldValues.length; j++) {
        var old = savedOldValues[j];
        for (var k = 0; k < cellResults.length; k++) {
          if (cellResults[k].type === old.type && cellResults[k].key === old.key) {
            old.cellUpdateStatus = cellResults[k].status;
            if (cellResults[k].error) old.cellUpdateError = cellResults[k].error;
          }
        }
        for (var m = 0; m < renameResults.length; m++) {
          if (renameResults[m].type === old.type && renameResults[m].key === old.key) {
            old.renameStatus = renameResults[m].status;
            if (renameResults[m].error) old.renameError = renameResults[m].error;
          }
        }
        for (var n = 0; n < downloadResults.length; n++) {
          if (downloadResults[n].type === old.type && downloadResults[n].key === old.key) {
            old.downloadStatus = downloadResults[n].status;
            if (downloadResults[n].error) old.downloadError = downloadResults[n].error;
          }
        }
      }
      var errorCount = 0;
      var statuses = ["cellUpdateStatus", "renameStatus", "downloadStatus"];
      for (var p = 0; p < savedOldValues.length; p++) {
        for (var q = 0; q < statuses.length; q++) {
          var s = savedOldValues[p][statuses[q]];
          if (s && s.indexOf("error") >= 0) errorCount++;
        }
      }
      lastExecuteResult = {
        status: "completed",
        cellResults: cellResults,
        renameResults: renameResults,
        downloadResults: downloadResults,
        savedOldValues: savedOldValues,
        summary: {
          total: savedOldValues.length,
          cellsUpdated: cellResults.filter(function (r) { return r.status === "cell-updated"; }).length,
          renamed: renameResults.filter(function (r) { return r.status === "renamed"; }).length,
          downloaded: downloadResults.filter(function (r) { return r.status === "downloaded"; }).length,
          errors: errorCount,
        },
        timestamp: Date.now(),
      };
      log(
        "执行完成：更新单元格 " + lastExecuteResult.summary.cellsUpdated + " 个，" +
        "重命名附件 " + lastExecuteResult.summary.renamed + " 个，" +
        "下载 " + lastExecuteResult.summary.downloaded + " 个，" +
        "错误 " + lastExecuteResult.summary.errors + " 个"
      );
      return lastExecuteResult;
    };

    kernel.report = function (options) {
      options = options || {};
      var sections = [];
      if (lastScanResult) {
        sections.push({
          type: "scan",
          source: lastScanResult.source,
          planCount: lastScanResult.planCount,
          rowCount: lastScanResult.rowCount,
          diagnostics: lastScanResult.diagnostics,
          pageEnv: lastScanResult.pageEnv,
          timestamp: lastScanResult.timestamp,
        });
      }
      if (lastMatchResult) {
        sections.push({
          type: "match",
          riskLevel: lastMatchResult.riskLevel,
          matchedCount: lastMatchResult.matchedCount,
          missingCount: lastMatchResult.missingCount,
          riskyCount: lastMatchResult.riskyItems.length,
          candidateCount: lastMatchResult.candidateCount,
          missingItems: lastMatchResult.missingItems,
          riskyItems: lastMatchResult.riskyItems,
          timestamp: lastMatchResult.timestamp,
        });
      }
      if (lastExecuteResult) {
        sections.push({
          type: "execute",
          status: lastExecuteResult.status,
          summary: lastExecuteResult.summary,
          savedOldValues: lastExecuteResult.savedOldValues,
          timestamp: lastExecuteResult.timestamp,
        });
      }
      var textReport = "";
      if (options.textReport !== false) {
        textReport = makeReportText({
          plan: lastScanResult ? lastScanResult.plan : [],
          candidates: lastMatchResult ? lastMatchResult.candidates : [],
          results: lastExecuteResult ? [].concat(
            lastExecuteResult.cellResults || [],
            lastExecuteResult.renameResults || [],
            lastExecuteResult.downloadResults || []
          ) : [],
        });
      }
      return {
        sections: sections,
        textReport: textReport,
        pageEnv: {
          url: location.href,
          title: document.title,
          time: new Date().toISOString(),
        },
      };
    };

    kernel.reset = function () {
      lastScanResult = null;
      lastMatchResult = null;
      lastExecuteResult = null;
    };

    kernel.getLastScanResult = function () { return lastScanResult; };
    kernel.getLastMatchResult = function () { return lastMatchResult; };
    kernel.getLastExecuteResult = function () { return lastExecuteResult; };

    kernel.getSelectedRange = getSelectedRange;
    kernel.inspectSelectedAttachmentCells = inspectSelectedAttachmentCells;
    kernel.previewRenameSelectedAttachments = previewRenameSelectedAttachments;
    kernel.renameSelectedAttachmentCells = renameSelectedAttachmentCells;
    kernel.diagnoseSelectionApis = diagnoseSelectionApis;
    kernel.diagnoseSelectedAttachmentCells = diagnoseSelectedAttachmentCells;
    kernel.prepareSelectedAttachmentDownloads = prepareSelectedAttachmentDownloads;

    return kernel;
  }

  var wpsBatchKernel = createWpsBatchKernel();

  window.WPSBatch = {
    // Kernel — stable API for page-bridge integration
    kernel: wpsBatchKernel,
    scan: function (options) { return wpsBatchKernel.scan(options); },
    preview: function (options) { return wpsBatchKernel.preview(options); },
    matchAttachments: function (options) { return wpsBatchKernel.matchAttachments(options); },
    execute: function (options) { return wpsBatchKernel.execute(options); },
    report: function (options) { return wpsBatchKernel.report(options); },
    selfTest: selfTest,
    checkPageEnvironment: checkPageEnvironment,
    resetKernel: function () { return wpsBatchKernel.reset(); },
    // Selection-based APIs
    getSelectedRange: function (options) { return wpsBatchKernel.getSelectedRange(options); },
    inspectSelectedAttachmentCells: function (options) { return wpsBatchKernel.inspectSelectedAttachmentCells(options); },
    previewRenameSelectedAttachments: function (rule) { return wpsBatchKernel.previewRenameSelectedAttachments(rule); },
    renameSelectedAttachmentCells: function (rule) { return wpsBatchKernel.renameSelectedAttachmentCells(rule); },
    diagnoseSelectionApis: function () { return wpsBatchKernel.diagnoseSelectionApis(); },
    diagnoseSelectedAttachmentCells: function (options) { return wpsBatchKernel.diagnoseSelectedAttachmentCells(options); },
    prepareSelectedAttachmentDownloads: function (options) { return wpsBatchKernel.prepareSelectedAttachmentDownloads(options); },
    // Legacy API — preserved for backward compatibility
    run,
    buildPlanFromTsv,
    buildPlanDirectlyFromPage,
    buildPlanFromTableDataDirectly,
    reportTableState,
    makeTableStateReportText,
    reportAttachmentCellApis,
    makeAttachmentCellApiReportText,
    reportAttachmentRangeQueries,
    reportSelectedHyperlinkApis,
    reportHyperlinkMethodSurface,
    copyHyperlinkMethodSurfaceReport,
    makeHyperlinkMethodSurfaceReportText,
    reportAttachmentApiProbe,
    fetchAttachmentApiCandidates,
    reportProbeAttachmentCandidates,
    collectAttachmentCandidatesFromProbe,
    makeAttachmentMapFromProbe,
    loadPersistedAttachmentMap,
    loadPersistedState,
    reportWpsApiState,
    makeWpsApiReportText,
    extractFromDomText,
    deepScanWindowStrings,
    extractFromNetworkResources,
    findDomAttachmentCandidates,
    makeReportText,
    copyReport,
    installProbeHooks,
    makeProbeReportText,
    deepScanAttachmentDetails,
    reportAttachmentState,
    makeAttachmentStateReportText,
    resolveAttachmentDownloadUrl,
    downloadAttachmentById,
    downloadByIdMap,
    makeDesiredNameMap,
    downloadByAttachmentMap,
    renameAttachmentById,
    renameByAttachmentMap,
    updateSheetAttachmentCellsByAttachmentMap,
    updateSheetAttachmentCellsAuto,
    renameAndDownloadByAttachmentMap,
    makeAttachmentMapTemplate,
    makeAutoAttachmentMap,
    renameAndDownloadAuto,
    installRenameProbeHooks,
    renameByCapturedRequest,
    probe: null,
    lastReport: null,
    lastReportText: "",
    lastProbeReportText: "",
    lastAttachmentStateReportText: "",
    lastAttachmentMapTemplate: "",
    lastAutoAttachmentMap: null,
    lastAutoAttachmentCandidates: [],
    lastAutoAttachmentPlan: [],
    lastTableReadResult: null,
    lastTableStateReportText: "",
    lastAttachmentCellApiReportText: "",
    lastAttachmentRangeQueryReportText: "",
    lastSelectedHyperlinkApiReportText: "",
    lastHyperlinkMethodSurface: [],
    lastHyperlinkMethodSurfaceReportText: "",
    lastAttachmentApiProbeReportText: "",
    lastAttachmentApiEndpointResults: [],
    lastProbeAttachmentCandidateReportText: "",
    lastProbeAttachmentCandidates: [],
    lastProbeDownloadIds: [],
    lastWpsApiReportText: "",
    config: CONFIG,
  };

  log("脚本已加载。直接运行：await WPSBatch.run()。如果没有 DOM 链接，运行 WPSBatch.installProbeHooks() 做接口探测。");
})();

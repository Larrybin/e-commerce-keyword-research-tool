#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readArg, readFlag } from "./lib/args.mjs";
import {
  attachChromePage,
  CdpClient,
  createChromePage,
  detachChromePage,
  navigateAndWait,
  readChromeWebSocketEndpoint,
  readDebuggerEndpointFromPort,
  waitForChromeTargetWithCdp
} from "./lib/cdp.mjs";
import { ensureChromeProfileTargetWithCdp } from "./lib/chrome-profiles.mjs";
import { sleep } from "./lib/browser-actions.mjs";
import { writeCsv, writeJson } from "./lib/files.mjs";
import {
  getSpreadsheetId
} from "./lib/google-sheet.mjs";
import {
  batchUpdateSheet,
  formatRejectedKeywordCells,
  getSheetValues,
  updateSheetValues
} from "./lib/google-sheets-api.mjs";
import {
  buildKeywordTotalValues,
  buildKeywordTotalSourceValues,
  existingKeywordTotalKeys,
  filterDuplicateKeywordRows,
  findKeywordTotalAppendStartRow,
  isKeywordTotalHeaderRow,
  keywordTotalBaseWriteRange,
  keywordTotalReadRange,
  keywordTotalSourceColumnIndex,
  KEYWORD_TOTAL_HEADERS
} from "./lib/sheet-write.mjs";
import {
  hasTaskInput,
  isCompletedTask,
  resolveTaskRows,
  shortErrorMessage,
  taskRunKey,
  toOutputRows
} from "./lib/task-batch.mjs";
import { filterKeywordRowsForEcommerce } from "./lib/keyword-filter.mjs";
import {
  DEFAULT_SHEET_URL,
  pickKeywordTask,
  readToolConfig
} from "./lib/tool-config.mjs";
import {
  applyRangeFilter,
  clickNextPage,
  closeSemrushCoachmark,
  countryDatabaseCode,
  detectPage,
  ensureFirstKeywordMagicPage,
  extractKeywordOverviewMetrics,
  extractKeywordRows,
  fetchKeywordMagicRowsViaPageApi,
  loginDash,
  navigateToKeywordMagic,
  navigateToKeywordOverview,
  openSemrushFromDash,
  searchSemrush,
  selectMatchType,
  validateMagicPhrase
} from "./lib/semrush-page.mjs";

const DASH_LOGIN_URL = "https://dash.3ue.com/zh-Hans/#/login";
const MANAGED_CHROME_PORT = "9333";
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function saveState(filePath, state) {
  await writeJson(filePath, {
    ...state,
    updatedAt: new Date().toISOString()
  });
}

async function findExistingWorkTarget(cdp) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets");
  const pages = targetInfos.filter((target) => target.type === "page");
  return (
    pages.find((target) => target.url.includes("sem.3ue.com/analytics/keywordmagic")) ||
    pages.find((target) => target.url.includes("sem.3ue.com/analytics/keywordoverview")) ||
    pages.find((target) => target.url.includes("sem.3ue.com")) ||
    pages.find((target) => target.url.includes("dash.3ue.com"))
  );
}

async function openOrAttachWorkPage(cdp, chromeProfile) {
  const existing = await findExistingWorkTarget(cdp);
  if (existing) {
    try {
      return await attachChromePage(cdp, existing.targetId);
    } catch (error) {
      if (!/No target with given id found|Session with given id not found/i.test(error?.message || "")) {
        throw error;
      }
    }
  }

  const target = await ensureChromeProfileTargetWithCdp(cdp, chromeProfile, DASH_LOGIN_URL, 30000);
  return attachChromePage(cdp, target.targetId);
}

async function closeWorkPage(cdp, page) {
  if (!page) {
    return;
  }
  await detachChromePage(cdp, page.sessionId).catch(() => {});
  await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
}

async function closeAllWorkTargets(cdp) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
  for (const target of targetInfos) {
    if (
      target.type === "page" &&
      (/sem\.3ue\.com|dash\.3ue\.com/.test(target.url || ""))
    ) {
      await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
    }
  }
}

async function switchToLatestSemrushPage(cdp, currentPage) {
  const target = await waitForChromeTargetWithCdp(
    cdp,
    (item) => item.type === "page" && item.url.includes("sem.3ue.com"),
    30000
  );
  if (target.targetId === currentPage.targetId) {
    return currentPage;
  }
  await detachChromePage(cdp, currentPage.sessionId);
  return attachChromePage(cdp, target.targetId);
}

async function collectAllKeywordPages(cdp, sessionId, task, maxPages) {
  const allRows = [];
  const seen = new Set();
  let filteredKeywordCount = null;
  let page = 1;

  while (page <= maxPages) {
    let result = await fetchKeywordMagicRowsViaPageApi(cdp, sessionId, {
      root: task.rootKeyword,
      query: task.query,
      page
    }).catch((error) => ({ ok: false, reason: error.message }));
    const usedApi = result.ok;

    if (!result.ok) {
      result = await extractKeywordRows(cdp, sessionId, {
        root: task.rootKeyword,
        query: task.query,
        page
      });
    }
    if (!result.ok) {
      throw new Error(result.reason || "Unable to extract keyword rows");
    }
    if (result.filteredKeywordCount) {
      filteredKeywordCount = result.filteredKeywordCount;
    }

    let newRows = 0;
    for (const row of result.rows) {
      const key = `${row.keyword}\t${row.volume}\t${row.kd}`;
      if (!seen.has(key)) {
        seen.add(key);
        allRows.push(row);
        newRows += 1;
      }
    }
    const currentPage = result.pagination?.currentPage || page;
    const totalPages = result.pagination?.totalPages || null;
    const pageLabel = totalPages ? `${currentPage}/${totalPages}` : String(currentPage);
    console.log(`Collect page ${pageLabel}${usedApi ? " via API" : ""}: ${result.rows.length} row(s), ${allRows.length} total unique row(s).`);

    if (totalPages && currentPage >= totalPages) {
      break;
    }
    if (totalPages && page >= totalPages) {
      break;
    }
    if (usedApi) {
      if (result.rawKeywordCount < result.pageSize || result.rows.length === 0 || newRows === 0) {
        break;
      }
      page += 1;
      continue;
    }

    const hasNext = await clickNextPage(cdp, sessionId);
    if (!hasNext) {
      break;
    }
    page += 1;
  }

  allRows.filteredKeywordCount = filteredKeywordCount;
  return allRows;
}

async function copyToClipboard(text) {
  await new Promise((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "inherit"] });
    child.stdin.end(text);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pbcopy exited ${code}`));
      }
    });
  });
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}`));
      }
    });
  });
}

async function runCommandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function systemPasteIntoChrome() {
  await runCommand("osascript", [
    "-e",
    'tell application "Google Chrome" to activate',
    "-e",
    "delay 1",
    "-e",
    'tell application "System Events" to keystroke "v" using command down'
  ]);
}

async function approveRemoteDebuggingPrompt() {
  return runCommandOutput("osascript", [
    "-e",
    `tell application "System Events"
      repeat with p in (every process whose background only is false)
        try
          repeat with w in windows of p
            repeat with b in buttons of w
              try
                set buttonName to name of b as text
                if buttonName contains "允许" or buttonName contains "Allow" then
                  click b
                  return "clicked:" & (name of p as text)
                end if
              end try
            end repeat
          end repeat
        end try
      end repeat
      return "not-found"
    end tell`
  ]).catch((error) => `error:${error.message}`);
}

async function launchManagedChromeCdp() {
  if (process.env.CHROME_REMOTE_DEBUGGING_PORT || process.env.CHROME_USER_DATA_DIR) {
    return null;
  }

  const existingEndpoint = readDebuggerEndpointFromPort(MANAGED_CHROME_PORT);
  if (existingEndpoint) {
    process.env.CHROME_REMOTE_DEBUGGING_PORT = MANAGED_CHROME_PORT;
    console.log(`Using existing Chrome CDP on port ${MANAGED_CHROME_PORT}.`);
    return null;
  }

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecommerce-keyword-chrome-"));
  const child = spawn(CHROME_BIN, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${MANAGED_CHROME_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    if (readDebuggerEndpointFromPort(MANAGED_CHROME_PORT)) {
      process.env.CHROME_REMOTE_DEBUGGING_PORT = MANAGED_CHROME_PORT;
      console.log(`Started isolated Chrome CDP on port ${MANAGED_CHROME_PORT}.`);
      return { child, userDataDir };
    }
    await sleep(500);
  }

  child.kill("SIGTERM");
  await fs.rm(userDataDir, { recursive: true, force: true });
  throw new Error(`Timed out starting isolated Chrome CDP on port ${MANAGED_CHROME_PORT}`);
}

async function cleanupManagedChromeCdp(cdp, managedChrome) {
  if (!managedChrome) {
    return;
  }
  await cdp?.send("Browser.close").catch(() => {});
  managedChrome.child.kill("SIGTERM");
  await sleep(500);
  await fs.rm(managedChrome.userDataDir, { recursive: true, force: true }).catch((error) => {
    console.warn(`Unable to remove temporary Chrome profile ${managedChrome.userDataDir}: ${error.message}`);
  });
}

async function connectChromeCdpWithRecovery() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const cdp = new CdpClient(readChromeWebSocketEndpoint());
    try {
      await cdp.connect();
      if (attempt > 1) {
        console.log(`Connected to Chrome CDP after ${attempt} attempt(s).`);
      }
      return cdp;
    } catch (error) {
      lastError = error;
      cdp.close();
      const approval = await approveRemoteDebuggingPrompt();
      console.warn(`Chrome CDP connect attempt ${attempt}/5 failed: ${error.message}; prompt=${approval}`);
      await sleep(1500);
    }
  }
  throw lastError;
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function headerIndex(headers, header) {
  const index = headers.indexOf(header);
  if (index === -1) {
    throw new Error(`子表缺少表头: ${header}`);
  }
  return index;
}

async function pasteTsvToSheetRange(cdp, sheetPage, sheetUrl, gid, range, tsv) {
  const spreadsheetId = getSpreadsheetId(sheetUrl);
  const targetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}&range=${encodeURIComponent(range)}#gid=${gid}`;
  await copyToClipboard(tsv);
  await cdp.send("Target.activateTarget", { targetId: sheetPage.targetId }).catch(() => {});
  await cdp.send("Page.navigate", { url: targetUrl }, sheetPage.sessionId).catch(() => {});
  await sleep(4000);
  await cdp.send("Target.activateTarget", { targetId: sheetPage.targetId }).catch(() => {});
  await systemPasteIntoChrome();
  await sleep(8000);
}

async function resolveSheetGid(cdp, sessionId, sheetName) {
  const clicked = await cdp.send(
    "Runtime.evaluate",
    {
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const tabs = [...document.querySelectorAll(".docs-sheet-tab")];
        const tab = tabs.find((item) => (item.innerText || item.textContent || "").trim() === ${JSON.stringify(sheetName)});
        if (!tab) return { ok: false, reason: "sheet tab not found" };
        tab.scrollIntoView({ block: "center", inline: "center" });
        tab.click();
        return { ok: true };
      })()`
    },
    sessionId
  );
  if (clicked.result?.value?.ok === false) {
    throw new Error(clicked.result.value.reason);
  }
  await sleep(1500);
  const urlResult = await cdp.send(
    "Runtime.evaluate",
    {
      returnByValue: true,
      expression: "location.href"
    },
    sessionId
  );
  const url = urlResult.result?.value || "";
  const gid = new URL(url).searchParams.get("gid") || url.match(/[#&?]gid=(\\d+)/)?.[1];
  if (!gid) {
    throw new Error(`Unable to resolve gid for ${sheetName}`);
  }
  return gid;
}

async function pasteRowsToKeywordTotalSheet(cdp, sheetPage, sheetUrl, sheetName, rows, gidOverride) {
  if (rows.length === 0) {
    return { skipped: true };
  }

  const gid = gidOverride || await resolveSheetGid(cdp, sheetPage.sessionId, sheetName);
  const existing = await getSheetValues({
    sheetUrl,
    range: keywordTotalReadRange(sheetName)
  });
  if (!existing.ok) {
    throw new Error(`读取 ${sheetName} 失败: ${existing.reason || "unknown error"}`);
  }

  const headers = existing.values[0] || KEYWORD_TOTAL_HEADERS;
  const hasHeader = existing.values.length > 0 && isKeywordTotalHeaderRow(headers);
  if (existing.values.length > 0 && !hasHeader) {
    throw new Error(`${sheetName} 缺少必要表头，停止写入以避免覆盖旧数据。当前表头: ${headers.join(", ")}`);
  }

  if (!hasHeader) {
    const headerWrite = await updateSheetValues({
      sheetUrl,
      range: `${sheetName}!A1:F1`,
      values: [KEYWORD_TOTAL_HEADERS]
    });
    if (!headerWrite.ok) {
      throw new Error(`写入 ${sheetName} 表头失败: ${headerWrite.reason || "unknown error"}`);
    }
  }

  const duplicateFilter = filterDuplicateKeywordRows(rows, existingKeywordTotalKeys(existing.values));
  const newRows = duplicateFilter.kept;
  if (newRows.length === 0) {
    return {
      skipped: true,
      reason: "all_keywords_duplicate",
      duplicateRows: duplicateFilter.skipped.length
    };
  }

  const startRow = findKeywordTotalAppendStartRow({
    headers,
    rawRows: hasHeader ? existing.values : [KEYWORD_TOTAL_HEADERS]
  });
  const endRow = startRow + newRows.length - 1;
  const range = keywordTotalBaseWriteRange(startRow, endRow, sheetName, headers).replace(`${sheetName}!`, "");
  const sourceColumnIndex = keywordTotalSourceColumnIndex(headers);
  const sourceRange = sourceColumnIndex === -1
    ? ""
    : `${columnName(sourceColumnIndex)}${startRow}:${columnName(sourceColumnIndex)}${endRow}`;

  let writeResult = await updateSheetValues({
    sheetUrl,
    range: `${sheetName}!${range}`,
    values: buildKeywordTotalValues(newRows, { headers })
  });
  let sourceWriteResult = { skipped: true, reason: "source_header_missing" };
  if (writeResult.ok && sourceRange) {
    sourceWriteResult = await updateSheetValues({
      sheetUrl,
      range: `${sheetName}!${sourceRange}`,
      values: buildKeywordTotalSourceValues(newRows)
    });
  }
  if (!writeResult.ok && /exceeds grid limits/i.test(writeResult.reason || "")) {
    const appendedRowCount = Math.max(newRows.length + 100, 500);
    const expandResult = await batchUpdateSheet({
      sheetUrl,
      requests: [
        {
          appendDimension: {
            sheetId: Number(gid),
            dimension: "ROWS",
            length: appendedRowCount
          }
        }
      ]
    });
    if (!expandResult.ok) {
      throw new Error(`扩展 ${sheetName} 行数失败: ${expandResult.reason || "unknown error"}`);
    }
    const clearBufferFormatResult = await batchUpdateSheet({
      sheetUrl,
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: Number(gid),
              startRowIndex: startRow - 1,
              endRowIndex: startRow + appendedRowCount - 1,
              startColumnIndex: 1,
              endColumnIndex: 2
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 1, blue: 1 }
              }
            },
            fields: "userEnteredFormat.backgroundColor"
          }
        }
      ]
    });
    if (!clearBufferFormatResult.ok) {
      throw new Error(`清理 ${sheetName} 预留行关键词背景色失败: ${clearBufferFormatResult.reason || "unknown error"}`);
    }
    writeResult = await updateSheetValues({
      sheetUrl,
      range: `${sheetName}!${range}`,
      values: buildKeywordTotalValues(newRows, { headers })
    });
    if (writeResult.ok && sourceRange) {
      sourceWriteResult = await updateSheetValues({
        sheetUrl,
        range: `${sheetName}!${sourceRange}`,
        values: buildKeywordTotalSourceValues(newRows)
      });
    }
  }
  if (!writeResult.ok) {
    throw new Error(`写入 ${sheetName} 失败: ${writeResult.reason || "unknown error"}`);
  }
  if (sourceWriteResult.ok === false) {
    throw new Error(`写入 ${sheetName} 来源列失败: ${sourceWriteResult.reason || "unknown error"}`);
  }

  const judgementFormatResult = await formatRejectedKeywordCells({
    sheetUrl,
    sheetId: gid,
    startRow,
    rows: newRows
  }).catch((error) => ({ ok: false, reason: error.message || String(error) }));

  const verify = await getSheetValues({
    sheetUrl,
    range: keywordTotalReadRange(sheetName)
  });

  return {
    gid,
    startRow,
    endRow,
    pastedRows: newRows.length,
    duplicateRows: duplicateFilter.skipped.length,
    rowCountBeforeRead: Math.max(0, existing.values.length - (hasHeader ? 1 : 0)),
    rowCountAfterRead: verify.ok ? Math.max(0, verify.values.length - 1) : null,
    method: "google_sheets_api",
    mode: "append",
    range,
    sourceRange,
    writeResult,
    sourceWriteResult,
    judgementFormatResult
  };
}

async function writeKeywordTaskUpdates(cdp, sheetPage, sheetUrl, sheet, taskRow, updates) {
  const sheetName = "词根拓展";
  const headers = sheet.headers || [];

  const written = [];
  for (const update of updates) {
    const column = columnName(headerIndex(headers, update.header));
    const range = `${column}${taskRow}`;
    const result = await updateSheetValues({
      sheetUrl,
      range: `${sheetName}!${range}`,
      values: [[update.value]]
    });
    if (!result.ok) {
      throw new Error(`写入 ${sheetName}!${range} 失败: ${result.reason || "unknown error"}`);
    }
    written.push({ ...update, range });
  }

  let verifiedRow = {};
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await sleep(1500);
    const verify = await getSheetValues({
      sheetUrl,
      range: `${sheetName}!A${taskRow}:M${taskRow}`
    });
    const values = verify.ok ? verify.values[0] || [] : [];
    verifiedRow = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
    const mismatch = updates.find(
      (update) => String(verifiedRow[update.header] || "").trim() !== update.value
    );
    if (!mismatch) {
      return {
        row: taskRow,
        written,
        verified: true
      };
    }
  }

  throw new Error(
    `${sheetName} row ${taskRow} status write verification failed. Last row data: ${JSON.stringify(verifiedRow)}`
  );
}

async function updateKeywordTaskResultSheet(cdp, sheetPage, sheetUrl, sheet, taskRow, result) {
  return writeKeywordTaskUpdates(cdp, sheetPage, sheetUrl, sheet, taskRow, [
    {
      header: "筛选数量",
      value: String(result.filteredKeywordCount || result.collectedRows)
    },
    {
      header: "SEM完成状态",
      value: `已完成${result.collectedRows}个关键词采集`
    }
  ]);
}

async function updateKeywordTaskKeywordResultSheet(cdp, sheetPage, sheetUrl, sheet, taskRow) {
  return writeKeywordTaskUpdates(cdp, sheetPage, sheetUrl, sheet, taskRow, [
    {
      header: "SEM完成状态",
      value: "已完成关键词采集"
    }
  ]);
}

async function updateKeywordTaskStatusSheet(cdp, sheetPage, sheetUrl, sheet, taskRow, status) {
  return writeKeywordTaskUpdates(cdp, sheetPage, sheetUrl, sheet, taskRow, [
    {
      header: "SEM完成状态",
      value: status
    }
  ]);
}

async function recoverFromPageError(cdp, page, state, statePath, current, task, error) {
  state.recoveryAttempts = state.recoveryAttempts || {};
  const key = current.kind || "unknown";
  const attempts = (state.recoveryAttempts[key] || 0) + 1;
  state.recoveryAttempts[key] = attempts;
  state.lastRecoveryError = {
    page: key,
    message: error.message || String(error)
  };

  if (attempts >= 5) {
    await saveState(statePath, state);
    throw new Error(`页面 ${key} 连续恢复 ${attempts} 次失败: ${error.message || String(error)}`);
  }

  console.warn(`Recover ${key} after error (${attempts}/5): ${error.message || String(error)}`);
  state.matchTypeApplied = false;
  state.volumeFilterApplied = false;
  state.kdFilterApplied = false;
  state.magicPhraseValidated = false;

  if (["semrush_keyword_magic", "semrush_keyword_overview", "semrush_home", "semrush_error"].includes(key)) {
    await navigateToKeywordOverview(cdp, page.sessionId, task.query, task.matchCountry).catch(async () => {
      await searchSemrush(cdp, page.sessionId, task.query).catch(async () => {
        await navigateAndWait(cdp, page.sessionId, DASH_LOGIN_URL, 45000).catch(async () => {
          await sleep(3000);
        });
      });
    });
  } else {
    await navigateAndWait(cdp, page.sessionId, DASH_LOGIN_URL, 45000).catch(async () => {
      await sleep(3000);
    });
  }

  await saveState(statePath, state);
}

async function runSemrushFlow(cdp, page, config, state, statePath, maxPages) {
  const { task, toolAccount } = config;
  const semrushUsername = toolAccount["semrush账号"] || "";
  const semrushPassword = toolAccount["semrush密码"] || toolAccount["密码"] || "";
  const expectedDb = countryDatabaseCode(task.matchCountry) || "us";

  if (!semrushUsername || !semrushPassword) {
    throw new Error("工具账号密码 子表缺少 semrush账号 或 semrush密码");
  }
	  for (let step = 0; step < 30; step += 1) {
	    await closeSemrushCoachmark(cdp, page.sessionId);
	    const current = await detectPage(cdp, page.sessionId);
    state.lastDetectedPage = current;
    await saveState(statePath, state);
    console.log(`Page: ${current.kind} ${current.url}`);

    try {
      if (current.kind === "dash_login") {
        await loginDash(cdp, page.sessionId, semrushUsername, semrushPassword);
        state.dashLoggedIn = true;
        await saveState(statePath, state);
        continue;
      }

      if (current.kind === "dash_home") {
        await openSemrushFromDash(cdp, page.sessionId);
        state.openedSemrushFromDash = true;
        await saveState(statePath, state);
        page = await switchToLatestSemrushPage(cdp, page);
        continue;
      }

      if (current.kind === "semrush_home") {
        await navigateToKeywordOverview(cdp, page.sessionId, task.query, task.matchCountry);
        state.searchedQuery = task.query;
        await saveState(statePath, state);
        continue;
      }

      if (current.kind === "semrush_keyword_overview") {
        if (
          (current.query || "").trim().toLowerCase() !== task.query.toLowerCase() ||
          ((current.db || "").trim().toLowerCase() !== expectedDb)
        ) {
          await navigateToKeywordOverview(cdp, page.sessionId, task.query, task.matchCountry);
          state.searchedQuery = task.query;
          state.searchedDb = expectedDb;
          await saveState(statePath, state);
          continue;
        }

        if (task.mode === "keyword") {
          const metrics = await extractKeywordOverviewMetrics(cdp, page.sessionId, task.query);
          const hasCountry = Boolean(task.matchCountry);
          const rows = [{
            root: "",
            keyword: task.query,
            country: hasCountry ? task.matchCountry : "全球",
            volume: hasCountry ? metrics.localVolume : metrics.globalVolume,
            kd: metrics.kd,
            semrush_page: "keyword_overview"
          }];
          state.keywordOverviewMetrics = metrics;
          state.collectedRows = rows.length;
          state.filteredKeywordCount = rows.length;
          state.completed = true;
          await saveState(statePath, state);
          return { page, rows, filteredKeywordCount: rows.length };
        }

        await navigateToKeywordMagic(cdp, page.sessionId, task);
        state.openedKeywordMagic = true;
        await saveState(statePath, state);
        continue;
      }

      if (current.kind === "semrush_keyword_magic") {
        if (task.mode === "keyword") {
          await navigateToKeywordOverview(cdp, page.sessionId, task.query, task.matchCountry);
          state.keywordModeReturnedToOverview = true;
          await saveState(statePath, state);
          continue;
        }

        const actualPhrase = (current.phrase || "").trim();
        if (
          actualPhrase && actualPhrase.toLowerCase() !== task.query.toLowerCase() ||
          current.query && current.query.toLowerCase() !== task.query.toLowerCase() ||
          ((current.db || "").trim().toLowerCase() !== expectedDb)
        ) {
          state.magicPhraseMismatch = {
            expected: task.query,
            actual: actualPhrase || current.query,
            expectedDb,
            actualDb: current.db || ""
          };
          state.matchTypeApplied = false;
          state.volumeFilterApplied = false;
          state.kdFilterApplied = false;
          state.magicSearchResult = await navigateToKeywordMagic(cdp, page.sessionId, task);
          state.searchedQuery = task.query;
          await saveState(statePath, state);
          continue;
        }

        await validateMagicPhrase(cdp, page.sessionId, task.query);
        state.magicPhraseValidated = true;
        await saveState(statePath, state);

        state.matchTypeResult = await selectMatchType(cdp, page.sessionId, task.matchType);
        state.matchTypeApplied = true;
        await saveState(statePath, state);

        state.volumeFilterResult = await applyRangeFilter(
          cdp,
          page.sessionId,
          "搜索量",
          task.volumeMin,
          task.volumeMax
        );
        state.volumeFilterApplied = true;
        await saveState(statePath, state);

        state.kdFilterResult = await applyRangeFilter(
          cdp,
          page.sessionId,
          "KD %",
          task.kdMin,
          task.kdMax
        );
        state.kdFilterApplied = true;
        await saveState(statePath, state);

        await ensureFirstKeywordMagicPage(cdp, page.sessionId);
        const rows = await collectAllKeywordPages(cdp, page.sessionId, task, maxPages);
        state.collectedRows = rows.length;
        state.filteredKeywordCount = rows.filteredKeywordCount || rows.length;
        state.completed = true;
        await saveState(statePath, state);
        return { page, rows, filteredKeywordCount: state.filteredKeywordCount };
      }

      await navigateAndWait(cdp, page.sessionId, DASH_LOGIN_URL, 45000).catch(async () => {
        await sleep(3000);
      });
    } catch (error) {
      await recoverFromPageError(cdp, page, state, statePath, current, task, error);
    }
	  }

  throw new Error("Semrush workflow did not reach a terminal state within 30 steps.");
}

async function runOneTask({
  cdp,
  page,
  baseConfig,
  sheetUrl,
  taskRow,
  maxPages,
  outDir,
  keywordTotalGid,
  source,
  reset,
  skipSheetWrite
}) {
  const task = pickKeywordTask(baseConfig.keywordSheet.rows, taskRow);
  const config = {
    ...baseConfig,
    task
  };
  const runKey = taskRunKey(task);
  const statePath = path.join(outDir, `${runKey}.state.json`);
  const jsonPath = path.join(outDir, `${runKey}.keywords.json`);
  const csvPath = path.join(outDir, `${runKey}.keywords.csv`);
  const state = reset
    ? {}
    : await readJsonIfExists(statePath, {});

  console.log(`Loaded task row ${taskRow}: ${task.query}`);
  const result = await runSemrushFlow(cdp, page, config, state, statePath, maxPages);
  const outputCountry = task.mode === "keyword"
    ? ""
    : task.matchCountry;
  const rawOutputRows = toOutputRows(result.rows, { country: outputCountry, source });
  const keywordOverviewRows = rawOutputRows.map((row) => ({
          ...row,
          判断: "继续",
          机器筛选状态: "跳过",
          机器筛选原因: "keyword_overview_flow"
        }));
  const keywordFilterResult = task.mode === "keyword"
    ? {
        rows: keywordOverviewRows,
        accepted: keywordOverviewRows,
        rejected: [],
        summary: {
          enabled: false,
          rawRows: rawOutputRows.length,
          acceptedRows: rawOutputRows.length,
          rejectedRows: 0,
          reason: "keyword_overview_flow"
        }
      }
    : filterKeywordRowsForEcommerce(rawOutputRows, task);
  const outputRows = keywordFilterResult.rows;

  await writeJson(jsonPath, {
    source: {
      sheetUrl,
      taskRow,
      query: task.query,
      mode: task.mode,
      collectedAt: new Date().toISOString()
    },
    machineFilter: keywordFilterResult.summary,
    rows: outputRows,
    continueRows: keywordFilterResult.accepted,
    rejectedRows: keywordFilterResult.rejected
  });
  await writeCsv(csvPath, outputRows);

  let sheetWriteResult = { skipped: true };
  let taskWriteResult = { skipped: true };
  if (!skipSheetWrite) {
    sheetWriteResult = await pasteRowsToKeywordTotalSheet(
      cdp,
      baseConfig.targetPage,
      sheetUrl,
      "关键词总表",
      outputRows,
      keywordTotalGid
    );
    await writeJson(path.join(outDir, `${runKey}.sheet-write.json`), sheetWriteResult);
    taskWriteResult = task.mode === "keyword"
      ? await updateKeywordTaskKeywordResultSheet(
          cdp,
          baseConfig.targetPage,
          sheetUrl,
          baseConfig.keywordSheet,
          taskRow
        )
      : await updateKeywordTaskResultSheet(
          cdp,
          baseConfig.targetPage,
          sheetUrl,
          baseConfig.keywordSheet,
          taskRow,
          {
            filteredKeywordCount: result.filteredKeywordCount,
            collectedRows: outputRows.length
          }
        );
    await writeJson(path.join(outDir, `${runKey}.task-write.json`), taskWriteResult);
  }

  console.log(
    `Collected ${rawOutputRows.length} keyword row(s); ${keywordFilterResult.accepted.length} marked 继续, ${keywordFilterResult.rejected.length} marked 拒绝.`
  );
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
  if (sheetWriteResult.skipped) {
    console.log("Skipped Google Sheet write.");
  } else {
    console.log(`Wrote ${sheetWriteResult.pastedRows} row(s) to 关键词总表 from row ${sheetWriteResult.startRow}.`);
  }

  return {
    page: result.page,
    summary: {
      row: taskRow,
      query: task.query,
      mode: task.mode,
      collectedRows: rawOutputRows.length,
      rawCollectedRows: rawOutputRows.length,
      continueRows: keywordFilterResult.accepted.length,
      rejectedRows: keywordFilterResult.rejected.length,
      filteredKeywordCount: result.filteredKeywordCount,
      sheetWriteResult,
      taskWriteResult
    }
  };
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const rowArg = readArg("row", "");
  const fromRowArg = readArg("from-row", "");
  const toRowArg = readArg("to-row", "");
  const taskRows = resolveTaskRows({ rowArg, fromRowArg, toRowArg });
  const isBatch = taskRows.length > 1 || Boolean(fromRowArg || toRowArg);
  const maxPagesArg = readArg("max-pages", "all");
  const maxPages = maxPagesArg === "all" ? Number.POSITIVE_INFINITY : Number(maxPagesArg);
  const outDir = readArg("out-dir", "output/semrush-step1");
  const keywordTotalGid = readArg("keyword-total-gid", "999267438");
  const source = readArg("source", "");
  const reset = readFlag("reset");
  const skipSheetWrite = readFlag("skip-sheet-write");
  const force = readFlag("force");
  const stopOnError = readFlag("stop-on-error");
  const restartWorkPageEvery = Number(readArg("restart-work-page-every", "0")) || 0;

  let managedChrome;
  let cdp;
  let page;
  let handledSinceWorkPageRestart = 0;
  let config;
  try {
    managedChrome = await launchManagedChromeCdp();
    cdp = await connectChromeCdpWithRecovery();
    console.log("Reading Google Sheet config...");
	    config = await readToolConfig(cdp, {
      sheetUrl,
      taskRow: taskRows[0],
      requireTask: !isBatch
    });
    console.log("Attaching Semrush work page...");
    if (restartWorkPageEvery > 0) {
      await closeAllWorkTargets(cdp);
    }
	    page = await openOrAttachWorkPage(cdp, config.chromeProfile);

    const summaries = [];
    for (let taskIndex = 0; taskIndex < taskRows.length; taskIndex += 1) {
      const taskRow = taskRows[taskIndex];
      if (!page) {
        page = await openOrAttachWorkPage(cdp, config.chromeProfile);
      }
      const row = config.keywordSheet.rows[taskRow - 2];
      if (!hasTaskInput(row)) {
        console.log(`Skip row ${taskRow}: empty task row.`);
        summaries.push({ row: taskRow, skipped: true, reason: "empty" });
        continue;
      }
      if (isBatch && !force && isCompletedTask(row)) {
        console.log(`Skip row ${taskRow}: already completed. Use --force to rerun.`);
        summaries.push({ row: taskRow, skipped: true, reason: "completed" });
        continue;
      }

      try {
        const result = await runOneTask({
          cdp,
          page,
          baseConfig: config,
          sheetUrl,
          taskRow,
          maxPages,
          outDir,
          keywordTotalGid,
          source,
          reset,
          skipSheetWrite
        });
        page = result.page;
        summaries.push(result.summary);
        handledSinceWorkPageRestart += 1;
        if (
          restartWorkPageEvery > 0 &&
          handledSinceWorkPageRestart >= restartWorkPageEvery &&
          taskIndex < taskRows.length - 1
        ) {
          await closeWorkPage(cdp, page).catch((error) => {
            console.warn(`Unable to close Semrush work page after row ${taskRow}: ${shortErrorMessage(error)}`);
          });
          await closeAllWorkTargets(cdp);
          page = null;
          handledSinceWorkPageRestart = 0;
        }
      } catch (error) {
        const status = `失败：${shortErrorMessage(error)}`;
        console.error(`Row ${taskRow} failed: ${shortErrorMessage(error)}`);
        summaries.push({ row: taskRow, failed: true, error: shortErrorMessage(error) });
        if (!skipSheetWrite) {
          await updateKeywordTaskStatusSheet(
            cdp,
            config.targetPage,
            sheetUrl,
            config.keywordSheet,
            taskRow,
            status
          ).catch((writeError) => {
            console.error(`Unable to write failure status for row ${taskRow}: ${shortErrorMessage(writeError)}`);
          });
        }
        if (!isBatch || stopOnError) {
          throw error;
        }
      }
    }

    await writeJson(path.join(outDir, "last-run-summary.json"), {
      sheetUrl,
      rows: taskRows,
      batch: isBatch,
      summaries
    });
    console.log(`Run summary: ${summaries.length} row(s) handled.`);
  } finally {
    if (page && cdp) {
      await detachChromePage(cdp, page.sessionId);
    }
    if (config?.targetPage && cdp) {
      await detachChromePage(cdp, config.targetPage.sessionId);
    }
    await cleanupManagedChromeCdp(cdp, managedChrome);
    cdp?.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});

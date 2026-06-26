#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readArg, readFlag } from "./lib/args.mjs";
import {
  attachChromePage,
  CdpClient,
  createChromePage,
  detachChromePage,
  navigateAndWait,
  waitForChromeTargetWithCdp
} from "./lib/cdp.mjs";
import { sleep } from "./lib/browser-actions.mjs";
import { writeCsv, writeJson } from "./lib/files.mjs";
import {
  batchUpdateSheet,
  getSpreadsheetSheets,
  getSheetValues,
  updateSheetValues
} from "./lib/google-sheets-api.mjs";
import {
  buildKeywordTotalValues,
  existingKeywordTotalKeys,
  filterDuplicateKeywordRows,
  findKeywordTotalAppendStartRow,
  isKeywordTotalHeaderRow,
  planKeywordTotalWriteCapacity,
  keywordTotalBaseWriteRange,
  keywordTotalReadRange,
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
  dismissJavascriptDialog,
  ensureFirstKeywordMagicPage,
  extractKeywordOverviewMetrics,
  extractKeywordRows,
  fetchKeywordMagicRowsViaPageApi,
  isSemrushNodeUnavailableMessage,
  loginDash,
  navigateToKeywordMagic,
  navigateToKeywordOverview,
  openSemrushFromDash,
  searchSemrush,
  selectMatchType,
  validateMagicPhrase,
  watchJavascriptDialogs
} from "./lib/semrush-page.mjs";
import {
  ensureSemrushSharedChrome,
  withSemrushSharedLock
} from "./lib/semrush-shared-chrome.mjs";

const DASH_LOGIN_URL = "https://dash.3ue.com/zh-Hans/#/login";
const DASH_HOME_URL = "https://dash.3ue.com/zh-Hans/#/page/m/home";
const ROW_DELAY_MS = 500;

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

async function openOwnedWorkPage(cdp) {
  const page = await createChromePage(cdp, "about:blank");
  await navigateAndWait(cdp, page.sessionId, DASH_LOGIN_URL, 45000).catch(async () => {
    await sleep(3000);
  });
  return page;
}

async function closeWorkPage(cdp, page) {
  if (!page) {
    return;
  }
  await detachChromePage(cdp, page.sessionId).catch(() => {});
  await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
}

async function pageTargetIds(cdp) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
  return new Set(targetInfos.filter((target) => target.type === "page").map((target) => target.targetId));
}

async function switchToOpenedSemrushPage(cdp, currentPage, existingTargetIds) {
  let lastCurrentUrl = "";
  const target = await waitForChromeTargetWithCdp(cdp, (item) => {
    if (item.type !== "page") return false;
    if (item.targetId === currentPage.targetId) {
      lastCurrentUrl = item.url || "";
    }
    return item.url.includes("sem.3ue.com") &&
      (item.targetId === currentPage.targetId || !existingTargetIds.has(item.targetId));
  }, 60000).catch((error) => {
    const current = lastCurrentUrl ? ` current=${lastCurrentUrl}` : "";
    throw new Error(`3ue did not open Semrush within 60s.${current} ${error.message || String(error)}`.trim());
  });
  if (target.targetId === currentPage.targetId) {
    return currentPage;
  }
  await closeWorkPage(cdp, currentPage);
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

async function connectChromeCdpWithRecovery(webSocketEndpoint) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const cdp = new CdpClient(webSocketEndpoint);
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

async function pasteRowsToKeywordTotalSheet(sheetUrl, sheetName, rows, gid) {
  if (rows.length === 0) {
    return { skipped: true };
  }

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
      range: `${sheetName}!A1:G1`,
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

  const metadata = await getSpreadsheetSheets({ sheetUrl });
  if (!metadata.ok) {
    throw new Error(`读取 Google Sheets 容量失败: ${metadata.reason || "unknown error"}`);
  }
  const capacity = planKeywordTotalWriteCapacity({
    sheets: metadata.sheets,
    sheetName,
    gid,
    startRow,
    rowCount: newRows.length
  });
  if (!capacity.ok) {
    throw new Error(
      `Google Sheets cell limit guard: ${sheetName} 需要新增 ${capacity.rowsToAppend} 行，` +
      `cells ${capacity.currentCells} -> ${capacity.cellsAfterAppend} 超过上限 ${capacity.limit}`
    );
  }

  if (capacity.rowsToAppend > 0) {
    const expandResult = await batchUpdateSheet({
      sheetUrl,
      requests: [
        {
          appendDimension: {
            sheetId: Number(gid),
            dimension: "ROWS",
            length: capacity.rowsToAppend
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
              startRowIndex: capacity.currentRowCount,
              endRowIndex: capacity.currentRowCount + capacity.rowsToAppend,
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
  }

  const writeResult = await updateSheetValues({
    sheetUrl,
    range: `${sheetName}!${range}`,
    values: buildKeywordTotalValues(newRows, { headers })
  });
  if (!writeResult.ok) {
    throw new Error(`写入 ${sheetName} 失败: ${writeResult.reason || "unknown error"}`);
  }

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
    writeResult
  };
}

async function writeKeywordTaskUpdates(sheetUrl, sheet, taskRow, updates) {
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

async function updateKeywordTaskResultSheet(sheetUrl, sheet, taskRow, result) {
  return writeKeywordTaskUpdates(sheetUrl, sheet, taskRow, [
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

async function updateKeywordTaskKeywordResultSheet(sheetUrl, sheet, taskRow) {
  return writeKeywordTaskUpdates(sheetUrl, sheet, taskRow, [
    {
      header: "SEM完成状态",
      value: "已完成关键词采集"
    }
  ]);
}

async function updateKeywordTaskStatusSheet(sheetUrl, sheet, taskRow, status) {
  return writeKeywordTaskUpdates(sheetUrl, sheet, taskRow, [
    {
      header: "SEM完成状态",
      value: status
    }
  ]);
}

function currentSemrushNode(state) {
  return Number(state?.semrushNode?.node || state?.semrushNode || 0) || 0;
}

async function recoverFromNodeUnavailable(cdp, page, state, statePath, error) {
  const node = currentSemrushNode(state);
  const blocked = new Set((state.unavailableSemrushNodes || []).map(Number).filter(Boolean));
  if (node) blocked.add(node);

  state.unavailableSemrushNodes = [...blocked].sort((a, b) => a - b);
  state.lastNodeUnavailableError = error.message || String(error);
  state.matchTypeApplied = false;
  state.volumeFilterApplied = false;
  state.kdFilterApplied = false;
  state.magicPhraseValidated = false;

  console.warn(
    `Semrush node unavailable; returning to user center and switching node. blocked=${state.unavailableSemrushNodes.join(",") || "none"}`
  );
  await navigateAndWait(cdp, page.sessionId, DASH_HOME_URL, 45000).catch(async () => {
    await sleep(3000);
  });
  await saveState(statePath, state);
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

  let nodeUnavailableDialog = null;
  let stopWatchingDialogs = () => {};
  let watchedSessionId = "";
  const watchCurrentPageDialogs = () => {
    if (watchedSessionId === page.sessionId) return;
    stopWatchingDialogs();
    watchedSessionId = page.sessionId;
    stopWatchingDialogs = watchJavascriptDialogs(cdp, page.sessionId, (event) => {
      state.lastJavascriptDialog = {
        message: event.message || "",
        type: event.type || "",
        url: event.url || "",
        seenAt: new Date().toISOString()
      };
      if (isSemrushNodeUnavailableMessage(event.message)) {
        nodeUnavailableDialog = event;
      }
    });
  };

  try {
    for (let step = 0; step < 30; step += 1) {
      watchCurrentPageDialogs();
      let current = { kind: "unknown", url: "" };
	    try {
        await closeSemrushCoachmark(cdp, page.sessionId);
        current = await detectPage(cdp, page.sessionId);
        state.lastDetectedPage = current;
        await saveState(statePath, state);
        console.log(`Page: ${current.kind} ${current.url}`);

	      if (current.kind === "dash_login") {
	        await withSemrushSharedLock("dash-login", () => loginDash(cdp, page.sessionId, semrushUsername, semrushPassword));
	        state.dashLoggedIn = true;
	        await saveState(statePath, state);
        continue;
      }
	
	      if (current.kind === "dash_home") {
	        const knownTargetIds = await pageTargetIds(cdp);
	        const openResult = await withSemrushSharedLock("dash-open-semrush", () =>
            openSemrushFromDash(cdp, page.sessionId, { blockedNodes: state.unavailableSemrushNodes || [] })
          );
	        state.openedSemrushFromDash = true;
          state.semrushNode = openResult.node;
	        await saveState(statePath, state);
	        page = await switchToOpenedSemrushPage(cdp, page, knownTargetIds);
	        continue;
	      }

      if (current.kind === "semrush_home") {
        if (task.mode === "keyword") {
          await navigateToKeywordOverview(cdp, page.sessionId, task.query, task.matchCountry);
          state.searchedQuery = task.query;
        } else {
          await navigateToKeywordMagic(cdp, page.sessionId, task);
          state.openedKeywordMagic = true;
        }
        await saveState(statePath, state);
        continue;
      }

      if (current.kind === "semrush_keyword_overview") {
        if (
          (current.query || "").trim().toLowerCase() !== task.query.toLowerCase() ||
          ((current.db || "").trim().toLowerCase() !== expectedDb)
        ) {
          if (task.mode === "keyword") {
            await navigateToKeywordOverview(cdp, page.sessionId, task.query, task.matchCountry);
            state.searchedQuery = task.query;
            state.searchedDb = expectedDb;
          } else {
            await navigateToKeywordMagic(cdp, page.sessionId, task);
            state.openedKeywordMagic = true;
          }
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

      if (current.kind === "unknown" && current.url === "about:blank") {
        throw new Error("3ue opened about:blank instead of Semrush.");
      }

      await withSemrushSharedLock("session-recovery", () =>
        navigateAndWait(cdp, page.sessionId, DASH_LOGIN_URL, 45000).catch(async () => {
          await sleep(3000);
	        })
	      );
	    } catch (error) {
        const acceptedDialog = await dismissJavascriptDialog(cdp, page.sessionId);
        const unavailableMessage = nodeUnavailableDialog?.message || "";
        if (
          isSemrushNodeUnavailableMessage(unavailableMessage) ||
          (current.kind === "dash_home" && /3ue did not open Semrush/i.test(error.message || String(error))) ||
          (acceptedDialog && /Runtime\.evaluate|Page\.enable/i.test(error.message || String(error)))
        ) {
          nodeUnavailableDialog = null;
          await withSemrushSharedLock("node-unavailable", () =>
            recoverFromNodeUnavailable(cdp, page, state, statePath, error)
          );
          continue;
        }
	      if (isFatalSemrushWorkflowError(error)) {
	        state.lastFatalError = error.message || String(error);
	        await saveState(statePath, state);
        throw error;
      }
      await withSemrushSharedLock("session-recovery", () =>
	        recoverFromPageError(cdp, page, state, statePath, current, task, error)
	      );
	    }
    }
  } finally {
    stopWatchingDialogs();
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
  const outputRows = toOutputRows(result.rows, { country: outputCountry, source });

  await writeJson(jsonPath, {
    source: {
      sheetUrl,
      taskRow,
      query: task.query,
      mode: task.mode,
      collectedAt: new Date().toISOString()
    },
    rows: outputRows
  });
  await writeCsv(csvPath, outputRows);

  let sheetWriteResult = { skipped: true };
  let taskWriteResult = { skipped: true };
  if (!skipSheetWrite) {
    sheetWriteResult = await pasteRowsToKeywordTotalSheet(
      sheetUrl,
      "关键词总表",
      outputRows,
      keywordTotalGid
    );
    await writeJson(path.join(outDir, `${runKey}.sheet-write.json`), sheetWriteResult);
    taskWriteResult = task.mode === "keyword"
      ? await updateKeywordTaskKeywordResultSheet(
          sheetUrl,
          baseConfig.keywordSheet,
          taskRow
        )
      : await updateKeywordTaskResultSheet(
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
    `Collected ${outputRows.length} keyword row(s).`
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
      collectedRows: outputRows.length,
      candidateRows: outputRows.length,
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

  let sharedChrome;
  let cdp;
  let page;
  let handledSinceWorkPageRestart = 0;
  let config;
  try {
    console.log("Reading Google Sheet config...");
    config = await readToolConfig({
      sheetUrl,
      taskRow: taskRows[0],
      requireTask: !isBatch
    });
    console.log("Starting shared Semrush Chrome...");
    sharedChrome = await ensureSemrushSharedChrome();
    cdp = await connectChromeCdpWithRecovery(sharedChrome.webSocketEndpoint);
    console.log(`Using shared Semrush Chrome on 127.0.0.1:${sharedChrome.port}.`);
    page = await openOwnedWorkPage(cdp);

    const summaries = [];
    for (let taskIndex = 0; taskIndex < taskRows.length; taskIndex += 1) {
      const taskRow = taskRows[taskIndex];
      let handledTask = false;
      if (!page) {
        page = await openOwnedWorkPage(cdp);
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
        handledTask = true;
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
          page = null;
          handledSinceWorkPageRestart = 0;
        }
	      } catch (error) {
        handledTask = true;
	        const status = `失败：${shortErrorMessage(error)}`;
        console.error(`Row ${taskRow} failed: ${shortErrorMessage(error)}`);
        summaries.push({ row: taskRow, failed: true, error: shortErrorMessage(error) });
        if (!skipSheetWrite) {
          await updateKeywordTaskStatusSheet(
            sheetUrl,
            config.keywordSheet,
            taskRow,
            status
          ).catch((writeError) => {
            console.error(`Unable to write failure status for row ${taskRow}: ${shortErrorMessage(writeError)}`);
          });
        }
	        if (!isBatch || stopOnError || isFatalSemrushWorkflowError(error)) {
	          throw error;
	        }
	      }
      if (handledTask && taskIndex < taskRows.length - 1) {
        await sleep(ROW_DELAY_MS);
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
      await closeWorkPage(cdp, page);
    }
    cdp?.close();
  }
}

export function isFatalSemrushWorkflowError(error) {
  return /3ue did not open Semrush|3ue opened about:blank|Session with given id not found|No target with given id found|Target closed|Google Sheets cell limit guard|读取 Google Sheets 容量失败/i.test(
    error?.message || String(error)
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

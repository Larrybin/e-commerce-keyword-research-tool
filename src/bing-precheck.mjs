#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  attachChromePage,
  CdpClient,
  createChromePage,
  detachChromePage,
  evaluate,
  navigateAndWait,
  readChromeWebSocketEndpoint,
  waitForChromeTargetWithCdp
} from "./lib/cdp.mjs";
import { sleep } from "./lib/browser-actions.mjs";
import {
  buildBingKeywordResearchUrl,
  fetchBingKeywordResearchViaPageApis,
  fetchBingTopSearchUrlsViaBrowser,
  keywordResearchUrlMatchesSite,
  navigateToBingKeywordResearch,
  searchBingKeyword
} from "./lib/bing-page.mjs";
import {
  getKeywordResearchMetrics,
  getKeywordCountryRows,
  isBingThrottleError,
  parseCountryCodes,
  readBingWebmasterApiKeys,
  shouldUseBingApiMetrics
} from "./lib/bing-webmaster-api.mjs";
import {
  classifyTopSearchResults,
  evaluateBingPrecheck,
  evaluateSerpOpportunity,
  formatInteger,
  sortCountryBreakdown
} from "./lib/bing-precheck.mjs";
import { readArg, readFlag } from "./lib/args.mjs";
import { findChromeProfile, openChromeProfileUrl } from "./lib/chrome-profiles.mjs";
import { readFeishuBingRegistry } from "./lib/feishu-registry.mjs";
import {
  batchUpdateSheet,
  batchUpdateSheetValues,
  buildCellBackgroundRequests,
  formatCellBackgrounds,
  getSheetValues,
  updateSheetValues
} from "./lib/google-sheets-api.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import {
  KEYWORD_TOTAL_SHEET,
  keywordTotalReadRange
} from "./lib/sheet-write.mjs";
import { writeJson } from "./lib/files.mjs";

const ACCOUNT_SHEET = "工具账号密码";
const TASK_SHEET = "词根拓展";
const DEFAULT_SITE_URL = "https://backwardstextgenerator.com/";
const WHITE_BACKGROUND = { red: 1, green: 1, blue: 1 };
const RED_BACKGROUND = { red: 1, green: 0, blue: 0 };
const PENDING_BACKGROUND = { red: 1, green: 0.9, blue: 0 };
const DEFAULT_BING_CHROME_PROFILE = "binben168er@gmail.com";

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

function rowToObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row?.[index] || ""]));
}

function valuesToTable(values) {
  const headers = values[0] || [];
  return {
    headers,
    rows: values.slice(1).map((row, index) => ({
      rowNumber: index + 2,
      values: row,
      record: rowToObject(headers, row)
    }))
  };
}

function headerIndex(headers, header) {
  const index = headers.indexOf(header);
  if (index === -1) {
    throw new Error(`${KEYWORD_TOTAL_SHEET} 缺少表头: ${header}`);
  }
  return index;
}

function isActualBingWebmasterApiKey(value) {
  return /^[a-f0-9]{32}$/i.test(String(value || "").trim());
}

async function readBingMetricApiKeys({ source = "auto", startFingerprintName = "25", startFeishuRow = 0 } = {}) {
  const normalizedSource = String(source || "auto").trim().toLowerCase();
  const feishuKeys = async () => {
    const rows = await readFeishuBingRegistry({
      startFingerprintName,
      requireBingApi: true,
      requireFingerprint: false
    });
    return rows
      .filter((row) => !startFeishuRow || row.rowNumber >= startFeishuRow)
      .map((row) => row.bingWebmasterApi)
      .filter(isActualBingWebmasterApiKey);
  };
  if (normalizedSource === "feishu") {
    return feishuKeys();
  }
  if (normalizedSource === "local" || normalizedSource === "file") {
    return readBingWebmasterApiKeys();
  }
  try {
    const keys = await feishuKeys();
    if (keys.length > 0) {
      return keys;
    }
  } catch (error) {
    console.warn(`Feishu Bing Webmaster API key unavailable, fallback to local file: ${error.message || String(error)}`);
  }
  return readBingWebmasterApiKeys();
}

function optionalHeaderIndex(headers, header) {
  return headers.indexOf(header);
}

function buildRuleIndex(taskTable) {
  const rootRules = new Map();
  const keywordRules = new Map();
  for (const row of taskTable.rows) {
    const root = String(row.record["词根"] || "").trim();
    const keyword = String(row.record["关键词"] || "").trim();
    if (root) {
      const list = rootRules.get(root.toLowerCase()) || [];
      list.push(row);
      rootRules.set(root.toLowerCase(), list);
    }
    if (keyword) {
      const list = keywordRules.get(keyword.toLowerCase()) || [];
      list.push(row);
      keywordRules.set(keyword.toLowerCase(), list);
    }
  }
  return { rootRules, keywordRules };
}

function findRuleForKeywordRow(keywordRow, ruleIndex) {
  const root = String(keywordRow.record["词根"] || "").trim();
  const keyword = String(keywordRow.record["关键词"] || "").trim();
  const candidates = root
    ? ruleIndex.rootRules.get(root.toLowerCase()) || []
    : ruleIndex.keywordRules.get(keyword.toLowerCase()) || [];
  if (candidates.length !== 1) {
    const source = root ? `词根=${root}` : `关键词=${keyword}`;
    throw new Error(`Bing 规则${candidates.length === 0 ? "不存在" : "不唯一"}: ${KEYWORD_TOTAL_SHEET} 第 ${keywordRow.rowNumber} 行 ${source}`);
  }
  return candidates[0];
}

function selectKeywordRows(keywordTable, { fromRow, toRow, force, onlyMissingCountry, chromeOnly, countryOnly }) {
  const prefilterIndex = headerIndex(keywordTable.headers, "agent预判断");
  const judgementIndex = headerIndex(keywordTable.headers, "判断");
  const bingJudgementIndex = optionalHeaderIndex(keywordTable.headers, "bing初步判断");
  const serpOpportunityIndex = optionalHeaderIndex(keywordTable.headers, "SERP机会判断");
  const top1CountryIndex = optionalHeaderIndex(keywordTable.headers, "top 1国家");
  const ratingIndex = optionalHeaderIndex(keywordTable.headers, "评级");
  if (countryOnly && ratingIndex === -1) {
    throw new Error(`${KEYWORD_TOTAL_SHEET} 缺少表头: 评级`);
  }
  const selected = [];
  for (const row of keywordTable.rows) {
    if (fromRow && row.rowNumber < fromRow) {
      continue;
    }
    if (toRow && row.rowNumber > toRow) {
      break;
    }
    const judgement = String(row.values[judgementIndex] || "").trim();
    if (!judgement && !toRow) {
      break;
    }
    const prefilter = String(row.values[prefilterIndex] || "").trim();
    if (prefilter !== "继续") {
      continue;
    }
    const bingJudgement = bingJudgementIndex === -1 ? "" : String(row.values[bingJudgementIndex] || "").trim();
    if (countryOnly) {
      const rating = ratingIndex === -1 ? "" : String(row.values[ratingIndex] || "").trim();
      if (rating !== "A") {
        continue;
      }
      if (onlyMissingCountry && top1CountryIndex !== -1 && String(row.values[top1CountryIndex] || "").trim()) {
        continue;
      }
      selected.push(row);
      continue;
    }
    if (judgement !== "继续") {
      continue;
    }
    if (onlyMissingCountry) {
      if (bingJudgement !== "继续") {
        continue;
      }
      if (String(row.values[top1CountryIndex] || "").trim()) {
        continue;
      }
    }
    if (chromeOnly) {
      const bingJudgement = bingJudgementIndex === -1 ? "" : String(row.values[bingJudgementIndex] || "").trim();
      const serpOpportunity = serpOpportunityIndex === -1 ? "" : String(row.values[serpOpportunityIndex] || "").trim();
      if (bingJudgement !== "继续") {
        continue;
      }
      if (serpOpportunity && !force) {
        continue;
      }
      selected.push(row);
      continue;
    }
    if (bingJudgement && !force) {
      continue;
    }
    selected.push(row);
  }
  return selected;
}

async function approveRemoteDebuggingPrompt() {
  return new Promise((resolve) => {
    const child = spawn("osascript", [
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
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.once("exit", () => resolve(stdout.trim() || "not-found"));
    child.once("error", (error) => resolve(`error:${error.message}`));
  });
}

async function connectChromeCdpWithRecovery() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const cdp = new CdpClient(readChromeWebSocketEndpoint());
    try {
      await cdp.connect();
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

function isBingAccountLimitError(error) {
  return /BING_ACCOUNT_LIMIT|quota|daily limit|usage limit|limit reached|too many requests|try again tomorrow|达到.*限制|次数.*限制|稍后再试/i.test(error?.message || String(error));
}

function isBingAccountSwitchableError(error) {
  return isBingAccountLimitError(error) ||
    /BING_TOP_URLS_EMPTY/i.test(error?.message || String(error)) ||
    /BING_ACCOUNT_UNAVAILABLE_FOR_SITE/i.test(error?.message || String(error));
}

function createAllBingApiKeysThrottledError(rowNumber) {
  const error = new Error(`所有 Bing Webmaster API key 都已达到限额，停止在第 ${rowNumber} 行`);
  error.name = "AllBingApiKeysThrottledError";
  return error;
}

function isAllBingApiKeysThrottledError(error) {
  return error?.name === "AllBingApiKeysThrottledError";
}

function isTransientBingAutomationError(error) {
  return /BING_API_CAPTURE_TIMEOUT|BING_TOP_URLS_EMPTY|Timed out waiting for CDP response|Timed out while loading|Target closed|WebSocket/i.test(
    error?.message || String(error)
  );
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isQuotaLimitedSheetResult(result) {
  const reason = String(result?.reason || "");
  return result?.status === 429 || /quota|rate|too many/i.test(reason);
}

async function retrySheetWrite(operation, {
  label,
  maxAttempts = 5,
  delayMs = 65000
}) {
  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await operation();
    if (lastResult.ok) {
      return lastResult;
    }
    if (!isQuotaLimitedSheetResult(lastResult) || attempt >= maxAttempts) {
      return lastResult;
    }
    const waitMs = delayMs + (attempt - 1) * 10000;
    console.warn(`${label} 触发限流，等待 ${Math.round(waitMs / 1000)} 秒后重试 (${attempt}/${maxAttempts})`);
    await sleep(waitMs);
  }
  return lastResult;
}

export function createSheetWriteQueue({
  sheetUrl,
  sheetId,
  outDir,
  batchSize = 25,
  retryDelayMs = 65000
}) {
  const valueWrites = [];
  const formatWrites = [];

  const pendingCount = () => valueWrites.length;
  const persistPending = async (error, reason) => {
    await fs.mkdir(outDir, { recursive: true });
    await writeJson(`${outDir}/pending-sheet-writes.json`, {
      reason,
      error: error?.message || String(error || ""),
      valueWrites,
      formatWrites,
      savedAt: new Date().toISOString()
    });
  };

  return {
    enqueueRow({ rowNumber, headers, values }) {
      const endColumn = columnName(Math.max(headers.length, values.length) - 1);
      const range = `${KEYWORD_TOTAL_SHEET}!A${rowNumber}:${endColumn}${rowNumber}`;
      valueWrites.push({
        rowNumber,
        range,
        values: [values.slice(0, Math.max(headers.length, values.length))]
      });
      return { queued: true, range };
    },
    enqueueBackgrounds({ cells, color }) {
      if (!cells.length) {
        return { skipped: true, reason: "no_cells" };
      }
      for (const cell of cells) {
        formatWrites.push({ cell, color });
      }
      return { queued: true, cells: cells.length };
    },
    pendingCount,
    shouldFlush() {
      return pendingCount() >= batchSize;
    },
    async flush(reason = "manual") {
      if (valueWrites.length === 0 && formatWrites.length === 0) {
        return { skipped: true, reason: "empty_queue" };
      }
      const pendingValues = valueWrites.splice(0);
      const pendingFormats = formatWrites.splice(0);
      try {
        let valueResult = { skipped: true, reason: "no_value_writes" };
        if (pendingValues.length > 0) {
          valueResult = await retrySheetWrite(
            () => batchUpdateSheetValues({
              sheetUrl,
              data: pendingValues.map(({ range, values }) => ({ range, values }))
            }),
            { label: `批量写入 ${pendingValues.length} 行`, delayMs: retryDelayMs }
          );
          if (!valueResult.ok) {
            throw new Error(valueResult.reason || "batch_value_write_failed");
          }
        }

        let formatResult = { skipped: true, reason: "no_format_writes" };
        if (pendingFormats.length > 0) {
          const requests = pendingFormats.flatMap(({ cell, color }) =>
            buildCellBackgroundRequests({ sheetId, cells: [cell], color })
          );
          formatResult = await retrySheetWrite(
            () => batchUpdateSheet({ sheetUrl, requests }),
            { label: `批量格式化 ${pendingFormats.length} 个单元格`, delayMs: retryDelayMs }
          );
          if (!formatResult.ok) {
            throw new Error(formatResult.reason || "batch_format_write_failed");
          }
        }

        return {
          ok: true,
          reason,
          valueRows: pendingValues.length,
          formatCells: pendingFormats.length,
          valueResult,
          formatResult
        };
      } catch (error) {
        valueWrites.unshift(...pendingValues);
        formatWrites.unshift(...pendingFormats);
        await persistPending(error, reason).catch(() => {});
        error.name = "SheetWriteQueueError";
        throw error;
      }
    }
  };
}

async function closeDuplicateBingTabs(cdp, keepTargetId, siteUrl) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets");
  const duplicates = targetInfos.filter(
    (target) =>
      target.type === "page" &&
      target.targetId !== keepTargetId &&
      keywordResearchUrlMatchesSite(target.url, siteUrl)
  );
  for (const target of duplicates) {
    await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  }
  return duplicates.length;
}

async function openOrAttachBingPage(cdp, profile, siteUrl, { reuseExisting = true, cleanDuplicates = false } = {}) {
  const targetUrl = buildBingKeywordResearchUrl(siteUrl);
  const { targetInfos = [] } = await cdp.send("Target.getTargets");
  if (reuseExisting) {
    const existing = targetInfos.find(
      (target) => target.type === "page" && keywordResearchUrlMatchesSite(target.url, siteUrl)
    );
    if (existing) {
      if (cleanDuplicates) {
        const closed = await closeDuplicateBingTabs(cdp, existing.targetId, siteUrl);
        if (closed > 0) {
          console.log(`Closed ${closed} duplicate Bing Keyword Research tab(s).`);
        }
      }
      return attachChromePage(cdp, existing.targetId);
    }
  }

  const beforeTargetIds = new Set(targetInfos.map((target) => target.targetId));
  await openChromeProfileUrl(profile, targetUrl).catch(() => {});
  const target = await waitForChromeTargetWithCdp(
    cdp,
    (item) =>
      item.type === "page" &&
      item.url.includes("bing.com/webmasters/keywordresearch") &&
      !beforeTargetIds.has(item.targetId),
    15000
  ).catch(async () => {
    const created = await createChromePage(cdp, targetUrl);
    return { targetId: created.targetId, _attachedPage: created };
  });
  if (target._attachedPage) {
    return target._attachedPage;
  }
  if (cleanDuplicates) {
    const closed = await closeDuplicateBingTabs(cdp, target.targetId, siteUrl);
    if (closed > 0) {
      console.log(`Closed ${closed} duplicate Bing Keyword Research tab(s).`);
    }
  }
  return attachChromePage(cdp, target.targetId);
}

async function readRequiredSheet(sheetUrl, range) {
  const result = await getSheetValues({ sheetUrl, range });
  if (!result.ok) {
    throw new Error(`读取 ${range} 失败: ${result.reason || "unknown error"}`);
  }
  return valuesToTable(result.values || []);
}

function buildKeywordTotalUpdates(keywordHeaders, keywordRow, precheck, competition) {
  const updates = new Map();
  const set = (header, value, { required = true } = {}) => {
    const index = required ? headerIndex(keywordHeaders, header) : optionalHeaderIndex(keywordHeaders, header);
    if (index === -1) {
      return;
    }
    updates.set(index, value);
  };

  set("3M展示", formatInteger(precheck.impressionsNumber));
  set("bing初步判断", precheck.judgement);
  set("SERP机会判断", competition.judgement);
  set("top10大平台数", String(competition.platformCount), { required: false });
  set("top10独立站数", String(competition.independentSiteCount), { required: false });
  set("疑似低权重独立站", competition.suspiciousLowAuthorityIndependentSite, { required: false });
  set("SERP格局", competition.pattern, { required: false });

  const existing = [...keywordRow.values];
  for (const [columnIndex, value] of updates.entries()) {
    existing[columnIndex] = value;
  }
  return existing;
}

function findTopCountrySlots(keywordHeaders) {
  return keywordHeaders
    .map((header) => {
      const match = String(header || "").match(/^top\s*(\d+)\s*国家$/i);
      if (!match) return null;
      const slot = Number(match[1]);
      const impressionHeader = keywordHeaders.find((candidate) => {
        const text = String(candidate || "");
        return new RegExp(`^top\\s*${slot}\\s*展示量$`, "i").test(text);
      });
      return Number.isFinite(slot) && impressionHeader ? {
        slot,
        countryHeader: header,
        impressionHeader
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.slot - b.slot);
}

function buildKeywordTotalApiUpdates(keywordHeaders, keywordRow, apiPrecheck) {
  const updates = new Map();
  const set = (header, value, { required = true } = {}) => {
    const index = required ? headerIndex(keywordHeaders, header) : optionalHeaderIndex(keywordHeaders, header);
    if (index === -1) {
      return;
    }
    updates.set(index, value);
  };

  set("3M展示", formatInteger(apiPrecheck.impressionsNumber));
  set("bing初步判断", apiPrecheck.judgement);

  for (const header of [
    "SERP机会判断",
    "top10大平台数",
    "top10独立站数",
    "疑似低权重独立站",
    "SERP格局"
  ]) {
    set(header, "", { required: false });
  }

  const existing = [...keywordRow.values];
  for (const [columnIndex, value] of updates.entries()) {
    existing[columnIndex] = value;
  }
  return existing;
}

function buildKeywordTotalCountryUpdates(keywordHeaders, keywordRow, countryTopRows) {
  const updates = new Map();
  const set = (header, value) => {
    const index = headerIndex(keywordHeaders, header);
    updates.set(index, value);
  };
  const slots = findTopCountrySlots(keywordHeaders);
  const topCountries = countryTopRows.slice(0, slots.length);
  for (const slot of slots) {
    const row = topCountries[slot.slot - 1];
    set(slot.countryHeader, row?.country || "");
    set(slot.impressionHeader, formatInteger(row?.impressionsNumber ?? ""));
  }
  const existing = [...keywordRow.values];
  for (const [columnIndex, value] of updates.entries()) {
    existing[columnIndex] = value;
  }
  return existing;
}

function buildKeywordTotalChromeUpdates(keywordHeaders, keywordRow, chromePrecheck, competition) {
  const updates = new Map();
  const set = (header, value, { required = true } = {}) => {
    const index = required ? headerIndex(keywordHeaders, header) : optionalHeaderIndex(keywordHeaders, header);
    if (index === -1) {
      return;
    }
    updates.set(index, value);
  };

  set("SERP机会判断", chromePrecheck.judgement);
  set("top10大平台数", String(competition.platformCount), { required: false });
  set("top10独立站数", String(competition.independentSiteCount), { required: false });
  set("疑似低权重独立站", competition.suspiciousLowAuthorityIndependentSite, { required: false });
  set("SERP格局", chromePrecheck.pattern, { required: false });

  const existing = [...keywordRow.values];
  for (const [columnIndex, value] of updates.entries()) {
    existing[columnIndex] = value;
  }
  return existing;
}

async function writeKeywordTotalRow({ sheetUrl, rowNumber, headers, values, writeQueue }) {
  if (writeQueue) {
    return writeQueue.enqueueRow({ rowNumber, headers, values });
  }
  const endColumn = columnName(Math.max(headers.length, values.length) - 1);
  const result = await updateSheetValues({
    sheetUrl,
    range: `${KEYWORD_TOTAL_SHEET}!A${rowNumber}:${endColumn}${rowNumber}`,
    values: [values.slice(0, Math.max(headers.length, values.length))]
  });
  if (!result.ok) {
    throw new Error(`写入 ${KEYWORD_TOTAL_SHEET} 第 ${rowNumber} 行失败: ${result.reason || "unknown error"}`);
  }
  return result;
}

async function formatCellBackgroundsOrQueue({
  writeQueue,
  sheetUrl,
  sheetId,
  cells,
  color = RED_BACKGROUND
}) {
  if (writeQueue) {
    return writeQueue.enqueueBackgrounds({ cells, color });
  }
  return formatCellBackgrounds({ sheetUrl, sheetId, cells, color });
}

async function processKeywordRow({
  cdp,
  page,
  sheetUrl,
  siteUrl,
  keywordTotalGid,
  keywordTable,
  keywordRow,
  rule,
  bingApiKey,
  useBingApiMetrics,
  bingApiCountryConcurrency,
  bingApiCountryRequestDelayMs,
  writeQueue
}) {
  const keyword = String(keywordRow.record["关键词"] || "").trim();
  const minImpressions = rule.record["bing最低展示量"] || "";
  let extracted;
  if (useBingApiMetrics && bingApiKey) {
    const metrics = await getKeywordResearchMetrics({
      apiKey: bingApiKey,
      keyword,
      countryCodes: [],
      countryConcurrency: bingApiCountryConcurrency,
      countryRequestDelayMs: bingApiCountryRequestDelayMs
    });
    const topUrls = await fetchBingTopSearchUrlsViaBrowser(cdp, page.sessionId, { keyword, siteUrl });
    extracted = {
      impressions: metrics.impressions,
      topUrls,
      countryRows: metrics.countryRows,
      source: "bing-webmaster-api"
    };
  } else {
    extracted = await fetchBingKeywordResearchViaPageApis(cdp, page.sessionId, { keyword, siteUrl });
  }
  const serp = classifyTopSearchResults(extracted.topUrls, 10);
  const serpPrecheck = evaluateSerpOpportunity(serp);
  const precheck = evaluateBingPrecheck({
    impressions: extracted.impressions,
    minImpressions
  });

  const values = buildKeywordTotalUpdates(
    keywordTable.headers,
    keywordRow,
    precheck,
    { ...serp, ...serpPrecheck }
  );
  const writeResult = await writeKeywordTotalRow({
    sheetUrl,
    rowNumber: keywordRow.rowNumber,
    headers: keywordTable.headers,
    values,
    writeQueue
  });

  const redCells = [];
  const ruleCells = [
    { row: keywordRow.rowNumber, column: headerIndex(keywordTable.headers, "3M展示") }
  ];
  const serpCellHeader = optionalHeaderIndex(keywordTable.headers, "SERP格局") === -1 ? "SERP机会判断" : "SERP格局";
  const serpCell = { row: keywordRow.rowNumber, column: headerIndex(keywordTable.headers, serpCellHeader) };
  await formatCellBackgroundsOrQueue({
    writeQueue,
    sheetUrl,
    sheetId: keywordTotalGid,
    cells: [...ruleCells, serpCell],
    color: WHITE_BACKGROUND
  }).catch(() => ({ skipped: true }));

  if (precheck.impressionFailed) {
    redCells.push(ruleCells[0]);
  }
  const formatResult = await formatCellBackgroundsOrQueue({
    writeQueue,
    sheetUrl,
    sheetId: keywordTotalGid,
    cells: redCells,
    color: RED_BACKGROUND
  }).catch((error) => ({ ok: false, reason: error.message || String(error) }));
  const pendingFormatResult = await formatCellBackgroundsOrQueue({
    writeQueue,
    sheetUrl,
    sheetId: keywordTotalGid,
    cells: serpPrecheck.judgement === "待定" ? [serpCell] : [],
    color: PENDING_BACKGROUND
  }).catch((error) => ({ ok: false, reason: error.message || String(error) }));

  return {
    row: keywordRow.rowNumber,
    keyword,
    judgement: precheck.judgement,
    serpJudgement: serpPrecheck.judgement,
    impressions: formatInteger(precheck.impressionsNumber),
    top10PlatformCount: serp.platformCount,
    top10IndependentSiteCount: serp.independentSiteCount,
    suspiciousLowAuthorityIndependentSite: serp.suspiciousLowAuthorityIndependentSite,
    serpPattern: serpPrecheck.pattern,
    topCountries: [],
    writeResult,
    formatResult,
    pendingFormatResult
  };
}

async function processKeywordRowApiOnly({
  sheetUrl,
  keywordTotalGid,
  keywordTable,
  keywordRow,
  rule,
  bingApiKey,
  bingApiCountryConcurrency,
  bingApiCountryRequestDelayMs,
  writeQueue
}) {
  const keyword = String(keywordRow.record["关键词"] || "").trim();
  const minImpressions = rule.record["bing最低展示量"] || "";
  const metrics = await getKeywordResearchMetrics({
    apiKey: bingApiKey,
    keyword,
    countryCodes: [],
    countryConcurrency: bingApiCountryConcurrency,
    countryRequestDelayMs: bingApiCountryRequestDelayMs
  });
  const apiPrecheck = evaluateBingPrecheck({
    impressions: metrics.impressions,
    minImpressions
  });
  const values = buildKeywordTotalApiUpdates(keywordTable.headers, keywordRow, apiPrecheck);
  const writeResult = await writeKeywordTotalRow({
    sheetUrl,
    rowNumber: keywordRow.rowNumber,
    headers: keywordTable.headers,
    values,
    writeQueue
  });

  const impressionCell = { row: keywordRow.rowNumber, column: headerIndex(keywordTable.headers, "3M展示") };
  await formatCellBackgroundsOrQueue({
    writeQueue,
    sheetUrl,
    sheetId: keywordTotalGid,
    cells: [impressionCell],
    color: WHITE_BACKGROUND
  }).catch(() => ({ skipped: true }));

  const formatResult = await formatCellBackgroundsOrQueue({
    writeQueue,
    sheetUrl,
    sheetId: keywordTotalGid,
    cells: apiPrecheck.impressionFailed ? [impressionCell] : [],
    color: RED_BACKGROUND
  }).catch((error) => ({ ok: false, reason: error.message || String(error) }));

  return {
    row: keywordRow.rowNumber,
    keyword,
    judgement: apiPrecheck.judgement,
    impressions: formatInteger(apiPrecheck.impressionsNumber),
    topCountries: [],
    writeResult,
    formatResult
  };
}

async function processKeywordRowCountryOnly({
  sheetUrl,
  keywordTable,
  keywordRow,
  bingApiKey,
  bingApiCountryCodes,
  bingApiCountryConcurrency,
  bingApiCountryRequestDelayMs,
  writeQueue
}) {
  const keyword = String(keywordRow.record["关键词"] || "").trim();
  const countryTopRows = await getKeywordCountryRows({
    apiKey: bingApiKey,
    keyword,
    countryCodes: bingApiCountryCodes,
    countryConcurrency: bingApiCountryConcurrency,
    countryRequestDelayMs: bingApiCountryRequestDelayMs
  });
  const values = buildKeywordTotalCountryUpdates(keywordTable.headers, keywordRow, countryTopRows);
  const writeResult = await writeKeywordTotalRow({
    sheetUrl,
    rowNumber: keywordRow.rowNumber,
    headers: keywordTable.headers,
    values,
    writeQueue
  });
  return {
    row: keywordRow.rowNumber,
    keyword,
    judgement: keywordRow.record["bing初步判断"] || "",
    impressions: keywordRow.record["3M展示"] || "",
    topCountries: countryTopRows.slice(0, 10),
    writeResult
  };
}

async function fetchTopUrlsForKeyword(cdp, page, { keyword, siteUrl }) {
  await searchBingKeyword(cdp, page.sessionId, keyword, siteUrl);
  const topUrls = await extractTopUrlsFromCurrentPageDom(cdp, page.sessionId);
  if (topUrls.length > 0) {
    return topUrls;
  }
  throw new Error(`BING_TOP_URLS_EMPTY: ${keyword}`);
}

async function extractTopUrlsFromCurrentPageDom(cdp, sessionId) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const usableUrl = (url) => {
          try {
            const parsed = new URL(url);
            return /^https?:$/i.test(parsed.protocol) &&
              !/\\b(bing|microsoft)\\.com$/i.test(parsed.hostname) &&
              !/\\/search\\?/i.test(parsed.pathname + parsed.search);
          } catch {
            return false;
          }
        };
        const linkValue = (link) => clean(link.textContent) || link.href;
        const grids = [...document.querySelectorAll('[role="grid"]')];
        const topUrlGrid = grids.find((grid) =>
          /Top 10 url ranking on this keyword/i.test(grid.getAttribute("aria-label") || grid.innerText || "")
        );
        const heading = [...document.querySelectorAll("h1,h2,h3,div,span")]
          .find((el) => clean(el.textContent) === "Top 10 url ranking on this keyword");
        const headingTop = heading?.getBoundingClientRect?.().top ?? 0;
        const root = topUrlGrid ||
          (heading
            ? [...document.querySelectorAll(".cardStyle, [class*=card], section, [role=grid], div")]
              .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return rect.top >= headingTop - 8 &&
                  candidate.querySelectorAll("a").length > 0 &&
                  /https?:\\/\\//i.test(candidate.innerText || candidate.textContent || "");
              })
            : null);
        let urls = root
          ? [...root.querySelectorAll('[role="row"], a.secondaryInfo, a[href]')]
            .flatMap((item) => {
              if (item.matches?.("a.secondaryInfo")) return [linkValue(item)];
              const link = item.querySelector?.("a.secondaryInfo") ||
                [...(item.querySelectorAll?.("a[href]") || [])].find((candidate) => usableUrl(linkValue(candidate)));
              return link ? [linkValue(link)] : [];
            })
            .filter(usableUrl)
          : [];
        if (urls.length === 0 && heading) {
          urls = [...document.querySelectorAll("a.secondaryInfo, a[href]")]
            .filter((link) => {
              const rect = link.getBoundingClientRect();
              return rect.top >= headingTop - 8 && usableUrl(linkValue(link));
            })
            .map(linkValue);
        }
        if (urls.length > 0) {
          return { found: true, urls: [...new Set(urls)].slice(0, 10) };
        }
        if (heading || topUrlGrid) {
          window.scrollBy({ top: Math.floor(window.innerHeight * 0.45), left: 0, behavior: "instant" });
          return { found: true, urls: [] };
        }
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.8), left: 0, behavior: "instant" });
        return { found: false, urls: [] };
      })()`,
      15000
    ).catch(() => ({ found: false, urls: [] }));
    if (result.urls?.length) {
      return result.urls;
    }
    await sleep(650);
  }
  return [];
}

async function processKeywordRowChromeOnly({
  cdp,
  page,
  sheetUrl,
  siteUrl,
  keywordTotalGid,
  keywordTable,
  keywordRow,
  rule,
  writeQueue
}) {
  const keyword = String(keywordRow.record["关键词"] || "").trim();
  const topUrls = await fetchTopUrlsForKeyword(cdp, page, { keyword, siteUrl });
  const serp = classifyTopSearchResults(topUrls, 10);
  const chromePrecheck = evaluateSerpOpportunity(serp);
  const values = buildKeywordTotalChromeUpdates(keywordTable.headers, keywordRow, chromePrecheck, serp);
  const writeResult = await writeKeywordTotalRow({
    sheetUrl,
    rowNumber: keywordRow.rowNumber,
    headers: keywordTable.headers,
    values,
    writeQueue
  });

  const serpCellHeader = optionalHeaderIndex(keywordTable.headers, "SERP格局") === -1 ? "SERP机会判断" : "SERP格局";
  const serpCell = { row: keywordRow.rowNumber, column: headerIndex(keywordTable.headers, serpCellHeader) };
  await formatCellBackgroundsOrQueue({
    writeQueue,
    sheetUrl,
    sheetId: keywordTotalGid,
    cells: [serpCell],
    color: WHITE_BACKGROUND
  }).catch(() => ({ skipped: true }));

  const formatResult = await formatCellBackgroundsOrQueue({
    writeQueue,
    sheetUrl,
    sheetId: keywordTotalGid,
    cells: [],
    color: RED_BACKGROUND
  }).catch((error) => ({ ok: false, reason: error.message || String(error) }));
  const pendingFormatResult = await formatCellBackgroundsOrQueue({
    writeQueue,
    sheetUrl,
    sheetId: keywordTotalGid,
    cells: chromePrecheck.judgement === "待定" ? [serpCell] : [],
    color: PENDING_BACKGROUND
  }).catch((error) => ({ ok: false, reason: error.message || String(error) }));

  return {
    row: keywordRow.rowNumber,
    keyword,
    judgement: chromePrecheck.judgement,
    impressions: keywordRow.record["3M展示"] || "",
    top10PlatformCount: serp.platformCount,
    top10IndependentSiteCount: serp.independentSiteCount,
    suspiciousLowAuthorityIndependentSite: serp.suspiciousLowAuthorityIndependentSite,
    serpPattern: chromePrecheck.pattern,
    writeResult,
    formatResult,
    pendingFormatResult
  };
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const siteUrl = readArg("site-url", DEFAULT_SITE_URL);
  const rowArg = readArg("row", "");
  const fromRowArg = readArg("from-row", "");
  const toRowArg = readArg("to-row", "");
  const force = readFlag("force");
  const onlyMissingCountry = readFlag("only-missing-country");
  const stopOnError = readFlag("stop-on-error");
  const outDir = readArg("out-dir", "output/bing-precheck");
  const keywordTotalGid = readArg("keyword-total-gid", "999267438");
  const requestedBingAccount = readArg("bing-account", process.env.BING_CHROME_PROFILE || DEFAULT_BING_CHROME_PROFILE);
  const minDelayMs = Number(readArg("min-delay-ms", "3500")) || 3500;
  const maxDelayMs = Number(readArg("max-delay-ms", "7500")) || 7500;
  const rowRetries = Number(readArg("row-retries", "3")) || 3;
  const cleanBingTabs = readFlag("clean-bing-tabs");
  const apiOnlyRequested = readFlag("api-only");
  const chromeOnly = readFlag("chrome-only");
  const legacyCountryOnly = readFlag("country-only");
  const agentACountryOnly = readFlag("agent-a-country-only");
  const countryOnly = agentACountryOnly;
  const apiOnly = apiOnlyRequested || countryOnly;
  const useBingApiMetrics = shouldUseBingApiMetrics(readArg("bing-api-metrics", "1"));
  const bingApiSource = readArg("bing-api-source", "auto");
  const bingApiStartFingerprint = readArg("bing-api-start-fingerprint", "25");
  const bingApiStartFeishuRow = Number(readArg("bing-api-start-feishu-row", "0")) || 0;
  const bingApiCountryCodes = parseCountryCodes(readArg("bing-api-countries", ""));
  const bingApiCountryConcurrency = Number(readArg("bing-api-country-concurrency", "8")) || 8;
  const bingApiCountryRequestDelayMs = Number(readArg("bing-api-country-request-delay-ms", "0")) || 0;
  const sheetWriteBatchSize = Number(readArg("sheet-write-batch-size", "25")) || 25;
  const sheetWriteRetryDelayMs = Number(readArg("sheet-write-retry-delay-ms", "65000")) || 65000;

  const fromRow = Number(rowArg || fromRowArg || "0") || 0;
  const toRow = Number(rowArg || toRowArg || "0") || 0;

  if (countryOnly && chromeOnly) {
    throw new Error("--agent-a-country-only/--country-only 不能和 --chrome-only 同时使用");
  }
  if (apiOnly && chromeOnly) {
    throw new Error("--api-only 和 --chrome-only 不能同时使用");
  }
  if (legacyCountryOnly) {
    throw new Error("--country-only 已删除。国家流量只允许使用 --agent-a-country-only，并且只处理 评级=A 的行。");
  }
  if (readFlag("include-country-breakdown") || readFlag("skip-country-breakdown")) {
    throw new Error("--include-country-breakdown/--skip-country-breakdown 已删除。国家流量只允许在 --agent-a-country-only 模式抓取。");
  }

  let cdp = apiOnly ? null : await connectChromeCdpWithRecovery();
  let page;
  let writeQueue;
  let finalFlushCompleted = false;
  try {
    const [taskTable, keywordTable] = await Promise.all([
      readRequiredSheet(sheetUrl, `${TASK_SHEET}!A:Z`),
      readRequiredSheet(sheetUrl, keywordTotalReadRange())
    ]);
    console.log(`Keyword total headers: ${keywordTable.headers.join(" | ")}`);
    const accounts = apiOnly ? [] : [requestedBingAccount];
    const ruleIndex = buildRuleIndex(taskTable);
    const keywordRows = selectKeywordRows(keywordTable, {
      fromRow,
      toRow,
      force,
      onlyMissingCountry,
      chromeOnly,
      countryOnly
    });
    const bingApiKeys = useBingApiMetrics
      ? await readBingMetricApiKeys({
        source: bingApiSource,
        startFingerprintName: bingApiStartFingerprint,
        startFeishuRow: bingApiStartFeishuRow
      }).catch((error) => {
        console.warn(`Bing Webmaster API key unavailable, fallback to browser metrics: ${error.message || String(error)}`);
        return [];
      })
      : [];
    let bingApiKeyIndex = 0;
    const currentBingApiKey = () => bingApiKeys[bingApiKeyIndex] || "";
    const switchBingApiKey = () => {
      if (bingApiKeys.length === 0) {
        return "";
      }
      bingApiKeyIndex = (bingApiKeyIndex + 1) % bingApiKeys.length;
      return currentBingApiKey();
    };

    console.log(`Selected ${keywordRows.length} keyword row(s).`);
    console.log(`Bing metric source: ${bingApiKeys.length ? `official API (${bingApiSource}, ${bingApiKeys.length} key(s))` : "browser page"}`);
    console.log(`Mode: ${countryOnly ? "agent-a-country-only" : chromeOnly ? "chrome-only" : apiOnly ? "api-only" : "api+chrome"}`);
    console.log(`Country breakdown: ${countryOnly ? "agent A only" : "disabled"}`);
    writeQueue = createSheetWriteQueue({
      sheetUrl,
      sheetId: keywordTotalGid,
      outDir,
      batchSize: sheetWriteBatchSize,
      retryDelayMs: sheetWriteRetryDelayMs
    });

    if (apiOnly && bingApiKeys.length === 0) {
      throw new Error("api-only 模式需要飞书 api 注册中的 bing webmaster api、secrets/bing-webmaster-api-key.txt 或 BING_WEBMASTER_API_KEY");
    }

    let accountIndex = 0;
    const reconnectBingPage = async () => {
      if (page?.sessionId) {
        await detachChromePage(cdp, page.sessionId).catch(() => {});
      }
      cdp.close();
      cdp = await connectChromeCdpWithRecovery();
      page = null;
      return switchBingAccount({ reuseExisting: true });
    };

    const switchBingAccount = async ({ reuseExisting = false } = {}) => {
      if (page?.sessionId) {
        await detachChromePage(cdp, page.sessionId).catch(() => {});
      }
      const account = accounts[accountIndex];
      const profile = findChromeProfile(account);
      console.log(`Bing profile: ${account} (${profile.directory})`);
      page = await openOrAttachBingPage(cdp, profile, siteUrl, {
        reuseExisting,
        cleanDuplicates: cleanBingTabs
      });
      await navigateToBingKeywordResearch(cdp, page.sessionId, siteUrl);
      return { account, profile };
    };

    if (!apiOnly) {
      let reuseExistingBingTab = true;
      for (;;) {
        try {
          await switchBingAccount({ reuseExisting: reuseExistingBingTab });
          break;
        } catch (error) {
          if (!isBingAccountSwitchableError(error) || accountIndex >= accounts.length - 1) {
            throw error;
          }
          const previousAccount = accounts[accountIndex];
          accountIndex += 1;
          reuseExistingBingTab = false;
          console.warn(`Bing account unavailable on ${previousAccount}; switch to ${accounts[accountIndex]}.`);
        }
      }
    }

    const summaries = [];
    for (const keywordRow of keywordRows) {
      try {
        const rule = findRuleForKeywordRow(keywordRow, ruleIndex);
        let summary;
        if (chromeOnly) {
          for (let attempt = 0; attempt < accounts.length; attempt += 1) {
            try {
              for (let rowTry = 1; rowTry <= rowRetries; rowTry += 1) {
                try {
                  summary = await processKeywordRowChromeOnly({
                    cdp,
                    page,
                    sheetUrl,
                    siteUrl,
                    keywordTotalGid,
                  keywordTable,
                  keywordRow,
                    rule,
                    writeQueue
                  });
                  break;
                } catch (error) {
                  if (!isTransientBingAutomationError(error) || rowTry >= rowRetries) {
                    throw error;
                  }
                  console.warn(`Row ${keywordRow.rowNumber} transient chrome error; retry ${rowTry + 1}/${rowRetries}: ${error.message || String(error)}`);
                  await sleep(randomInt(2500, 5000));
                  await reconnectBingPage();
                }
              }
              break;
            } catch (error) {
              if (!isBingAccountSwitchableError(error) || accountIndex >= accounts.length - 1) {
                throw error;
              }
              const previousAccount = accounts[accountIndex];
              accountIndex += 1;
              console.warn(`Bing account switch needed on ${previousAccount}; switch to ${accounts[accountIndex]}.`);
              await switchBingAccount({ reuseExisting: false });
            }
          }
        } else if (apiOnly && countryOnly) {
          const maxKeyAttempts = Math.max(1, bingApiKeys.length);
          let keyAttempts = 0;
          for (let rowTry = 1; rowTry <= rowRetries; rowTry += 1) {
            try {
              summary = await processKeywordRowCountryOnly({
                sheetUrl,
                keywordTable,
                keywordRow,
                bingApiKey: currentBingApiKey(),
                bingApiCountryCodes,
                bingApiCountryConcurrency,
                bingApiCountryRequestDelayMs,
                writeQueue
              });
              break;
            } catch (error) {
              if (isBingThrottleError(error) && bingApiKeys.length > 1) {
                if (keyAttempts >= maxKeyAttempts) {
                  throw createAllBingApiKeysThrottledError(keywordRow.rowNumber);
                }
                const previousIndex = bingApiKeyIndex;
                switchBingApiKey();
                keyAttempts += 1;
                console.warn(
                  `Row ${keywordRow.rowNumber} API key ${previousIndex + 1}/${bingApiKeys.length} throttled; switch to key ${bingApiKeyIndex + 1}/${bingApiKeys.length}`
                );
                rowTry -= 1;
                continue;
              }
              if (rowTry >= rowRetries) {
                throw error;
              }
              console.warn(`Row ${keywordRow.rowNumber} API error; retry ${rowTry + 1}/${rowRetries}: ${error.message || String(error)}`);
              await sleep(1000 * rowTry);
            }
          }
        } else if (apiOnly) {
          const maxKeyAttempts = Math.max(1, bingApiKeys.length);
          let keyAttempts = 0;
          for (let rowTry = 1; rowTry <= rowRetries; rowTry += 1) {
            try {
              summary = await processKeywordRowApiOnly({
                sheetUrl,
                keywordTotalGid,
                keywordTable,
                keywordRow,
                rule,
                bingApiKey: currentBingApiKey(),
                bingApiCountryConcurrency,
                bingApiCountryRequestDelayMs,
                writeQueue
              });
              break;
            } catch (error) {
              if (isBingThrottleError(error) && bingApiKeys.length > 1) {
                if (keyAttempts >= maxKeyAttempts) {
                  throw createAllBingApiKeysThrottledError(keywordRow.rowNumber);
                }
                const previousIndex = bingApiKeyIndex;
                switchBingApiKey();
                keyAttempts += 1;
                console.warn(
                  `Row ${keywordRow.rowNumber} API key ${previousIndex + 1}/${bingApiKeys.length} throttled; switch to key ${bingApiKeyIndex + 1}/${bingApiKeys.length}`
                );
                rowTry -= 1;
                continue;
              }
              if (rowTry >= rowRetries) {
                throw error;
              }
              console.warn(`Row ${keywordRow.rowNumber} API error; retry ${rowTry + 1}/${rowRetries}: ${error.message || String(error)}`);
              await sleep(1000 * rowTry);
            }
          }
        } else {
          for (let attempt = 0; attempt < accounts.length; attempt += 1) {
            try {
              for (let rowTry = 1; rowTry <= rowRetries; rowTry += 1) {
                try {
                  summary = await processKeywordRow({
                    cdp,
                    page,
                    sheetUrl,
                    siteUrl,
                    keywordTotalGid,
                    keywordTable,
                    keywordRow,
                    rule,
                    bingApiKey: currentBingApiKey(),
                    useBingApiMetrics,
                    bingApiCountryConcurrency,
                    bingApiCountryRequestDelayMs,
                    writeQueue
                  });
                  break;
                } catch (error) {
                  if (!isTransientBingAutomationError(error) || rowTry >= rowRetries) {
                    throw error;
                  }
                  console.warn(`Row ${keywordRow.rowNumber} transient automation error; retry ${rowTry + 1}/${rowRetries}: ${error.message || String(error)}`);
                  await sleep(randomInt(2500, 5000));
                  await reconnectBingPage();
                }
              }
              break;
            } catch (error) {
              if (!isBingAccountSwitchableError(error) || accountIndex >= accounts.length - 1) {
                throw error;
              }
              const previousAccount = accounts[accountIndex];
              accountIndex += 1;
              console.warn(`Bing account switch needed on ${previousAccount}; switch to ${accounts[accountIndex]}.`);
              await switchBingAccount({ reuseExisting: false });
            }
          }
        }
        summaries.push(summary);
        console.log(`Row ${summary.row}: ${summary.keyword} -> ${summary.judgement}, 3M=${summary.impressions}${apiOnly ? "" : `, SERP=${summary.serpJudgement || summary.judgement}, platform=${summary.top10PlatformCount}, independent=${summary.top10IndependentSiteCount}`}`);
        if (writeQueue.shouldFlush()) {
          const flushResult = await writeQueue.flush(`batch_at_row_${summary.row}`);
          console.log(`Flushed ${flushResult.valueRows || 0} row write(s), ${flushResult.formatCells || 0} format cell(s).`);
        }
        await sleep(randomInt(Math.min(minDelayMs, maxDelayMs), Math.max(minDelayMs, maxDelayMs)));
      } catch (error) {
        if (error?.name === "SheetWriteQueueError") {
          throw error;
        }
        summaries.push({
          row: keywordRow.rowNumber,
          keyword: keywordRow.record["关键词"] || "",
          failed: true,
          error: error.message || String(error)
        });
        console.error(`Row ${keywordRow.rowNumber} failed: ${error.message || String(error)}`);
        if (!apiOnly && isBingAccountSwitchableError(error) && accountIndex >= accounts.length - 1) {
          throw new Error(`所有 Bing Webmaster 账号都不可用或额度已耗尽，停止运行。最后错误: ${error.message || String(error)}`);
        }
        if (isAllBingApiKeysThrottledError(error)) {
          throw error;
        }
        if (stopOnError) {
          throw error;
        }
      }
    }

    const finalFlushResult = await writeQueue.flush("final");
    finalFlushCompleted = true;
    if (!finalFlushResult.skipped) {
      console.log(`Final flush ${finalFlushResult.valueRows || 0} row write(s), ${finalFlushResult.formatCells || 0} format cell(s).`);
    }

    await fs.mkdir(outDir, { recursive: true });
    await writeJson(`${outDir}/last-run-summary.json`, {
      sheetUrl,
      siteUrl,
      mode: countryOnly ? "agent-a-country-only" : chromeOnly ? "chrome-only" : apiOnly ? "api-only" : "api+chrome",
      countryBreakdown: countryOnly ? "agent-a-only" : "disabled",
      accounts,
      lastAccount: accounts[accountIndex],
      rows: keywordRows.map((row) => row.rowNumber),
      summaries
    });
    console.log(`Run summary: ${summaries.length} row(s) handled.`);
  } finally {
    if (writeQueue && !finalFlushCompleted && writeQueue.pendingCount() > 0) {
      await writeQueue.flush("finally").catch((error) => {
        console.error(`Final write queue flush failed: ${error.message || String(error)}`);
      });
    }
    if (page?.sessionId && cdp) {
      await detachChromePage(cdp, page.sessionId).catch(() => {});
    }
    cdp?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

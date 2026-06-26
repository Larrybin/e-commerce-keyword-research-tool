#!/usr/bin/env node
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  getKeywordResearchMetrics,
  getKeywordCountryRows,
  isBingThrottleError,
  parseCountryCodes
} from "./lib/bing-webmaster-api.mjs";
import {
  evaluateBingPrecheck,
  formatInteger,
  sortCountryBreakdown
} from "./lib/bing-precheck.mjs";
import { readArg, readFlag } from "./lib/args.mjs";
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

const API_SHEET = "api";
const TASK_SHEET = "词根拓展";
const WHITE_BACKGROUND = { red: 1, green: 1, blue: 1 };
const RED_BACKGROUND = { red: 1, green: 0, blue: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

export function collectBingMetricApiKeysFromApiTable(apiTable, { startFingerprintName = "", startRow = 0 } = {}) {
  const fingerprintIndex = apiTable.headers.indexOf("指纹的名称");
  const bingApiIndex = apiTable.headers.indexOf("bing webmaster api");
  if (fingerprintIndex === -1) {
    throw new Error(`${API_SHEET} 缺少表头: 指纹的名称`);
  }
  if (bingApiIndex === -1) {
    throw new Error(`${API_SHEET} 缺少表头: bing webmaster api`);
  }

  const start = String(startFingerprintName || "").trim();
  const startIndex = start
    ? apiTable.rows.findIndex((row) => String(row.values[fingerprintIndex] || "").trim() === start)
    : 0;
  if (start && startIndex === -1) {
    throw new Error(`${API_SHEET} 中没有找到指纹名称: ${start}`);
  }

  return apiTable.rows
    .slice(start ? startIndex : 0)
    .filter((row) => !startRow || row.rowNumber >= startRow)
    .map((row) => row.values[bingApiIndex])
    .filter(isActualBingWebmasterApiKey);
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

function selectKeywordRows(keywordTable, { fromRow, toRow, force, onlyMissingCountry, countryOnly }) {
  const keywordIndex = headerIndex(keywordTable.headers, "关键词");
  const prefilterIndex = headerIndex(keywordTable.headers, "agent预判断");
  const bingJudgementIndex = optionalHeaderIndex(keywordTable.headers, "bing初步判断");
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
    const keyword = String(row.values[keywordIndex] || "").trim();
    if (!keyword && !toRow) {
      break;
    }
    if (!keyword) {
      continue;
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
    if (onlyMissingCountry) {
      if (bingJudgement !== "继续") {
        continue;
      }
      if (String(row.values[top1CountryIndex] || "").trim()) {
        continue;
      }
    }
    if (bingJudgement && !force) {
      continue;
    }
    selected.push(row);
  }
  return selected;
}

function createAllBingApiKeysThrottledError(rowNumber) {
  const error = new Error(`所有 Bing Webmaster API key 都已达到限额，停止在第 ${rowNumber} 行`);
  error.name = "AllBingApiKeysThrottledError";
  return error;
}

function isAllBingApiKeysThrottledError(error) {
  return error?.name === "AllBingApiKeysThrottledError";
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

async function readRequiredSheet(sheetUrl, range) {
  const result = await getSheetValues({ sheetUrl, range });
  if (!result.ok) {
    throw new Error(`读取 ${range} 失败: ${result.reason || "unknown error"}`);
  }
  return valuesToTable(result.values || []);
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

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const rowArg = readArg("row", "");
  const fromRowArg = readArg("from-row", "");
  const toRowArg = readArg("to-row", "");
  const force = readFlag("force");
  const onlyMissingCountry = readFlag("only-missing-country");
  const stopOnError = readFlag("stop-on-error");
  const outDir = readArg("out-dir", "output/bing-precheck");
  const keywordTotalGid = readArg("keyword-total-gid", "999267438");
  const minDelayMs = Number(readArg("min-delay-ms", "3500")) || 3500;
  const maxDelayMs = Number(readArg("max-delay-ms", "7500")) || 7500;
  const rowRetries = Number(readArg("row-retries", "3")) || 3;
  const legacyCountryOnly = readFlag("country-only");
  const agentACountryOnly = readFlag("agent-a-country-only");
  const countryOnly = agentACountryOnly;
  const bingApiStartFingerprint = readArg("bing-api-start-fingerprint", "");
  const bingApiStartRow = Number(readArg("bing-api-start-row", "0")) || 0;
  const bingApiCountryCodes = parseCountryCodes(readArg("bing-api-countries", ""));
  const bingApiCountryConcurrency = Number(readArg("bing-api-country-concurrency", "8")) || 8;
  const bingApiCountryRequestDelayMs = Number(readArg("bing-api-country-request-delay-ms", "0")) || 0;
  const bingApiKeyConcurrencyArg = Number(readArg("bing-api-key-concurrency", "0")) || 0;
  const sheetWriteBatchSize = Number(readArg("sheet-write-batch-size", "25")) || 25;
  const sheetWriteRetryDelayMs = Number(readArg("sheet-write-retry-delay-ms", "65000")) || 65000;

  const fromRow = Number(rowArg || fromRowArg || "0") || 0;
  const toRow = Number(rowArg || toRowArg || "0") || 0;

  if (legacyCountryOnly) {
    throw new Error("--country-only 已删除。国家流量只允许使用 --agent-a-country-only，并且只处理 评级=A 的行。");
  }
  if (readFlag("include-country-breakdown") || readFlag("skip-country-breakdown")) {
    throw new Error("--include-country-breakdown/--skip-country-breakdown 已删除。国家流量只允许在 --agent-a-country-only 模式抓取。");
  }

  let writeQueue;
  let finalFlushCompleted = false;
  try {
    const [taskTable, keywordTable, apiTable] = await Promise.all([
      readRequiredSheet(sheetUrl, `${TASK_SHEET}!A:Z`),
      readRequiredSheet(sheetUrl, keywordTotalReadRange()),
      readRequiredSheet(sheetUrl, `${API_SHEET}!A:Z`)
    ]);
    console.log(`Keyword total headers: ${keywordTable.headers.join(" | ")}`);
    const ruleIndex = buildRuleIndex(taskTable);
    const keywordRows = selectKeywordRows(keywordTable, {
      fromRow,
      toRow,
      force,
      onlyMissingCountry,
      countryOnly
    });
    const bingApiKeys = collectBingMetricApiKeysFromApiTable(apiTable, {
      startFingerprintName: bingApiStartFingerprint,
      startRow: bingApiStartRow
    });
    const bingApiKeyConcurrency = Math.max(1, Math.min(
      bingApiKeyConcurrencyArg || bingApiKeys.length,
      bingApiKeys.length,
      keywordRows.length || 1
    ));

    console.log(`Selected ${keywordRows.length} keyword row(s).`);
    if (bingApiKeys.length === 0) {
      throw new Error(`${API_SHEET} 表没有可用的 bing webmaster api`);
    }
    console.log(`Bing metric source: api sheet (${bingApiKeys.length} key(s))`);
    console.log(`Bing API key concurrency: ${bingApiKeyConcurrency}`);
    console.log(`Mode: ${countryOnly ? "agent-a-country-only" : "api-only"}`);
    console.log(`Country breakdown: ${countryOnly ? "agent A only" : "disabled"}`);
    writeQueue = createSheetWriteQueue({
      sheetUrl,
      sheetId: keywordTotalGid,
      outDir,
      batchSize: sheetWriteBatchSize,
      retryDelayMs: sheetWriteRetryDelayMs
    });

    const summaries = [];
    const retryRows = [];
    let nextRowIndex = 0;
    let flushChain = Promise.resolve();
    const takeNextRow = () => retryRows.pop() || keywordRows[nextRowIndex++];
    const flushQueued = async (reason) => {
      if (!writeQueue.shouldFlush()) {
        return { skipped: true, reason: "below_batch_size" };
      }
      flushChain = flushChain.then(async () => {
        if (!writeQueue.shouldFlush()) {
          return { skipped: true, reason: "below_batch_size" };
        }
        return writeQueue.flush(reason);
      });
      const flushResult = await flushChain;
      if (!flushResult.skipped) {
        console.log(`Flushed ${flushResult.valueRows || 0} row write(s), ${flushResult.formatCells || 0} format cell(s).`);
      }
      return flushResult;
    };

    const processKeywordRowWithKey = async (keywordRow, bingApiKey) => {
      const rule = countryOnly ? null : findRuleForKeywordRow(keywordRow, ruleIndex);
      for (let rowTry = 1; rowTry <= rowRetries; rowTry += 1) {
        try {
          if (countryOnly) {
            return await processKeywordRowCountryOnly({
              sheetUrl,
              keywordTable,
              keywordRow,
              bingApiKey,
              bingApiCountryCodes,
              bingApiCountryConcurrency,
              bingApiCountryRequestDelayMs,
              writeQueue
            });
          }
          return await processKeywordRowApiOnly({
            sheetUrl,
            keywordTotalGid,
            keywordTable,
            keywordRow,
            rule,
            bingApiKey,
            bingApiCountryConcurrency,
            bingApiCountryRequestDelayMs,
            writeQueue
          });
        } catch (error) {
          if (isBingThrottleError(error) || rowTry >= rowRetries) {
            throw error;
          }
          console.warn(`Row ${keywordRow.rowNumber} API error; retry ${rowTry + 1}/${rowRetries}: ${error.message || String(error)}`);
          await sleep(1000 * rowTry);
        }
      }
      throw new Error(`Row ${keywordRow.rowNumber} API retry exhausted`);
    };

    const runWorker = async (workerIndex, bingApiKey) => {
      for (;;) {
        const keywordRow = takeNextRow();
        if (!keywordRow) {
          return;
        }
        let shouldDelay = false;
        try {
          const summary = await processKeywordRowWithKey(keywordRow, bingApiKey);
          summaries.push(summary);
          console.log(`Row ${summary.row}: ${summary.keyword} -> ${summary.judgement}, 3M=${summary.impressions}`);
          await flushQueued(`batch_at_row_${summary.row}`);
          shouldDelay = true;
        } catch (error) {
          if (error?.name === "SheetWriteQueueError") {
            throw error;
          }
          if (isBingThrottleError(error)) {
            retryRows.push(keywordRow);
            console.warn(`API key ${workerIndex + 1}/${bingApiKeys.length} throttled; stop this key`);
            return;
          }
          summaries.push({
            row: keywordRow.rowNumber,
            keyword: keywordRow.record["关键词"] || "",
            failed: true,
            error: error.message || String(error)
          });
          console.error(`Row ${keywordRow.rowNumber} failed: ${error.message || String(error)}`);
          if (stopOnError) {
            throw error;
          }
        }
        if (shouldDelay) {
          await sleep(randomInt(Math.min(minDelayMs, maxDelayMs), Math.max(minDelayMs, maxDelayMs)));
        }
      }
    };

    await Promise.all(
      bingApiKeys
        .slice(0, bingApiKeyConcurrency)
        .map((bingApiKey, index) => runWorker(index, bingApiKey))
    );

    if (retryRows.length > 0 || nextRowIndex < keywordRows.length) {
      const rowNumber = (retryRows[0] || keywordRows[nextRowIndex])?.rowNumber || 0;
      throw createAllBingApiKeysThrottledError(rowNumber);
    }

    await flushChain;

    const finalFlushResult = await writeQueue.flush("final");
    finalFlushCompleted = true;
    if (!finalFlushResult.skipped) {
      console.log(`Final flush ${finalFlushResult.valueRows || 0} row write(s), ${finalFlushResult.formatCells || 0} format cell(s).`);
    }

    await fs.mkdir(outDir, { recursive: true });
    await writeJson(`${outDir}/last-run-summary.json`, {
      sheetUrl,
      mode: countryOnly ? "agent-a-country-only" : "api-only",
      countryBreakdown: countryOnly ? "agent-a-only" : "disabled",
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
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

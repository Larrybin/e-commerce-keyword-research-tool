#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readArg, readFlag } from "./lib/args.mjs";
import { writeJson } from "./lib/files.mjs";
import { getSheetValues, updateSheetValues } from "./lib/google-sheets-api.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import {
  columnName,
  valuesToTable
} from "./lib/table-utils.mjs";
import {
  AGENT_STATUS_COLUMN,
  evaluateKeywordAgentRow,
  targetAgentColumns
} from "./lib/keyword-agent-rules.mjs";
import { enrichItemsWithResearch } from "./lib/keyword-agent-research.mjs";
import {
  createHttpResearchProvider,
  createNoopResearchProvider
} from "./lib/keyword-research-provider.mjs";
import { detectResearchNeeds } from "./lib/keyword-research-boundary.mjs";
import { evaluateKeywordRowsWithOpenAI } from "./lib/openai-keyword-agent.mjs";

const TASK_SHEET = "词根拓展";
const KEYWORD_TOTAL_SHEET = "关键词总表";
const DEFAULT_LIMIT = 20;

export { AGENT_STATUS_COLUMN };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function isRulesMode(mode) {
  return mode === "rules";
}

function researchSummaryFields(research) {
  if (!research) {
    return {};
  }
  return {
    researchNeeded: Boolean(research.needed),
    researchReasons: research.reasons || [],
    researchProvider: research.provider || "",
    researchConfidence: research.confidence || "",
    researchSkipped: Boolean(research.skipped),
    researchError: research.error || "",
    researchSkipReason: research.skipReason || ""
  };
}

function headerExists(headers, header) {
  return optionalNormalizedHeaderIndex(headers, header) !== -1;
}

function compactList(values) {
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function countRows(rows) {
  return Array.isArray(rows) ? rows.length : Number(rows || 0);
}

function resolvedModelName(mode, model) {
  return isRulesMode(mode) ? "" : (model || process.env.OPENAI_MODEL || "gpt-5.4-mini");
}

function summarizeRule(rule = {}) {
  return {
    root: String(rule["词根"] || "").trim(),
    keyword: String(rule["关键词"] || "").trim(),
    intent: String(rule["意图"] || "").trim(),
    monetizationChannels: compactList([rule["变现渠道1"], rule["变现渠道2"]]),
    abilities: compactList([rule["能力1"], rule["能力2"]])
  };
}

export function buildHeaderDiagnostics(headers) {
  const agentStatusHeaderIndex = optionalNormalizedHeaderIndex(headers, AGENT_STATUS_COLUMN);
  const targetHeadersPresent = targetAgentColumns().filter((header) => headerExists(headers, header));
  const targetHeadersMissing = targetAgentColumns().filter((header) => !headerExists(headers, header));
  const optionalHeadersMissing = agentStatusHeaderIndex === -1 ? [AGENT_STATUS_COLUMN] : [];

  return {
    agentStatusHeaderPresent: agentStatusHeaderIndex !== -1,
    agentStatusHeaderName: AGENT_STATUS_COLUMN,
    agentStatusHeaderIndex,
    targetHeadersPresent,
    targetHeadersMissing,
    optionalHeadersMissing
  };
}

export function assertOptionalHeaders(headers, { requireAgentStatusColumn = false } = {}) {
  if (requireAgentStatusColumn && !headerExists(headers, AGENT_STATUS_COLUMN)) {
    throw new Error(
      `关键词总表 缺少可选表头 ${AGENT_STATUS_COLUMN}。请先在 Sheet 中新增精确表头「${AGENT_STATUS_COLUMN}」，或移除 --require-agent-status-column。`
    );
  }
}

export function buildPlanOnlySummary({
  sheetUrl = "",
  taskSheet = TASK_SHEET,
  keywordSheet = KEYWORD_TOTAL_SHEET,
  mode = "llm",
  model = "",
  dryRun = false,
  force = false,
  limit = DEFAULT_LIMIT,
  fromRow = 0,
  toRow = 0,
  researchEnabled = false,
  researchMaxItems = 5,
  researchEndpoint = "",
  researchFailOpen = true,
  selectedRows = [],
  pending = [],
  collectedSummaries = [],
  headerDiagnostics = null,
  ranAt = new Date().toISOString()
} = {}) {
  const plannedRows = pending.map((item) => {
    const planRow = {
      row: item.rowNumber,
      keyword: item.keyword,
      status: "planned",
      mode,
      model: resolvedModelName(mode, model),
      wouldEvaluate: true,
      wouldWrite: false,
      force,
      rule: summarizeRule(item.rule)
    };

    if (researchEnabled) {
      const researchNeed = detectResearchNeeds({
        keyword: item.keyword,
        rule: item.rule,
        keywordRecord: item.keywordRecord
      });
      planRow.researchNeeded = researchNeed.needed;
      planRow.researchReasons = researchNeed.reasons;
      planRow.researchLevel = researchNeed.level;
      planRow.researchProvider = "";
      planRow.researchSkipped = true;
      planRow.researchSkipReason = "plan_only";
    }

    return planRow;
  });

  return {
    source: {
      sheetUrl,
      taskSheet,
      keywordSheet,
      dryRun,
      planOnly: true,
      force,
      mode,
      model: resolvedModelName(mode, model),
      limit,
      fromRow,
      toRow,
      research: {
        enabled: researchEnabled,
        effective: false,
        planOnlyProviderSkipped: researchEnabled,
        endpointConfigured: Boolean(researchEndpoint),
        maxResearchItems: researchMaxItems,
        failOpen: researchFailOpen
      },
      headerDiagnostics,
      ranAt
    },
    selectedRows: countRows(selectedRows),
    pendingRows: pending.length,
    updatedRows: 0,
    skippedRows: collectedSummaries.length,
    wouldEvaluateRows: pending.length,
    wouldWriteRows: 0,
    rows: [...collectedSummaries, ...plannedRows]
  };
}

export function buildRuleIndex(taskTable) {
  const rootRules = new Map();
  const keywordRules = new Map();
  for (const row of taskTable.rows) {
    const root = normalizeKey(row.record["词根"]);
    const keyword = normalizeKey(row.record["关键词"]);
    if (root) {
      const candidates = rootRules.get(root) || [];
      candidates.push(row);
      rootRules.set(root, candidates);
    }
    if (keyword) {
      const candidates = keywordRules.get(keyword) || [];
      candidates.push(row);
      keywordRules.set(keyword, candidates);
    }
  }
  return { rootRules, keywordRules };
}

export function findRule(keywordRow, ruleIndex, { duplicateRule = "error" } = {}) {
  const root = normalizeKey(keywordRow.record["词根"]);
  const keyword = normalizeKey(keywordRow.record["关键词"]);
  const source = root ? `词根=${root}` : `关键词=${keyword}`;
  const candidates = root
    ? ruleIndex.rootRules.get(root) || []
    : ruleIndex.keywordRules.get(keyword) || [];

  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0].record;
  }
  if (duplicateRule === "latest") {
    return [...candidates]
      .sort((a, b) => Number(b.rowNumber || 0) - Number(a.rowNumber || 0))[0].record;
  }
  const taskRows = candidates
    .map((candidate) => candidate.rowNumber)
    .filter((rowNumber) => rowNumber !== undefined && rowNumber !== null)
    .join(", ");
  throw new Error(
    `关键词规则不唯一: 关键词总表第 ${keywordRow.rowNumber} 行 ${source} 匹配到词根拓展第 ${taskRows || "未知"} 行。请先拆分词根或后续引入 taskRunKey。`
  );
}

function normalizedHeaderIndex(headers, header, tableName = KEYWORD_TOTAL_SHEET) {
  const expected = String(header || "").trim();
  const index = headers.findIndex((candidate) => String(candidate || "").trim() === expected);
  if (index === -1) {
    throw new Error(`${tableName} 缺少表头: ${header}`);
  }
  return index;
}

function optionalNormalizedHeaderIndex(headers, header) {
  const expected = String(header || "").trim();
  return headers.findIndex((candidate) => String(candidate || "").trim() === expected);
}

export function validateHeaders(headers) {
  const required = [
    "词根",
    "关键词",
    "bing二次判断",
    ...targetAgentColumns()
  ];
  const normalized = new Set(headers.map((header) => String(header || "").trim()));
  const missing = required.filter((header) => !normalized.has(header));
  if (missing.length > 0) {
    throw new Error(`${KEYWORD_TOTAL_SHEET} 缺少表头: ${missing.join(", ")}`);
  }
}

export function collectKeywordAgentPendingRows({
  keywordTable,
  ruleIndex,
  fromRow = 0,
  toRow = 0,
  limit = DEFAULT_LIMIT,
  force = false,
  duplicateRule = "error"
}) {
  const bingSecondIndex = normalizedHeaderIndex(keywordTable.headers, "bing二次判断");
  const keywordIndex = normalizedHeaderIndex(keywordTable.headers, "关键词");
  const selectedRows = [];
  const pending = [];
  const summaries = [];

  for (const row of keywordTable.rows) {
    if (fromRow && row.rowNumber < fromRow) {
      continue;
    }
    if (toRow && row.rowNumber > toRow) {
      break;
    }
    const keyword = String(row.values[keywordIndex] || "").trim();
    if (!keyword) {
      continue;
    }
    const bingSecond = String(row.values[bingSecondIndex] || "").trim();
    if (bingSecond !== "继续") {
      continue;
    }
    selectedRows.push(row);

    const skip = shouldSkipKeywordAgentRow({
      headers: keywordTable.headers,
      row,
      force
    });
    if (skip.skip) {
      summaries.push({
        row: row.rowNumber,
        keyword,
        status: "skipped",
        reason: skip.reason
      });
      continue;
    }

    const rule = findRule(row, ruleIndex, { duplicateRule });
    if (!rule) {
      summaries.push({
        row: row.rowNumber,
        keyword,
        status: "skipped",
        reason: "missing_rule"
      });
      continue;
    }

    pending.push({
      row,
      rowNumber: row.rowNumber,
      keyword,
      rule,
      keywordRecord: row.record
    });
    if (limit && pending.length >= limit) {
      break;
    }
  }

  return {
    selectedRows,
    pending,
    summaries
  };
}

export function buildRowUpdate(headers, row, proposedValues, { force = false } = {}) {
  const values = [...row.values];
  while (values.length < headers.length) {
    values.push("");
  }

  const changed = [];
  const ignoredHeaders = [];
  const blockedHeaders = [];
  const writableValues = {};
  const proposedValueCopy = { ...proposedValues };
  const proposedHeaders = Object.keys(proposedValueCopy);
  for (const [header, value] of Object.entries(proposedValues)) {
    const index = optionalNormalizedHeaderIndex(headers, header);
    if (index === -1) {
      ignoredHeaders.push(header);
      continue;
    }
    if (!force && String(values[index] || "").trim()) {
      blockedHeaders.push(header);
      continue;
    }
    values[index] = value;
    changed.push(header);
    writableValues[header] = value;
  }

  return {
    values,
    changed,
    proposedHeaders,
    ignoredHeaders,
    blockedHeaders,
    writableValues,
    proposedValues: proposedValueCopy
  };
}

function hasBlankTargetColumn(headers, row) {
  return targetAgentColumns().some((header) => {
    const index = optionalNormalizedHeaderIndex(headers, header);
    return index !== -1 && !String(row.values[index] || "").trim();
  });
}

export function shouldSkipKeywordAgentRow({ headers, row, force = false }) {
  if (force) {
    return { skip: false, reason: "" };
  }

  const statusIndex = optionalNormalizedHeaderIndex(headers, AGENT_STATUS_COLUMN);
  if (statusIndex !== -1) {
    const status = String(row.values[statusIndex] || "").trim();
    if (status === "完成") {
      return { skip: true, reason: "agent_status_done" };
    }
    if (status === "排除") {
      return { skip: true, reason: "agent_status_excluded" };
    }
  }

  if (!hasBlankTargetColumn(headers, row)) {
    return { skip: true, reason: "target_columns_already_filled" };
  }

  return { skip: false, reason: "" };
}

async function readRequiredSheet(sheetUrl, range) {
  const result = await getSheetValues({ sheetUrl, range });
  if (!result.ok) {
    throw new Error(`读取 ${range} 失败: ${result.reason || "unknown error"}`);
  }
  return valuesToTable(result.values || []);
}

async function writeKeywordRow({ sheetUrl, headers, rowNumber, values }) {
  const lastColumn = columnName(headers.length - 1);
  let lastResult;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    lastResult = await updateSheetValues({
      sheetUrl,
      range: `${KEYWORD_TOTAL_SHEET}!A${rowNumber}:${lastColumn}${rowNumber}`,
      values: [values.slice(0, headers.length)]
    });
    if (lastResult.ok) {
      return lastResult;
    }
    const reason = String(lastResult.reason || "");
    const quotaLimited = lastResult.status === 429 || /quota|rate|too many/i.test(reason);
    if (!quotaLimited || attempt >= 5) {
      return lastResult;
    }
    const waitMs = 65000 + (attempt - 1) * 10000;
    console.warn(`写入第 ${rowNumber} 行触发限流，等待 ${Math.round(waitMs / 1000)} 秒后重试 (${attempt}/5)`);
    await sleep(waitMs);
  }
  return lastResult;
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const fromRow = Number(readArg("from-row", "0")) || 0;
  const toRow = Number(readArg("to-row", "0")) || 0;
  const limit = Number(readArg("limit", String(DEFAULT_LIMIT))) || DEFAULT_LIMIT;
  const dryRun = readFlag("dry-run");
  const planOnly = readFlag("plan-only") || readFlag("preflight");
  const requireAgentStatusColumn = readFlag("require-agent-status-column");
  const force = readFlag("force");
  const duplicateRule = readArg("duplicate-rule", "error");
  const mode = readArg("mode", "llm");
  const model = readArg("model", process.env.OPENAI_MODEL || "");
  const out = readArg("out", "output/keyword-agent/last-run-summary.json");
  const writeDelayMs = Number(readArg("write-delay-ms", "1200")) || 1200;
  const researchEnabled = readFlag("research");
  const researchMaxItems = Number(readArg("research-max", "5")) || 5;
  const researchEndpoint = readArg("research-endpoint", process.env.KEYWORD_RESEARCH_ENDPOINT || "");
  const researchFailOpen = !readFlag("research-fail-closed");

  const [taskTable, keywordTable] = await Promise.all([
    readRequiredSheet(sheetUrl, `${TASK_SHEET}!A:S`),
    readRequiredSheet(sheetUrl, `${KEYWORD_TOTAL_SHEET}!A:AZ`)
  ]);

  validateHeaders(keywordTable.headers);
  assertOptionalHeaders(keywordTable.headers, { requireAgentStatusColumn });
  const headerDiagnostics = buildHeaderDiagnostics(keywordTable.headers);
  const ruleIndex = buildRuleIndex(taskTable);
  const collected = collectKeywordAgentPendingRows({
    keywordTable,
    ruleIndex,
    fromRow,
    toRow,
    limit,
    force,
    duplicateRule
  });
  const selectedRows = collected.selectedRows;
  let pending = collected.pending;
  const summaries = [...collected.summaries];
  const researchIgnoredInRulesMode = researchEnabled && isRulesMode(mode);
  const researchProviderMissing = researchEnabled && !dryRun && !researchIgnoredInRulesMode && !researchEndpoint;
  let researchProviderName = "";

  if (planOnly) {
    const summary = buildPlanOnlySummary({
      sheetUrl,
      taskSheet: TASK_SHEET,
      keywordSheet: KEYWORD_TOTAL_SHEET,
      mode,
      model,
      dryRun,
      force,
      duplicateRule,
      limit,
      fromRow,
      toRow,
      researchEnabled,
      researchMaxItems,
      researchEndpoint,
      researchFailOpen,
      selectedRows,
      pending,
      collectedSummaries: summaries,
      headerDiagnostics
    });
    await writeJson(out, summary);
    console.log(`Plan-only ${summary.pendingRows}/${summary.selectedRows} pending row(s). Wrote ${out}`);
    return;
  }

  if (researchEnabled && !researchIgnoredInRulesMode) {
    const provider = dryRun
      ? createNoopResearchProvider()
      : (researchEndpoint
          ? createHttpResearchProvider({
              endpoint: researchEndpoint,
              apiKey: process.env.KEYWORD_RESEARCH_API_KEY || ""
            })
          : createNoopResearchProvider());
    researchProviderName = provider.name;
    pending = await enrichItemsWithResearch(pending, {
      enabled: true,
      provider,
      maxResearchItems: dryRun ? 0 : researchMaxItems,
      failOpen: researchFailOpen
    });
  }

  const evaluations = isRulesMode(mode)
    ? pending.map((item) => ({
        rowNumber: item.rowNumber,
        values: evaluateKeywordAgentRow(item.row, item.rule).values,
        modelRationale: "",
        warnings: []
      }))
    : await evaluateKeywordRowsWithOpenAI(pending, { model: model || undefined });
  const evaluationByRow = new Map(evaluations.map((evaluation) => [Number(evaluation.rowNumber), evaluation]));

  for (const item of pending) {
    const row = item.row;
    const keyword = item.keyword;
    const evaluation = evaluationByRow.get(Number(row.rowNumber));
    if (!evaluation) {
      summaries.push({
        row: row.rowNumber,
        keyword,
        status: "skipped",
        reason: "missing_evaluation"
      });
      continue;
    }
    const update = buildRowUpdate(keywordTable.headers, row, evaluation.values, { force });
    if (update.changed.length === 0) {
      summaries.push({
        row: row.rowNumber,
        keyword,
        status: "skipped",
        reason: "target_columns_already_filled",
        proposedValues: update.proposedValues,
        writableValues: update.writableValues,
        ignoredHeaders: update.ignoredHeaders,
        blockedHeaders: update.blockedHeaders
      });
      continue;
    }

    let writeResult = { skipped: true, dryRun };
    if (!dryRun) {
      writeResult = await writeKeywordRow({
        sheetUrl,
        headers: keywordTable.headers,
        rowNumber: row.rowNumber,
        values: update.values
      });
      if (!writeResult.ok) {
        throw new Error(`写入第 ${row.rowNumber} 行失败: ${writeResult.reason || "unknown error"}`);
      }
    }

    summaries.push({
      row: row.rowNumber,
      keyword,
      status: dryRun ? "dry-run" : "updated",
      mode,
      model: resolvedModelName(mode, model),
      changed: update.changed,
      values: update.writableValues,
      proposedValues: update.proposedValues,
      writableValues: update.writableValues,
      ignoredHeaders: update.ignoredHeaders,
      blockedHeaders: update.blockedHeaders,
      modelRationale: evaluation.modelRationale,
      warnings: evaluation.warnings || [],
      ...researchSummaryFields(item.research),
      writeResult
    });
    if (!dryRun && writeDelayMs > 0) {
      await sleep(writeDelayMs);
    }
  }

  const summary = {
    source: {
      sheetUrl,
      taskSheet: TASK_SHEET,
      keywordSheet: KEYWORD_TOTAL_SHEET,
      dryRun,
      planOnly: false,
      force,
      mode,
      model: resolvedModelName(mode, model),
      writeDelayMs,
      limit,
      fromRow,
      toRow,
      research: {
        enabled: researchEnabled,
        effective: researchEnabled && !researchIgnoredInRulesMode,
        ignoredInRulesMode: researchIgnoredInRulesMode,
        provider: researchProviderName,
        providerMissing: researchProviderMissing,
        endpointConfigured: Boolean(researchEndpoint),
        maxResearchItems: researchMaxItems,
        failOpen: researchFailOpen,
        dryRunProviderSkipped: researchEnabled && dryRun && !researchIgnoredInRulesMode
      },
      headerDiagnostics,
      ranAt: new Date().toISOString()
    },
    selectedRows: selectedRows.length,
    updatedRows: summaries.filter((item) => item.status === "updated" || item.status === "dry-run").length,
    skippedRows: summaries.filter((item) => item.status === "skipped").length,
    rows: summaries
  };

  await writeJson(out, summary);
  console.log(`${dryRun ? "Dry-run" : "Updated"} ${summary.updatedRows}/${summary.selectedRows} selected row(s).`);
  console.log(`Wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

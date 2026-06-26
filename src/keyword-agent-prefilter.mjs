#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readArg, readFlag } from "./lib/args.mjs";
import { writeJson } from "./lib/files.mjs";
import { batchUpdateSheetValues, getSheetValues } from "./lib/google-sheets-api.mjs";
import { evaluateKeywordAgentPrefilter } from "./lib/keyword-agent-prefilter.mjs";
import { KEYWORD_TOTAL_SHEET, keywordTotalReadRange } from "./lib/sheet-write.mjs";
import { columnName, valuesToTable } from "./lib/table-utils.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";

const DEFAULT_LIMIT = 100;
const PREFILTER_COLUMN = "agent预判断";

function headerIndex(headers, header) {
  const index = headers.findIndex((candidate) => String(candidate || "").trim() === header);
  if (index === -1) throw new Error(`${KEYWORD_TOTAL_SHEET} 缺少表头: ${header}`);
  return index;
}

export function buildPrefilterCellUpdate(headers, row, evaluation, { force = false } = {}) {
  const prefilterIndex = headerIndex(headers, PREFILTER_COLUMN);
  const currentPrefilter = String(row.values[prefilterIndex] || "").trim();
  if (!force && currentPrefilter) {
    return { skipped: true, reason: "prefilter_already_filled" };
  }

  return {
    skipped: false,
    range: `${KEYWORD_TOTAL_SHEET}!${columnName(prefilterIndex)}${row.rowNumber}`,
    values: [[evaluation.judgement]]
  };
}

async function readKeywordTable(sheetUrl) {
  const result = await getSheetValues({ sheetUrl, range: keywordTotalReadRange() });
  if (!result.ok) throw new Error(`读取 ${KEYWORD_TOTAL_SHEET} 失败: ${result.reason || "unknown error"}`);
  return valuesToTable(result.values || []);
}

export function collectPrefilterRows(keywordTable, { fromRow = 0, toRow = 0, limit = DEFAULT_LIMIT, force = false } = {}) {
  const keywordIndex = headerIndex(keywordTable.headers, "关键词");
  const prefilterIndex = headerIndex(keywordTable.headers, PREFILTER_COLUMN);
  const rows = [];
  const skipped = [];

  for (const row of keywordTable.rows) {
    if (fromRow && row.rowNumber < fromRow) continue;
    if (toRow && row.rowNumber > toRow) break;
    const keyword = String(row.values[keywordIndex] || "").trim();
    if (!keyword) continue;
    const prefilter = String(row.values[prefilterIndex] || "").trim();
    if (!force && prefilter) {
      skipped.push({ row: row.rowNumber, keyword, status: "skipped", reason: "prefilter_already_filled" });
      continue;
    }
    rows.push(row);
    if (limit && rows.length >= limit) break;
  }

  return { rows, skipped };
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const fromRow = Number(readArg("from-row", "0")) || 0;
  const toRow = Number(readArg("to-row", "0")) || 0;
  const limit = Number(readArg("limit", String(DEFAULT_LIMIT))) || DEFAULT_LIMIT;
  const dryRun = readFlag("dry-run");
  const force = readFlag("force");
  const out = readArg("out", "output/keyword-agent-prefilter/last-run-summary.json");

  const keywordTable = await readKeywordTable(sheetUrl);
  const collected = collectPrefilterRows(keywordTable, { fromRow, toRow, limit, force });
  const summaries = [...collected.skipped];
  const updates = [];

  for (const row of collected.rows) {
    const evaluation = evaluateKeywordAgentPrefilter(row);
    const update = buildPrefilterCellUpdate(keywordTable.headers, row, evaluation, { force });
    if (update.skipped) {
      summaries.push({ row: row.rowNumber, keyword: row.record["关键词"], status: "skipped", reason: update.reason });
      continue;
    }

    updates.push({ range: update.range, values: update.values });

    summaries.push({
      row: row.rowNumber,
      keyword: row.record["关键词"],
      status: dryRun ? "dry-run" : "updated",
      values: {
        [PREFILTER_COLUMN]: evaluation.judgement
      },
      reason: evaluation.reason
    });
  }

  let writeResult = { skipped: true, dryRun };
  if (!dryRun && updates.length > 0) {
    writeResult = await batchUpdateSheetValues({
      sheetUrl,
      data: updates,
      valueInputOption: "RAW"
    });
    if (!writeResult.ok) throw new Error(`批量写入 ${KEYWORD_TOTAL_SHEET} ${PREFILTER_COLUMN} 失败: ${writeResult.reason || "unknown error"}`);
  }

  const summary = {
    source: { sheetUrl, keywordSheet: KEYWORD_TOTAL_SHEET, dryRun, force, limit, fromRow, toRow, writeMode: "batch_agent_prefilter_column", ranAt: new Date().toISOString() },
    selectedRows: collected.rows.length,
    updatedRows: summaries.filter((item) => item.status === "updated" || item.status === "dry-run").length,
    skippedRows: summaries.filter((item) => item.status === "skipped").length,
    writeResult,
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

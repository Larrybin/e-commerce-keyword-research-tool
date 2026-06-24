#!/usr/bin/env node
import { readArg, readFlag } from "./lib/args.mjs";
import { writeJson } from "./lib/files.mjs";
import { batchUpdateSheetValues, getSheetValues } from "./lib/google-sheets-api.mjs";
import { columnName, headerIndex, valuesToTable } from "./lib/table-utils.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import {
  KEYWORD_TOTAL_SHEET,
  keywordTotalReadRange
} from "./lib/sheet-write.mjs";
import {
  buildTaskStatusUpdates,
  statusColumns
} from "./lib/task-status-summary.mjs";

const TASK_SHEET = "词根拓展";

const TASK_READ_RANGE = `${TASK_SHEET}!A:Z`;
const KEYWORD_READ_RANGE = keywordTotalReadRange();

const REQUIRED_KEYWORD_HEADERS = [
  "词根",
  "关键词",
  "判断",
  "3M展示",
  "bing初步判断",
  "SERP机会判断",
  "第一次判断",
  "评级",
  "agent状态",
  "top 1国家"
];

function quoteSheetName(sheetName) {
  return `'${sheetName.replaceAll("'", "''")}'`;
}

function trim(value) {
  return String(value || "").trim();
}

function validateHeaders(tableName, headers, requiredHeaders) {
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(`${tableName} 缺少表头: ${missing.join(", ")}`);
  }
}

export function buildTaskStatusWritePlan(taskTable, keywordTable) {
  validateHeaders(TASK_SHEET, taskTable.headers, ["词根", "关键词", ...statusColumns()]);
  validateHeaders(KEYWORD_TOTAL_SHEET, keywordTable.headers, REQUIRED_KEYWORD_HEADERS);

  const statusIndexes = Object.fromEntries(
    statusColumns().map((header) => [header, headerIndex(taskTable.headers, header, TASK_SHEET)])
  );

  const updates = buildTaskStatusUpdates(taskTable, keywordTable);
  return updates.map((update) => {
    const changedCells = statusColumns()
      .map((header) => {
        const index = statusIndexes[header];
        const current = trim(taskTable.rows.find((row) => row.rowNumber === update.rowNumber)?.record?.[header]);
        const proposed = update.values[header] || "";
        return {
          header,
          current,
          proposed,
          column: columnName(index),
          range: `${quoteSheetName(TASK_SHEET)}!${columnName(index)}${update.rowNumber}:${columnName(index)}${update.rowNumber}`
        };
      })
      .filter((cell) => cell.current !== cell.proposed);

    return {
      rowNumber: update.rowNumber,
      root: update.root,
      keyword: update.keyword,
      values: update.values,
      changed: changedCells.map((cell) => cell.header),
      changedCells
    };
  });
}

async function readTable({ sheetUrl, range }) {
  const result = await getSheetValues({ sheetUrl, range });
  if (!result.ok) {
    throw new Error(`读取 ${range} 失败: ${result.reason || result.status || "unknown_error"}`);
  }
  return valuesToTable(result.values);
}

async function writeChangedCells({ sheetUrl, plan }) {
  const cells = plan.flatMap((row) =>
    row.changedCells.map((cell) => ({
      rowNumber: row.rowNumber,
      header: cell.header,
      range: cell.range,
      values: [[cell.proposed]]
    }))
  );
  if (cells.length === 0) {
    return [];
  }

  const result = await batchUpdateSheetValues({
    sheetUrl,
    data: cells.map(({ range, values }) => ({ range, values }))
  });
  if (!result.ok) {
    throw new Error(`批量写入状态列失败: ${result.reason || result.status || "unknown_error"}`);
  }

  return cells.map((cell) => ({
    rowNumber: cell.rowNumber,
    header: cell.header,
    range: cell.range,
    updated: true
  }));
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const output = readArg("out", "agent-outputs/task-status-sync.json");
  const dryRun = readFlag("dry-run");

  const taskTable = await readTable({ sheetUrl, range: TASK_READ_RANGE });
  const keywordTable = await readTable({ sheetUrl, range: KEYWORD_READ_RANGE });
  const plan = buildTaskStatusWritePlan(taskTable, keywordTable);
  const changedRows = plan.filter((row) => row.changed.length > 0);

  const writeResults = dryRun ? [] : await writeChangedCells({ sheetUrl, plan: changedRows });
  const summary = {
    source: {
      sheetUrl,
      taskSheet: TASK_SHEET,
      keywordSheet: KEYWORD_TOTAL_SHEET,
      dryRun,
      readAt: new Date().toISOString()
    },
    totalTaskRows: plan.length,
    changedRows: changedRows.length,
    changedCells: changedRows.reduce((count, row) => count + row.changedCells.length, 0),
    writtenCells: writeResults.length,
    rows: plan,
    writeResults
  };

  await writeJson(output, summary);
  console.log(
    `${dryRun ? "Dry-run" : "Updated"} ${summary.changedRows} task row(s), ${summary.changedCells} cell(s). Wrote ${output}`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

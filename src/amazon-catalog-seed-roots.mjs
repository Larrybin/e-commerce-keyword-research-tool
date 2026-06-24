#!/usr/bin/env node
import { readArg, readFlag } from "./lib/args.mjs";
import { getSheetValues, updateSheetValues } from "./lib/google-sheets-api.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import { columnName, headerIndex, valuesToTable } from "./lib/table-utils.mjs";
import {
  AMAZON_CATALOG_SHEET,
  selectAmazonCatalogCandidates
} from "./lib/amazon-catalog-sheet.mjs";
import { writeJson } from "./lib/files.mjs";

const TASK_SHEET = "词根拓展";

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

function trim(value) {
  return String(value || "").trim();
}

function keywordKey(value) {
  return trim(value).replace(/\s+/g, " ").toLowerCase();
}

async function readTable({ sheetUrl, sheetName, range = "A:Z" }) {
  const result = await getSheetValues({ sheetUrl, range: `${quoteSheetName(sheetName)}!${range}` });
  if (!result.ok) {
    throw new Error(`读取 ${sheetName} 失败: ${result.reason || result.status || "unknown_error"}`);
  }
  return valuesToTable(result.values || []);
}

function existingRootKeys(taskRows) {
  return new Set(taskRows
    .map((row) => row.record)
    .flatMap((record) => [record["词根"], record["关键词"]])
    .map(keywordKey)
    .filter(Boolean));
}

function findAppendRow(rows, columnIndex) {
  let last = 1;
  for (const row of rows) {
    if (trim(row.values[columnIndex])) {
      last = row.rowNumber;
    }
  }
  return last + 1;
}

function buildTaskRootRows(taskHeaders, roots) {
  const rootIndex = headerIndex(taskHeaders, "词根", TASK_SHEET);
  return roots.map((root) => {
    const row = Array(taskHeaders.length).fill("");
    row[rootIndex] = root.keyword;
    return row;
  });
}

export function planAmazonCatalogRootSeed({ catalogRows, taskRows, taskHeaders, options = {} }) {
  const rootIndex = headerIndex(taskHeaders, "词根", TASK_SHEET);
  const existing = existingRootKeys(taskRows);
  const candidates = selectAmazonCatalogCandidates(catalogRows, options);
  const selected = [];
  let alreadyInTask = 0;

  for (const candidate of candidates.selected) {
    const key = keywordKey(candidate.keyword);
    if (existing.has(key)) {
      alreadyInTask += 1;
      continue;
    }
    existing.add(key);
    selected.push(candidate);
  }

  const appendRow = findAppendRow(taskRows, rootIndex);
  return {
    appendRow,
    selected,
    skipped: {
      ...candidates.skipped,
      alreadyInTask
    },
    values: buildTaskRootRows(taskHeaders, selected)
  };
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const minWords = Number(readArg("min-words", "2"));
  const minDepth = Number(readArg("min-depth", "1"));
  const maxDepth = Number(readArg("max-depth", "2"));
  const limit = Number(readArg("limit", "500"));
  const write = readFlag("write");
  const output = readArg("out", "output/amazon-catalog-root-seed.json");

  const [catalogTable, taskTable] = await Promise.all([
    readTable({ sheetUrl, sheetName: AMAZON_CATALOG_SHEET, range: "A:J" }),
    readTable({ sheetUrl, sheetName: TASK_SHEET, range: "A:Z" })
  ]);

  const plan = planAmazonCatalogRootSeed({
    catalogRows: catalogTable.rows,
    taskRows: taskTable.rows,
    taskHeaders: taskTable.headers,
    options: { minWords, minDepth, maxDepth, limit }
  });

  let writeResult = { skipped: true, reason: "dry_run" };
  if (write && plan.values.length > 0) {
    const startColumn = columnName(0);
    const endColumn = columnName(taskTable.headers.length - 1);
    const endRow = plan.appendRow + plan.values.length - 1;
    writeResult = await updateSheetValues({
      sheetUrl,
      range: `${quoteSheetName(TASK_SHEET)}!${startColumn}${plan.appendRow}:${endColumn}${endRow}`,
      values: plan.values
    });
    if (!writeResult.ok) {
      throw new Error(`写入 ${TASK_SHEET} 失败: ${writeResult.reason || writeResult.status || "unknown_error"}`);
    }
  }

  const summary = {
    source: {
      sheetUrl,
      catalogSheet: AMAZON_CATALOG_SHEET,
      taskSheet: TASK_SHEET,
      write,
      minWords,
      minDepth,
      maxDepth,
      limit
    },
    catalogRows: catalogTable.rows.length,
    selectedRows: plan.selected.length,
    appendRow: plan.appendRow,
    skipped: plan.skipped,
    preview: plan.selected.slice(0, 20),
    writeResult
  };

  await writeJson(output, summary);
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import fs from "node:fs";
import { readArg, readFlag } from "./lib/args.mjs";
import {
  batchUpdateSheetValues,
  batchUpdateSheet,
  getSpreadsheetSheets,
  getSheetValues,
  updateSheetValues
} from "./lib/google-sheets-api.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import { isValidAmazonCatalogCategory } from "./lib/amazon-catalog-crawler.mjs";
import {
  AMAZON_CATALOG_HEADERS,
  AMAZON_CATALOG_SHEET,
  amazonCatalogAppendRange,
  buildAmazonCatalogValues,
  migrateAmazonCatalogValues,
  normalizeAmazonCatalogKeywords,
  planAmazonCatalogWrites
} from "./lib/amazon-catalog-sheet.mjs";
import { valuesToTable } from "./lib/table-utils.mjs";

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

function readKeywordFile(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensureAmazonCatalogSheet(sheetUrl) {
  const range = `${quoteSheetName(AMAZON_CATALOG_SHEET)}!A:J`;
  const existing = await getSheetValues({ sheetUrl, range });
  if (existing.ok) {
    return existing.values || [];
  }

  const created = await batchUpdateSheet({
    sheetUrl,
    requests: [{ addSheet: { properties: { title: AMAZON_CATALOG_SHEET } } }]
  });
  if (!created.ok) {
    throw new Error(`创建 ${AMAZON_CATALOG_SHEET} 失败: ${created.reason || "unknown error"}`);
  }
  return [];
}

async function writeHeaderIfNeeded(sheetUrl, values) {
  const firstRow = values[0] || [];
  const firstCell = String(firstRow[0] || "").trim();
  if (AMAZON_CATALOG_HEADERS.every((header, index) => firstRow[index] === header)) {
    return values;
  }

  const migrated = migrateAmazonCatalogValues(values);
  if (migrated.migrated) {
    const result = await updateSheetValues({
      sheetUrl,
      range: `${quoteSheetName(AMAZON_CATALOG_SHEET)}!A1:J${migrated.values.length}`,
      values: migrated.values
    });
    if (!result.ok) {
      throw new Error(`迁移 ${AMAZON_CATALOG_SHEET} 表头失败: ${result.reason || "unknown error"}`);
    }
    return migrated.values;
  }

  if (firstCell && firstCell !== AMAZON_CATALOG_HEADERS[0]) {
    throw new Error(`${AMAZON_CATALOG_SHEET}!A1 已有内容 "${firstCell}"，不会覆盖。`);
  }

  const result = await updateSheetValues({
    sheetUrl,
    range: `${quoteSheetName(AMAZON_CATALOG_SHEET)}!A1:J1`,
    values: [AMAZON_CATALOG_HEADERS]
  });
  if (!result.ok) {
    throw new Error(`写入 ${AMAZON_CATALOG_SHEET} 表头失败: ${result.reason || "unknown error"}`);
  }
  return [AMAZON_CATALOG_HEADERS, ...values.slice(1)];
}

async function getAmazonCatalogSheetId(sheetUrl) {
  const result = await getSpreadsheetSheets({ sheetUrl });
  if (!result.ok) {
    throw new Error(`读取 ${AMAZON_CATALOG_SHEET} 元数据失败: ${result.reason || "unknown error"}`);
  }
  const sheet = result.sheets.find((item) => item.properties?.title === AMAZON_CATALOG_SHEET);
  if (!sheet) {
    throw new Error(`找不到 ${AMAZON_CATALOG_SHEET} sheetId`);
  }
  return sheet.properties.sheetId;
}

async function expandAmazonCatalogRows(sheetUrl, length) {
  const sheetId = await getAmazonCatalogSheetId(sheetUrl);
  const result = await batchUpdateSheet({
    sheetUrl,
    requests: [{
      appendDimension: {
        sheetId,
        dimension: "ROWS",
        length
      }
    }]
  });
  if (!result.ok) {
    throw new Error(`扩展 ${AMAZON_CATALOG_SHEET} 行数失败: ${result.reason || "unknown error"}`);
  }
}

export async function writeAmazonCatalogKeywords({ sheetUrl, keywords }) {
  const existingRows = valuesToTable(await writeHeaderIfNeeded(sheetUrl, await ensureAmazonCatalogSheet(sheetUrl))).rows;
  const newKeywords = normalizeAmazonCatalogKeywords(keywords, existingRows);
  return writeAmazonCatalogCategories({
    sheetUrl,
    categories: newKeywords.map((keyword) => ({ keyword, path: [keyword] }))
  });
}

export async function writeAmazonCatalogCategories({ sheetUrl, categories, crawledAt = new Date().toISOString() }) {
  const existingValues = await writeHeaderIfNeeded(sheetUrl, await ensureAmazonCatalogSheet(sheetUrl));
  const table = valuesToTable(existingValues);
  const validCategories = categories.filter((category) => isValidAmazonCatalogCategory(category));
  const plan = planAmazonCatalogWrites(validCategories, table.rows, crawledAt);
  const data = [];

  for (const update of plan.updates) {
    data.push({
      range: `${quoteSheetName(AMAZON_CATALOG_SHEET)}!A${update.rowNumber}:J${update.rowNumber}`,
      values: buildAmazonCatalogValues([update.record], crawledAt)
    });
  }

  if (plan.appends.length > 0) {
    const startRow = existingValues.length + 1;
    data.push({
      range: amazonCatalogAppendRange(plan.appends.length, startRow),
      values: buildAmazonCatalogValues(plan.appends, crawledAt)
    });
  }

  if (data.length === 0) {
    return { writtenRows: 0, updatedRows: 0, skippedRows: plan.skipped };
  }

  let result = await batchUpdateSheetValues({ sheetUrl, data });
  if (!result.ok && /exceeds grid limits/i.test(result.reason || "")) {
    await expandAmazonCatalogRows(sheetUrl, Math.max(plan.appends.length + 100, 500));
    result = await batchUpdateSheetValues({ sheetUrl, data });
  }
  if (!result.ok) {
    throw new Error(`写入 ${AMAZON_CATALOG_SHEET} 失败: ${result.reason || "unknown error"}`);
  }

  return {
    writtenRows: plan.appends.length,
    updatedRows: plan.updates.length,
    skippedRows: plan.skipped,
    updatedRanges: data.map((item) => item.range)
  };
}

async function main() {
  const sheetUrl = readArg("sheet", DEFAULT_SHEET_URL);
  const file = readArg("file", "");
  const initOnly = readFlag("init");
  const keywords = file ? readKeywordFile(file) : [];

  if (!file && !initOnly) {
    throw new Error("缺少 --file=keywords.txt；只创建 tab 时使用 --init。");
  }

  const result = initOnly
    ? { writtenRows: 0, skippedRows: 0, initialized: true, sheet: AMAZON_CATALOG_SHEET, rows: (await writeHeaderIfNeeded(sheetUrl, await ensureAmazonCatalogSheet(sheetUrl))).length }
    : await writeAmazonCatalogKeywords({ sheetUrl, keywords });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

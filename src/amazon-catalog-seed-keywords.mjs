#!/usr/bin/env node
import { readArg, readFlag } from "./lib/args.mjs";
import { getSheetValues, updateSheetValues } from "./lib/google-sheets-api.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import { columnName, valuesToTable } from "./lib/table-utils.mjs";
import {
  AMAZON_CATALOG_SHEET,
  selectAmazonCatalogCandidates
} from "./lib/amazon-catalog-sheet.mjs";
import {
  buildKeywordTotalSourceValues,
  buildKeywordTotalValues,
  existingKeywordTotalKeys,
  filterDuplicateKeywordRows,
  findKeywordTotalAppendStartRow,
  KEYWORD_TOTAL_READ_COLUMNS,
  KEYWORD_TOTAL_SHEET,
  keywordTotalSourceColumnIndex
} from "./lib/sheet-write.mjs";
import { writeJson } from "./lib/files.mjs";

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

async function readValues({ sheetUrl, sheetName, range }) {
  const result = await getSheetValues({ sheetUrl, range: `${quoteSheetName(sheetName)}!${range}` });
  if (!result.ok) {
    throw new Error(`读取 ${sheetName} 失败: ${result.reason || result.status || "unknown_error"}`);
  }
  return result.values || [];
}

function toKeywordRows(candidates, { country = "美国" } = {}) {
  return candidates.map((candidate) => ({
    词根: candidate.keyword,
    关键词: candidate.keyword,
    国家: country,
    搜索量: "",
    KD: "",
    判断: "继续",
    来源: "amazon_catalog"
  }));
}

export function planAmazonCatalogKeywordSeed({ catalogRows, keywordTotalValues, options = {} }) {
  const candidates = selectAmazonCatalogCandidates(catalogRows, options);
  const rows = toKeywordRows(candidates.selected, { country: options.country });
  const filtered = filterDuplicateKeywordRows(rows, existingKeywordTotalKeys(keywordTotalValues));
  const table = valuesToTable(keywordTotalValues);
  const sourceColumnIndex = keywordTotalSourceColumnIndex(table.headers);
  const appendRow = findKeywordTotalAppendStartRow({
    headers: table.headers,
    rawRows: keywordTotalValues
  });

  return {
    appendRow,
    selected: filtered.kept,
    skipped: {
      ...candidates.skipped,
      alreadyInKeywordTotal: filtered.skipped.length
    },
    values: buildKeywordTotalValues(filtered.kept, { headers: table.headers }),
    sourceColumnIndex,
    sourceValues: buildKeywordTotalSourceValues(filtered.kept),
    candidates: candidates.selected
  };
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const minWords = Number(readArg("min-words", "2"));
  const minDepth = Number(readArg("min-depth", "3"));
  const maxDepth = Number(readArg("max-depth", "5"));
  const limit = Number(readArg("limit", "500"));
  const country = readArg("country", "美国");
  const write = readFlag("write");
  const output = readArg("out", "output/amazon-catalog-keyword-seed.json");

  const [catalogValues, keywordTotalValues] = await Promise.all([
    readValues({ sheetUrl, sheetName: AMAZON_CATALOG_SHEET, range: "A:J" }),
    readValues({ sheetUrl, sheetName: KEYWORD_TOTAL_SHEET, range: KEYWORD_TOTAL_READ_COLUMNS })
  ]);

  const catalogTable = valuesToTable(catalogValues);
  const plan = planAmazonCatalogKeywordSeed({
    catalogRows: catalogTable.rows,
    keywordTotalValues,
    options: { minWords, minDepth, maxDepth, limit, country }
  });

  let writeResult = { skipped: true, reason: "dry_run" };
  let sourceWriteResult = { skipped: true, reason: "dry_run" };
  if (write && plan.values.length > 0) {
    const endRow = plan.appendRow + plan.values.length - 1;
    writeResult = await updateSheetValues({
      sheetUrl,
      range: `${quoteSheetName(KEYWORD_TOTAL_SHEET)}!A${plan.appendRow}:${columnName(plan.values[0].length - 1)}${endRow}`,
      values: plan.values
    });
    if (!writeResult.ok) {
      throw new Error(`写入 ${KEYWORD_TOTAL_SHEET} 失败: ${writeResult.reason || writeResult.status || "unknown_error"}`);
    }
    if (plan.sourceColumnIndex === -1) {
      sourceWriteResult = { skipped: true, reason: "source_header_missing" };
    } else {
      const sourceColumn = columnName(plan.sourceColumnIndex);
      sourceWriteResult = await updateSheetValues({
        sheetUrl,
        range: `${quoteSheetName(KEYWORD_TOTAL_SHEET)}!${sourceColumn}${plan.appendRow}:${sourceColumn}${endRow}`,
        values: plan.sourceValues
      });
      if (!sourceWriteResult.ok) {
        throw new Error(`写入 ${KEYWORD_TOTAL_SHEET} 来源列失败: ${sourceWriteResult.reason || sourceWriteResult.status || "unknown_error"}`);
      }
    }
  }

  const summary = {
    source: {
      sheetUrl,
      catalogSheet: AMAZON_CATALOG_SHEET,
      keywordTotalSheet: KEYWORD_TOTAL_SHEET,
      write,
      minWords,
      minDepth,
      maxDepth,
      limit,
      country
    },
    catalogRows: catalogTable.rows.length,
    selectedRows: plan.selected.length,
    appendRow: plan.appendRow,
    skipped: plan.skipped,
    preview: plan.candidates.slice(0, 20),
    writeResult,
    sourceWriteResult
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

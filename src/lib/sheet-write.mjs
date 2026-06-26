import { columnName } from "./table-utils.mjs";

export const KEYWORD_TOTAL_SHEET = "关键词总表";
export const KEYWORD_TOTAL_READ_COLUMNS = "A:BA";
export const KEYWORD_TOTAL_BASE_WRITE_COLUMNS = "A:F";
export const KEYWORD_TOTAL_HEADERS = ["词根", "关键词", "国家", "来源", "搜索量", "KD"];
export const GOOGLE_SHEETS_CELL_LIMIT = 10_000_000;

function normalizeCell(value) {
  return String(value ?? "").trim();
}

export function keywordTotalColumnIndexes(headers) {
  return KEYWORD_TOTAL_HEADERS.map((header) => headers.indexOf(header));
}

function keywordTotalBaseEndColumnIndex(headers) {
  const indexes = keywordTotalColumnIndexes(headers);
  const missing = KEYWORD_TOTAL_HEADERS.filter((_, index) => indexes[index] === -1);
  if (missing.length > 0) {
    throw new Error(`关键词总表缺少表头: ${missing.join(", ")}`);
  }
  return Math.max(...indexes);
}

export function keywordTotalReadRange(sheetName = KEYWORD_TOTAL_SHEET) {
  return `${sheetName}!${KEYWORD_TOTAL_READ_COLUMNS}`;
}

export function keywordTotalBaseWriteRange(startRow, endRow, sheetName = KEYWORD_TOTAL_SHEET, headers = KEYWORD_TOTAL_HEADERS) {
  return `${sheetName}!A${startRow}:${columnName(keywordTotalBaseEndColumnIndex(headers))}${endRow}`;
}

export function spreadsheetCellCount(sheets = []) {
  return sheets.reduce((total, sheet) => {
    const grid = sheet?.properties?.gridProperties || {};
    return total + (Number(grid.rowCount) || 0) * (Number(grid.columnCount) || 0);
  }, 0);
}

export function planKeywordTotalWriteCapacity({
  sheets = [],
  sheetName = KEYWORD_TOTAL_SHEET,
  gid = "",
  startRow,
  rowCount
}) {
  const target = sheets.find((sheet) => {
    const props = sheet?.properties || {};
    return String(props.sheetId) === String(gid) || props.title === sheetName;
  });
  if (!target) {
    throw new Error(`找不到 ${sheetName} 工作表 metadata`);
  }

  const grid = target.properties?.gridProperties || {};
  const currentRowCount = Number(grid.rowCount) || 0;
  const currentColumnCount = Number(grid.columnCount) || 0;
  const endRow = startRow + rowCount - 1;
  const rowsToAppend = Math.max(0, endRow - currentRowCount);
  const currentCells = spreadsheetCellCount(sheets);
  const cellsAfterAppend = currentCells + rowsToAppend * currentColumnCount;

  return {
    ok: cellsAfterAppend <= GOOGLE_SHEETS_CELL_LIMIT,
    currentCells,
    cellsAfterAppend,
    currentRowCount,
    currentColumnCount,
    rowsToAppend,
    limit: GOOGLE_SHEETS_CELL_LIMIT
  };
}

export function findKeywordTotalAppendStartRow(sheet) {
  const headers = sheet?.headers || [];
  const indexes = keywordTotalColumnIndexes(headers);
  const missing = KEYWORD_TOTAL_HEADERS.filter((_, index) => indexes[index] === -1);
  if (missing.length > 0) {
    throw new Error(`关键词总表缺少表头: ${missing.join(", ")}`);
  }

  const rawRows = sheet?.rawRows || [];
  let lastDataRowNumber = 1;
  for (let index = 1; index < rawRows.length; index += 1) {
    const row = rawRows[index] || [];
    const hasKeywordTotalData = indexes.some((columnIndex) => normalizeCell(row[columnIndex]));
    if (hasKeywordTotalData) {
      lastDataRowNumber = index + 1;
    }
  }

  return lastDataRowNumber + 1;
}

export function buildKeywordTotalTsv(rows, { includeHeader = false } = {}) {
  const lines = rows.map((row) => KEYWORD_TOTAL_HEADERS.map((header) => row[header] || "").join("\t"));
  if (includeHeader) {
    lines.unshift(KEYWORD_TOTAL_HEADERS.join("\t"));
  }
  return lines.join("\n");
}

export function buildKeywordTotalValues(rows, { includeHeader = false, headers = KEYWORD_TOTAL_HEADERS } = {}) {
  const endColumnIndex = keywordTotalBaseEndColumnIndex(headers);
  const values = rows.map((row) => {
    const valuesRow = Array(endColumnIndex + 1).fill("");
    for (const header of KEYWORD_TOTAL_HEADERS) {
      valuesRow[headers.indexOf(header)] = row[header] || "";
    }
    return valuesRow;
  });
  if (includeHeader) {
    values.unshift(headers.slice(0, endColumnIndex + 1));
  }
  return values;
}

export function isKeywordTotalHeaderRow(row) {
  return KEYWORD_TOTAL_HEADERS.every((header) => row?.includes(header));
}

function keywordKey(value) {
  return normalizeCell(value).toLowerCase().replace(/\s+/g, " ");
}

export function existingKeywordTotalKeys(values = []) {
  const headers = values[0] || [];
  const keywordIndex = headers.indexOf("关键词");
  if (keywordIndex === -1) {
    return new Set();
  }
  return new Set(
    values
      .slice(1)
      .map((row) => keywordKey(row?.[keywordIndex]))
      .filter(Boolean)
  );
}

export function filterDuplicateKeywordRows(rows, existingKeys = new Set()) {
  const seen = new Set(existingKeys);
  const kept = [];
  const skipped = [];
  for (const row of rows) {
    const key = keywordKey(row?.关键词);
    if (!key || seen.has(key)) {
      skipped.push(row);
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return { kept, skipped };
}

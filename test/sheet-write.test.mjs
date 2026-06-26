import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKeywordTotalValues,
  buildKeywordTotalTsv,
  existingKeywordTotalKeys,
  filterDuplicateKeywordRows,
  findKeywordTotalAppendStartRow,
  GOOGLE_SHEETS_CELL_LIMIT,
  isKeywordTotalHeaderRow,
  KEYWORD_TOTAL_BASE_WRITE_COLUMNS,
  KEYWORD_TOTAL_READ_COLUMNS,
  KEYWORD_TOTAL_SHEET,
  keywordTotalBaseWriteRange,
  keywordTotalReadRange,
  planKeywordTotalWriteCapacity,
  spreadsheetCellCount
} from "../src/lib/sheet-write.mjs";

test("keyword total sheet contract centralizes ranges and sheet name", () => {
  assert.equal(KEYWORD_TOTAL_SHEET, "关键词总表");
  assert.equal(KEYWORD_TOTAL_READ_COLUMNS, "A:BA");
  assert.equal(KEYWORD_TOTAL_BASE_WRITE_COLUMNS, "A:F");
  assert.equal(keywordTotalReadRange(), "关键词总表!A:BA");
  assert.equal(keywordTotalBaseWriteRange(3, 5), "关键词总表!A3:F5");
  assert.equal(
    keywordTotalBaseWriteRange(3, 5, "关键词总表", ["词根", "关键词", "国家", "agent预判断", "来源", "搜索量", "KD"]),
    "关键词总表!A3:G5"
  );
});

test("findKeywordTotalAppendStartRow appends after the last populated keyword total row", () => {
  const sheet = {
    headers: ["词根", "关键词", "国家", "来源", "搜索量", "KD"],
    rawRows: [
      ["词根", "关键词", "国家", "来源", "搜索量", "KD"],
      ["generator", "barcode generator", "美国", "semrush", "301,000", "49"],
      ["generator", "yes or no generator", "美国", "semrush", "12,100", "56"]
    ]
  };

  assert.equal(findKeywordTotalAppendStartRow(sheet), 4);
});

test("findKeywordTotalAppendStartRow ignores unrelated columns when locating append row", () => {
  const headers = ["词根", "关键词", "国家", "来源", "搜索量", "KD"];
  headers[52] = "备注";
  headers[53] = "状态";
  const dataRow = ["generator", "barcode generator", "美国", "semrush", "301,000", "49"];
  const noteOnlyRow = [];
  noteOnlyRow[52] = "manual-note";
  noteOnlyRow[53] = "manual status";

  const sheet = {
    headers,
    rawRows: [
      headers,
      dataRow,
      noteOnlyRow
    ]
  };

  assert.equal(findKeywordTotalAppendStartRow(sheet), 3);
});

test("planKeywordTotalWriteCapacity blocks appends above the workbook cell limit", () => {
  const sheets = [
    { properties: { sheetId: 1, title: "关键词总表", gridProperties: { rowCount: 999_999, columnCount: 10 } } },
    { properties: { sheetId: 2, title: "其它", gridProperties: { rowCount: 1, columnCount: 10 } } }
  ];

  const plan = planKeywordTotalWriteCapacity({
    sheets,
    sheetName: "关键词总表",
    gid: 1,
    startRow: 1_000_000,
    rowCount: 2
  });

  assert.equal(spreadsheetCellCount(sheets), GOOGLE_SHEETS_CELL_LIMIT);
  assert.equal(plan.ok, false);
  assert.equal(plan.rowsToAppend, 2);
});

test("planKeywordTotalWriteCapacity allows writes into already allocated rows", () => {
  const sheets = [
    { properties: { sheetId: 1, title: "关键词总表", gridProperties: { rowCount: 1_000_000, columnCount: 10 } } }
  ];

  const plan = planKeywordTotalWriteCapacity({
    sheets,
    sheetName: "关键词总表",
    gid: 1,
    startRow: 999_999,
    rowCount: 2
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.rowsToAppend, 0);
});

test("buildKeywordTotalTsv writes data rows without headers by default", () => {
  assert.equal(
    buildKeywordTotalTsv([
      { 词根: "calculator", 关键词: "age calculator", 国家: "全球", 来源: "semrush", 搜索量: "201,000", KD: "35" }
    ]),
    "calculator\tage calculator\t全球\tsemrush\t201,000\t35"
  );
});

test("buildKeywordTotalValues can include the required header row", () => {
  assert.deepEqual(
    buildKeywordTotalValues([
      { 词根: "calculator", 关键词: "age calculator", 国家: "全球", 来源: "semrush", 搜索量: "201,000", KD: "35" }
    ], { includeHeader: true }),
    [
      ["词根", "关键词", "国家", "来源", "搜索量", "KD"],
      ["calculator", "age calculator", "全球", "semrush", "201,000", "35"]
    ]
  );
  assert.deepEqual(
    buildKeywordTotalValues([
      { 词根: "calculator", 关键词: "age calculator", 国家: "全球", 来源: "semrush", 搜索量: "201,000", KD: "35" }
    ], { headers: ["词根", "关键词", "国家", "agent预判断", "来源", "搜索量", "KD"] }),
    [["calculator", "age calculator", "全球", "", "semrush", "201,000", "35"]]
  );
});

test("isKeywordTotalHeaderRow validates required keyword total headers", () => {
  assert.equal(isKeywordTotalHeaderRow(["词根", "关键词", "国家", "来源", "搜索量", "KD"]), true);
  assert.equal(isKeywordTotalHeaderRow(["词根", "关键词", "国家", "agent预判断", "来源", "搜索量", "KD"]), true);
  assert.equal(isKeywordTotalHeaderRow(["calculator", "age calculator", "全球", "201,000", "35"]), false);
});

test("filterDuplicateKeywordRows skips existing and same-batch keywords", () => {
  const existing = existingKeywordTotalKeys([
    ["词根", "关键词", "国家", "来源", "搜索量", "KD"],
    ["filter", "water filter", "美国", "semrush", "27.1K", "33"]
  ]);

  const result = filterDuplicateKeywordRows([
    { 词根: "filter", 关键词: "Water   Filter", 国家: "美国", 来源: "semrush", 搜索量: "27.1K", KD: "33" },
    { 词根: "filter", 关键词: "air filter", 国家: "美国", 来源: "semrush", 搜索量: "22.2K", KD: "41" },
    { 词根: "filter", 关键词: "AIR FILTER", 国家: "美国", 来源: "semrush", 搜索量: "18.1K", KD: "44" }
  ], existing);

  assert.deepEqual(result.kept.map((row) => row.关键词), ["air filter"]);
  assert.deepEqual(result.skipped.map((row) => row.关键词), ["Water   Filter", "AIR FILTER"]);
});

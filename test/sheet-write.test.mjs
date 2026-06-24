import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKeywordTotalSourceValues,
  buildKeywordTotalValues,
  buildKeywordTotalTsv,
  existingKeywordTotalKeys,
  filterDuplicateKeywordRows,
  findKeywordTotalAppendStartRow,
  isKeywordTotalHeaderRow,
  KEYWORD_TOTAL_BASE_WRITE_COLUMNS,
  KEYWORD_TOTAL_READ_COLUMNS,
  KEYWORD_TOTAL_SHEET,
  keywordTotalBaseWriteRange,
  keywordTotalReadRange,
  keywordTotalSourceColumnIndex
} from "../src/lib/sheet-write.mjs";

test("keyword total sheet contract centralizes ranges and sheet name", () => {
  assert.equal(KEYWORD_TOTAL_SHEET, "关键词总表");
  assert.equal(KEYWORD_TOTAL_READ_COLUMNS, "A:BA");
  assert.equal(KEYWORD_TOTAL_BASE_WRITE_COLUMNS, "A:F");
  assert.equal(keywordTotalReadRange(), "关键词总表!A:BA");
  assert.equal(keywordTotalBaseWriteRange(3, 5), "关键词总表!A3:F5");
  assert.equal(
    keywordTotalBaseWriteRange(3, 5, "关键词总表", ["词根", "关键词", "国家", "agent预判断", "搜索量", "KD", "判断"]),
    "关键词总表!A3:G5"
  );
});

test("findKeywordTotalAppendStartRow appends after the last populated keyword total row", () => {
  const sheet = {
    headers: ["词根", "关键词", "国家", "搜索量", "KD", "判断", "来源"],
    rawRows: [
      ["词根", "关键词", "国家", "搜索量", "KD", "判断", "来源"],
      ["generator", "barcode generator", "美国", "301,000", "49", "继续", "semrush"],
      ["generator", "yes or no generator", "美国", "12,100", "56", "拒绝", "semrush"]
    ]
  };

  assert.equal(findKeywordTotalAppendStartRow(sheet), 4);
});

test("findKeywordTotalAppendStartRow ignores unrelated columns when locating append row", () => {
  const headers = ["词根", "关键词", "国家", "搜索量", "KD", "判断"];
  headers[52] = "来源";
  headers[53] = "状态";
  const dataRow = ["generator", "barcode generator", "美国", "301,000", "49", "继续"];
  dataRow[52] = "semrush";
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

test("buildKeywordTotalTsv writes data rows without headers by default", () => {
  assert.equal(
    buildKeywordTotalTsv([
      { 词根: "calculator", 关键词: "age calculator", 国家: "全球", 搜索量: "201,000", KD: "35", 判断: "继续" }
    ]),
    "calculator\tage calculator\t全球\t201,000\t35\t继续"
  );
});

test("buildKeywordTotalValues can include the required header row", () => {
  assert.deepEqual(
    buildKeywordTotalValues([
      { 词根: "calculator", 关键词: "age calculator", 国家: "全球", 搜索量: "201,000", KD: "35", 判断: "继续" }
    ], { includeHeader: true }),
    [
      ["词根", "关键词", "国家", "搜索量", "KD", "判断"],
      ["calculator", "age calculator", "全球", "201,000", "35", "继续"]
    ]
  );
  assert.deepEqual(
    buildKeywordTotalValues([
      { 词根: "calculator", 关键词: "age calculator", 国家: "全球", 搜索量: "201,000", KD: "35", 判断: "继续" }
    ], { headers: ["词根", "关键词", "国家", "agent预判断", "搜索量", "KD", "判断"] }),
    [["calculator", "age calculator", "全球", "", "201,000", "35", "继续"]]
  );
});

test("isKeywordTotalHeaderRow validates required keyword total headers", () => {
  assert.equal(isKeywordTotalHeaderRow(["词根", "关键词", "国家", "搜索量", "KD", "判断"]), true);
  assert.equal(isKeywordTotalHeaderRow(["词根", "关键词", "国家", "agent预判断", "搜索量", "KD", "判断"]), true);
  assert.equal(isKeywordTotalHeaderRow(["calculator", "age calculator", "全球", "201,000", "35", "继续"]), false);
});

test("source helpers locate and build optional source values", () => {
  assert.equal(keywordTotalSourceColumnIndex(["词根", "关键词", "国家", "搜索量", "KD", "判断", "来源"]), 6);
  assert.equal(keywordTotalSourceColumnIndex(["词根", "关键词", "国家", "搜索量", "KD", "判断"]), -1);
  assert.deepEqual(
    buildKeywordTotalSourceValues([
      { 来源: "semrush" },
      { 来源: "amazon_catalog" },
      {}
    ]),
    [["semrush"], ["amazon_catalog"], [""]]
  );
});

test("filterDuplicateKeywordRows skips existing and same-batch keywords", () => {
  const existing = existingKeywordTotalKeys([
    ["词根", "关键词", "国家", "搜索量", "KD", "判断"],
    ["filter", "water filter", "美国", "27.1K", "33", "拒绝"]
  ]);

  const result = filterDuplicateKeywordRows([
    { 词根: "filter", 关键词: "Water   Filter", 国家: "美国", 搜索量: "27.1K", KD: "33", 判断: "继续" },
    { 词根: "filter", 关键词: "air filter", 国家: "美国", 搜索量: "22.2K", KD: "41", 判断: "继续" },
    { 词根: "filter", 关键词: "AIR FILTER", 国家: "美国", 搜索量: "18.1K", KD: "44", 判断: "拒绝" }
  ], existing);

  assert.deepEqual(result.kept.map((row) => row.关键词), ["air filter"]);
  assert.deepEqual(result.skipped.map((row) => row.关键词), ["Water   Filter", "AIR FILTER"]);
});

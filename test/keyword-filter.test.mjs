import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateKeywordForEcommerce,
  filterKeywordRowsForEcommerce
} from "../src/lib/keyword-filter.mjs";

const task = { rootKeyword: "generator", query: "generator" };

test("keyword machine filter keeps ecommerce-shaped keywords", () => {
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "portable generator" }, task).accepted, true);
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "solar generator" }, task).accepted, true);
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "generator replacement battery" }, task).accepted, true);
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "honda generator price" }, task).accepted, true);
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "generator" }, task).accepted, true);
});

test("keyword machine filter rejects obvious non-ecommerce keywords", () => {
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "ai porn generator" }, task).accepted, false);
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "generator installation near me" }, task).accepted, false);
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "generator jobs" }, task).accepted, false);
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "generator manual pdf" }, task).accepted, false);
  assert.equal(evaluateKeywordForEcommerce({ 关键词: "free online barcode generator" }, task).accepted, false);
  assert.deepEqual(evaluateKeywordForEcommerce({ 关键词: "one two three four five six seven eight nine" }, task), {
    accepted: false,
    reason: "too_many_words"
  });
});

test("filterKeywordRowsForEcommerce annotates accepted and rejected rows", () => {
  const result = filterKeywordRowsForEcommerce([
    { 词根: "generator", 关键词: "portable generator", 搜索量: "1000", KD: "30" },
    { 词根: "generator", 关键词: "generator repair near me", 搜索量: "1000", KD: "30" }
  ], task);

  assert.equal(result.summary.rawRows, 2);
  assert.equal(result.summary.acceptedRows, 1);
  assert.equal(result.summary.rejectedRows, 1);
  assert.equal(result.accepted[0].判断, "继续");
  assert.equal(result.rejected[0].判断, "拒绝");
  assert.equal(result.accepted[0].机器筛选状态, "通过");
  assert.match(result.rejected[0].机器筛选原因, /^contains_excluded_term:/);
  assert.deepEqual(result.rows.map((row) => row.关键词), ["portable generator", "generator repair near me"]);
});

test("filterKeywordRowsForEcommerce treats all rows as continue when disabled", () => {
  const result = filterKeywordRowsForEcommerce([
    { 词根: "generator", 关键词: "generator jobs", 搜索量: "1000", KD: "30" },
    { 词根: "generator", 关键词: "generator installation near me", 搜索量: "1000", KD: "30" }
  ], { ...task, machineFilter: "否" });

  assert.equal(result.summary.enabled, false);
  assert.equal(result.summary.acceptedRows, 2);
  assert.equal(result.summary.rejectedRows, 0);
  assert.deepEqual(result.accepted.map((row) => row.判断), ["继续", "继续"]);
  assert.deepEqual(result.accepted.map((row) => row.机器筛选原因), [
    "machine_filter_disabled",
    "machine_filter_disabled"
  ]);
});

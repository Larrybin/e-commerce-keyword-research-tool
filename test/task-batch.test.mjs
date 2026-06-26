import assert from "node:assert/strict";
import test from "node:test";
import {
  hasTaskInput,
  isCompletedTask,
  resolveTaskRows,
  taskRunKey,
  toOutputRows
} from "../src/lib/task-batch.mjs";

test("resolveTaskRows keeps single-row defaults and ranges explicit", () => {
  assert.deepEqual(resolveTaskRows({}), [2]);
  assert.deepEqual(resolveTaskRows({ rowArg: "5" }), [5]);
  assert.deepEqual(resolveTaskRows({ fromRowArg: "5", toRowArg: "8" }), [5, 6, 7, 8]);
});

test("task row helpers identify input and completed rows", () => {
  assert.equal(hasTaskInput({ 词根: " Compiler ", 关键词: "" }), true);
  assert.equal(hasTaskInput({ 词根: "", 关键词: "compiler online" }), true);
  assert.equal(hasTaskInput({ 词根: "", 关键词: "" }), false);
  assert.equal(isCompletedTask({ SEM完成状态: "已完成15个关键词采集" }), true);
  assert.equal(isCompletedTask({ SEM完成状态: "已完成关键词采集" }), true);
  assert.equal(isCompletedTask({ SEM完成状态: "失败：筛选没有生效" }), false);
});

test("taskRunKey and toOutputRows keep output naming stable", () => {
  assert.equal(taskRunKey({ mode: "root", query: "C++ Compiler" }), "root-c-compiler");
  assert.equal(taskRunKey({ rowNumber: 21, mode: "keyword", query: "cursive generator" }), "row-21-keyword-cursive-generator");
  assert.deepEqual(
    toOutputRows([{ root: "Compiler", keyword: "online compiler", volume: "12,100", kd: "53", semrush_page: 1 }], { country: "美国" }),
    [{ 词根: "Compiler", 关键词: "online compiler", 国家: "美国", 来源: "semrush", 搜索量: "12,100", KD: "53", semrush_page: 1 }]
  );
  assert.deepEqual(
    toOutputRows([{ root: "Crafts", keyword: "craft kits", volume: "8,100", kd: "42", semrush_page: 1 }], { country: "美国", source: "amazon_catalog" }),
    [{ 词根: "Crafts", 关键词: "craft kits", 国家: "美国", 来源: "amazon_catalog", 搜索量: "8,100", KD: "42", semrush_page: 1 }]
  );
});

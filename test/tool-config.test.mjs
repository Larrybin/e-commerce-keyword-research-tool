import assert from "node:assert/strict";
import test from "node:test";
import { pickKeywordTask } from "../src/lib/tool-config.mjs";

test("pickKeywordTask applies Semrush defaults for blank filter cells", () => {
  assert.deepEqual(
    pickKeywordTask([{ "词根": "water filter" }]),
    {
      rowNumber: 2,
      row: { "词根": "water filter" },
      query: "water filter",
      mode: "root",
      rootKeyword: "water filter",
      keyword: "",
      matchType: "词组匹配",
      matchCountry: "",
      volumeMin: "1000",
      volumeMax: "",
      kdMin: "0",
      kdMax: "60",
      machineFilter: ""
    }
  );
});

test("pickKeywordTask keeps explicit Semrush filter cells", () => {
  const task = pickKeywordTask([{
    "词根": "water filter",
    "匹配类型": "完全匹配",
    "搜索量范围（小）": "5000",
    "搜索量范围（大）": "20000",
    "KD范围（小）": "2",
    "KD范围（大）": "12"
  }]);

  assert.equal(task.matchType, "完全匹配");
  assert.equal(task.volumeMin, "5000");
  assert.equal(task.volumeMax, "20000");
  assert.equal(task.kdMin, "2");
  assert.equal(task.kdMax, "12");
});

import assert from "node:assert/strict";
import test from "node:test";
import { planAmazonCatalogKeywordSeed } from "../src/amazon-catalog-seed-keywords.mjs";

test("planAmazonCatalogKeywordSeed appends depth 3+ catalog terms to keyword total", () => {
  const plan = planAmazonCatalogKeywordSeed({
    catalogRows: [
      { rowNumber: 2, record: { "关键词": "Kitchen Storage", "深度": "2" } },
      { rowNumber: 3, record: { "关键词": "Water Filter Pitchers", "深度": "4" } },
      { rowNumber: 4, record: { "关键词": "Replacement Air Filters", "深度": "5" } },
      { rowNumber: 5, record: { "关键词": "Digital Music Players", "深度": "4" } }
    ],
    keywordTotalValues: [
      ["词根", "关键词", "国家", "搜索量", "KD", "判断", "来源"],
      ["filter", "Water Filter Pitchers", "美国", "", "", "继续", "manual"]
    ],
    options: { minDepth: 3, maxDepth: 5, limit: 10, country: "美国" }
  });

  assert.equal(plan.appendRow, 3);
  assert.deepEqual(plan.selected.map((row) => row.关键词), ["Replacement Air Filters"]);
  assert.equal(plan.skipped.depthOutOfRange, 1);
  assert.equal(plan.skipped.excluded, 1);
  assert.equal(plan.skipped.alreadyInKeywordTotal, 1);
  assert.deepEqual(plan.values, [["Replacement Air Filters", "Replacement Air Filters", "美国", "", "", "继续"]]);
  assert.equal(plan.sourceColumnIndex, 6);
  assert.deepEqual(plan.sourceValues, [["amazon_catalog"]]);
});

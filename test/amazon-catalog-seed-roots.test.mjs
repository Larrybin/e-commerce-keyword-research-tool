import assert from "node:assert/strict";
import test from "node:test";
import { planAmazonCatalogRootSeed } from "../src/amazon-catalog-seed-roots.mjs";

test("planAmazonCatalogRootSeed appends only new selected roots", () => {
  const taskHeaders = ["词根", "关键词", "匹配类型", "匹配国家"];
  const plan = planAmazonCatalogRootSeed({
    catalogRows: [
      { rowNumber: 2, record: { "关键词": "Home & Kitchen", "深度": "1" } },
      { rowNumber: 3, record: { "关键词": "Kitchen Storage", "深度": "2" } },
      { rowNumber: 4, record: { "关键词": "Water Filter Pitchers", "深度": "4" } },
      { rowNumber: 5, record: { "关键词": "Digital Music", "深度": "1" } }
    ],
    taskRows: [
      { rowNumber: 2, values: ["generator"], record: { "词根": "generator", "关键词": "" } },
      { rowNumber: 3, values: ["Home & Kitchen"], record: { "词根": "Home & Kitchen", "关键词": "" } }
    ],
    taskHeaders,
    options: { minDepth: 1, maxDepth: 2, limit: 10 }
  });

  assert.equal(plan.appendRow, 4);
  assert.deepEqual(plan.selected.map((item) => item.keyword), ["Kitchen Storage"]);
  assert.equal(plan.skipped.alreadyInTask, 1);
  assert.equal(plan.skipped.excluded, 1);
  assert.equal(plan.skipped.depthOutOfRange, 1);
  assert.deepEqual(plan.values, [["Kitchen Storage", "", "", ""]]);
});

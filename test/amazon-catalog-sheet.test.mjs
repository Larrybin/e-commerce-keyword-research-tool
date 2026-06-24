import assert from "node:assert/strict";
import test from "node:test";
import {
  amazonCatalogAppendRange,
  buildAmazonCatalogRecord,
  buildAmazonCatalogValues,
  migrateAmazonCatalogValues,
  normalizeAmazonCatalogKeywords,
  planAmazonCatalogWrites,
  selectAmazonCatalogCandidates
} from "../src/lib/amazon-catalog-sheet.mjs";

test("normalizeAmazonCatalogKeywords trims whitespace and removes duplicates", () => {
  assert.deepEqual(
    normalizeAmazonCatalogKeywords(["  Air Filter  ", "air   filter", "", "Water Pump"]),
    ["Air Filter", "Water Pump"]
  );
});

test("normalizeAmazonCatalogKeywords skips keywords already in the sheet", () => {
  assert.deepEqual(
    normalizeAmazonCatalogKeywords(["air filter", "water pump"], [
      { record: { "关键词": "Air Filter" } }
    ]),
    ["water pump"]
  );
});

test("buildAmazonCatalogValues returns the catalog metadata columns", () => {
  assert.deepEqual(
    buildAmazonCatalogValues([
      {
        keyword: "Bedding",
        url: "https://www.amazon.com/Best-Sellers-Home-Kitchen-Bedding/zgbs/home-garden/1063252",
        depth: 2,
        path: ["Home & Kitchen", "Bedding"]
      }
    ], "2026-06-24T00:00:00.000Z"),
    [[
      "美国",
      "Amazon",
      "Bedding",
      "Home & Kitchen",
      "Bedding",
      "",
      "Home & Kitchen > Bedding",
      "https://www.amazon.com/Best-Sellers-Home-Kitchen-Bedding/zgbs/home-garden/1063252",
      "2",
      "2026-06-24T00:00:00.000Z"
    ]]
  );
});

test("planAmazonCatalogWrites updates old keyword-only rows and skips existing URLs", () => {
  const plan = planAmazonCatalogWrites([
    {
      keyword: "Home & Kitchen",
      url: "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden",
      depth: 1,
      path: ["Home & Kitchen"]
    },
    {
      keyword: "Bedding",
      url: "https://www.amazon.com/Best-Sellers-Home-Kitchen-Bedding/zgbs/home-garden/1063252",
      depth: 2,
      path: ["Home & Kitchen", "Bedding"]
    },
    {
      keyword: "Bath",
      url: "https://www.amazon.com/Best-Sellers-Home-Kitchen-Bath-Products/zgbs/home-garden/1063236",
      depth: 2,
      path: ["Home & Kitchen", "Bath"]
    }
  ], [
    { rowNumber: 2, record: { "关键词": "Home & Kitchen" } },
    {
      rowNumber: 3,
      record: buildAmazonCatalogRecord({
        keyword: "Bedding",
        url: "https://www.amazon.com/Best-Sellers-Home-Kitchen-Bedding/zgbs/home-garden/1063252",
        depth: 2,
        path: ["Home & Kitchen", "Bedding"]
      })
    }
  ], "2026-06-24T00:00:00.000Z");

  assert.deepEqual(plan.updates.map((item) => item.rowNumber), [2]);
  assert.deepEqual(plan.appends.map((item) => item["关键词"]), ["Bath"]);
  assert.equal(plan.skipped, 1);
});

test("amazonCatalogAppendRange returns the direct write range", () => {
  assert.equal(amazonCatalogAppendRange(2, 3), "'Amazon目录词'!A3:J4");
  assert.equal(amazonCatalogAppendRange(0, 3), "");
});

test("migrateAmazonCatalogValues shifts legacy rows to country and platform columns", () => {
  const result = migrateAmazonCatalogValues([
    ["关键词", "一级目录", "二级目录", "三级目录", "目录路径", "Amazon URL", "深度", "抓取时间"],
    ["Bedding", "Home & Kitchen", "Bedding", "", "Home & Kitchen > Bedding", "https://www.amazon.com/Best-Sellers-Home-Kitchen-Bedding/zgbs/home-garden/1063252", "2", "2026-06-24T00:00:00.000Z"]
  ]);

  assert.equal(result.migrated, true);
  assert.deepEqual(result.values[1], [
    "美国",
    "Amazon",
    "Bedding",
    "Home & Kitchen",
    "Bedding",
    "",
    "Home & Kitchen > Bedding",
    "https://www.amazon.com/Best-Sellers-Home-Kitchen-Bedding/zgbs/home-garden/1063252",
    "2",
    "2026-06-24T00:00:00.000Z"
  ]);
});

test("selectAmazonCatalogCandidates keeps deeper multi-word physical catalog terms", () => {
  const result = selectAmazonCatalogCandidates([
    { rowNumber: 2, record: { "关键词": "Home", "深度": "3" } },
    { rowNumber: 3, record: { "关键词": "Home Storage", "深度": "2" } },
    { rowNumber: 4, record: { "关键词": "Digital Music Players", "深度": "4" } },
    { rowNumber: 5, record: { "关键词": "Car Dash Cameras", "深度": "3", "目录路径": "Amazon Devices & Accessories > Amazon Devices > Car Dash Cameras" } },
    { rowNumber: 6, record: { "关键词": "Water Filter Pitchers", "深度": "4", "目录路径": "Home > Kitchen > Water Filter Pitchers" } },
    { rowNumber: 7, record: { "关键词": "water filter pitchers", "深度": "5" } },
    { rowNumber: 8, record: { "关键词": "Replacement Air Filters", "深度": "5" } },
    { rowNumber: 9, record: { "关键词": "Cordless Drill Batteries", "深度": "5" } }
  ], { limit: 2 });

  assert.deepEqual(result.selected.map((item) => item.keyword), [
    "Water Filter Pitchers",
    "Replacement Air Filters"
  ]);
  assert.equal(result.skipped.tooShort, 1);
  assert.equal(result.skipped.depthOutOfRange, 1);
  assert.equal(result.skipped.excluded, 2);
  assert.equal(result.skipped.duplicate, 1);
  assert.equal(result.skipped.overLimit, 1);
});

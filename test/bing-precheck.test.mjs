import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  collectBingMetricApiKeysFromApiTable,
  createSheetWriteQueue
} from "../src/bing-precheck.mjs";
import {
  classifyTopSearchResults,
  evaluateBingPrecheck,
  evaluateSerpOpportunity,
  parseCompactNumber,
  sortCountryBreakdown
} from "../src/lib/bing-precheck.mjs";
import { keywordResearchUrlMatchesSite } from "../src/lib/bing-page.mjs";

test("parseCompactNumber converts Bing shorthand metrics", () => {
  assert.equal(parseCompactNumber("16.9K"), 16900);
  assert.equal(parseCompactNumber("472.7K"), 472700);
  assert.equal(parseCompactNumber("1.2M"), 1200000);
  assert.equal(parseCompactNumber("308"), 308);
});

test("keywordResearchUrlMatchesSite requires the expected siteUrl", () => {
  assert.equal(
    keywordResearchUrlMatchesSite(
      "https://www.bing.com/webmasters/keywordresearch?siteUrl=https%3A%2F%2Fbackwardstextgenerator.com%2F&keyword=test",
      "https://backwardstextgenerator.com/"
    ),
    true
  );
  assert.equal(
    keywordResearchUrlMatchesSite(
      "https://www.bing.com/webmasters/keywordresearch?siteUrl=https%3A%2F%2Fbackwardstextgenerator.com%2F&keyword=test",
      "https://2fafree.com/"
    ),
    false
  );
});

test("evaluateBingPrecheck rejects only when impressions miss the minimum", () => {
  assert.equal(
    evaluateBingPrecheck({
      impressions: "999",
      minImpressions: "1000"
    }).judgement,
    "拒绝"
  );
  assert.equal(
    evaluateBingPrecheck({
      impressions: "10K",
      minImpressions: "1000"
    }).judgement,
    "继续"
  );
  assert.equal(
    evaluateBingPrecheck({
      impressions: "499",
      minImpressions: ""
    }).judgement,
    "拒绝"
  );
  assert.equal(
    evaluateBingPrecheck({
      impressions: "500",
      minImpressions: ""
    }).judgement,
    "继续"
  );
  assert.deepEqual(
    evaluateBingPrecheck({
      impressions: "",
      minImpressions: ""
    }),
    {
      judgement: "拒绝",
      impressionFailed: true,
      impressionsNumber: 0,
      minImpressionsNumber: 500
    }
  );
});

test("classifyTopSearchResults separates platforms, independent sites, and strong content", () => {
  const result = classifyTopSearchResults([
    "https://www.amazon.com/example-product/dp/1",
    "https://www.walmart.com/ip/example-product/1",
    "https://smallwidgets.example/buy",
    "https://www.nytimes.com/wirecutter/reviews/example-product"
  ]);

  assert.equal(result.platformCount, 2);
  assert.equal(result.independentSiteCount, 1);
  assert.equal(result.strongContentCount, 1);
  assert.equal(result.suspiciousLowAuthorityIndependentSite, "smallwidgets.example");
});

test("evaluateSerpOpportunity marks independent-site and platform-gap opportunities", () => {
  assert.deepEqual(
    evaluateSerpOpportunity(classifyTopSearchResults([
      "https://smallwidgets.example/buy",
      "https://www.amazon.com/example-product/dp/1",
      "https://www.walmart.com/ip/example-product/1",
      "https://www.ebay.com/itm/1",
      "https://www.nytimes.com/wirecutter/reviews/example-product",
      "https://www.tomsguide.com/reviews/example-product",
      "https://www.cnet.com/reviews/example-product",
      "https://www.techradar.com/reviews/example-product",
      "https://www.forbes.com/advisor/example-product",
      "https://www.consumerreports.org/example-product"
    ])).judgement,
    "机会"
  );

  assert.equal(
    evaluateSerpOpportunity(classifyTopSearchResults([
      "https://www.amazon.com/a",
      "https://www.walmart.com/b",
      "https://www.ebay.com/c",
      "https://www.nytimes.com/wirecutter/reviews/a",
      "https://www.tomsguide.com/reviews/b",
      "https://www.cnet.com/reviews/c",
      "https://www.techradar.com/reviews/d",
      "https://www.forbes.com/advisor/e",
      "https://www.consumerreports.org/f",
      "https://www.goodhousekeeping.com/g"
    ])).judgement,
    "机会"
  );

  assert.equal(
    evaluateSerpOpportunity(classifyTopSearchResults([
      "https://www.nytimes.com/wirecutter/reviews/a",
      "https://www.tomsguide.com/reviews/b",
      "https://www.cnet.com/reviews/c",
      "https://www.techradar.com/reviews/d",
      "https://www.forbes.com/advisor/e",
      "https://www.consumerreports.org/f",
      "https://www.goodhousekeeping.com/g",
      "https://www.bobvila.com/h",
      "https://www.thespruce.com/i",
      "https://www.pcmag.com/j"
    ])).judgement,
    "待定"
  );

  assert.equal(
    evaluateSerpOpportunity(classifyTopSearchResults([])).judgement,
    "待定"
  );
});

test("sortCountryBreakdown ranks countries by impressions", () => {
  assert.deepEqual(
    sortCountryBreakdown([
      { country: "United States", impressions: "161.1K" },
      { country: "India", impressions: "76.7K" },
      { country: "Germany", impressions: "31.8K" }
    ]).map((row) => row.country),
    ["United States", "India", "Germany"]
  );
});

test("createSheetWriteQueue batches row writes before flushing", () => {
  const queue = createSheetWriteQueue({
    sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
    sheetId: "999267438",
    outDir: "agent-outputs/test-write-queue",
    batchSize: 2
  });

  assert.deepEqual(
    queue.enqueueRow({ rowNumber: 5, headers: ["词根", "关键词"], values: ["root", "keyword"] }),
    { queued: true, range: "关键词总表!A5:B5" }
  );
  assert.equal(queue.pendingCount(), 1);
  assert.equal(queue.shouldFlush(), false);
  assert.deepEqual(
    queue.enqueueBackgrounds({ cells: [], color: { red: 1, green: 0, blue: 0 } }),
    { skipped: true, reason: "no_cells" }
  );

  queue.enqueueRow({ rowNumber: 6, headers: ["词根", "关键词"], values: ["root", "keyword 2"] });
  assert.equal(queue.pendingCount(), 2);
  assert.equal(queue.shouldFlush(), true);
});

test("collectBingMetricApiKeysFromApiTable reads keys from the api tab", () => {
  const apiTable = {
    headers: ["IP所在区域", "指纹的名称", "域名", "bing webmaster api"],
    rows: [
      { rowNumber: 2, values: ["", "1", "a.com", "11111111111111111111111111111111"] },
      { rowNumber: 3, values: ["", "2", "b.com", "not-a-key"] },
      { rowNumber: 4, values: ["", "3", "c.com", "22222222222222222222222222222222"] }
    ]
  };

  assert.deepEqual(
    collectBingMetricApiKeysFromApiTable(apiTable, { startFingerprintName: "2" }),
    ["22222222222222222222222222222222"]
  );
  assert.deepEqual(
    collectBingMetricApiKeysFromApiTable(apiTable, { startFingerprintName: "", startRow: 4 }),
    ["22222222222222222222222222222222"]
  );
});

test("Bing writers no longer reference legacy top5 SERP columns", async () => {
  const files = [
    new URL("../src/bing-precheck.mjs", import.meta.url),
    new URL("../src/bing-hubstudio-serp.mjs", import.meta.url)
  ];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    assert.doesNotMatch(source, /top5根域名数量|根域名1|根域名1排名|根域名2|根域名2排名/);
  }
});

test("bing:precheck uses only API-sheet Webmaster metrics", async () => {
  const source = await fs.readFile(new URL("../src/bing-precheck.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /readFeishuBingRegistry|readBingWebmasterApiKeys|fetchBingKeywordResearchViaPageApis/);
  assert.doesNotMatch(source, /fetchBingTopSearchUrlsViaBrowser|searchBingKeyword|connectChromeCdpWithRecovery|chrome-only|api\+chrome/);
  assert.doesNotMatch(source, /fallback to local file|fallback to browser metrics|browser page/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createCatalogSheetWriteQueue,
  parsePlatformIds
} from "../src/crawl-catalog.mjs";
import { DEFAULT_PLATFORM_IDS } from "../src/lib/catalog-crawler.mjs";

test("parsePlatformIds expands all platforms and comma lists", () => {
  assert.deepEqual(parsePlatformIds("all"), DEFAULT_PLATFORM_IDS);
  assert.deepEqual(parsePlatformIds("amazon,walmart"), ["amazon", "walmart"]);
});

test("createCatalogSheetWriteQueue batches writes and serializes flushes", async () => {
  const batches = [];
  const queue = createCatalogSheetWriteQueue({
    sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
    batchSize: 2,
    delayMs: 0,
    crawledAt: "2026-06-24T00:00:00.000Z",
    logStatus: () => {},
    writeCategories: async ({ categories }) => {
      batches.push(categories.map((category) => category.keyword));
      return { writtenRows: categories.length };
    }
  });

  await Promise.all([
    queue.enqueue([{ keyword: "A" }]),
    queue.enqueue([{ keyword: "B" }]),
    queue.enqueue([{ keyword: "C" }])
  ]);
  await queue.flush();

  assert.deepEqual(batches, [["A", "B"], ["C"]]);
  assert.deepEqual(queue.stats(), {
    writtenRows: 3,
    updatedRows: 0,
    skippedRows: 0,
    batches: 2,
    pendingRows: 0
  });
});

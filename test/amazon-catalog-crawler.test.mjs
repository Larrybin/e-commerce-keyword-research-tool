import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalAmazonCategoryUrl,
  crawlAmazonCatalog,
  createAmazonCatalogState,
  expandAmazonCatalogQueueForDepth,
  parseAmazonCategoryLinks
} from "../src/lib/amazon-catalog-crawler.mjs";

const ROOT_HTML = `
  <a href="/Best-Sellers/zgbs/ref=zg_bs_tab_bs">Best Sellers</a>
  <a href="/Best-Sellers-Home-Kitchen/zgbs/home-garden/ref=zg_bs_nav_home-garden_0">Home &amp; Kitchen</a>
  <a href="/Some-Product/dp/B00TEST">Not a category</a>
  <a href="/Best-Sellers/zgbs/ref=zg_bs_pg_1?_encoding=UTF8&amp;pg=1">1</a>
  <a href="/Best-Sellers/zgbs/ref=zg_bs_pg_2?_encoding=UTF8&amp;pg=2">Next page →</a>
  <a href="/Best-Sellers-Books-CD/zgbs/books/123/ref=zg_bs_nav_books_1">34875086-8a6a-4dfe-b095-4d85f</a>
`;

const HOME_HTML = `
  <a href="/Best-Sellers/zgbs/ref=zg_bs_unv_home-garden_0_1">Any Department</a>
  <a href="/Best-Sellers-Home-Kitchen-Bedding/zgbs/home-garden/1063252/ref=zg_bs_nav_home-garden_1">Bedding</a>
  <a href="/Best-Sellers-Home-Kitchen-Bath-Products/zgbs/home-garden/1063236/ref=zg_bs_nav_home-garden_1">Bath</a>
`;

test("canonicalAmazonCategoryUrl keeps only Amazon zgbs category URLs", () => {
  assert.equal(
    canonicalAmazonCategoryUrl("/Best-Sellers-Home-Kitchen/zgbs/home-garden/ref=zg_bs_nav_home-garden_0"),
    "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden"
  );
  assert.equal(canonicalAmazonCategoryUrl("/Some-Product/dp/B00TEST"), "");
});

test("parseAmazonCategoryLinks extracts category labels and skips nav noise", () => {
  assert.deepEqual(parseAmazonCategoryLinks(ROOT_HTML), [
    {
      text: "Home & Kitchen",
      url: "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden"
    }
  ]);
});

test("crawlAmazonCatalog follows category links within depth and page limits", async () => {
  const pages = new Map([
    ["https://www.amazon.com/Best-Sellers/zgbs", ROOT_HTML],
    ["https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden", HOME_HTML]
  ]);
  const result = await crawlAmazonCatalog({
    maxDepth: 2,
    maxPages: 10,
    delayMs: 0,
    fetcher: async (url) => ({
      ok: true,
      text: async () => pages.get(url) || ""
    })
  });

  assert.equal(result.pagesVisited, 2);
  assert.deepEqual(result.categories.map((item) => item.keyword), [
    "Home & Kitchen",
    "Bedding",
    "Bath"
  ]);
});

test("crawlAmazonCatalog reports progress after each visited page", async () => {
  const pages = new Map([
    ["https://www.amazon.com/Best-Sellers/zgbs", ROOT_HTML],
    ["https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden", HOME_HTML]
  ]);
  const progress = [];

  await crawlAmazonCatalog({
    maxDepth: 2,
    maxPages: 10,
    delayMs: 0,
    fetcher: async (url) => ({
      ok: true,
      text: async () => pages.get(url) || ""
    }),
    onProgress: async (item) => progress.push(item)
  });

  assert.equal(progress.length, 2);
  assert.deepEqual(progress.map((item) => item.pagesVisited), [1, 2]);
  assert.equal(progress.at(-1).categoryCount, 3);
});

test("crawlAmazonCatalog persists state and resumes queued pages", async () => {
  const pages = new Map([
    ["https://www.amazon.com/Best-Sellers/zgbs", ROOT_HTML],
    ["https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden", HOME_HTML]
  ]);
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amazon-crawl-")), "state.json");
  const state = createAmazonCatalogState();
  const fetcher = async (url) => ({
    ok: true,
    text: async () => pages.get(url) || ""
  });

  const first = await crawlAmazonCatalog({ maxDepth: 2, maxPages: 1, delayMs: 0, state, statePath, fetcher });
  assert.equal(first.pagesVisited, 1);
  assert.equal(first.queueLength, 1);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).queue.length, 1);

  const resumed = await crawlAmazonCatalog({ maxDepth: 2, maxPages: 0, delayMs: 0, state: first.state, statePath, fetcher });
  assert.equal(resumed.pagesVisited, 2);
  assert.deepEqual(resumed.categories.map((item) => item.keyword), [
    "Home & Kitchen",
    "Bedding",
    "Bath"
  ]);
});

test("crawlAmazonCatalog can report progress without persisting dry-run state", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amazon-crawl-")), "state.json");

  await crawlAmazonCatalog({
    maxDepth: 1,
    maxPages: 1,
    delayMs: 0,
    statePath,
    persistState: false,
    fetcher: async () => ({
      ok: true,
      text: async () => ROOT_HTML
    })
  });

  assert.equal(fs.existsSync(statePath), false);
});

test("expandAmazonCatalogQueueForDepth requeues known deeper candidates after a shallow run", () => {
  const state = {
    queue: [],
    visited: ["https://www.amazon.com/Best-Sellers/zgbs"],
    categories: [
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
      }
    ]
  };

  assert.equal(expandAmazonCatalogQueueForDepth(state, 2), 1);
  assert.deepEqual(state.queue.map((item) => item.url), [
    "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden"
  ]);
});

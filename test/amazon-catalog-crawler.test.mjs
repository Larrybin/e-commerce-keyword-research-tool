import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  crawlCatalog,
  createCatalogState,
  canonicalCatalogUrl,
  expandCatalogQueueForDepth,
  getPlatformConfig,
  normalizeCatalogLinks,
  parseCatalogLinks
} from "../src/lib/catalog-crawler.mjs";

const AMAZON = getPlatformConfig("amazon");

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

test("canonicalCatalogUrl keeps only Amazon zgbs category URLs", () => {
  assert.equal(
    canonicalCatalogUrl("/Best-Sellers-Home-Kitchen/zgbs/home-garden/ref=zg_bs_nav_home-garden_0", AMAZON),
    "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden"
  );
  assert.equal(canonicalCatalogUrl("/Some-Product/dp/B00TEST", AMAZON), "");
});

test("parseCatalogLinks extracts category labels and skips nav noise", () => {
  assert.deepEqual(parseCatalogLinks(ROOT_HTML, AMAZON), [
    {
      text: "Home & Kitchen",
      url: "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden"
    }
  ]);
});

test("normalizeCatalogLinks filters browser-extracted links with platform rules", () => {
  const costco = getPlatformConfig("costco");

  assert.deepEqual(normalizeCatalogLinks([
    { text: "Refrigerators", href: "https://www.costco.com/refrigerators.html" },
    { text: "Air Conditioner Product", href: "https://www.costco.com/example.product.123.html" },
    { text: "Help", href: "https://www.costco.com/customer-service.html" }
  ], costco).map((item) => item.text), ["Refrigerators"]);
});

test("crawlCatalog follows category links within depth and page limits", async () => {
  const pages = new Map([
    ["https://www.amazon.com/Best-Sellers/zgbs", ROOT_HTML],
    ["https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden", HOME_HTML]
  ]);
  const result = await crawlCatalog({
    config: AMAZON,
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

test("crawlCatalog skips dead category links without pausing the platform", async () => {
  const result = await crawlCatalog({
    config: AMAZON,
    maxDepth: 2,
    maxPages: 0,
    delayMs: 0,
    fetcher: async (url) => url === "https://www.amazon.com/Best-Sellers/zgbs"
      ? { ok: true, text: async () => ROOT_HTML }
      : { ok: false, status: 404, text: async () => "" }
  });

  assert.equal(result.paused, false);
  assert.equal(result.errors.length, 0);
  assert.equal(result.pagesVisited, 2);
  assert.deepEqual(result.categories.map((item) => item.keyword), ["Home & Kitchen"]);
});

test("crawlCatalog de-duplicates queued URLs before fetching", async () => {
  let fetchCount = 0;
  const state = {
    queue: [
      { url: "https://www.amazon.com/Best-Sellers/zgbs", depth: 0, path: [] },
      { url: "https://www.amazon.com/Best-Sellers/zgbs", depth: 0, path: [] }
    ],
    visited: [],
    categories: [],
    errors: [],
    paused: false,
    pauseReason: ""
  };

  await crawlCatalog({
    config: AMAZON,
    maxDepth: 1,
    maxPages: 0,
    delayMs: 0,
    state,
    fetcher: async () => {
      fetchCount += 1;
      return { ok: true, text: async () => ROOT_HTML };
    }
  });

  assert.equal(fetchCount, 1);
});

test("crawlCatalog reports progress after each visited page", async () => {
  const pages = new Map([
    ["https://www.amazon.com/Best-Sellers/zgbs", ROOT_HTML],
    ["https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden", HOME_HTML]
  ]);
  const progress = [];

  await crawlCatalog({
    config: AMAZON,
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

test("crawlCatalog persists state and resumes queued pages", async () => {
  const pages = new Map([
    ["https://www.amazon.com/Best-Sellers/zgbs", ROOT_HTML],
    ["https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden", HOME_HTML]
  ]);
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amazon-crawl-")), "state.json");
  const state = createCatalogState(AMAZON);
  const fetcher = async (url) => ({
    ok: true,
    text: async () => pages.get(url) || ""
  });

  const first = await crawlCatalog({ config: AMAZON, maxDepth: 2, maxPages: 1, delayMs: 0, state, statePath, fetcher });
  assert.equal(first.pagesVisited, 1);
  assert.equal(first.queueLength, 1);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).queue.length, 1);

  const resumed = await crawlCatalog({ config: AMAZON, maxDepth: 2, maxPages: 0, delayMs: 0, state: first.state, statePath, fetcher });
  assert.equal(resumed.pagesVisited, 2);
  assert.deepEqual(resumed.categories.map((item) => item.keyword), [
    "Home & Kitchen",
    "Bedding",
    "Bath"
  ]);
});

test("crawlCatalog can report progress without persisting dry-run state", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amazon-crawl-")), "state.json");

  await crawlCatalog({
    config: AMAZON,
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

test("crawlCatalog does not fetch seeded categories at max depth", async () => {
  const config = {
    ...AMAZON,
    rootUrls: [{
      keyword: "Seeded Category",
      url: "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden",
      depth: 1,
      path: ["Seeded Category"]
    }]
  };
  let fetchCount = 0;

  const result = await crawlCatalog({
    config,
    maxDepth: 1,
    maxPages: 10,
    delayMs: 0,
    fetcher: async () => {
      fetchCount += 1;
      return { ok: true, text: async () => "" };
    }
  });

  assert.equal(fetchCount, 0);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.categories.map((item) => item.keyword), ["Seeded Category"]);
});

test("crawlCatalog can keep seeded categories as non-fetching roots", async () => {
  const config = {
    ...AMAZON,
    discoverSeedRoots: false,
    rootUrls: [{
      keyword: "Seeded Category",
      url: "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden",
      depth: 1,
      path: ["Seeded Category"]
    }]
  };

  const result = await crawlCatalog({
    config,
    maxDepth: 2,
    maxPages: 10,
    delayMs: 0,
    fetcher: async () => {
      throw new Error("should_not_fetch");
    }
  });

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.categories.map((item) => item.keyword), ["Seeded Category"]);
});

test("site-specific static adapters can include deeper categories without fetching", () => {
  const lowesState = createCatalogState(getPlatformConfig("lowes"));
  const macysState = createCatalogState(getPlatformConfig("macys"));

  assert.equal(lowesState.queue.length, 0);
  assert.equal(macysState.queue.length, 0);
  assert.ok(lowesState.categories.some((item) => item.depth === 2 && item.path.join(" > ") === "Kitchen > Cabinets"));
  assert.ok(macysState.categories.some((item) => item.depth === 2 && item.path.join(" > ") === "Women > Women's Tops"));
});

test("crawlCatalog can discover seeded roots with a browser link extractor", async () => {
  const config = {
    ...AMAZON,
    browserFetch: true,
    requiredHrefPattern: null,
    rootUrls: [{
      keyword: "Seeded Category",
      url: "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden",
      depth: 1,
      path: ["Seeded Category"]
    }]
  };

  const result = await crawlCatalog({
    config,
    maxDepth: 2,
    maxPages: 1,
    delayMs: 0,
    browserLinkExtractor: async () => [
      {
        text: "Bedding",
        url: "https://www.amazon.com/Best-Sellers-Home-Kitchen-Bedding/zgbs/home-garden/1063252"
      }
    ]
  });

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.categories.map((item) => item.keyword), ["Seeded Category", "Bedding"]);
});

test("expandCatalogQueueForDepth requeues known deeper candidates after a shallow run", () => {
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

  assert.equal(expandCatalogQueueForDepth(state, AMAZON, 2), 1);
  assert.deepEqual(state.queue.map((item) => item.url), [
    "https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden"
  ]);
});

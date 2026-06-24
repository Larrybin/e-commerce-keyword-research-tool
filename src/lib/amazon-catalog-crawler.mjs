import fs from "node:fs";
import path from "node:path";

const AMAZON_ORIGIN = "https://www.amazon.com";
const DEFAULT_ROOT_URL = `${AMAZON_ORIGIN}/Best-Sellers/zgbs`;
const SKIP_LABELS = new Set(["Any Department", "Best Sellers", "New Releases", "Next page", "Previous page"]);
const UUID_LIKE_PATTERN = /\b[0-9a-f]{8}-[0-9a-f-]{12,}\b/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanText(value) {
  return decodeHtml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function canonicalAmazonCategoryUrl(href, baseUrl = DEFAULT_ROOT_URL) {
  const url = new URL(decodeHtml(href), baseUrl);
  if (url.hostname !== "www.amazon.com" || !url.pathname.includes("/zgbs/")) {
    return "";
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/ref=.*$/, "").replace(/\/$/, "");
  return url.toString();
}

export function parseAmazonCategoryLinks(html, baseUrl = DEFAULT_ROOT_URL) {
  const links = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = cleanText(match[2]);
    const href = decodeHtml(match[1]);
    if (!href.includes("ref=zg_bs_nav")) {
      continue;
    }
    const url = canonicalAmazonCategoryUrl(href, baseUrl);
    const category = { keyword: text, url, depth: 1, path: [text] };
    if (!isValidAmazonCatalogCategory(category) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    links.push({ text, url });
  }
  return links;
}

export function isValidAmazonCatalogCategory(category = {}) {
  const keyword = String(category.keyword || "").trim();
  const url = String(category.url || "").trim();
  const path = Array.isArray(category.path) ? category.path.map((item) => String(item || "").trim()).filter(Boolean) : [];
  if (!keyword || SKIP_LABELS.has(keyword) || /^\d+$/.test(keyword) || /^(next|previous) page\b/i.test(keyword) || UUID_LIKE_PATTERN.test(keyword)) return false;
  if (!url || !url.startsWith(AMAZON_ORIGIN) || !new URL(url).pathname.includes("/zgbs/")) return false;
  if (/zg_bs_pg|[?&]pg=/.test(url)) return false;
  if (path.length > 0 && path.at(-1) !== keyword) return false;
  if (Number(category.depth || path.length || 0) < 1) return false;
  return true;
}

function looksBlocked(html) {
  return /api-services-support@amazon\.com|Enter the characters you see below|automated access/i.test(String(html || ""));
}

async function fetchAmazonPage(url, { fetcher = fetch, timeoutMs = 20000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "accept": "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
        }
      });
      const html = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (looksBlocked(html)) {
        throw new Error("amazon_blocked_automated_access");
      }
      return html;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(750 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

export function createAmazonCatalogState(rootUrl = DEFAULT_ROOT_URL) {
  return {
    rootUrl,
    queue: [{ url: rootUrl, depth: 0, path: [] }],
    visited: [],
    categories: [],
    errors: []
  };
}

export function readAmazonCatalogState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function writeAmazonCatalogState(statePath, state) {
  if (!statePath) {
    return;
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function expandAmazonCatalogQueueForDepth(state, maxDepth) {
  const queued = new Set((state.queue || []).map((item) => item.url));
  const visited = new Set(state.visited || []);
  const added = [];

  for (const category of state.categories || []) {
    if (!isValidAmazonCatalogCategory(category) || category.depth >= maxDepth || visited.has(category.url) || queued.has(category.url)) {
      continue;
    }
    const item = { url: category.url, depth: category.depth, path: category.path || [category.keyword].filter(Boolean) };
    state.queue.push(item);
    queued.add(category.url);
    added.push(item);
  }

  return added.length;
}

export async function crawlAmazonCatalog({
  rootUrl = DEFAULT_ROOT_URL,
  maxDepth = 3,
  maxPages = 100,
  delayMs = 1500,
  fetcher = fetch,
  state = null,
  statePath = "",
  persistState = true,
  onCategories = null,
  onProgress = null
} = {}) {
  const crawlState = state || createAmazonCatalogState(rootUrl);
  crawlState.categories = (crawlState.categories || []).filter(isValidAmazonCatalogCategory);
  const visited = new Set(crawlState.visited || []);
  crawlState.queue = (crawlState.queue || []).filter((item) => {
    if (!item.url || visited.has(item.url)) return false;
    if (Number(item.depth || 0) === 0) return true;
    return isValidAmazonCatalogCategory({
      keyword: item.keyword || item.path?.at?.(-1),
      url: item.url,
      depth: item.depth,
      path: item.path || []
    });
  });
  expandAmazonCatalogQueueForDepth(crawlState, maxDepth);
  const byUrl = new Map((crawlState.categories || []).map((category) => [category.url, category]));
  const maxPageCount = Number(maxPages);

  while (
    crawlState.queue.length > 0 &&
    (maxPageCount === 0 || visited.size < maxPageCount)
  ) {
    const page = crawlState.queue.shift();
    if (visited.has(page.url) || page.depth > maxDepth) {
      continue;
    }
    visited.add(page.url);
    crawlState.visited = [...visited];
    const newCategories = [];

    try {
      const html = await fetchAmazonPage(page.url, { fetcher });
      for (const link of parseAmazonCategoryLinks(html, page.url)) {
        const path = [...page.path, link.text];
        const category = { keyword: link.text, url: link.url, depth: page.depth + 1, path };
        if (!isValidAmazonCatalogCategory(category)) {
          continue;
        }
        if (!byUrl.has(link.url)) {
          byUrl.set(link.url, category);
          newCategories.push(category);
        }
        if (!visited.has(link.url) && page.depth + 1 < maxDepth) {
          crawlState.queue.push({ url: link.url, depth: page.depth + 1, path });
        }
      }
    } catch (error) {
      crawlState.errors.push({ url: page.url, reason: error.message || String(error) });
    }

    crawlState.categories = [...byUrl.values()];
    if (persistState) {
      writeAmazonCatalogState(statePath, crawlState);
    }
    if (onProgress) {
      await onProgress({
        url: page.url,
        depth: page.depth,
        newCategoryCount: newCategories.length,
        pagesVisited: visited.size,
        queueLength: crawlState.queue.length,
        categoryCount: byUrl.size,
        errorCount: crawlState.errors.length
      }, crawlState);
    }
    if (newCategories.length > 0 && onCategories) {
      await onCategories(newCategories, crawlState);
    }

    if (crawlState.queue.length > 0 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    pagesVisited: visited.size,
    categories: [...byUrl.values()],
    errors: crawlState.errors,
    queueLength: crawlState.queue.length,
    state: crawlState
  };
}

export { DEFAULT_ROOT_URL };

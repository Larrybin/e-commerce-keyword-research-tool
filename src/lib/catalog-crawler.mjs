import fs from "node:fs";
import path from "node:path";
import {
  CdpClient,
  createChromePage,
  evaluate,
  navigateAndWait,
  readChromeWebSocketEndpoint
} from "./cdp.mjs";

const GENERIC_SKIP_LABELS = new Set([
  "All",
  "All Categories",
  "All Departments",
  "Any Department",
  "Back to top",
  "Best Sellers",
  "Departments",
  "Featured",
  "Help",
  "Home",
  "New Releases",
  "Next",
  "Next page",
  "Previous",
  "Previous page",
  "Sale",
  "Shop",
  "Shop all"
]);
const UUID_LIKE_PATTERN = /\b[0-9a-f]{8}-[0-9a-f-]{12,}\b/i;
const TRACKING_PARAMS_PATTERN = /^(?:_branch_|ad|asc|campid|cmpid|gclid|irgwc|linkCode|msclkid|ref|tag|utm_)/i;
const GENERIC_BLOCKED_PATTERN =
  /captcha challenge|robot check|verify you are human|access denied|automated access|unusual traffic|press & hold|powered and protected by/i;
const BROWSER_BLOCKED_RESOURCE_TYPES = ["Image", "Media", "Font", "Stylesheet"];

function root(keyword, url) {
  return { keyword, url, depth: 1, path: [keyword] };
}

function child(parentKeyword, keyword, url) {
  return { keyword, url, depth: 2, path: [parentKeyword, keyword] };
}

export const PLATFORM_CONFIGS = {
  amazon: {
    id: "amazon",
    platform: "Amazon",
    rootUrls: ["https://www.amazon.com/Best-Sellers/zgbs"],
    hosts: ["www.amazon.com"],
    categoryPathPatterns: [/\/zgbs(?:\/|$)/],
    requiredHrefPattern: /ref=zg_bs_nav/i,
    blockedPattern: /api-services-support@amazon\.com|Enter the characters you see below|automated access/i
  },
  walmart: {
    id: "walmart",
    platform: "Walmart",
    rootUrls: [
      root("Grocery", "https://www.walmart.com/cp/food/976759"),
      root("Electronics", "https://www.walmart.com/cp/electronics/3944"),
      root("Home", "https://www.walmart.com/cp/home/4044"),
      root("Clothing", "https://www.walmart.com/cp/clothing/5438"),
      root("Toys", "https://www.walmart.com/cp/toys/4171"),
      root("Health and Wellness", "https://www.walmart.com/cp/health/976760"),
      root("Beauty", "https://www.walmart.com/cp/beauty/1085666"),
      root("Sports and Outdoors", "https://www.walmart.com/cp/sports-outdoors/4125"),
      root("Auto and Tires", "https://www.walmart.com/cp/auto-tires/91083"),
      root("Patio and Garden", "https://www.walmart.com/cp/patio-garden/5428")
    ],
    hosts: ["www.walmart.com"],
    categoryPathPatterns: [/^\/cp(?:\/|$)/, /^\/browse(?:\/|$)/]
  },
  ebay: {
    id: "ebay",
    platform: "eBay",
    browserFetch: true,
    rootUrls: [
      "https://www.ebay.com/n/all-categories",
      root("Electronics", "https://www.ebay.com/b/Electronics/bn_7000259124"),
      root("Fashion", "https://www.ebay.com/b/Fashion/bn_7000259856"),
      root("Motors", "https://www.ebay.com/b/Auto-Parts-and-Vehicles/6000/bn_1865334"),
      root("Home and Garden", "https://www.ebay.com/b/Home-Garden/11700/bn_1853126"),
      root("Collectibles", "https://www.ebay.com/b/Collectibles-Art/1/bn_7000259855")
    ],
    hosts: ["www.ebay.com"],
    categoryPathPatterns: [/^\/b(?:\/|$)/, /^\/n\/all-categories(?:\/|$)/]
  },
  etsy: {
    id: "etsy",
    platform: "Etsy",
    browserFetch: true,
    rootUrls: [
      root("Home and Living", "https://www.etsy.com/c/home-and-living"),
      root("Jewelry", "https://www.etsy.com/c/jewelry"),
      root("Clothing", "https://www.etsy.com/c/clothing"),
      root("Craft Supplies and Tools", "https://www.etsy.com/c/craft-supplies-and-tools"),
      root("Art and Collectibles", "https://www.etsy.com/c/art-and-collectibles"),
      root("Weddings", "https://www.etsy.com/c/weddings"),
      root("Toys and Games", "https://www.etsy.com/c/toys-and-games"),
      root("Bags and Purses", "https://www.etsy.com/c/bags-and-purses")
    ],
    hosts: ["www.etsy.com"],
    categoryPathPatterns: [/^\/c(?:\/|$)/]
  },
  target: {
    id: "target",
    platform: "Target",
    browserFetch: true,
    browserWaitMs: 12000,
    rootUrls: [
      "https://www.target.com/c/categories/-/N-5xsxf",
      root("Home", "https://www.target.com/c/home/-/N-5xtvd"),
      root("Clothing", "https://www.target.com/c/clothing-shoes-accessories/-/N-5xtd4"),
      root("Baby", "https://www.target.com/c/baby/-/N-5xtly"),
      root("Electronics", "https://www.target.com/c/electronics/-/N-5xtg6"),
      root("Toys", "https://www.target.com/c/toys/-/N-5xtb0"),
      root("Beauty", "https://www.target.com/c/beauty/-/N-55r1x"),
      root("Health", "https://www.target.com/c/health/-/N-5xu1n")
    ],
    hosts: ["www.target.com"],
    categoryPathPatterns: [/^\/c(?:\/|$)/]
  },
  bestbuy: {
    id: "bestbuy",
    platform: "Best Buy",
    rootUrls: [
      "https://www.bestbuy.com/site/electronics/all-categories/pcmcat128500050004.c?id=pcmcat128500050004",
      root("TV and Home Theater", "https://www.bestbuy.com/site/tv-home-theater/abcat0100000.c?id=abcat0100000"),
      root("Computers and Tablets", "https://www.bestbuy.com/site/computers-pcs/abcat0500000.c?id=abcat0500000"),
      root("Cell Phones", "https://www.bestbuy.com/site/cell-phones/abcat0800000.c?id=abcat0800000"),
      root("Appliances", "https://www.bestbuy.com/site/major-appliances/abcat0900000.c?id=abcat0900000"),
      root("Cameras", "https://www.bestbuy.com/site/cameras-camcorders/abcat0400000.c?id=abcat0400000")
    ],
    hosts: ["www.bestbuy.com"],
    categoryPathPatterns: [/^\/site(?:\/|$)/],
    keepSearchParams: ["id"]
  },
  homedepot: {
    id: "homedepot",
    platform: "Home Depot",
    browserFetch: true,
    rootUrls: [
      root("Appliances", "https://www.homedepot.com/b/Appliances/N-5yc1vZbv1w"),
      root("Bath", "https://www.homedepot.com/b/Bath/N-5yc1vZbzb3"),
      root("Building Materials", "https://www.homedepot.com/b/Building-Materials/N-5yc1vZaqns"),
      root("Doors and Windows", "https://www.homedepot.com/b/Doors-Windows/N-5yc1vZaqih"),
      root("Electrical", "https://www.homedepot.com/b/Electrical/N-5yc1vZarcd"),
      root("Flooring", "https://www.homedepot.com/b/Flooring/N-5yc1vZaq7r"),
      root("Hardware", "https://www.homedepot.com/b/Hardware/N-5yc1vZc21m"),
      root("Kitchen", "https://www.homedepot.com/b/Kitchen/N-5yc1vZar4i"),
      root("Lawn and Garden", "https://www.homedepot.com/b/Outdoors-Garden-Center/N-5yc1vZbx6k"),
      root("Tools", "https://www.homedepot.com/b/Tools/N-5yc1vZc1xy")
    ],
    hosts: ["www.homedepot.com"],
    categoryPathPatterns: [/^\/b(?:\/|$)/, /^\/c(?:\/|$)/]
  },
  lowes: {
    id: "lowes",
    platform: "Lowe's",
    discoverSeedRoots: false,
    rootUrls: [
      root("Appliances", "https://www.lowes.com/c/Appliances"),
      child("Appliances", "Refrigerators", "https://www.lowes.com/c/Refrigerators-Appliances"),
      child("Appliances", "Washers and Dryers", "https://www.lowes.com/c/Washers-dryers-Appliances"),
      child("Appliances", "Dishwashers", "https://www.lowes.com/c/Dishwashers-Appliances"),
      child("Appliances", "Ranges", "https://www.lowes.com/c/Ranges-Appliances"),
      child("Appliances", "Microwaves", "https://www.lowes.com/c/Microwaves-Appliances"),
      root("Bathroom", "https://www.lowes.com/c/Bathroom"),
      root("Building Supplies", "https://www.lowes.com/c/Building-supplies"),
      root("Electrical", "https://www.lowes.com/c/Electrical"),
      root("Flooring", "https://www.lowes.com/c/Flooring"),
      root("Hardware", "https://www.lowes.com/c/Hardware"),
      root("Home Decor", "https://www.lowes.com/c/Home-decor"),
      root("Kitchen", "https://www.lowes.com/c/Kitchen"),
      child("Kitchen", "Cabinets", "https://www.lowes.com/c/Kitchen-cabinets-Kitchen"),
      child("Kitchen", "Countertops", "https://www.lowes.com/c/Kitchen-countertops-accessories-Kitchen"),
      child("Kitchen", "Kitchen Sinks", "https://www.lowes.com/c/Kitchen-sinks-Kitchen"),
      child("Kitchen", "Kitchen Faucets", "https://www.lowes.com/c/Kitchen-faucets-Kitchen"),
      child("Kitchen", "Backsplash Panels", "https://www.lowes.com/c/Backsplash-panels-Kitchen"),
      root("Lawn and Garden", "https://www.lowes.com/c/Lawn-garden"),
      root("Tools", "https://www.lowes.com/c/Tools"),
      child("Tools", "Power Tools", "https://www.lowes.com/c/Power-tools-Tools"),
      child("Tools", "Hand Tools", "https://www.lowes.com/c/Hand-tools-Tools"),
      child("Tools", "Power Tool Accessories", "https://www.lowes.com/c/Power-tool-accessories-Tools")
    ],
    hosts: ["www.lowes.com"],
    categoryPathPatterns: [/^\/c(?:\/|$)/, /^\/pl(?:\/|$)/]
  },
  wayfair: {
    id: "wayfair",
    platform: "Wayfair",
    browserFetch: true,
    rootUrls: [
      root("Furniture", "https://www.wayfair.com/furniture/sb0/furniture-c45974.html"),
      root("Outdoor", "https://www.wayfair.com/outdoor/sb0/outdoor-c185786.html"),
      root("Bedding and Bath", "https://www.wayfair.com/bed-bath/sb0/bed-bath-c215386.html"),
      root("Rugs", "https://www.wayfair.com/rugs/sb0/rugs-c215385.html"),
      root("Decor and Pillows", "https://www.wayfair.com/decor-pillows/sb0/decor-pillows-c186328.html"),
      root("Lighting", "https://www.wayfair.com/lighting/sb0/lighting-c215385.html"),
      root("Kitchen", "https://www.wayfair.com/kitchen-tabletop/sb0/kitchen-tabletop-c215384.html"),
      root("Baby and Kids", "https://www.wayfair.com/baby-kids/sb0/baby-kids-c186177.html")
    ],
    hosts: ["www.wayfair.com"],
    categoryPathPatterns: [/\/sb0\//, /(?:\/|-)(?:c)\d+\.html$/]
  },
  chewy: {
    id: "chewy",
    platform: "Chewy",
    browserFetch: true,
    rootUrls: [
      root("Dog", "https://www.chewy.com/b/dog-288"),
      root("Cat", "https://www.chewy.com/b/cat-325"),
      root("Fish", "https://www.chewy.com/b/fish-885"),
      root("Bird", "https://www.chewy.com/b/bird-941"),
      root("Small Pet", "https://www.chewy.com/b/small-pet-977"),
      root("Reptile", "https://www.chewy.com/b/reptile-1025"),
      root("Horse", "https://www.chewy.com/b/horse-1663")
    ],
    hosts: ["www.chewy.com"],
    categoryPathPatterns: [/^\/b(?:\/|$)/, /^\/c(?:\/|$)/]
  },
  macys: {
    id: "macys",
    platform: "Macy's",
    discoverSeedRoots: false,
    rootUrls: [
      root("Women", "https://www.macys.com/shop/womens-clothing?id=118"),
      child("Women", "Women's Tops", "https://www.macys.com/shop/womens-clothing/all-womens-clothing/womens-tops?id=255"),
      child("Women", "Women's Dresses", "https://www.macys.com/shop/womens-clothing/womens-dresses?id=5449"),
      child("Women", "Plus Size Clothing", "https://www.macys.com/shop/womens-clothing/all-plus-size-clothing?id=188853"),
      root("Men", "https://www.macys.com/shop/mens-clothing?id=1"),
      child("Men", "Men's Suits", "https://www.macys.com/shop/mens-clothing/mens-suits?id=17788"),
      child("Men", "Men's Wedding", "https://www.macys.com/shop/mens-clothing/wedding?id=209658"),
      root("Shoes", "https://www.macys.com/shop/shoes?id=13247"),
      child("Shoes", "Women's Shoes", "https://www.macys.com/shop/shoes/all-womens-shoes?id=56233"),
      child("Shoes", "Comfort Shoes", "https://www.macys.com/shop/shoes/comfort-shoes?id=27902"),
      root("Handbags", "https://www.macys.com/shop/handbags-accessories?id=26846"),
      root("Jewelry", "https://www.macys.com/shop/jewelry-watches?id=544"),
      root("Beauty", "https://www.macys.com/shop/makeup-and-perfume?id=669"),
      root("Home", "https://www.macys.com/shop/for-the-home?id=22672"),
      child("Home", "Bedding", "https://www.macys.com/shop/bed-bath/all-bedding?id=20919"),
      child("Home", "Kitchen", "https://www.macys.com/shop/kitchen/shop-all-kitchen?id=291559"),
      root("Kids", "https://www.macys.com/shop/kids-clothes?id=5991")
    ],
    hosts: ["www.macys.com"],
    categoryPathPatterns: [/^\/shop(?:\/|$)/],
    keepSearchParams: ["id"]
  },
  nordstrom: {
    id: "nordstrom",
    platform: "Nordstrom",
    browserFetch: true,
    browserWaitMs: 12000,
    rootUrls: [
      root("Women", "https://www.nordstrom.com/browse/women"),
      root("Men", "https://www.nordstrom.com/browse/men"),
      root("Kids", "https://www.nordstrom.com/browse/kids"),
      root("Home", "https://www.nordstrom.com/browse/home"),
      root("Beauty", "https://www.nordstrom.com/browse/beauty"),
      root("Designer", "https://www.nordstrom.com/browse/designer")
    ],
    hosts: ["www.nordstrom.com"],
    categoryPathPatterns: [/^\/browse(?:\/|$)/]
  },
  kohls: {
    id: "kohls",
    platform: "Kohl's",
    browserFetch: true,
    rootUrls: [
      root("Women", "https://www.kohls.com/catalog/womens-clothing.jsp"),
      root("Men", "https://www.kohls.com/catalog/mens-clothing.jsp"),
      root("Kids", "https://www.kohls.com/catalog/kids-clothing.jsp"),
      root("Shoes", "https://www.kohls.com/catalog/shoes.jsp"),
      root("Home", "https://www.kohls.com/catalog/home.jsp"),
      root("Bed and Bath", "https://www.kohls.com/catalog/bed-bath.jsp"),
      root("Kitchen and Dining", "https://www.kohls.com/catalog/kitchen-dining.jsp"),
      root("Toys", "https://www.kohls.com/catalog/toys.jsp")
    ],
    hosts: ["www.kohls.com"],
    categoryPathPatterns: [/^\/catalog(?:\/|\.jsp)/, /^\/catalog\//]
  },
  costco: {
    id: "costco",
    platform: "Costco",
    browserFetch: true,
    rootUrls: [
      root("Appliances", "https://www.costco.com/appliances.html"),
      root("Baby", "https://www.costco.com/baby.html"),
      root("Clothing", "https://www.costco.com/clothing.html"),
      root("Computers", "https://www.costco.com/computers.html"),
      root("Electronics", "https://www.costco.com/electronics.html"),
      root("Furniture", "https://www.costco.com/furniture.html"),
      root("Grocery", "https://www.costco.com/grocery-household.html"),
      root("Home and Kitchen", "https://www.costco.com/home-and-kitchen.html"),
      root("Sports and Fitness", "https://www.costco.com/sports-fitness.html")
    ],
    hosts: ["www.costco.com"],
    categoryPathPatterns: [/\.html$/],
    excludePathPatterns: [/\.product\./]
  },
  samsclub: {
    id: "samsclub",
    platform: "Sam's Club",
    browserFetch: true,
    rootUrls: [
      root("Meat and Seafood", "https://www.samsclub.com/c/meat-poultry-seafood/1545"),
      root("Household Essentials", "https://www.samsclub.com/c/household-essentials-items/450203"),
      root("Health and Wellness", "https://www.samsclub.com/c/better-for-you/15940526")
    ],
    hosts: ["www.samsclub.com"],
    categoryPathPatterns: [/^\/(?:c|cp)(?:\/|$)/]
  }
};

export const DEFAULT_PLATFORM_IDS = Object.keys(PLATFORM_CONFIGS);
const PLATFORM_CONFIGS_BY_NAME = new Map(
  Object.values(PLATFORM_CONFIGS).map((config) => [config.platform.toLowerCase(), config])
);

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

function rootUrlOf(config) {
  const root = config.rootUrls?.[0];
  return typeof root === "string" ? root : root?.url;
}

function categoryUrlAllowed(url, config) {
  if (!url || !config.hosts.includes(url.hostname)) {
    return false;
  }
  if ((config.excludePathPatterns || []).some((pattern) => pattern.test(url.pathname))) {
    return false;
  }
  return config.categoryPathPatterns.some((pattern) => pattern.test(url.pathname));
}

export function getPlatformConfig(platformId) {
  const config = PLATFORM_CONFIGS[String(platformId || "").toLowerCase()];
  if (!config) {
    throw new Error(`Unknown platform: ${platformId}`);
  }
  return config;
}

export function getCategoryPlatformConfig(category = {}) {
  const platformId = String(category.platformId || "").toLowerCase();
  if (platformId && PLATFORM_CONFIGS[platformId]) {
    return PLATFORM_CONFIGS[platformId];
  }
  const platformName = String(category.platform || category["平台"] || "Amazon").toLowerCase();
  return PLATFORM_CONFIGS_BY_NAME.get(platformName) || PLATFORM_CONFIGS.amazon;
}

export function canonicalCatalogUrl(href, config, baseUrl = rootUrlOf(config)) {
  let url;
  try {
    url = new URL(decodeHtml(href), baseUrl);
  } catch {
    return "";
  }
  if (!categoryUrlAllowed(url, config)) {
    return "";
  }

  url.hash = "";
  url.pathname = url.pathname.replace(/\/ref=.*$/, "").replace(/\/$/, "");
  const keep = new Set(config.keepSearchParams || []);
  for (const name of [...url.searchParams.keys()]) {
    if (!keep.has(name) || TRACKING_PARAMS_PATTERN.test(name)) {
      url.searchParams.delete(name);
    }
  }
  url.search = url.searchParams.toString() ? `?${url.searchParams.toString()}` : "";
  return url.toString();
}

export function isValidCatalogCategory(category = {}, config = getCategoryPlatformConfig(category)) {
  const keyword = cleanText(category.keyword || "");
  const url = String(category.url || "").trim();
  const pathParts = Array.isArray(category.path)
    ? category.path.map(cleanText).filter(Boolean)
    : String(category["目录路径"] || "").split(">").map(cleanText).filter(Boolean);
  if (!keyword || keyword.length > 90 || GENERIC_SKIP_LABELS.has(keyword) || UUID_LIKE_PATTERN.test(keyword)) return false;
  if (/^(?:\d+|next|previous|page \d+)\b/i.test(keyword)) return false;
  if (!url || !canonicalCatalogUrl(url, config, rootUrlOf(config))) return false;
  if (pathParts.length > 0 && pathParts.at(-1) !== keyword) return false;
  if (Number(category.depth || pathParts.length || 0) < 1) return false;
  return true;
}

export function parseCatalogLinks(html, config, baseUrl = rootUrlOf(config)) {
  return normalizeCatalogLinks([...String(html || "").matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ href: match[2], text: match[3] })), config, baseUrl);
}

export function normalizeCatalogLinks(rawLinks, config, baseUrl = rootUrlOf(config)) {
  const links = [];
  const seen = new Set();

  for (const rawLink of rawLinks || []) {
    const href = decodeHtml(rawLink.href || rawLink.url);
    if (config.requiredHrefPattern && !config.requiredHrefPattern.test(href)) {
      continue;
    }
    const url = canonicalCatalogUrl(href, config, baseUrl);
    const text = cleanText(rawLink.text);
    const category = { keyword: text, url, depth: 1, path: [text], platformId: config.id };
    if (!isValidCatalogCategory(category, config) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    links.push({ text, url });
  }

  return links;
}

async function extractBrowserCatalogLinks(url, config) {
  return extractDirectCdpCatalogLinks(url, config);
}

function browserLinkExpression(config) {
  return `
    JSON.stringify({
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.slice(0, 1000) || "",
      links: [...document.querySelectorAll("a[href]")]
        .map((item) => ({
          text: (item.innerText || item.textContent || item.getAttribute("aria-label") || "").trim(),
          href: item.href
        }))
        .filter((item) => item.text && item.href)
        .slice(0, ${Number(config.browserLinkLimit || 1500)})
    })
  `;
}

async function extractDirectCdpCatalogLinks(url, config) {
  const cdp = new CdpClient(readChromeWebSocketEndpoint());
  await cdp.connect();
  const { sessionId, targetId } = await createChromePage(cdp, "about:blank");
  const waitMs = Number(config.browserWaitMs || 8000);
  const stopBlocking = await blockHeavyBrowserResources(cdp, sessionId);

  try {
    await navigateAndWait(cdp, sessionId, url, 30000).catch(() => {});
    const payload = await evaluate(cdp, sessionId, `
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(${browserLinkExpression(config)});
        }, ${waitMs});
      })
    `, waitMs + 15000);
    const page = JSON.parse(payload || "{}");
    if (looksBlocked(`${page.title || ""}\n${page.text || ""}`, config)) {
      throw new Error("blocked_or_captcha");
    }
    return normalizeCatalogLinks(page.links || [], config, page.url || url);
  } finally {
    await stopBlocking();
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
}

async function blockHeavyBrowserResources(cdp, sessionId) {
  const unsubscribe = cdp.on("Fetch.requestPaused", (event) => {
    if (event.sessionId !== sessionId) {
      return;
    }
    cdp.send("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient"
    }, sessionId).catch(() => {});
  });

  try {
    await cdp.send("Fetch.enable", {
      patterns: BROWSER_BLOCKED_RESOURCE_TYPES.map((resourceType) => ({
        urlPattern: "*",
        resourceType,
        requestStage: "Request"
      }))
    }, sessionId);
  } catch {
    unsubscribe();
    return async () => {};
  }

  return async () => {
    unsubscribe();
    await cdp.send("Fetch.disable", {}, sessionId).catch(() => {});
  };
}

function normalizeRoot(root) {
  return typeof root === "string" ? { url: root, depth: 0, path: [] } : {
    url: root.url,
    keyword: root.keyword || "",
    depth: Number(root.depth || 0),
    path: root.path || (root.keyword ? [root.keyword] : [])
  };
}

export function createCatalogState(config) {
  const roots = (config.rootUrls || []).map(normalizeRoot);
  const categories = roots
    .filter((root) => root.keyword)
    .map((root) => ({
      country: "美国",
      platform: config.platform,
      platformId: config.id,
      keyword: root.keyword,
      url: root.url,
      depth: root.depth || root.path.length || 1,
      path: root.path
    }))
    .filter((category) => isValidCatalogCategory(category, config));

  return {
    platformId: config.id,
    platform: config.platform,
    rootUrls: roots.map((root) => root.url),
    queue: roots.filter((item) => !item.keyword || config.discoverSeedRoots !== false),
    visited: [],
    categories,
    errors: [],
    paused: false,
    pauseReason: ""
  };
}

export function readCatalogState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function writeCatalogState(statePath, state) {
  if (!statePath) {
    return;
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function expandCatalogQueueForDepth(state, config, maxDepth) {
  if (config.discoverSeedRoots === false) {
    return 0;
  }
  const queued = new Set((state.queue || []).map((item) => item.url));
  const visited = new Set(state.visited || []);
  let added = 0;

  for (const category of state.categories || []) {
    const normalized = { ...category, platformId: config.id };
    if (!isValidCatalogCategory(normalized, config) || Number(normalized.depth) >= maxDepth || visited.has(normalized.url) || queued.has(normalized.url)) {
      continue;
    }
    state.queue.push({ url: normalized.url, depth: Number(normalized.depth), path: normalized.path || [normalized.keyword].filter(Boolean), keyword: normalized.keyword });
    queued.add(normalized.url);
    added += 1;
  }

  return added;
}

function looksBlocked(html, config) {
  return GENERIC_BLOCKED_PATTERN.test(String(html || "")) || Boolean(config.blockedPattern?.test(String(html || "")));
}

function isDeadCatalogLinkError(error) {
  const message = String(error?.message || error || "");
  if (/^HTTP (?:400|404|410)$/.test(message)) {
    return true;
  }
  return /(?:CDP WebSocket|Inspected target navigated or closed|Target closed|Could not connect to host|Protocol error|timed out connecting)/i.test(message);
}

function dedupeCatalogQueue(queue = [], visited = new Set()) {
  const queued = new Set();
  const items = [];
  for (const item of queue) {
    if (!item.url || visited.has(item.url) || queued.has(item.url)) {
      continue;
    }
    queued.add(item.url);
    items.push(item);
  }
  return { items, queued };
}

async function fetchCatalogPage(url, config, { fetcher = fetch, timeoutMs = 20000, retries = 2 } = {}) {
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
      if (looksBlocked(html, config)) {
        throw new Error("blocked_or_captcha");
      }
      return html;
    } catch (error) {
      lastError = error;
      if (isDeadCatalogLinkError(error)) {
        break;
      }
      if (attempt < retries) {
        await sleep(750 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function getCatalogLinksForPage(url, config, options) {
  if (config.browserFetch) {
    return (options.browserLinkExtractor || extractBrowserCatalogLinks)(url, config);
  }
  const html = await fetchCatalogPage(url, config, options);
  return parseCatalogLinks(html, config, url);
}

export async function crawlCatalog({
  config,
  maxDepth = 3,
  maxPages = 100,
  delayMs = 1500,
  fetcher = fetch,
  state = null,
  statePath = "",
  persistState = true,
  onCategories = null,
  onProgress = null,
  browserLinkExtractor = null
} = {}) {
  const crawlState = state || createCatalogState(config);
  if (crawlState.paused) {
    return {
      platformId: config.id,
      paused: true,
      pauseReason: crawlState.pauseReason,
      pagesVisited: new Set(crawlState.visited || []).size,
      categories: crawlState.categories || [],
      errors: crawlState.errors || [],
      queueLength: crawlState.queue?.length || 0,
      state: crawlState
    };
  }

  crawlState.categories = (crawlState.categories || []).filter((category) => isValidCatalogCategory({ ...category, platformId: config.id }, config));
  const visited = new Set(crawlState.visited || []);
  crawlState.queue = dedupeCatalogQueue(crawlState.queue || [], visited).items;
  expandCatalogQueueForDepth(crawlState, config, maxDepth);
  const dedupedQueue = dedupeCatalogQueue(crawlState.queue, visited);
  crawlState.queue = dedupedQueue.items;
  const queued = dedupedQueue.queued;

  const byUrl = new Map((crawlState.categories || []).map((category) => [category.url, category]));
  const maxPageCount = Number(maxPages);

  while (
    crawlState.queue.length > 0 &&
    (maxPageCount === 0 || visited.size < maxPageCount)
  ) {
    const page = crawlState.queue.shift();
    queued.delete(page.url);
    if (visited.has(page.url) || (maxDepth > 0 && Number(page.depth || 0) >= maxDepth)) {
      continue;
    }

    visited.add(page.url);
    crawlState.visited = [...visited];
    const newCategories = [];

    try {
      const links = await getCatalogLinksForPage(page.url, config, { fetcher, browserLinkExtractor });
      if (Number(page.depth || 0) === 0 && !page.path?.length && links.length === 0) {
        throw new Error("no_categories_found");
      }

      for (const link of links) {
        const depth = Number(page.depth || 0) + 1;
        const categoryPath = [...(page.path || []), link.text];
        const category = {
          country: "美国",
          platform: config.platform,
          platformId: config.id,
          keyword: link.text,
          url: link.url,
          depth,
          path: categoryPath
        };
        if (!isValidCatalogCategory(category, config)) {
          continue;
        }
        if (!byUrl.has(link.url)) {
          byUrl.set(link.url, category);
          newCategories.push(category);
        }
        if (!visited.has(link.url) && !queued.has(link.url) && depth < maxDepth) {
          crawlState.queue.push({ url: link.url, depth, path: categoryPath, keyword: link.text });
          queued.add(link.url);
        }
      }
    } catch (error) {
      if (!isDeadCatalogLinkError(error)) {
        crawlState.errors.push({ platform: config.platform, url: page.url, reason: error.message || String(error) });
        crawlState.paused = true;
        crawlState.pauseReason = error.message || String(error);
      }
    }

    crawlState.categories = [...byUrl.values()];
    if (persistState) {
      writeCatalogState(statePath, crawlState);
    }
    if (onProgress) {
      await onProgress({
        platformId: config.id,
        platform: config.platform,
        url: page.url,
        depth: page.depth,
        newCategoryCount: newCategories.length,
        pagesVisited: visited.size,
        queueLength: crawlState.queue.length,
        categoryCount: byUrl.size,
        errorCount: crawlState.errors.length,
        paused: crawlState.paused,
        pauseReason: crawlState.pauseReason
      }, crawlState);
    }
    if (newCategories.length > 0 && onCategories) {
      await onCategories(newCategories, crawlState);
    }
    if (crawlState.paused) {
      break;
    }

    if (crawlState.queue.length > 0 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    platformId: config.id,
    paused: crawlState.paused,
    pauseReason: crawlState.pauseReason,
    pagesVisited: visited.size,
    categories: [...byUrl.values()],
    errors: crawlState.errors,
    queueLength: crawlState.queue.length,
    state: crawlState
  };
}

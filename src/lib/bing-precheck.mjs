const COMMON_PREFIXES = new Set(["www", "m"]);
const LARGE_PLATFORM_HOSTS = new Set([
  "amazon.com",
  "walmart.com",
  "ebay.com",
  "aliexpress.com",
  "etsy.com",
  "temu.com",
  "target.com",
  "costco.com",
  "bestbuy.com",
  "homedepot.com",
  "lowes.com",
  "wayfair.com",
  "shein.com",
  "shopify.com",
  "youtube.com",
  "reddit.com",
  "pinterest.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com"
]);
const STRONG_VERTICAL_ECOMMERCE_HOSTS = new Set([
  "grainger.com",
  "mcmaster.com",
  "uline.com",
  "zoro.com",
  "webstaurantstore.com",
  "newegg.com",
  "bhphotovideo.com",
  "reverb.com",
  "chewy.com",
  "tractorsupply.com"
]);
const STRONG_CONTENT_HOSTS = new Set([
  "nytimes.com",
  "wirecutter.com",
  "forbes.com",
  "consumerreports.org",
  "goodhousekeeping.com",
  "bobvila.com",
  "thespruce.com",
  "cnet.com",
  "pcmag.com",
  "techradar.com",
  "tomsguide.com",
  "wikipedia.org",
  "quora.com"
]);
const BRAND_OFFICIAL_HOSTS = new Set([
  "apple.com",
  "samsung.com",
  "dyson.com",
  "nike.com",
  "adidas.com",
  "sony.com",
  "lg.com",
  "panasonic.com",
  "whirlpool.com",
  "geappliances.com"
]);
const DEFAULT_BING_MIN_IMPRESSIONS = "500";

export function parseCompactNumber(value) {
  const text = String(value || "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!text) {
    return null;
  }
  const match = text.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) {
    return null;
  }
  const multiplier = {
    K: 1000,
    M: 1000000,
    B: 1000000000
  }[match[2]?.toUpperCase()] || 1;
  return Math.round(Number(match[1]) * multiplier);
}

export function formatInteger(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const number = typeof value === "number" ? value : parseCompactNumber(value);
  if (number === null || Number.isNaN(number)) {
    return String(value);
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number);
}

export function rootHost(hostname) {
  const parts = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter(Boolean);
  while (parts.length > 2 && COMMON_PREFIXES.has(parts[0])) {
    parts.shift();
  }
  return parts.join(".");
}

function hostMatches(host, domains) {
  return [...domains].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function classifySearchResultUrl(url) {
  try {
    const parsed = new URL(url);
    const host = rootHost(parsed.hostname);
    if (!host) {
      return { url, host: "", type: "无法分类" };
    }
    if (hostMatches(host, LARGE_PLATFORM_HOSTS)) {
      return { url, host, type: "大平台" };
    }
    if (hostMatches(host, BRAND_OFFICIAL_HOSTS)) {
      return { url, host, type: "品牌官网" };
    }
    if (hostMatches(host, STRONG_VERTICAL_ECOMMERCE_HOSTS)) {
      return { url, host, type: "强垂直电商" };
    }
    if (hostMatches(host, STRONG_CONTENT_HOSTS)) {
      return { url, host, type: "强内容站" };
    }
    return { url, host, type: "独立站" };
  } catch {
    return { url, host: "", type: "无法分类" };
  }
}

export function classifyTopSearchResults(urls, limit = 10) {
  const results = urls.slice(0, limit).map(classifySearchResultUrl);
  const independentHosts = [...new Set(results
    .filter((result) => result.type === "独立站")
    .map((result) => result.host)
    .filter(Boolean))];
  const countType = (type) => results.filter((result) => result.type === type).length;
  return {
    resultCount: results.length,
    incomplete: results.length < limit,
    results,
    platformCount: countType("大平台"),
    independentSiteCount: independentHosts.length,
    brandOfficialCount: countType("品牌官网"),
    strongVerticalEcommerceCount: countType("强垂直电商"),
    strongContentCount: countType("强内容站"),
    unclassifiedCount: countType("无法分类"),
    suspiciousLowAuthorityIndependentSite: independentHosts[0] || ""
  };
}

export function evaluateSerpOpportunity(serp) {
  if (serp.incomplete || serp.unclassifiedCount > 0) {
    return { judgement: "待定", pattern: "结果不完整/无法分类" };
  }
  if (serp.suspiciousLowAuthorityIndependentSite) {
    return { judgement: "机会", pattern: "有疑似低权重独立站" };
  }
  if (serp.platformCount >= 3 && serp.independentSiteCount === 0) {
    return { judgement: "机会", pattern: "大平台霸屏缺独立站" };
  }
  return { judgement: "待定", pattern: "强站为主" };
}

export function sortCountryBreakdown(rows) {
  return [...rows]
    .map((row) => ({
      country: String(row.country || "").trim(),
      impressions: String(row.impressions || "").trim(),
      impressionsNumber: Number.isFinite(Number(row.impressionsNumber))
        ? Number(row.impressionsNumber)
        : parseCompactNumber(row.impressions)
    }))
    .filter((row) => row.country && row.impressionsNumber !== null)
    .sort((a, b) => b.impressionsNumber - a.impressionsNumber);
}

export function evaluateBingPrecheck({
  impressions,
  minImpressions
}) {
  const impressionsNumber = String(impressions || "").trim() ? parseCompactNumber(impressions) : 0;
  const minImpressionsNumber = parseCompactNumber(minImpressions || DEFAULT_BING_MIN_IMPRESSIONS);

  const impressionFailed =
    minImpressionsNumber !== null &&
    impressionsNumber !== null &&
    impressionsNumber < minImpressionsNumber;

  return {
    judgement: impressionFailed ? "拒绝" : "继续",
    impressionFailed,
    impressionsNumber,
    minImpressionsNumber
  };
}

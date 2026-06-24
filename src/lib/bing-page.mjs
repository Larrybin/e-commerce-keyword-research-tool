import { evaluate, navigateAndWait } from "./cdp.mjs";
import { sleep, waitForCondition } from "./browser-actions.mjs";

export function buildBingKeywordResearchUrl(siteUrl = "https://backwardstextgenerator.com/", keyword = "") {
  const url = new URL("https://www.bing.com/webmasters/keywordresearch");
  if (siteUrl) {
    url.searchParams.set("siteUrl", siteUrl);
  }
  if (keyword) {
    url.searchParams.set("keyword", keyword);
  }
  return url.toString();
}

export function keywordResearchUrlMatchesSite(url, siteUrl = "https://backwardstextgenerator.com/") {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.bing.com" &&
      parsed.pathname === "/webmasters/keywordresearch" &&
      parsed.searchParams.get("siteUrl") === siteUrl;
  } catch {
    return false;
  }
}

export async function navigateToBingKeywordResearch(cdp, sessionId, siteUrl) {
  const targetUrl = buildBingKeywordResearchUrl(siteUrl);
  const current = await evaluate(cdp, sessionId, "location.href").catch(() => "");
  if (!keywordResearchUrlMatchesSite(current, siteUrl)) {
    await navigateAndWait(cdp, sessionId, targetUrl, 45000).catch(async () => {
      await sleep(4000);
    });
  }
  await waitForBingKeywordResearchReady(cdp, sessionId);
}

export async function waitForBingKeywordResearchReady(cdp, sessionId) {
  try {
    await waitForCondition(
      cdp,
      sessionId,
      `(() => {
        const input = document.querySelector('input[placeholder="Enter keyword phrases"], input[aria-label="Enter keyword phrases"], input[type="text"]');
        const url = location.href;
        const body = document.body?.innerText || "";
        const readyText = /Keyword Research/i.test(body) && /Get details/i.test(body);
        return (Boolean(input) || readyText) &&
          /bing\\.com\\/webmasters\\/keywordresearch/i.test(url) &&
          !/Welcome to Bing Webmaster Tools/i.test(body);
      })()`,
      45000
    );
  } catch (error) {
    const state = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const text = clean(document.body?.innerText || "");
        return {
          url: location.href,
          title: document.title,
          text: text.slice(0, 800),
          needsSite: /Welcome to Bing Webmaster Tools/i.test(text) &&
            /Add your site|Import your sites from GSC/i.test(text)
        };
      })()`,
      10000
    ).catch(() => ({ needsSite: false }));
    if (state.needsSite) {
      throw new Error(`BING_ACCOUNT_UNAVAILABLE_FOR_SITE: ${JSON.stringify(state)}`);
    }
    throw error;
  }
}

export async function searchBingKeyword(cdp, sessionId, keyword, siteUrl = "https://backwardstextgenerator.com/") {
  await waitForBingKeywordResearchReady(cdp, sessionId);
  const submitted = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const input = document.querySelector(
        'input[placeholder="Enter keyword phrases"], input[aria-label="Enter keyword phrases"], input[type="text"], textarea'
      );
      if (!input) {
        return { ok: false, reason: "input_not_found", url: location.href, text: clean(document.body?.innerText || "").slice(0, 500) };
      }
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      if (setter) {
        setter.call(input, ${JSON.stringify(keyword)});
      } else {
        input.value = ${JSON.stringify(keyword)};
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const buttons = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')];
      const button = buttons.find((item) => /Get details/i.test(clean(item.textContent || item.value || ""))) ||
        input.closest("form")?.querySelector('button, input[type="submit"]');
      if (!button) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
        return { ok: true, submittedBy: "enter", value: input.value };
      }
      button.click();
      return { ok: true, submittedBy: "button", value: input.value };
    })()`,
    20000
  );
  if (!submitted.ok) {
    throw new Error(`BING_KEYWORD_INPUT_NOT_FOUND: ${submitted.reason || ""} ${submitted.url || ""}`);
  }

  await waitForCondition(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const body = document.body?.innerText || "";
      const input = document.querySelector('input[placeholder="Enter keyword phrases"], input[aria-label="Enter keyword phrases"], input[type="text"]')?.value || "";
      const urlKeyword = new URL(location.href).searchParams.get("keyword") || "";
      return (clean(input) === ${JSON.stringify(keyword.toLowerCase())} || clean(urlKeyword) === ${JSON.stringify(keyword.toLowerCase())}) &&
        ((body.includes("Impressions") && body.includes("Top 10 url ranking on this keyword")) ||
          body.includes("No data available") ||
          body.includes("Global breakdown"));
    })()`,
    45000
  );
  await sleep(1500);
}

function extractUrlsFromTopSearchPayload(payload) {
  const urls = [];
  const walk = (value) => {
    if (typeof value === "string") {
      const textValue = value.trim();
      if (/^https?:\/\//i.test(textValue) && !/\/search\?/i.test(textValue)) {
        urls.push(textValue);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(payload);
  return [...new Set(urls)].slice(0, 10);
}

export async function captureTopSearchUrlsWhile(cdp, sessionId, callback) {
  await cdp.send("Network.enable", {}, sessionId).catch(() => {});
  const pending = new Set();
  const captured = [];
  const unsubscribeResponse = cdp.on("Network.responseReceived", (event) => {
    if (event.sessionId && event.sessionId !== sessionId) {
      return;
    }
    const url = event.response?.url || "";
    if (/\/webmasters\/api\/keywordresearch\/topsearchurls/i.test(url)) {
      pending.add(event.requestId);
    }
  });
  const unsubscribeFinished = cdp.on("Network.loadingFinished", (event) => {
    if (event.sessionId && event.sessionId !== sessionId) {
      return;
    }
    if (!pending.has(event.requestId)) {
      return;
    }
    pending.delete(event.requestId);
    captured.push(
      cdp
        .send("Network.getResponseBody", { requestId: event.requestId }, sessionId)
        .then((bodyResult) => {
          const text = bodyResult.base64Encoded
            ? Buffer.from(bodyResult.body || "", "base64").toString("utf8")
            : bodyResult.body || "";
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          const limited = /TooManyRequests|too many requests|quota|daily limit|usage limit|limit reached/i.test(text) ||
            /TooManyRequests|too many requests|quota|daily limit|usage limit|limit reached/i.test(data?.code || data?.message || "");
          return {
            limited,
            urls: limited ? [] : extractUrlsFromTopSearchPayload(data),
            preview: text.slice(0, 800)
          };
        })
        .catch((error) => ({ urls: [], limited: false, error: error.message || String(error) }))
    );
  });

  try {
    await callback();
    await sleep(2000);
    const results = await Promise.all(captured);
    const limited = results.find((result) => result.limited);
    if (limited) {
      throw new Error(`BING_ACCOUNT_LIMIT: ${limited.preview || "topsearchurls too many requests"}`);
    }
    const urls = results.flatMap((result) => result.urls || []);
    return {
      seen: results.length > 0,
      urls: [...new Set(urls)].slice(0, 10)
    };
  } finally {
    unsubscribeResponse();
    unsubscribeFinished();
  }
}

function isLimitedApiResponse(text, status = 200) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return status === 429 ||
    /TooManyRequests|too many requests|quota|daily limit|usage limit|limit reached/i.test(text) ||
    /TooManyRequests|too many requests|quota|daily limit|usage limit|limit reached/i.test(data?.code || data?.message || "");
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function countryNameFromCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "UK") {
    return "United Kingdom";
  }
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(normalized) || normalized;
  } catch {
    return normalized;
  }
}

function buildApiResult({ stats, topUrls }) {
  const countries = (stats?.GlobalBreakDownData || []).map((row) => ({
    country: countryNameFromCode(row.Country),
    impressions: row.ImpressionsFormatted || String(row.Impressions ?? ""),
    impressionsNumber: Number(row.Impressions)
  }));
  return {
    ok: Boolean(stats),
    impressions: stats?.ImpressionCount ?? "0",
    topUrls: (topUrls?.TopUrls || []).map((item) => item.Url).filter(Boolean),
    countryRows: countries,
    raw: {
      stats,
      topUrls
    }
  };
}

async function fetchBingKeywordResearchFallback(cdp, sessionId, { keyword, siteUrl, statsRequest }) {
  const csrfToken = statsRequest?.headers?.["x-csrf-token"] || statsRequest?.headers?.["X-CSRF-Token"] || "";
  const statsPostData = statsRequest?.postData || "";
  return evaluate(
    cdp,
    sessionId,
    `(async () => {
      const limitedPattern = /TooManyRequests|too many requests|quota|daily limit|usage limit|limit reached/i;
      const parseJson = (text) => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      };
      const isLimited = (status, text, data) => status === 429 ||
        limitedPattern.test(text) ||
        limitedPattern.test(data?.code || data?.message || "");

      const result = { stats: null, topUrls: null, limited: false, preview: "" };
      if (${JSON.stringify(csrfToken)} && ${JSON.stringify(statsPostData)}) {
        const response = await fetch("/webmasters/api/keywordresearch/statswithglobalbreakdown", {
          method: "POST",
          credentials: "include",
          headers: {
            "accept": "application/json, text/javascript, */*; q=0.01",
            "content-type": "application/json;charset=UTF-8",
            "x-csrf-token": ${JSON.stringify(csrfToken)}
          },
          body: ${JSON.stringify(statsPostData)}
        });
        const text = await response.text();
        const data = parseJson(text);
        if (isLimited(response.status, text, data)) {
          result.limited = true;
          result.preview = text.slice(0, 800);
          return result;
        }
        result.stats = data;
      }

      const topResponse = await fetch("/webmasters/api/keywordresearch/topsearchurls?keyword=" +
        encodeURIComponent(${JSON.stringify(keyword)}) +
        "&resultCount=10&siteUrl=" +
        encodeURIComponent(${JSON.stringify(siteUrl)}), { credentials: "include" });
      const topText = await topResponse.text();
      const topData = parseJson(topText);
      if (isLimited(topResponse.status, topText, topData)) {
        result.limited = true;
        result.preview = topText.slice(0, 800);
        return result;
      }
      result.topUrls = topData;
      return result;
    })()`,
    20000
  );
}

export async function fetchBingKeywordResearchViaPageApis(cdp, sessionId, { keyword, siteUrl, timeoutMs = 25000 }) {
  await cdp.send("Network.enable", {}, sessionId).catch(() => {});

  const pending = new Map();
  const captured = {
    stats: null,
    topUrls: null,
    limited: null,
    errors: [],
    statsRequest: null
  };
  const bodyPromises = [];

  const unsubscribeRequest = cdp.on("Network.requestWillBeSent", (event) => {
    if (event.sessionId && event.sessionId !== sessionId) {
      return;
    }
    const url = event.request?.url || "";
    if (/\/webmasters\/api\/keywordresearch\/statswithglobalbreakdown/i.test(url)) {
      captured.statsRequest = {
        headers: event.request?.headers || {},
        postData: event.request?.postData || ""
      };
    }
  });

  const unsubscribeResponse = cdp.on("Network.responseReceived", (event) => {
    if (event.sessionId && event.sessionId !== sessionId) {
      return;
    }
    const url = event.response?.url || "";
    if (/\/webmasters\/api\/keywordresearch\/statswithglobalbreakdown/i.test(url)) {
      pending.set(event.requestId, { type: "stats", status: event.response?.status || 0, url });
    }
    if (/\/webmasters\/api\/keywordresearch\/topsearchurls/i.test(url)) {
      pending.set(event.requestId, { type: "topUrls", status: event.response?.status || 0, url });
    }
  });

  const unsubscribeFailed = cdp.on("Network.loadingFailed", (event) => {
    if (event.sessionId && event.sessionId !== sessionId) {
      return;
    }
    const item = pending.get(event.requestId);
    if (!item) {
      return;
    }
    pending.delete(event.requestId);
    captured.errors.push(`${item.type} failed: ${event.errorText || "unknown error"}`);
  });

  const unsubscribeFinished = cdp.on("Network.loadingFinished", (event) => {
    if (event.sessionId && event.sessionId !== sessionId) {
      return;
    }
    const item = pending.get(event.requestId);
    if (!item) {
      return;
    }
    pending.delete(event.requestId);
    bodyPromises.push(
      cdp
        .send("Network.getResponseBody", { requestId: event.requestId }, sessionId)
        .then((bodyResult) => {
          const text = bodyResult.base64Encoded
            ? Buffer.from(bodyResult.body || "", "base64").toString("utf8")
            : bodyResult.body || "";
          if (isLimitedApiResponse(text, item.status)) {
            captured.limited = text.slice(0, 800);
            return;
          }
          const data = parseJsonResponse(text);
          if (!data) {
            captured.errors.push(`${item.type} returned non-json: ${text.slice(0, 200)}`);
            return;
          }
          captured[item.type] = data;
        })
        .catch((error) => {
          captured.errors.push(`${item.type} body error: ${error.message || String(error)}`);
        })
    );
  });

  try {
    const targetUrl = new URL(buildBingKeywordResearchUrl(siteUrl, keyword));
    targetUrl.searchParams.set("_codex_ts", String(Date.now()));
    await cdp
      .send("Page.navigate", {
        url: targetUrl.toString(),
        timeout: 8000
      }, sessionId)
      .catch((error) => {
        if (!/Timed out waiting for CDP response: Page\.navigate/i.test(error.message || String(error))) {
          throw error;
        }
      });

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await Promise.all(bodyPromises.splice(0));
      if (captured.limited) {
        throw new Error(`BING_ACCOUNT_LIMIT: ${captured.limited}`);
      }
      if (captured.stats && captured.topUrls) {
        return buildApiResult(captured);
      }
      await sleep(500);
    }

    await Promise.all(bodyPromises.splice(0));
    if (captured.limited) {
      throw new Error(`BING_ACCOUNT_LIMIT: ${captured.limited}`);
    }
    const fallback = await fetchBingKeywordResearchFallback(cdp, sessionId, {
      keyword,
      siteUrl,
      statsRequest: captured.statsRequest
    }).catch((error) => {
      captured.errors.push(`fallback fetch error: ${error.message || String(error)}`);
      return null;
    });
    if (fallback?.limited) {
      throw new Error(`BING_ACCOUNT_LIMIT: ${fallback.preview || "fallback fetch limited"}`);
    }
    if (fallback?.stats || fallback?.topUrls) {
      captured.stats = captured.stats || fallback.stats;
      captured.topUrls = captured.topUrls || fallback.topUrls;
      if (captured.stats) {
        return buildApiResult(captured);
      }
    }
    throw new Error(`BING_API_CAPTURE_TIMEOUT: ${captured.errors.join("; ") || "stats/topUrls responses not captured"}`);
  } finally {
    unsubscribeRequest();
    unsubscribeResponse();
    unsubscribeFailed();
    unsubscribeFinished();
  }
}

export async function fetchBingTopSearchUrlsViaBrowser(cdp, sessionId, { keyword, siteUrl }) {
  const result = await evaluate(
    cdp,
    sessionId,
    `(async () => {
      const response = await fetch("/webmasters/api/keywordresearch/topsearchurls?keyword=" +
        encodeURIComponent(${JSON.stringify(keyword)}) +
        "&resultCount=10&siteUrl=" +
        encodeURIComponent(${JSON.stringify(siteUrl)}), { credentials: "include" });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      const limited = ${isLimitedApiResponse.toString()}(text, response.status);
      return {
        limited,
        status: response.status,
        topUrls: limited || !data ? [] : (data.TopUrls || []).map((item) => item.Url).filter(Boolean),
        preview: text.slice(0, 800)
      };
    })()`,
    20000
  );
  if (result.limited) {
    throw new Error(`BING_ACCOUNT_LIMIT: ${result.preview || "topsearchurls limited"}`);
  }
  return result.topUrls || [];
}

export async function detectBingUsageLimit(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const text = clean(document.body?.innerText || "");
      const limited = /quota|daily limit|usage limit|limit reached|too many requests|try again tomorrow|达到.*限制|次数.*限制|稍后再试/i.test(text);
      return {
        limited,
        preview: text.slice(0, 800)
      };
    })()`,
    10000
  ).catch((error) => ({ limited: false, preview: error.message || String(error) }));
}

async function fetchTopSearchUrlsFromApi(cdp, sessionId, { keyword, siteUrl }) {
  if (!keyword || !siteUrl) {
    return { urls: [], skipped: true };
  }
  return evaluate(
    cdp,
    sessionId,
    `(async () => {
      const endpoint = "/webmasters/api/keywordresearch/topsearchurls?keyword=" +
        encodeURIComponent(${JSON.stringify(keyword)}) +
        "&resultCount=10&siteUrl=" +
        encodeURIComponent(${JSON.stringify(siteUrl)});
      const response = await fetch(endpoint, { credentials: "include" });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      const clean = (value) => String(value || "").trim();
      const limited = response.status === 429 ||
        /TooManyRequests|too many requests|quota|daily limit|usage limit|limit reached/i.test(text) ||
        /TooManyRequests|too many requests|quota|daily limit|usage limit|limit reached/i.test(data?.code || data?.message || "");
      if (limited) {
        return {
          limited: true,
          status: response.status,
          preview: clean(text).slice(0, 800)
        };
      }

      const urls = [];
      const walk = (value) => {
        if (typeof value === "string") {
          const textValue = clean(value);
          if (/^https?:\\/\\//i.test(textValue) && !/\\/search\\?/i.test(textValue)) {
            urls.push(textValue);
          }
          return;
        }
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        if (value && typeof value === "object") {
          Object.values(value).forEach(walk);
        }
      };
      walk(data);
      return {
        limited: false,
        status: response.status,
        urls: [...new Set(urls)].slice(0, 10),
        preview: clean(text).slice(0, 800)
      };
    })()`,
    30000
  ).catch((error) => ({ urls: [], error: error.message || String(error) }));
}

export async function extractBingKeywordResearch(cdp, sessionId, {
  keyword = "",
  siteUrl = "",
  capturedTopUrls = [],
  topUrlsResponseSeen = false
} = {}) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const found = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const grid = [...document.querySelectorAll('[role="grid"]')]
          .find((item) => /Top 10 url ranking on this keyword/i.test(item.getAttribute("aria-label") || item.innerText || ""));
        const heading = [...document.querySelectorAll("h1,h2,h3,div,span")]
          .find((el) => clean(el.textContent) === "Top 10 url ranking on this keyword");
        const target = grid || heading;
        if (target) {
          target.scrollIntoView({ block: "center", inline: "center" });
          return true;
        }
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), left: 0, behavior: "instant" });
        return false;
      })()`
    ).catch(() => false);
    if (found) {
      break;
    }
    await sleep(700);
  }
  await sleep(1000);

  const result = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const bodyText = document.body?.innerText || "";

      const findImpressions = () => {
        const labels = [...document.querySelectorAll("div, span, p, label")].filter((el) => clean(el.textContent) === "Impressions");
        for (const label of labels) {
          const card = label.closest(".cardStyle, [class*=card], section, div");
          const h1 = card?.querySelector("h1");
          if (h1 && visible(h1)) return clean(h1.textContent);
          const next = label.nextElementSibling;
          if (next) {
            const value = clean(next.textContent);
            if (/^[0-9,.]+[KMB]?$/i.test(value)) return value;
          }
        }
        const lines = bodyText.split(/\\n+/).map(clean).filter(Boolean);
        const index = lines.findIndex((line) => line === "Impressions");
        if (index >= 0) {
          for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
            if (/^[0-9,.]+[KMB]?$/i.test(lines[next])) return lines[next];
          }
        }
        return "";
      };

      const topUrlGrid = [...document.querySelectorAll('[role="grid"]')]
        .find((grid) => /Top 10 url ranking on this keyword/i.test(grid.getAttribute("aria-label") || grid.innerText || ""));
      const topUrls = topUrlGrid
        ? [...topUrlGrid.querySelectorAll('[role="row"]')]
          .flatMap((row) => {
            const link = row.querySelector("a.secondaryInfo") ||
              [...row.querySelectorAll("a")].find((item) => /^https?:\\/\\//i.test(clean(item.textContent)));
            return link ? [clean(link.textContent) || link.href] : [];
          })
        : [];

      const impressions = findImpressions();
      const noData = /No data available/i.test(bodyText) ||
        (/Global breakdown/i.test(bodyText) && /Country\\s+Impressions/i.test(bodyText) && !impressions);
      return {
        ok: Boolean(impressions) || noData,
        impressions: impressions || (noData ? "0" : ""),
        topUrls,
        url: location.href,
        title: document.title,
        bodyPreview: clean(bodyText).slice(0, 500)
      };
    })()`,
    30000
  );
  if (!result.ok) {
    throw new Error(`无法提取 Bing Keyword Research 初筛数据: ${JSON.stringify(result)}`);
  }
  if (topUrlsResponseSeen) {
    result.topUrls = capturedTopUrls;
  } else if (result.topUrls.length === 0) {
    const apiTopUrls = await fetchTopSearchUrlsFromApi(cdp, sessionId, { keyword, siteUrl });
    if (apiTopUrls.limited) {
      throw new Error(`BING_ACCOUNT_LIMIT: ${apiTopUrls.preview || "topsearchurls too many requests"}`);
    }
    if (apiTopUrls.urls?.length) {
      result.topUrls = apiTopUrls.urls;
    }
  }
  return result;
}

export async function loadAllGlobalBreakdown(cdp, sessionId) {
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const button = [...document.querySelectorAll("button, [role=button]")]
        .find((item) => /Load more/i.test(clean(item.innerText || item.textContent)));
      if (!button) return { clicked: false };
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return { clicked: true };
    })()`
  );
  await sleep(1500);

  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const breakdownHeading = [...document.querySelectorAll("h1,h2,h3,div,span")]
        .find((el) => clean(el.textContent) === "Global breakdown");
      let root = breakdownHeading?.closest(".cardStyle, [class*=card]");
      if (!root || !root.querySelector('[role="row"]')) {
        root = [...document.querySelectorAll('[role="grid"]')]
          .find((grid) => /Global breakdown/i.test(grid.getAttribute("aria-label") || grid.innerText || "")) || document;
      }
      const rows = [...root.querySelectorAll('[role="row"]')]
        .map((row) => {
          const countryCell = row.querySelector('[data-automation-key="Country"]');
          const impressionsCell = row.querySelector('[data-automation-key="Impressions"]');
          const country = clean(countryCell?.innerText || countryCell?.textContent || "");
          const impressions = clean(impressionsCell?.innerText || impressionsCell?.textContent || "");
          return { country, impressions };
        })
        .filter((row) => row.country && row.impressions && !/Country/i.test(row.country));

      if (rows.length > 0) return rows;

      const lines = clean(root.innerText || root.textContent || "").split(/\\n+/).map(clean).filter(Boolean);
      const parsed = [];
      for (let index = 0; index < lines.length - 1; index += 1) {
        if (/^[A-Za-z' .-]+$/.test(lines[index]) && /^[0-9,.]+[KMB]?$/i.test(lines[index + 1])) {
          parsed.push({ country: lines[index], impressions: lines[index + 1] });
          index += 1;
        }
      }
      return parsed;
    })()`,
    30000
  );
}

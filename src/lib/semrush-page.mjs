import zlib from "node:zlib";
import { evaluate, navigateAndWait } from "./cdp.mjs";
import { clickByText, clickSelector, setInputValue, sleep, waitForCondition } from "./browser-actions.mjs";

export async function detectPage(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const text = (el) => (el?.innerText || el?.textContent || "").trim();
      const url = location.href;
      const has = (selector) => Boolean(document.querySelector(selector));
      const pageText = document.body?.innerText || "";

      let kind = "unknown";
      if (url.includes("sem.3ue.com") && /Error code 520|Web server is returning an unknown error/i.test(pageText)) {
        kind = "semrush_error";
      } else if (url.includes("dash.3ue.com") && (url.includes("/login") || has("#input-username"))) {
        kind = "dash_login";
      } else if (url.includes("dash.3ue.com") && (url.includes("/page/m/home") || pageText.includes("SEMRUSH"))) {
        kind = "dash_home";
      } else if (url.includes("sem.3ue.com/analytics/keywordoverview")) {
        kind = "semrush_keyword_overview";
      } else if (url.includes("sem.3ue.com/analytics/keywordmagic")) {
        kind = "semrush_keyword_magic";
      } else if (url.includes("sem.3ue.com")) {
        kind = "semrush_home";
      }

      return {
        kind,
        url,
        query: new URL(url).searchParams.get("q") || "",
        db: new URL(url).searchParams.get("db") || "",
        title: document.title,
        phrase: text(document.querySelector("[data-testid=phrase], .title-wrapper__phrase")),
        searchValue: document.querySelector('[data-test="searchbar_input"]')?.value || ""
      };
    })()`
  );
}

export async function loginDash(cdp, sessionId, username, password) {
  await waitForCondition(cdp, sessionId, "Boolean(document.querySelector('#input-username') && document.querySelector('#input-password'))", 30000);
  await setInputValue(cdp, sessionId, "#input-username", username);
  await setInputValue(cdp, sessionId, "#input-password", password);
  await clickByText(cdp, sessionId, { selector: "button", text: "登录" });
  await sleep(3000);
}

export async function openSemrushFromDash(cdp, sessionId) {
  await waitForCondition(
    cdp,
    sessionId,
    `Boolean([...document.querySelectorAll("button")].find((button) => /打开/.test(button.innerText || button.textContent || "")))`,
    30000
  );
  await clickByText(cdp, sessionId, {
    selector: "button",
    text: "打开",
    includes: true,
    inputClick: true
  });
  await sleep(100);
}

export async function searchSemrush(cdp, sessionId, query) {
  await waitForCondition(cdp, sessionId, "Boolean(document.querySelector('[data-test=\"searchbar_input\"]'))", 45000);
  await setInputValue(cdp, sessionId, '[data-test="searchbar_input"]', query);
  const clicked = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const form = document.querySelector("#srf-global-searchbar form") || document.querySelector('form');
      const button = document.querySelector("#srf-global-searchbar button[aria-label='搜索']") ||
        document.querySelector("#srf-global-searchbar button") ||
        [...document.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") || "").includes("搜索"));
      if (button) {
        button.click();
        return { ok: true, method: "button" };
      }
      if (form) {
        form.requestSubmit ? form.requestSubmit() : form.submit();
        return { ok: true, method: "form" };
      }
      return { ok: false };
    })()`
  );
  if (!clicked.ok) {
    throw new Error("Unable to trigger Semrush search");
  }
  await sleep(8000);
}

export async function searchKeywordMagicInPlace(cdp, sessionId, query) {
  const before = await evaluate(
    cdp,
    sessionId,
    `(() => ({
      phrase: (document.querySelector("[data-testid=phrase], .title-wrapper__phrase")?.innerText || "").trim(),
      url: location.href
    }))()`
  );
  await searchSemrush(cdp, sessionId, query);
  await waitForCondition(
    cdp,
    sessionId,
    `(() => {
      const phrase = (document.querySelector("[data-testid=phrase], .title-wrapper__phrase")?.innerText || "").trim();
      const input = document.querySelector('[data-test="searchbar_input"]')?.value || "";
      const urlQuery = new URL(location.href).searchParams.get("q") || "";
      return phrase.toLowerCase() === ${JSON.stringify(query.toLowerCase())} ||
        input.toLowerCase() === ${JSON.stringify(query.toLowerCase())} ||
        urlQuery.toLowerCase() === ${JSON.stringify(query.toLowerCase())};
    })()`,
    45000
  );
  await waitForCondition(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('#keywords-table [role="row"]')];
      return Boolean(rows.find((row) => row.querySelector('[role="columnheader"]')));
    })()`,
    45000
  ).catch(() => {});
  return { searchedInPlace: true, from: before.phrase || before.url, to: query };
}

const COUNTRY_DATABASE_CODES = {
  美国: "us",
  "United States": "us",
  US: "us",
  USA: "us",
  英国: "uk",
  "United Kingdom": "uk",
  UK: "uk",
  GB: "uk",
  澳大利亚: "au",
  Australia: "au",
  AU: "au",
  德国: "de",
  Germany: "de",
  DE: "de",
  法国: "fr",
  France: "fr",
  FR: "fr",
  西班牙: "es",
  Spain: "es",
  ES: "es",
  中国台湾: "tw",
  台湾: "tw",
  Taiwan: "tw",
  TW: "tw",
  加拿大: "ca",
  Canada: "ca",
  CA: "ca",
  印度: "in",
  India: "in",
  IN: "in",
  日本: "jp",
  Japan: "jp",
  JP: "jp",
  巴西: "br",
  Brazil: "br",
  BR: "br",
  意大利: "it",
  Italy: "it",
  IT: "it",
  荷兰: "nl",
  Netherlands: "nl",
  NL: "nl",
  墨西哥: "mx",
  Mexico: "mx",
  MX: "mx"
};

export function countryDatabaseCode(country) {
  const value = String(country || "").trim();
  if (!value) {
    return "";
  }
  return COUNTRY_DATABASE_CODES[value] || COUNTRY_DATABASE_CODES[value.toUpperCase()] || value.toLowerCase();
}

export async function navigateToKeywordOverview(cdp, sessionId, query, country = "") {
  const databaseCode = countryDatabaseCode(country) || "us";
  const targetUrl = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const current = new URL(location.href);
      const next = new URL("/analytics/keywordoverview/", current.origin);
      next.searchParams.set("q", ${JSON.stringify(query)});
      next.searchParams.set("db", ${JSON.stringify(databaseCode)});
      const gmitm = current.searchParams.get("__gmitm");
      if (gmitm) next.searchParams.set("__gmitm", gmitm);
      return next.toString();
    })()`
  );
  await navigateAndWait(cdp, sessionId, targetUrl, 45000).catch(async () => {
    await sleep(4000);
  });
  await sleep(5000);
}

const KEYWORD_MAGIC_MATCH_TYPES = {
  所有关键词: "all",
  广泛匹配: "broad",
  词组匹配: "phrase",
  完全匹配: "exact",
  相关性: "related"
};

export function buildKeywordMagicUrl(currentUrl, {
  query,
  country = "",
  matchType = "",
  volumeMin = "",
  volumeMax = "",
  kdMin = "",
  kdMax = ""
}) {
  const current = new URL(currentUrl);
  const next = new URL("/analytics/keywordmagic/", current.origin);
  next.searchParams.set("q", query);
  next.searchParams.set("db", countryDatabaseCode(country) || "us");

  const type = KEYWORD_MAGIC_MATCH_TYPES[matchType];
  if (type && type !== "all") {
    next.searchParams.set("type", type);
  }

  const filter = structuredClone(EMPTY_KEYWORD_MAGIC_FILTER);
  filter.volume = buildNumericFilterEntries(volumeMin, volumeMax);
  filter.difficulty = buildNumericFilterEntries(kdMin, kdMax);
  if (filter.volume.length > 0 || filter.difficulty.length > 0) {
    next.searchParams.set("filter", encodeKeywordMagicFilter(filter));
  }

  const gmitm = current.searchParams.get("__gmitm");
  if (gmitm) {
    next.searchParams.set("__gmitm", gmitm);
  }
  return next.toString();
}

export async function navigateToKeywordMagic(cdp, sessionId, task) {
  const currentUrl = await evaluate(cdp, sessionId, "location.href");
  await navigateAndWait(cdp, sessionId, buildKeywordMagicUrl(currentUrl, task), 45000).catch(async () => {
    await sleep(4000);
  });
  await sleep(7000);
}

function keywordMagicApiMode(type) {
  return type === "phrase" ? 1 : null;
}

export function buildKeywordMagicApiPayload(currentUrl, { page = 1, pageSize = 100 } = {}) {
  const url = new URL(currentUrl);
  if (!url.pathname.includes("/analytics/keywordmagic/")) {
    return null;
  }

  const phrase = (url.searchParams.get("q") || "").trim();
  const mode = keywordMagicApiMode(url.searchParams.get("type") || "all");
  if (!phrase || mode === null) {
    return null;
  }

  return {
    id: page,
    jsonrpc: "2.0",
    method: "ideas.GetKeywords",
    params: {
      mode,
      currency: "USD",
      database: url.searchParams.get("db") || "us",
      filter: decodeKeywordMagicFilter(url.searchParams.get("filter") || ""),
      groups: [],
      order: { direction: 1, field: "volume" },
      groups_order: { direction: 1, field: "count" },
      phrase,
      questions_only: false,
      page: { number: page, size: pageSize }
    }
  };
}

function formatKeywordMagicApiVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value || "");
  }
  if (number >= 1000000) {
    return `${(number / 1000000).toFixed(1)}M`;
  }
  if (number >= 1000) {
    return `${(number / 1000).toFixed(1)}K`;
  }
  return String(number);
}

export function keywordMagicApiKeywordsToRows(keywords, context = {}) {
  return (Array.isArray(keywords) ? keywords : [])
    .map((item) => ({
      root: context.root || "",
      source_query: context.query || "",
      keyword: item?.phrase || "",
      volume: formatKeywordMagicApiVolume(item?.volume),
      kd: item?.difficulty === undefined || item?.difficulty === null ? "" : String(item.difficulty),
      semrush_page: Number(context.page || 1)
    }))
    .filter((row) => row.keyword && row.volume && row.kd);
}

export async function fetchKeywordMagicRowsViaPageApi(cdp, sessionId, context) {
  const currentUrl = await evaluate(cdp, sessionId, "location.href");
  const page = Number(context.page || 1);
  const pageSize = Number(context.pageSize || 100);
  const payload = buildKeywordMagicApiPayload(currentUrl, { page, pageSize });
  if (!payload) {
    return { ok: false, reason: "unsupported_keyword_magic_api_url" };
  }

  const apiUrl = new URL("/kmtgw/v2/webapi", currentUrl);
  const gmitm = new URL(currentUrl).searchParams.get("__gmitm");
  if (gmitm) {
    apiUrl.searchParams.set("__gmitm", gmitm);
  }

  const response = await evaluate(
    cdp,
    sessionId,
    `(async () => {
      const response = await fetch(${JSON.stringify(apiUrl.toString())}, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: ${JSON.stringify(JSON.stringify(payload))}
      });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {}
      return { ok: response.ok, status: response.status, data, text: data ? "" : text.slice(0, 500) };
    })()`,
    45000
  );

  if (!response.ok) {
    return { ok: false, reason: `keyword_magic_api_http_${response.status}` };
  }
  const keywords = response.data?.result?.keywords;
  if (!Array.isArray(keywords)) {
    return { ok: false, reason: response.data?.error?.message || "keyword_magic_api_missing_keywords" };
  }

  return {
    ok: true,
    rows: keywordMagicApiKeywordsToRows(keywords, {
      root: context.root,
      query: context.query || payload.params.phrase,
      page
    }),
    pageSize,
    rawKeywordCount: keywords.length,
    pagination: {
      currentPage: page,
      totalPages: null,
      text: "keyword_magic_api"
    }
  };
}

function parseCompactNumberText(value) {
  const normalized = String(value || "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
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

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export async function extractKeywordOverviewMetrics(cdp, sessionId, query) {
  await waitForCondition(
    cdp,
    sessionId,
    `location.href.includes("/analytics/keywordoverview") && (new URL(location.href).searchParams.get("q") || "").toLowerCase() === ${JSON.stringify(query.toLowerCase())}`,
    45000
  );
  await waitForCondition(
    cdp,
    sessionId,
    `document.body && /全球搜索量|关键词难度/.test(document.body.innerText || "")`,
    45000
  );

  const result = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const bodyText = document.body?.innerText || "";
      const lines = bodyText.split(/\\n+/).map(clean).filter(Boolean);
      const compact = "[0-9][0-9,.]*(?:\\\\.[0-9]+)?[KMB]?";
      const findAfterLabel = (label, { exact = false } = {}) => {
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index] === label || (!exact && lines[index].includes(label))) {
            const sameLine = lines[index].match(new RegExp(label + "\\\\s*(" + compact + ")", "i"));
            if (sameLine) return sameLine[1];
            for (let next = index + 1; next < Math.min(lines.length, index + 5); next += 1) {
              const match = lines[next].match(new RegExp("^(" + compact + ")(?:%|$)", "i"));
              if (match) return match[1];
            }
          }
        }
        return "";
      };
      const localVolumeFromTotal = clean(document.querySelector('[data-testid="volume-total"]')?.childNodes?.[0]?.textContent || "");
      const localVolume = localVolumeFromTotal || findAfterLabel("搜索量", { exact: true });
      const globalVolume = findAfterLabel("全球搜索量");
      const kdText = findAfterLabel("关键词难度");
      const queryFromUrl = new URL(location.href).searchParams.get("q") || "";
      return {
        ok: Boolean(globalVolume && kdText),
        queryFromUrl,
        localVolume,
        globalVolume,
        kd: (kdText || "").replace(/%$/, ""),
        title: document.title,
        url: location.href
      };
    })()`
  );

  if (!result.ok) {
    throw new Error(`无法从关键词概览页提取全球搜索量/KD: ${JSON.stringify(result)}`);
  }

  const parsedVolume = parseCompactNumberText(result.globalVolume);
  const parsedLocalVolume = parseCompactNumberText(result.localVolume);
  const parsedKd = parseCompactNumberText(result.kd);
  return {
    keyword: query,
    localVolume: parsedLocalVolume === null ? result.localVolume : formatInteger(parsedLocalVolume),
    globalVolume: parsedVolume === null ? result.globalVolume : formatInteger(parsedVolume),
    kd: parsedKd === null ? result.kd : String(parsedKd),
    url: result.url
  };
}

export async function clickViewAllKeywords(cdp, sessionId) {
  try {
    await waitForCondition(
      cdp,
      sessionId,
      `Boolean([...document.querySelectorAll("a, button, span")].find((el) => /查看全部[\\s\\S]*个关键词/.test(el.innerText || el.textContent || "")))`,
      45000
    );
  } catch (error) {
    const currentUrl = await evaluate(cdp, sessionId, "location.href");
    const url = new URL(currentUrl);
    if (url.hostname === "sem.3ue.com" && url.searchParams.get("q") && url.searchParams.get("db")) {
      url.pathname = "/analytics/keywordmagic/";
      await navigateAndWait(cdp, sessionId, url.toString(), 45000).catch(async () => {
        await sleep(3000);
      });
      return;
    }
    throw error;
  }
  const result = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const candidates = [...document.querySelectorAll("a, button")].filter((el) =>
        /查看全部[\\s\\S]*个关键词/.test(el.innerText || el.textContent || "")
      );
      const el = candidates[0];
      if (!el) return { ok: false };
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return { ok: true, text: clean(el.innerText || el.textContent) };
    })()`
  );
  if (!result.ok) {
    throw new Error("Unable to click 查看全部关键词");
  }
  await sleep(10000);
}

export async function validateMagicPhrase(cdp, sessionId, query) {
  await waitForCondition(
    cdp,
    sessionId,
    `(() => {
      const el = document.querySelector("[data-testid=phrase], .title-wrapper__phrase");
      return el && (el.innerText || el.textContent || "").trim().toLowerCase() === ${JSON.stringify(query.toLowerCase())};
    })()`,
    45000
  );
}

const COUNTRY_ALIASES = {
  美国: ["美国", "United States", "US", "USA", "us"],
  英国: ["英国", "United Kingdom", "UK", "GB", "uk"],
  澳大利亚: ["澳大利亚", "Australia", "AU", "au"],
  德国: ["德国", "Germany", "DE", "de"],
  法国: ["法国", "France", "FR", "fr"],
  西班牙: ["西班牙", "Spain", "ES", "es"],
  中国台湾: ["中国台湾", "台湾", "Taiwan", "TW", "tw"],
  加拿大: ["加拿大", "Canada", "CA", "ca"],
  印度: ["印度", "India", "IN", "in"],
  日本: ["日本", "Japan", "JP", "jp"],
  巴西: ["巴西", "Brazil", "BR", "br"],
  意大利: ["意大利", "Italy", "IT", "it"],
  荷兰: ["荷兰", "Netherlands", "NL", "nl"],
  墨西哥: ["墨西哥", "Mexico", "MX", "mx"]
};

function countryAliases(country) {
  const value = String(country || "").trim();
  if (!value) {
    return [];
  }
  return [...new Set([value, ...(COUNTRY_ALIASES[value] || [])])];
}

export async function ensureKeywordMagicCountry(cdp, sessionId, country) {
  const aliases = countryAliases(country);
  if (aliases.length === 0) {
    return { skipped: true, reason: "no_match_country" };
  }

  const active = await readKeywordMagicCountry(cdp, sessionId, aliases);
  if (active.ok && active.matchesExpected) {
    return {
      alreadySelected: true,
      requested: country,
      currentText: active.currentText,
      currentValue: active.currentValue
    };
  }

  const opened = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const trigger = document.querySelector('[data-testid="database-selector"]') ||
        [...document.querySelectorAll('button[aria-label], button[data-ui-name="Select.Trigger"]')].find((button) =>
          visible(button) && /选择国家|国家|地区/.test(button.getAttribute("aria-label") || button.innerText || button.textContent || "")
        );
      if (!trigger || !visible(trigger)) {
        return { ok: false, reason: "country selector trigger not found" };
      }
      trigger.scrollIntoView({ block: "center", inline: "center" });
      trigger.click();
      return { ok: true };
    })()`
  );
  if (!opened.ok) {
    throw new Error(opened.reason || "Unable to open country selector");
  }

  await sleep(700);

  const selected = await searchAndClickCountryOption(cdp, sessionId, aliases);
  if (!selected.ok) {
    throw new Error(selected.reason || `Unable to select country: ${country}`);
  }

  await sleep(7000);
  const verified = await waitForCondition(
    cdp,
    sessionId,
    `(${keywordMagicCountryReadExpression(aliases)})().matchesExpected`,
    15000
  ).catch((error) => ({ ok: false, reason: error.message }));
  if (!verified.ok) {
    const after = await readKeywordMagicCountry(cdp, sessionId, aliases);
    throw new Error(`匹配国家没有生效: expected ${country}; actual=${after.currentText || after.currentValue || "unknown"}`);
  }

  return {
    selected: country,
    selectedText: selected.text || "",
    currentText: verified.currentText || ""
  };
}

async function readKeywordMagicCountry(cdp, sessionId, aliases) {
  return evaluate(cdp, sessionId, `(${keywordMagicCountryReadExpression(aliases)})()`);
}

function keywordMagicCountryReadExpression(aliases) {
  return `() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const normalize = (value) => clean(value).toLowerCase();
    const expected = ${JSON.stringify(aliases)}.map(normalize);
    const trigger = document.querySelector('[data-testid="database-selector"]') ||
      [...document.querySelectorAll('button[aria-label], button[data-ui-name="Select.Trigger"]')].find((button) =>
        /选择国家|国家|地区/.test(button.getAttribute("aria-label") || button.innerText || button.textContent || "")
      );
    const currentText = clean(trigger?.innerText || trigger?.textContent || "");
    const currentValue = clean(trigger?.getAttribute("value") || "");
    const currentAria = clean(trigger?.getAttribute("aria-label") || "");
    const candidates = [currentText, currentValue, currentAria].map(normalize);
    return {
      ok: Boolean(trigger),
      currentText,
      currentValue,
      currentAria,
      matchesExpected: candidates.some((candidate) =>
        expected.some((item) => candidate === item || candidate.includes(item))
      )
    };
  }`;
}

async function clickCountryOption(cdp, sessionId, aliases) {
  const clicked = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const normalize = (value) => clean(value).toLowerCase();
      const expected = ${JSON.stringify(aliases)}.map(normalize);
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const matches = (el) => {
        const text = normalize(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
        return expected.some((item) => text === item || text.includes(item));
      };
      const candidate = [...document.querySelectorAll('[role="option"], button, [data-ui-name*="Option"], [data-ui-name*="Item"], div')]
        .filter(visible)
        .find(matches);
      if (!candidate) {
        return { ok: false, reason: "country option not visible" };
      }
      const clickable = candidate.closest('[role="option"], button, [data-ui-name*="Option"], [data-ui-name*="Item"]') || candidate;
      clickable.scrollIntoView({ block: "center", inline: "center" });
      clickable.click();
      return { ok: true, text: clean(candidate.innerText || candidate.textContent || "") };
    })()`
  );
  if (clicked.ok) {
    return clicked;
  }

  const searched = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const input = [...document.querySelectorAll('input[placeholder*="搜索"], input[type="text"], input[role="combobox"]')].find(visible);
      if (!input) {
        return { ok: false, reason: "country search input not found" };
      }
      input.focus();
      input.select?.();
      input.value = ${JSON.stringify(aliases[0])};
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(aliases[0])} }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    })()`
  );
  if (!searched.ok) {
    return clicked;
  }

  await sleep(700);
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const normalize = (value) => clean(value).toLowerCase();
      const expected = ${JSON.stringify(aliases)}.map(normalize);
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidate = [...document.querySelectorAll('[role="option"], button, [data-ui-name*="Option"], [data-ui-name*="Item"], div')]
        .filter(visible)
        .find((el) => {
          const text = normalize(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
          return expected.some((item) => text === item || text.includes(item));
        });
      if (!candidate) {
        return { ok: false, reason: "country option not found after search" };
      }
      const clickable = candidate.closest('[role="option"], button, [data-ui-name*="Option"], [data-ui-name*="Item"]') || candidate;
      clickable.scrollIntoView({ block: "center", inline: "center" });
      clickable.click();
      return { ok: true, text: clean(candidate.innerText || candidate.textContent || "") };
    })()`
  );
}

async function searchAndClickCountryOption(cdp, sessionId, aliases) {
  const searched = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const input = [...document.querySelectorAll('input[placeholder*="搜索"], input[type="text"], input[role="combobox"]')].find(visible);
      if (!input) {
        return { ok: false, reason: "country search input not found" };
      }
      input.focus();
      input.select?.();
      input.value = "";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      input.value = ${JSON.stringify(aliases[0])};
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(aliases[0])} }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    })()`
  );

  if (searched.ok) {
    await sleep(1000);
  }

  const clicked = await clickCountryOption(cdp, sessionId, aliases);
  if (clicked.ok) {
    return {
      ...clicked,
      method: searched.ok ? "search_then_click" : "visible_click"
    };
  }
  return clicked;
}

export async function selectMatchType(cdp, sessionId, matchType) {
  if (!matchType) {
    return { skipped: true };
  }
  const allowed = new Set(["所有关键词", "广泛匹配", "词组匹配", "完全匹配", "相关性"]);
  if (!allowed.has(matchType)) {
    throw new Error(`Unsupported 匹配类型: ${matchType}`);
  }
  const active = await verifySelectedMatchType(cdp, sessionId, matchType);
  if (active.ok) {
    return { alreadySelected: matchType };
  }
  await clickByText(cdp, sessionId, {
    selector: '[role="tab"], button',
    text: matchType
  });
  await sleep(5000);
  const verified = await verifySelectedMatchType(cdp, sessionId, matchType);
  if (!verified.ok) {
    throw new Error(`匹配类型没有生效: expected ${matchType}; actual ${verified.actual || "unknown"}`);
  }
  return { selected: matchType };
}

export async function applyRangeFilter(cdp, sessionId, filterLabel, minValue, maxValue) {
  if (!minValue && !maxValue) {
    return { skipped: true };
  }

  const active = await readActiveRangeFilter(cdp, sessionId, filterLabel, minValue, maxValue);
  if (active.ok && active.matchesExpected) {
    return { alreadyApplied: filterLabel, activeText: active.activeText };
  }

  const urlResult = await applyRangeFilterViaUrl(cdp, sessionId, filterLabel, minValue, maxValue);
  if (urlResult.ok) {
    return urlResult;
  }

  await closeOpenPopper(cdp, sessionId);

  const opened = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const aliases = ${JSON.stringify(filterLabel === "KD %" ? ["KD %", "KD"] : [filterLabel])};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const triggers = [...document.querySelectorAll('button[data-ui-name="FilterTrigger.TriggerButton"], button[aria-label]')].filter((el) => {
        if (!visible(el)) return false;
        const actual = clean(el.innerText || el.textContent);
        const placeholder = el.getAttribute("placeholder") || "";
        const aria = el.getAttribute("aria-label") || "";
        return aliases.some((label) =>
          actual === label ||
          actual.startsWith(label + ":") ||
          placeholder === label ||
          aria.includes(label) ||
          (label === "搜索量" && aria.includes("搜索量")) ||
          (label === "KD" && aria.includes("关键词竞争度")) ||
          (label === "KD %" && aria.includes("关键词竞争度"))
        );
      });
      const clickable = triggers[0];
      if (!clickable) return { ok: false, reason: "filter trigger not found", label: aliases.join("/") };
      clickable.scrollIntoView({ block: "center", inline: "center" });
      clickable.click();
      return {
        ok: true,
        triggerId: clickable.id || "",
        popperId: clickable.id ? clickable.id.replace(/-trigger$/, "-popper") : ""
      };
    })()`
  );
  if (!opened.ok) {
    throw new Error(opened.reason || `Unable to open ${filterLabel} filter`);
  }

  const popperReady = await waitForCondition(
    cdp,
    sessionId,
    `(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const popperId = ${JSON.stringify(opened.popperId || "")};
      const byId = popperId ? document.getElementById(popperId) : null;
      const dialog = byId || [...document.querySelectorAll('[role="dialog"], [id$="-popper"]')].filter(visible).find((el) =>
        /从|到|应用|定制范围/.test(el.innerText || el.textContent || "")
      );
      return dialog && visible(dialog) ? { ok: true, popperId: dialog.id || popperId } : false;
    })()`,
    5000
  ).catch((error) => ({ ok: false, reason: error.message }));
  if (!popperReady.ok) {
    throw new Error(`Unable to open ${filterLabel} filter popper: ${popperReady.reason || "not visible"}`);
  }

  const resolvedPopperId = popperReady.popperId || opened.popperId;

  const filled = await fillRangeFilterWithKeyboard(cdp, sessionId, resolvedPopperId, {
    from: minValue || "",
    to: maxValue || ""
  });
  if (!filled.ok) {
    throw new Error(filled.reason || `Unable to fill ${filterLabel} filter`);
  }
  await sleep(800);

  const applied = await clickRangeFilterApply(cdp, sessionId, resolvedPopperId);
  if (!applied.ok) {
    throw new Error(applied.reason || `Unable to apply ${filterLabel} filter`);
  }

  await sleep(7000);
  const verified = await waitForCondition(
    cdp,
    sessionId,
    `(${rangeFilterVerificationExpression(filterLabel, minValue, maxValue)})()`,
    12000
  ).catch((error) => ({ ok: false, reason: error.message }));
  if (!verified.ok) {
    const actual = await readActiveRangeFilter(cdp, sessionId, filterLabel, minValue, maxValue);
    throw new Error(
      `${filterLabel} 筛选没有生效: expected from=${minValue || ""}, to=${maxValue || ""}; actual=${actual.activeText || "not active"}`
    );
  }
  return { applied: filterLabel, minValue, maxValue, activeText: verified.activeText };
}

const EMPTY_KEYWORD_MAGIC_FILTER = {
  competition_level: [],
  cpc: [],
  difficulty: [],
  phrase: [],
  phrase_include_logic: 0,
  results: [],
  serp_features: [{ inverted: false, value: [] }],
  volume: [],
  words_count: []
};

function decodeKeywordMagicFilter(encoded) {
  if (!encoded) {
    return structuredClone(EMPTY_KEYWORD_MAGIC_FILTER);
  }

  try {
    const json = zlib.gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
    return {
      ...structuredClone(EMPTY_KEYWORD_MAGIC_FILTER),
      ...JSON.parse(json)
    };
  } catch {
    return structuredClone(EMPTY_KEYWORD_MAGIC_FILTER);
  }
}

function encodeKeywordMagicFilter(filter) {
  return zlib.gzipSync(JSON.stringify(filter)).toString("base64");
}

function parseFilterNumber(value) {
  const normalized = String(value || "").replace(/,/g, "").trim();
  if (!normalized) {
    return null;
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function buildNumericFilterEntries(minValue, maxValue) {
  const entries = [];
  const min = parseFilterNumber(minValue);
  const max = parseFilterNumber(maxValue);
  if (min !== null) {
    entries.push({ inverted: false, operation: 5, value: min });
  }
  if (max !== null) {
    entries.push({ inverted: false, operation: 4, value: max });
  }
  return entries;
}

async function applyRangeFilterViaUrl(cdp, sessionId, filterLabel, minValue, maxValue) {
  const currentUrl = await evaluate(cdp, sessionId, "location.href");
  if (!currentUrl.includes("/analytics/keywordmagic/")) {
    return { ok: false, reason: "not keyword magic page" };
  }

  const filterKey = filterLabel === "搜索量" ? "volume" : filterLabel === "KD %" ? "difficulty" : "";
  if (!filterKey) {
    return { ok: false, reason: `unsupported URL filter: ${filterLabel}` };
  }

  const url = new URL(currentUrl);
  const filter = decodeKeywordMagicFilter(url.searchParams.get("filter") || "");
  filter[filterKey] = buildNumericFilterEntries(minValue, maxValue);
  url.searchParams.set("filter", encodeKeywordMagicFilter(filter));

  await navigateAndWait(cdp, sessionId, url.toString(), 45000).catch(async () => {
    await sleep(4000);
  });
  await sleep(7000);

  const verified = await waitForCondition(
    cdp,
    sessionId,
    `(${rangeFilterVerificationExpression(filterLabel, minValue, maxValue)})()`,
    15000
  ).catch((error) => ({ ok: false, reason: error.message }));
  if (!verified.ok) {
    return { ok: false, reason: verified.reason || `${filterLabel} URL filter did not verify` };
  }

  return { ok: true, applied: filterLabel, method: "keyword_magic_url_filter", minValue, maxValue, activeText: verified.activeText };
}

async function closeOpenPopper(cdp, sessionId) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27
  }, sessionId).catch(() => {});
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27
  }, sessionId).catch(() => {});
  await sleep(300);
}

async function fillRangeFilterWithKeyboard(cdp, sessionId, popperId, values) {
  const controls = await getRangeFilterControls(cdp, sessionId, popperId);
  if (!controls.ok) {
    return controls;
  }

  await focusRangeInput(cdp, sessionId, popperId, "from");
  await replaceFocusedText(cdp, sessionId, values.from);
  await focusRangeInput(cdp, sessionId, popperId, "to");
  await replaceFocusedText(cdp, sessionId, values.to);

  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const controls = (${rangeFilterControlsExpression(popperId)})();
      return {
        ok: Boolean(controls.ok),
        inputCount: controls.inputCount || 0,
        fromValue: controls.from?.value || "",
        toValue: controls.to?.value || ""
      };
    })()`
  );
}

async function getRangeFilterControls(cdp, sessionId, popperId) {
  return evaluate(cdp, sessionId, `(${rangeFilterControlsExpression(popperId)})()`);
}

async function focusRangeInput(cdp, sessionId, popperId, which) {
  const focused = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const popperId = ${JSON.stringify(popperId || "")};
      const popper = (popperId ? document.getElementById(popperId) : null) ||
        [...document.querySelectorAll('[role="dialog"], [id$="-popper"]')].filter(visible).find((el) =>
          /从|到|应用|定制范围/.test(el.innerText || el.textContent || "")
        );
      if (!popper || !visible(popper)) {
        return { ok: false, reason: "filter popper not found", popperId };
      }
      const selector = ${JSON.stringify(which)} === "from"
        ? 'input[placeholder="从"], input[aria-label="从"]'
        : 'input[placeholder="到"], input[aria-label="到"]';
      const input = [...popper.querySelectorAll(selector)].find(visible);
      if (!input) {
        return { ok: false, reason: ${JSON.stringify(which)} + " input not found" };
      }
      input.focus();
      input.select?.();
      return { ok: document.activeElement === input, value: input.value || "" };
    })()`
  );
  if (!focused.ok) {
    throw new Error(focused.reason || `Unable to focus ${which} range input`);
  }
  return focused;
}

function rangeFilterControlsExpression(popperId) {
  return `() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const center = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        value: el.value || ""
      };
    };
    const popperId = ${JSON.stringify(popperId || "")};
    const popper = (popperId ? document.getElementById(popperId) : null) ||
      [...document.querySelectorAll('[role="dialog"], [id$="-popper"]')].filter(visible).find((el) =>
        /从|到|应用|定制范围/.test(el.innerText || el.textContent || "")
      );
    if (!popper || !visible(popper)) {
      return { ok: false, reason: "filter popper not found", popperId };
    }
    const inputs = [...popper.querySelectorAll('input[placeholder="从"], input[aria-label="从"], input[placeholder="到"], input[aria-label="到"]')].filter(visible);
    const from = inputs.find((input) => input.placeholder === "从" || input.getAttribute("aria-label") === "从");
    const to = inputs.find((input) => input.placeholder === "到" || input.getAttribute("aria-label") === "到");
    const apply = [...popper.querySelectorAll("button")].filter(visible).find((button) => (button.innerText || button.textContent || "").trim() === "应用");
    if (!from || !to) {
      return { ok: false, reason: "range inputs not found", inputCount: inputs.length, popperId };
    }
    return {
      ok: true,
      inputCount: inputs.length,
      from: center(from),
      to: center(to),
      apply: center(apply),
      popperId: popper.id || popperId
    };
  }`;
}

async function replaceFocusedText(cdp, sessionId, text) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8
  }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8
  }, sessionId);
  if (text) {
    await cdp.send("Input.insertText", { text: String(text) }, sessionId);
  }
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const el = document.activeElement;
      el?.dispatchEvent?.(new Event("input", { bubbles: true }));
      el?.dispatchEvent?.(new Event("change", { bubbles: true }));
      return true;
    })()`
  );
}

async function clickRangeFilterApply(cdp, sessionId, popperId) {
  const controls = await getRangeFilterControls(cdp, sessionId, popperId);
  if (!controls.ok) {
    return controls;
  }
  if (!controls.apply) {
    return { ok: false, reason: "apply button not found" };
  }
  await clickPoint(cdp, sessionId, controls.apply);
  return { ok: true };
}

async function clickPoint(cdp, sessionId, point) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y
  }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1
  }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  }, sessionId);
}

async function verifySelectedMatchType(cdp, sessionId, matchType) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const allowed = new Set(["所有关键词", "广泛匹配", "词组匹配", "完全匹配", "相关性"]);
      const tabs = [...document.querySelectorAll('[role="tab"], button')].filter((el) => allowed.has(clean(el.innerText || el.textContent)));
      const selected = tabs.find((el) => el.getAttribute("aria-selected") === "true" || /selected|__selected/.test(el.className || ""));
      const actual = selected ? clean(selected.innerText || selected.textContent) : "";
      return { ok: actual === ${JSON.stringify(matchType)}, actual };
    })()`
  );
}

async function readActiveRangeFilter(cdp, sessionId, filterLabel, minValue, maxValue) {
  return evaluate(cdp, sessionId, `(${rangeFilterReadExpression(filterLabel, minValue, maxValue)})()`);
}

function rangeFilterVerificationExpression(filterLabel, minValue, maxValue) {
  return rangeFilterReadExpression(filterLabel, minValue, maxValue, "return result.ok && result.matchesExpected ? result : false;");
}

function rangeFilterReadExpression(filterLabel, minValue, maxValue, returnStatement = "return result;") {
  return `() => {
    const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
    const compact = (value) => clean(value).toLowerCase().replace(/,/g, "");
    const aliases = ${JSON.stringify(filterLabel === "KD %" ? ["KD %", "KD"] : [filterLabel])};
    const expectedMin = ${JSON.stringify(minValue || "")};
    const expectedMax = ${JSON.stringify(maxValue || "")};
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const activeText = [...document.querySelectorAll('[data-ui-name="FilterTrigger.Text"], button')]
      .filter(visible)
      .map((el) => clean(el.innerText || el.textContent))
      .find((actual) => aliases.some((label) => actual.startsWith(label + ":")));
    const actual = compact(activeText || "");
    const hasExpectedNumber = (value) => {
      if (value === "") return true;
      const numeric = value.replace(/,/g, "");
      if (actual.includes(numeric)) return true;
      if (/000$/.test(numeric)) {
        const k = String(Number(numeric) / 1000);
        if (actual.includes(k + "k")) return true;
      }
      return false;
    };
    const result = {
      ok: Boolean(activeText),
      activeText: activeText || "",
      matchesExpected: Boolean(activeText) && hasExpectedNumber(expectedMin) && hasExpectedNumber(expectedMax)
    };
    ${returnStatement}
  }`;
}

export async function extractKeywordRows(cdp, sessionId, context) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => (value || "").replace(/\\u200b/g, "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const rows = [...document.querySelectorAll('#keywords-table [role="row"]')];
      const header = rows.find((row) => row.querySelector('[role="columnheader"]'));
      const summaryText = clean(document.querySelector("#keywords-table")?.innerText || document.body?.innerText || "");
      const noData = /未能找到与您的请求相关的任何数据|No data|No results/i.test(summaryText);
      if (!header && noData) {
        return {
          ok: true,
          headers: [],
          rows: [],
          pageUrl: location.href,
          signature: "",
          pagination: { currentPage: 1, totalPages: 1, text: "" },
          filteredKeywordCount: 0
        };
      }
      if (!header) return { ok: false, reason: "table header not found", rows: [] };
      const headers = [...header.querySelectorAll('[role="columnheader"]')].map((cell) => clean(cell.innerText || cell.textContent));
      const keywordIndex = headers.indexOf("关键词");
      const volumeIndex = headers.indexOf("搜索量");
      const kdIndex = headers.indexOf("KD");
      const dataRows = rows.filter((row) => row.className.includes("sm-table-layout__row"));
	      const extracted = dataRows.map((row) => {
	        const cells = [...row.querySelectorAll('[role="cell"]')].map((cell) => clean(cell.innerText || cell.textContent));
	        return {
          root: ${JSON.stringify(context.root || "")},
          source_query: ${JSON.stringify(context.query || "")},
          keyword: cells[keywordIndex] || "",
          volume: cells[volumeIndex] || "",
          kd: cells[kdIndex] || "",
	          semrush_page: ${Number(context.page || 1)}
	        };
	      }).filter((row) => row.keyword && row.volume && row.kd);
      const navs = [...document.querySelectorAll("#keywords-table nav")].filter(visible);
      const nav = navs[navs.length - 1] || null;
	      const navText = nav ? clean(nav.innerText || nav.textContent) : "";
      const parseCompactNumber = (value) => {
        const match = clean(value).match(/^([\\d,.]+)\\s*([KMB])?$/i);
        if (!match) return null;
        const number = Number(match[1].replace(/,/g, ""));
        if (!Number.isFinite(number)) return null;
        const suffix = (match[2] || "").toUpperCase();
        const multiplier = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
        return Math.round(number * multiplier);
      };
      const filteredKeywordCount = parseCompactNumber(
        summaryText.match(/所有关键词\\s*[:：]\\s*([\\d,.]+\\s*[KMB]?)/i)?.[1] || ""
      );
	      const currentPage = Number(nav?.querySelector("input")?.value || "");
      const totalPages = Number(
        navText.match(/\\bof\\s+(\\d+)\\b/i)?.[1] ||
        navText.match(/共\\s*(\\d+)\\s*页/)?.[1] ||
        ""
      );
      const ignoredNavText = [...document.querySelectorAll("nav")]
	        .map((nav) => clean(nav.innerText || nav.textContent))
	        .join(" ");

      return {
	        ok: true,
	        headers,
	        rows: extracted,
	        pageUrl: location.href,
        signature: extracted.slice(0, 10).map((row) => [row.keyword, row.volume, row.kd].join("\\t")).join("\\n"),
	        pagination: {
	          currentPage: Number.isFinite(currentPage) && currentPage > 0 ? currentPage : null,
	          totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null,
	          text: navText,
	          allNavText: ignoredNavText
	        },
        filteredKeywordCount: Number.isFinite(filteredKeywordCount) && filteredKeywordCount > 0 ? filteredKeywordCount : null
	      };
	    })()`
  );
}

export async function ensureFirstKeywordMagicPage(cdp, sessionId) {
  const targetUrl = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const url = new URL(location.href);
      if (!url.pathname.includes("/analytics/keywordmagic/")) return "";
      if (!url.searchParams.has("page")) return "";
      url.searchParams.delete("page");
      return url.toString();
    })()`
  );
  if (targetUrl) {
    await navigateAndWait(cdp, sessionId, targetUrl, 45000).catch(async () => {
      await sleep(4000);
    });
    await sleep(3000);
  }
}

export async function clickNextPage(cdp, sessionId) {
  const before = await keywordMagicTableState(cdp, sessionId);
  if (before.pagination?.totalPages && before.pagination.currentPage >= before.pagination.totalPages) {
    return false;
  }
  const result = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const navs = [...document.querySelectorAll("#keywords-table nav")].filter(visible);
      const nav = navs[navs.length - 1];
      if (!nav) return { ok: false, hasNext: false, reason: "pagination nav not found" };
      const button = [...nav.querySelectorAll("button")].filter(visible).find((item) => (item.innerText || item.textContent || "").trim() === "Next" || item.getAttribute("data-ui-name") === "Pagination.NextPage");
      if (!button) return { ok: false, hasNext: false, reason: "next not found" };
      const disabled = button.disabled ||
        button.getAttribute("aria-disabled") === "true" ||
        button.className.includes("disabled") ||
        button.className.includes("_disabled") ||
        getComputedStyle(button).pointerEvents === "none";
      if (disabled) return { ok: true, hasNext: false, reason: "next disabled" };
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return { ok: true, hasNext: true };
    })()`
  );
  if (!result.ok) {
    return false;
  }
  if (!result.hasNext) {
    return false;
  }
  await waitForCondition(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => (value || "").replace(/\\u200b/g, "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const rows = [...document.querySelectorAll('#keywords-table [role="row"]')];
      const header = rows.find((row) => row.querySelector('[role="columnheader"]'));
      const headers = header ? [...header.querySelectorAll('[role="columnheader"]')].map((cell) => clean(cell.innerText || cell.textContent)) : [];
      const keywordIndex = headers.indexOf("关键词");
      const volumeIndex = headers.indexOf("搜索量");
      const kdIndex = headers.indexOf("KD");
      const dataRows = rows.filter((row) => row.className.includes("sm-table-layout__row"));
      const signature = dataRows.slice(0, 10).map((row) => {
        const cells = [...row.querySelectorAll('[role="cell"]')].map((cell) => clean(cell.innerText || cell.textContent));
        return [cells[keywordIndex] || "", cells[volumeIndex] || "", cells[kdIndex] || ""].join("\\t");
      }).join("\\n");
      return signature && signature !== ${JSON.stringify(before.signature)};
    })()`,
    20000
  ).catch(() => false);
  await sleep(1000);
  const after = await keywordMagicTableState(cdp, sessionId);
  return Boolean(after.signature && after.signature !== before.signature);
}

async function keywordMagicTableState(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const clean = (value) => (value || "").replace(/\\u200b/g, "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const rows = [...document.querySelectorAll('#keywords-table [role="row"]')];
      const header = rows.find((row) => row.querySelector('[role="columnheader"]'));
      const headers = header ? [...header.querySelectorAll('[role="columnheader"]')].map((cell) => clean(cell.innerText || cell.textContent)) : [];
      const keywordIndex = headers.indexOf("关键词");
      const volumeIndex = headers.indexOf("搜索量");
      const kdIndex = headers.indexOf("KD");
      const dataRows = rows.filter((row) => row.className.includes("sm-table-layout__row"));
      const signature = dataRows.slice(0, 10).map((row) => {
        const cells = [...row.querySelectorAll('[role="cell"]')].map((cell) => clean(cell.innerText || cell.textContent));
        return [cells[keywordIndex] || "", cells[volumeIndex] || "", cells[kdIndex] || ""].join("\\t");
      }).join("\\n");
      const navs = [...document.querySelectorAll("#keywords-table nav")].filter(visible);
      const nav = navs[navs.length - 1] || null;
      const navText = nav ? clean(nav.innerText || nav.textContent) : "";
      const currentPage = Number(nav?.querySelector("input")?.value || "");
      const totalPages = Number(
        navText.match(/\\bof\\s+(\\d+)\\b/i)?.[1] ||
        navText.match(/共\\s*(\\d+)\\s*页/)?.[1] ||
        ""
      );
      return {
        pageUrl: location.href,
        signature,
        pagination: {
          currentPage: Number.isFinite(currentPage) && currentPage > 0 ? currentPage : null,
          totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null,
          text: navText
        }
      };
    })()`
  );
}

export async function closeSemrushCoachmark(cdp, sessionId) {
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const buttons = [...document.querySelectorAll("button")];
      const gotIt = buttons.find((button) => /明白了|稍后提醒我|关闭/.test(button.innerText || button.textContent || button.getAttribute("aria-label") || ""));
      if (gotIt) gotIt.click();
      const close = [...document.querySelectorAll('[aria-label="关闭"], [aria-label="Close"], button')].find((el) => /关闭|Close|×/.test(el.getAttribute("aria-label") || el.innerText || el.textContent || ""));
      if (close) close.click();
      return true;
    })()`
  ).catch(() => {});
}

#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  CdpClient,
  createChromePage,
  detachChromePage,
  evaluate,
  navigateAndWait,
  readDebuggerEndpointFromPort
} from "./lib/cdp.mjs";
import { sleep } from "./lib/browser-actions.mjs";
import { runBingWebmasterAuthFlow } from "./lib/bing-webmaster-auth.mjs";
import { searchBingKeyword, waitForBingKeywordResearchReady } from "./lib/bing-page.mjs";
import {
  classifyTopSearchResults,
  evaluateSerpOpportunity,
  formatInteger
} from "./lib/bing-precheck.mjs";
import { readArg, readFlag } from "./lib/args.mjs";
import { readFeishuBingRegistry } from "./lib/feishu-registry.mjs";
import {
  cacheHubstudioBrowserSession,
  evaluateHubstudioProxyDirectGuard,
  extractIpAddress,
  findHubstudioEnvironmentBySerialNumber,
  forgetHubstudioBrowserSession,
  hasHubstudioApiProxyConfig,
  isHubstudioStartPendingMessage,
  readPublicIp,
  readCachedHubstudioBrowserSession,
  readHubstudioConfig,
  resolveHubstudioProxyRegion,
  startHubstudioBrowser,
  stopHubstudioBrowser,
  updateHubstudioApiProxy,
  waitForHubstudioDebuggerEndpoint
} from "./lib/hubstudio-api.mjs";
import { formatCellBackgrounds, getSheetValues, updateSheetValues } from "./lib/google-sheets-api.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import {
  KEYWORD_TOTAL_SHEET,
  keywordTotalReadRange
} from "./lib/sheet-write.mjs";
import { columnName, headerIndex, optionalHeaderIndex, valuesToTable } from "./lib/table-utils.mjs";
import { writeJson } from "./lib/files.mjs";
import { readHubstudioFingerprintCache } from "./lib/hubstudio-api.mjs";

const BING_WEBMASTER_HOME_URL = "https://www.bing.com/webmasters/";
const BING_KEYWORD_RESEARCH_ENTRY_URL = "https://www.bing.com/webmasters/keywordresearch";

function isBingAccountLimitMessage(message) {
  return /BING_ACCOUNT_LIMIT|TooManyRequests|too many requests|quota|daily limit|usage limit|limit reached/i.test(
    String(message || "")
  );
}

function isRecoverablePageMessage(message) {
  return /BING_HOME_CHROME_ERROR|BING_KEYWORD_INPUT_NOT_FOUND|Hubstudio Local API 超时|Hubstudio Local API 连接失败|Hubstudio 序号 .*没有找到.*total=0|startBrowser.*未执行结束|has not yet finished executing|数据获取失败|过于频繁|Timed out waiting for condition|Timed out while loading|Session with given id not found|Target closed|Cannot find context|Execution context was destroyed/i.test(
    String(message || "")
  );
}

function isBingTopUrlsEmptyMessage(message) {
  return /BING_TOP_URLS_EMPTY/i.test(String(message || ""));
}

async function readRequiredSheet(sheetUrl, range) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await getSheetValues({ sheetUrl, range });
      if (result.ok) {
        return valuesToTable(result.values || []);
      }
      lastError = new Error(`读取 ${range} 失败: ${result.reason || "unknown error"}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await sleep(1500 * attempt);
    }
  }
  throw lastError || new Error(`读取 ${range} 失败`);
}

function readCachedHubstudioFingerprints({ startFingerprintName = "", limit = 0 } = {}) {
  const cache = readHubstudioFingerprintCache();
  const rows = Object.values(cache.fingerprints || {})
    .map((fingerprint) => {
      const serialNumber = Number(fingerprint.serialNumber);
      if (!Number.isFinite(serialNumber) || serialNumber <= 0 || !fingerprint.containerCode) {
        return null;
      }
      return {
        rowNumber: serialNumber,
        fingerprintName: String(serialNumber),
        serialNumber,
        containerCode: String(fingerprint.containerCode),
        containerName: String(fingerprint.containerName || ""),
        coreVersion: fingerprint.coreVersion ?? null,
        region: "",
        email: "",
        password: "",
        recoverEmail: "",
        fallbackPassword: ""
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.serialNumber - b.serialNumber);

  const start = String(startFingerprintName || "").trim();
  const startIndex = start
    ? rows.findIndex((row) => String(row.fingerprintName || "").trim() === start)
    : 0;
  if (start && startIndex === -1) {
    throw new Error(`本地 Hubstudio 缓存中没有找到指纹名称: ${start}`);
  }
  const selected = rows.slice(start ? startIndex : 0);
  return limit > 0 ? selected.slice(0, limit) : selected;
}

async function readHubstudioFingerprintsWithFallback({ startFingerprintName = "", fingerprintLimit = 0 } = {}) {
  try {
    return await readFeishuBingRegistry({
      startFingerprintName,
      limit: fingerprintLimit,
      requireBingApi: true
    });
  } catch (error) {
    console.warn(`Feishu Hubstudio registry unavailable, fallback to local cache: ${error.message || String(error)}`);
    const cached = readCachedHubstudioFingerprints({
      startFingerprintName,
      limit: fingerprintLimit
    });
    if (cached.length === 0) {
      throw error;
    }
    return cached;
  }
}

function selectRows(keywordTable, { fromRow, toRow, force }) {
  const keywordIndex = headerIndex(keywordTable.headers, "关键词", KEYWORD_TOTAL_SHEET);
  const prefilterIndex = headerIndex(keywordTable.headers, "agent预判断", KEYWORD_TOTAL_SHEET);
  const bingFirstIndex = headerIndex(keywordTable.headers, "bing初步判断", KEYWORD_TOTAL_SHEET);
  const serpOpportunityIndex = optionalHeaderIndex(keywordTable.headers, "SERP机会判断");
  const selected = [];
  for (const row of keywordTable.rows) {
    if (fromRow && row.rowNumber < fromRow) continue;
    if (toRow && row.rowNumber > toRow) break;
    const keyword = String(row.values[keywordIndex] || "").trim();
    if (!keyword && !toRow) break;
    if (!keyword) continue;
    const prefilter = String(row.values[prefilterIndex] || "").trim();
    const bingFirst = String(row.values[bingFirstIndex] || "").trim();
    const serpOpportunity = serpOpportunityIndex === -1 ? "" : String(row.values[serpOpportunityIndex] || "").trim();
    if (prefilter !== "继续" || bingFirst !== "继续") continue;
    if (serpOpportunity && !force) continue;
    selected.push(row);
  }
  return selected;
}

function buildChromeValues(headers, keywordRow, precheck, competition) {
  const values = [...keywordRow.values];
  const set = (header, value, { required = false } = {}) => {
    const index = required
      ? headerIndex(headers, header, KEYWORD_TOTAL_SHEET)
      : optionalHeaderIndex(headers, header);
    if (index !== -1) {
      values[index] = value;
    }
  };
  set("SERP机会判断", precheck.judgement, { required: true });
  set("top10大平台数", String(competition.platformCount));
  set("top10独立站数", String(competition.independentSiteCount));
  set("疑似低权重独立站", competition.suspiciousLowAuthorityIndependentSite);
  set("SERP格局", precheck.pattern);
  return values;
}

async function writeKeywordTotalRow({ sheetUrl, rowNumber, headers, values }) {
  const endColumn = columnName(Math.max(headers.length, values.length) - 1);
  const result = await updateSheetValues({
    sheetUrl,
    range: `${KEYWORD_TOTAL_SHEET}!A${rowNumber}:${endColumn}${rowNumber}`,
    values: [values.slice(0, Math.max(headers.length, values.length))]
  });
  if (!result.ok) {
    throw new Error(`写入 ${KEYWORD_TOTAL_SHEET} 第 ${rowNumber} 行失败: ${result.reason || "unknown error"}`);
  }
  return result;
}

async function maximizeChromeWindow(cdp, targetId) {
  if (!targetId) return false;
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
    if (!windowId) return false;
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "maximized" }
    });
    await sleep(1000);
    return true;
  } catch {
    return false;
  }
}

async function extractTop10UrlsFromBingDom(cdp, sessionId) {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const result = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const usableUrl = (url) => {
          try {
            const parsed = new URL(url);
            return /^https?:$/i.test(parsed.protocol) &&
              !/(^|\\.)(bing|microsoft)\\.com$/i.test(parsed.hostname) &&
              !/\\/search\\?/i.test(parsed.pathname + parsed.search);
          } catch {
            return false;
          }
        };
        const linkValue = (link) => clean(link.textContent) || link.href;
        const text = document.body?.innerText || "";
        const heading = [...document.querySelectorAll("h1,h2,h3,div,span")]
          .find((el) => clean(el.textContent) === "Top 10 url ranking on this keyword");
        const grid = [...document.querySelectorAll('[role="grid"]')]
          .find((item) => /Top 10 url ranking on this keyword/i.test(item.getAttribute("aria-label") || item.innerText || ""));
        const headingTop = heading?.getBoundingClientRect?.().top ?? -1;
        let root = grid || null;
        if (!root && heading) {
          root = [...document.querySelectorAll(".cardStyle, [class*=card], section, [role=grid], div")]
            .find((candidate) => {
              const rect = candidate.getBoundingClientRect();
              return rect.top >= headingTop - 8 &&
                candidate.querySelectorAll("a").length > 0 &&
                /https?:\\/\\//i.test(candidate.innerText || candidate.textContent || "");
            });
        }
        let urls = root
          ? [...root.querySelectorAll('[role="row"], a.secondaryInfo, a[href]')]
            .flatMap((item) => {
              if (item.matches?.("a.secondaryInfo")) return [linkValue(item)];
              const link = item.querySelector?.("a.secondaryInfo") ||
                [...(item.querySelectorAll?.("a[href]") || [])].find((candidate) => usableUrl(linkValue(candidate)));
              return link ? [linkValue(link)] : [];
            })
            .filter(usableUrl)
          : [];
        if (urls.length === 0 && heading) {
          urls = [...document.querySelectorAll("a.secondaryInfo, a[href]")]
            .filter((link) => {
              const rect = link.getBoundingClientRect();
              return rect.top >= headingTop - 8 && usableUrl(linkValue(link));
            })
            .map(linkValue);
        }
        if (urls.length > 0) {
          return { urls: [...new Set(urls)].slice(0, 10), foundHeading: true };
        }

        const scrollTargets = [
          document.querySelector("#content"),
          document.querySelector(".mainContainer"),
          document.scrollingElement,
          document.documentElement,
          document.body
        ].filter(Boolean);
        for (const target of scrollTargets) {
          target.scrollTop = Math.min(target.scrollTop + Math.floor(window.innerHeight * 0.75), target.scrollHeight);
        }
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.75), left: 0, behavior: "instant" });
        return {
          urls: [],
          foundHeading: Boolean(heading || grid),
          preview: clean(text).slice(-1000)
        };
      })()`,
      20000
    ).catch((error) => ({ urls: [], error: error.message || String(error) }));
    if (result.urls?.length) {
      return result.urls;
    }
    await sleep(900);
  }
  return [];
}

async function openBingKeywordResearchFromHome(cdp, sessionId, { maxChromeErrors = 3 } = {}) {
  let chromeErrorCount = 0;
  let homeClicked = false;
  await navigateAndWait(cdp, sessionId, BING_WEBMASTER_HOME_URL, 60000).catch(async () => {
    await sleep(5000);
  });
  for (let attempt = 1; attempt <= 18; attempt += 1) {
    const state = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const currentUrl = location.href;
        if (/\\/webmasters\\/keywordresearch/i.test(currentUrl)) {
          const siteUrl = new URL(currentUrl).searchParams.get("siteUrl") || "";
          if (siteUrl) {
            return { ok: true, url: currentUrl, siteUrl };
          }
        }
        const links = [...document.querySelectorAll('a[href]')];
        const discoveredSiteUrl = links
          .map((link) => {
            try {
              return new URL(link.getAttribute("href") || link.href || "", location.origin).searchParams.get("siteUrl") || "";
            } catch {
              return "";
            }
          })
          .find(Boolean) || "";
        return {
          url: currentUrl,
          siteUrl: new URL(currentUrl).searchParams.get("siteUrl") || "",
          discoveredSiteUrl,
          text: clean(document.body?.innerText || "").slice(0, 800)
        };
      })()`,
      15000
    );
    if (state.ok && state.siteUrl) {
      await waitForBingKeywordResearchReady(cdp, sessionId);
      return state.siteUrl;
    }
    if (/^chrome-error:\/\//i.test(state.url || "")) {
      chromeErrorCount += 1;
      if (chromeErrorCount >= maxChromeErrors) {
        const error = new Error(`BING_HOME_CHROME_ERROR: ${state.text || state.url || "chrome-error"}`);
        error.name = "BingHomeChromeError";
        throw error;
      }
      await navigateAndWait(cdp, sessionId, BING_WEBMASTER_HOME_URL, 60000).catch(async () => {
        await sleep(5000);
      });
      continue;
    }

    if (state.discoveredSiteUrl) {
      const target = new URL(BING_KEYWORD_RESEARCH_ENTRY_URL);
      target.searchParams.set("siteUrl", state.discoveredSiteUrl);
      await navigateAndWait(cdp, sessionId, target.toString(), 60000).catch(async () => {
        await sleep(5000);
      });
      continue;
    }

    if (!homeClicked) {
      const clickedHome = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
          const xpathHome = document.evaluate(
            '//*[@id="root"]/div/div/div[1]/div/div[2]/ul/li[1]/div/a/div',
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          const xpathLink = xpathHome?.closest?.("a");
          if (xpathLink) {
            xpathLink.click();
            return { clicked: true, by: "xpath", href: xpathLink.href || xpathLink.getAttribute("href") || "", text: clean(xpathLink.textContent) };
          }
          const links = [...document.querySelectorAll('a[href]')];
          const homeLink = links.find((link) => {
            const text = clean(link.textContent);
            const href = link.getAttribute("href") || link.href || "";
            return /Home\\s*Home|^Home$/i.test(text.replace(/^[^A-Za-z]+/, "")) ||
              /\\/webmasters\\/(home)?\\?siteUrl=/i.test(href);
          });
          if (!homeLink) {
            return { clicked: false, reason: "home_not_found", url: location.href, text: clean(document.body?.innerText || "").slice(0, 800) };
          }
          homeLink.click();
          return { clicked: true, href: homeLink.href || homeLink.getAttribute("href") || "", text: clean(homeLink.textContent) };
        })()`,
        15000
      );
      if (clickedHome.clicked) {
        homeClicked = true;
        await sleep(5000);
        continue;
      }
    }

    const clickedKeywordResearch = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const links = [...document.querySelectorAll('a[href]')];
        const withSite = links.find((link) => /\\/webmasters\\/keywordresearch\\?siteUrl=/i.test(link.getAttribute("href") || link.href || ""));
        const byText = links.find((link) => /Keyword Research\\s*Keyword Research|^Keyword Research$/i.test(clean(link.textContent).replace(/^[^A-Za-z]+/, "")));
        const link = withSite || byText;
        if (!link) {
          return { clicked: false, reason: "keyword_research_not_found", url: location.href, text: clean(document.body?.innerText || "").slice(0, 800) };
        }
        link.click();
        return { clicked: true, href: link.href || link.getAttribute("href") || "", text: clean(link.textContent) };
      })()`,
      15000
    );
    if (clickedKeywordResearch.clicked) {
      await sleep(5000);
    } else {
      await sleep(3000);
    }
    const afterClick = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const currentUrl = location.href;
        const ready = /\\/webmasters\\/keywordresearch/i.test(currentUrl);
        const siteUrl = ready ? new URL(currentUrl).searchParams.get("siteUrl") || "" : "";
        return { url: currentUrl, siteUrl, ready };
      })()`,
      10000
    ).catch(() => ({ siteUrl: "" }));
    if (afterClick.siteUrl) {
      await waitForBingKeywordResearchReady(cdp, sessionId);
      return afterClick.siteUrl;
    }
  }
  const debugState = await evaluate(
    cdp,
    sessionId,
    `(() => ({
      url: location.href,
      title: document.title,
      text: String(document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 1000)
    }))()`,
    10000
  ).catch(() => ({}));
  throw new Error(`无法从 Bing Webmaster 首页进入带 siteUrl 的 Keyword Research: ${JSON.stringify(debugState)}`);
}

async function startFingerprintSession({
  hubConfig,
  fingerprint,
  bingAuthMode = "auto",
  proxyUpdateMode = "off",
  proxyRegion = "",
  hostPublicIp = ""
}) {
  console.log(`  find Hubstudio env serial ${fingerprint.serialNumber || fingerprint.fingerprintName}`);
  const env = await findHubstudioEnvironmentBySerialNumber({
    config: hubConfig,
    serialNumber: fingerprint.serialNumber || fingerprint.fingerprintName
  });
  const switchMaxAttempts = Number(hubConfig.proxy?.directGuardSwitchMaxAttempts || 3);
  let lastGuard = null;
  for (let proxyAttempt = 1; proxyAttempt <= switchMaxAttempts; proxyAttempt += 1) {
    const proxyState = await prepareHubstudioProxyBeforeStart({
      hubConfig,
      env,
      fingerprint,
      proxyUpdateMode,
      proxyRegion
    });
    const started = await startHubstudioBrowserWithRecovery({
      hubConfig,
      env,
      fingerprint,
      allowSessionReuse: !proxyState.updated
    });
    const endpoint = started.endpoint;
    if (!endpoint) {
      throw new Error(`Hubstudio 指纹 ${fingerprint.fingerprintName} 已启动，但无法读取 CDP endpoint: ${started.debuggingPort}`);
    }
    console.log("  connect Chrome CDP");
    const cdp = new CdpClient(endpoint);
    await cdp.connect();
    console.log("  create and maximize page");
    const page = await createChromePage(cdp, "about:blank");
    await maximizeChromeWindow(cdp, page.targetId);

    const session = { env, started, cdp, page, proxyRegion: proxyState.region || "" };
    const guard = await verifyHubstudioProxyNotDirect({
      hubConfig,
      session,
      hostPublicIp
    });
    lastGuard = guard;
    if (guard.ok) {
      console.log(`  ${guard.message}`);
      console.log("  open Bing Webmaster Keyword Research");
      let activeSiteUrl = "";
      try {
        activeSiteUrl = await openBingKeywordResearchFromHome(cdp, page.sessionId);
      } catch (error) {
        const originalMessage = error.message || String(error);
        const shouldTryAuth = String(bingAuthMode || "auto").toLowerCase() !== "off" &&
          String(bingAuthMode || "auto").toLowerCase() !== "false" &&
          fingerprint.email &&
          fingerprint.password;
        if (!shouldTryAuth) {
          throw error;
        }
        console.warn(`  Keyword Research unavailable; try Bing Webmaster auth fallback: ${originalMessage}`);
        const authResult = await runBingWebmasterAuthFlow(cdp, page.sessionId, {
          email: fingerprint.email,
          password: fingerprint.password,
          recoverEmail: fingerprint.recoverEmail,
          fallbackPassword: fingerprint.fallbackPassword
        });
        if (!authResult.ok) {
          throw new Error(`${originalMessage}; Bing auth fallback failed: ${authResult.reason}`);
        }
        console.log("  Bing Webmaster auth fallback succeeded; reopen Keyword Research");
        activeSiteUrl = await openBingKeywordResearchFromHome(cdp, page.sessionId);
      }
      console.log(`  active siteUrl: ${activeSiteUrl}`);
      return { ...session, activeSiteUrl };
    }

    console.warn(`  ${guard.message}`);
    if (!guard.shouldSwitch || proxyAttempt >= switchMaxAttempts) {
      await closeAndStopFingerprintSession(session, hubConfig);
      throw new Error(guard.message);
    }
    console.warn(`  suspected direct connection; re-extract proxy and reopen (${proxyAttempt}/${switchMaxAttempts})`);
    await closeAndStopFingerprintSession(session, hubConfig);
    await sleep(5000);
  }
  throw new Error(lastGuard?.message || "Hubstudio 代理直连检测失败");
}

async function startHubstudioBrowserWithRecovery({
  hubConfig,
  env,
  fingerprint,
  startAttempts = 3,
  allowSessionReuse = true
}) {
  const cached = allowSessionReuse ? readCachedHubstudioBrowserSession(env.containerCode) : null;
  if (cached) {
    const cachedEndpoint = await waitForHubstudioDebuggerEndpoint({
      debuggingPort: cached.debuggingPort,
      timeoutMs: 3000,
      intervalMs: 500,
      readEndpoint: readDebuggerEndpointFromPort
    });
    if (cachedEndpoint) {
      console.log(`  reuse Hubstudio browser ${env.serialNumber}:${env.containerName || env.containerCode}, port=${cached.debuggingPort}`);
      return {
        raw: {},
        browser: {},
        debuggingPort: cached.debuggingPort,
        endpoint: cachedEndpoint,
        reused: true
      };
    }
    forgetHubstudioBrowserSession(env.containerCode);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
    try {
      console.log(`  start Hubstudio browser ${env.serialNumber}:${env.containerName || env.containerCode} (${attempt}/${startAttempts})`);
      const started = await startHubstudioBrowser({
        config: hubConfig,
        containerCode: env.containerCode,
        isHeadless: false,
        timeoutMs: 30000
      });
      console.log(`  Hubstudio debugging port: ${started.debuggingPort || "empty"}`);
      const endpoint = await waitForHubstudioDebuggerEndpoint({
        debuggingPort: started.debuggingPort,
        timeoutMs: 30000,
        intervalMs: 1000,
        readEndpoint: readDebuggerEndpointFromPort
      });
      if (!endpoint) {
        throw new Error(`Hubstudio 指纹 ${fingerprint.fingerprintName} 已启动，但 CDP 端口未就绪: ${started.debuggingPort}`);
      }
      cacheHubstudioBrowserSession({
        serialNumber: env.serialNumber,
        containerCode: env.containerCode,
        debuggingPort: started.debuggingPort
      });
      return { ...started, endpoint, reused: false };
    } catch (error) {
      lastError = error;
      const message = error.message || String(error);
      console.warn(`  Hubstudio browser start failed ${attempt}/${startAttempts}: ${message}`);
      if (isHubstudioStartPendingMessage(message)) {
        console.warn(`  startBrowser pending; stop fingerprint ${env.serialNumber} and wait 20s`);
        await stopHubstudioBrowser({ config: hubConfig, containerCode: env.containerCode, timeoutMs: 10000 }).catch((stopError) => {
          console.warn(`  stop pending fingerprint failed: ${stopError.message || String(stopError)}`);
        });
        forgetHubstudioBrowserSession(env.containerCode);
        await sleep(20000);
        continue;
      }
      if (/Hubstudio Local API 超时|数据获取失败|过于频繁/i.test(message)) {
        await sleep(/数据获取失败|过于频繁/i.test(message) ? 30000 : 10000);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function prepareHubstudioProxyBeforeStart({
  hubConfig,
  env,
  fingerprint,
  proxyUpdateMode = "auto",
  proxyRegion
}) {
  const mode = String(proxyUpdateMode || "auto").toLowerCase();
  if (mode === "off" || mode === "false" || mode === "0") {
    return { updated: false, region: "" };
  }
  const configured = hasHubstudioApiProxyConfig(hubConfig);
  if (!configured) {
    if (mode === "on" || mode === "true" || mode === "1") {
      throw new Error("已要求更新 Hubstudio API 提取代理，但当前没有代理配置");
    }
    console.warn("  Hubstudio API proxy config not found; skip proxy update before opening fingerprint");
    return { updated: false, region: "" };
  }
  const region = proxyRegion || hubConfig.proxy?.regions?.[0] || "us-east-1";
  console.log(`  update Hubstudio API proxy ${env.serialNumber}:${env.containerName || env.containerCode}, region=${region}`);
  await stopHubstudioBrowser({ config: hubConfig, containerCode: env.containerCode, timeoutMs: 10000 }).catch((error) => {
    console.warn(`  stop before proxy update skipped: ${error.message || String(error)}`);
  });
  forgetHubstudioBrowserSession(env.containerCode);
  await updateHubstudioApiProxy({
    config: hubConfig,
    containerCode: env.containerCode,
    containerName: env.containerName,
    region,
    timeoutMs: 30000
  });
  await sleep(3000);
  return { updated: true, region };
}

async function verifyHubstudioProxyNotDirect({
  hubConfig,
  session,
  hostPublicIp
}) {
  if (hubConfig.proxy?.directGuardEnabled === false) {
    return { ok: true, shouldSwitch: false, message: "代理直连保护已关闭" };
  }
  const browserIp = await readBrowserPublicIp({
    cdp: session.cdp,
    sessionId: session.page.sessionId,
    ipCheckUrl: hubConfig.proxy?.ipCheckUrl,
    timeoutMs: hubConfig.proxy?.ipCheckTimeoutMs
  }).catch(() => "");
  return evaluateHubstudioProxyDirectGuard({
    hostIp: hostPublicIp,
    browserIp
  });
}

async function readBrowserPublicIp({
  cdp,
  sessionId,
  ipCheckUrl = "https://api.ipify.org?format=json",
  timeoutMs = 12000
}) {
  await navigateAndWait(cdp, sessionId, ipCheckUrl, timeoutMs);
  const bodyText = await evaluate(
    cdp,
    sessionId,
    `document.body ? document.body.innerText : ""`,
    timeoutMs
  );
  return extractIpAddress(bodyText);
}

async function startFingerprintSessionWithRetry({
  hubConfig,
  fingerprint,
  attempts = 3,
  bingAuthMode = "auto",
  proxyUpdateMode = "off",
  proxyRegion = "",
  hostPublicIp = ""
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await startFingerprintSession({
        hubConfig,
        fingerprint,
        bingAuthMode,
        proxyUpdateMode,
        proxyRegion,
        hostPublicIp
      });
    } catch (error) {
      lastError = error;
      const message = error.message || String(error);
      if (!isRecoverablePageMessage(message) || attempt >= attempts) {
        throw error;
      }
      console.warn(
        `Start fingerprint ${fingerprint.fingerprintName} failed ${attempt}/${attempts}: ${message}; reopen same fingerprint`
      );
      await sleep(/数据获取失败|过于频繁/i.test(message) ? 30000 : 5000);
    }
  }
  throw lastError;
}

async function closeFingerprintSession(session) {
  if (!session) return;
  if (session.page?.targetId) {
    await session.cdp.send("Target.closeTarget", { targetId: session.page.targetId }).catch(() => {});
  }
  if (session.page?.sessionId) {
    await detachChromePage(session.cdp, session.page.sessionId).catch(() => {});
  }
  session.cdp?.close();
}

async function closeAndStopFingerprintSession(session, hubConfig) {
  if (!session) return;
  const containerCode = session.env?.containerCode;
  await closeFingerprintSession(session);
  if (!containerCode) return;
  console.log(`  stop Hubstudio browser ${session.env?.serialNumber || ""}:${containerCode}`);
  await stopHubstudioBrowser({ config: hubConfig, containerCode, timeoutMs: 10000 }).catch((error) => {
    console.warn(`  stop Hubstudio browser failed: ${error.message || String(error)}`);
  });
  forgetHubstudioBrowserSession(containerCode);
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const fromRow = Number(readArg("from-row", readArg("row", "11"))) || 11;
  const toRow = Number(readArg("to-row", readArg("row", "100"))) || 100;
  const keywordTotalGid = readArg("keyword-total-gid", "999267438");
  const startFingerprintName = readArg("start-fingerprint", "1");
  const fingerprintLimit = Number(readArg("fingerprint-limit", "0")) || 0;
  const maxRowsPerFingerprint = Number(readArg("max-rows-per-fingerprint", "90")) || 90;
  const rowRetries = Number(readArg("row-retries", "2")) || 2;
  const rowDelayMs = Number(readArg("row-delay-ms", "1500")) || 0;
  const topUrlEmptySwitchAttempts = Number(readArg("top-url-empty-switch-attempts", "3")) || 3;
  const bingAuthMode = readArg("bing-auth", "auto");
  const proxyUpdateMode = readArg("proxy-update", "auto");
  const force = readFlag("force");
  const outDir = readArg("out-dir", "output/bing-hubstudio-serp");

  const [keywordTable, fingerprints] = await Promise.all([
    readRequiredSheet(sheetUrl, keywordTotalReadRange()),
    readHubstudioFingerprintsWithFallback({ startFingerprintName, fingerprintLimit })
  ]);
  if (fingerprints.length === 0) {
    throw new Error(`飞书 api 注册中没有可用指纹，从 ${startFingerprintName} 开始`);
  }

  const rows = selectRows(keywordTable, { fromRow, toRow, force });
  const hubConfig = readHubstudioConfig();
  const proxyRegions = readArg("proxy-regions", (hubConfig.proxy?.regions || []).join(","))
    .split(",")
    .map((region) => region.trim())
    .filter(Boolean);
  const hostPublicIp = hubConfig.proxy?.directGuardEnabled === false
    ? ""
    : await readPublicIp({
      ipCheckUrl: hubConfig.proxy?.ipCheckUrl,
      timeoutMs: hubConfig.proxy?.ipCheckTimeoutMs
    }).catch((error) => {
      console.warn(`Host public IP check failed: ${error.message || String(error)}`);
      return "";
    });
  console.log(`Selected ${rows.length} Google Sheet row(s), fingerprints from serial ${fingerprints[0].fingerprintName}.`);

  const summaries = [];
  let fingerprintIndex = 0;
  let proxyRegionIndex = 0;
  let session = null;
  let usedRowsOnFingerprint = 0;
  let topUrlEmptyAttemptsOnFingerprint = 0;

  const switchFingerprint = async () => {
    await closeAndStopFingerprintSession(session, hubConfig);
    session = null;
    while (fingerprintIndex < fingerprints.length) {
      const fingerprint = fingerprints[fingerprintIndex];
      fingerprintIndex += 1;
      const fallbackRegion = proxyRegions.length
        ? proxyRegions[proxyRegionIndex % proxyRegions.length]
        : "us-east-1";
      const proxyRegion = resolveHubstudioProxyRegion(fingerprint.region, fallbackRegion);
      proxyRegionIndex += 1;
      console.log(`Hubstudio fingerprint serial: ${fingerprint.fingerprintName}, region=${proxyRegion}${fingerprint.region ? ` (${fingerprint.region})` : ""}`);
      try {
        session = await startFingerprintSessionWithRetry({
          hubConfig,
          fingerprint,
          attempts: rowRetries,
          bingAuthMode,
          proxyUpdateMode,
          proxyRegion,
          hostPublicIp
        });
        usedRowsOnFingerprint = 0;
        topUrlEmptyAttemptsOnFingerprint = 0;
        return fingerprint;
      } catch (error) {
        console.warn(
          `Skip Hubstudio fingerprint ${fingerprint.fingerprintName}: ${error.message || String(error)}`
        );
        session = null;
      }
    }
    throw new Error("飞书 api 注册中没有更多可用 Hubstudio 指纹");
  };

  const restartActiveFingerprint = async () => {
    if (!activeFingerprint) {
      return switchFingerprint();
    }
    await closeFingerprintSession(session);
    session = null;
    console.log(`Reopen page on Hubstudio fingerprint serial: ${activeFingerprint.fingerprintName}`);
    session = await startFingerprintSessionWithRetry({
      hubConfig,
      fingerprint: activeFingerprint,
      attempts: rowRetries,
      bingAuthMode,
      proxyUpdateMode: "off",
      hostPublicIp
    });
    return activeFingerprint;
  };

  let activeFingerprint = await switchFingerprint();
  try {
    for (const keywordRow of rows) {
      const keyword = String(keywordRow.record["关键词"] || "").trim();
      let handled = false;
      for (let attempt = 1; attempt <= rowRetries && !handled; attempt += 1) {
        try {
          if (maxRowsPerFingerprint > 0 && usedRowsOnFingerprint >= maxRowsPerFingerprint) {
            activeFingerprint = await switchFingerprint();
            topUrlEmptyAttemptsOnFingerprint = 0;
          }
          await searchBingKeyword(session.cdp, session.page.sessionId, keyword, session.activeSiteUrl);
          const topUrls = await extractTop10UrlsFromBingDom(session.cdp, session.page.sessionId);
          if (topUrls.length === 0) {
            throw new Error(`BING_TOP_URLS_EMPTY: ${keyword}`);
          }

          const competition = classifyTopSearchResults(topUrls, 10);
          const precheck = evaluateSerpOpportunity(competition);
          const values = buildChromeValues(keywordTable.headers, keywordRow, precheck, competition);
          await writeKeywordTotalRow({
            sheetUrl,
            rowNumber: keywordRow.rowNumber,
            headers: keywordTable.headers,
            values
          });

          const serpCellHeader = optionalHeaderIndex(keywordTable.headers, "SERP格局") === -1 ? "SERP机会判断" : "SERP格局";
          const serpCell = { row: keywordRow.rowNumber, column: headerIndex(keywordTable.headers, serpCellHeader, KEYWORD_TOTAL_SHEET) };
          await formatCellBackgrounds({
            sheetUrl,
            sheetId: keywordTotalGid,
            cells: [serpCell],
            color: { red: 1, green: 1, blue: 1 }
          }).catch(() => {});
          await formatCellBackgrounds({
            sheetUrl,
            sheetId: keywordTotalGid,
            cells: []
          }).catch(() => {});
          await formatCellBackgrounds({
            sheetUrl,
            sheetId: keywordTotalGid,
            cells: precheck.judgement === "待定" ? [serpCell] : [],
            color: { red: 1, green: 0.9, blue: 0 }
          }).catch(() => {});

          usedRowsOnFingerprint += 1;
          handled = true;
          topUrlEmptyAttemptsOnFingerprint = 0;
          const summary = {
            row: keywordRow.rowNumber,
            keyword,
            fingerprint: activeFingerprint.fingerprintName,
            proxyRegion: session.proxyRegion || "",
            judgement: precheck.judgement,
            top10PlatformCount: competition.platformCount,
            top10IndependentSiteCount: competition.independentSiteCount,
            suspiciousLowAuthorityIndependentSite: competition.suspiciousLowAuthorityIndependentSite,
            serpPattern: precheck.pattern,
            urls: topUrls
          };
          summaries.push(summary);
          console.log(`Row ${keywordRow.rowNumber}: ${keyword} -> ${precheck.judgement}, platform=${competition.platformCount}, independent=${competition.independentSiteCount}, fp=${activeFingerprint.fingerprintName}`);
          if (rowDelayMs > 0) {
            await sleep(rowDelayMs);
          }
        } catch (error) {
          const message = error.message || String(error);
          console.warn(`Row ${keywordRow.rowNumber} attempt ${attempt}/${rowRetries} failed on fp=${activeFingerprint?.fingerprintName}: ${message}`);
          if (isBingAccountLimitMessage(message)) {
            activeFingerprint = await switchFingerprint();
            topUrlEmptyAttemptsOnFingerprint = 0;
            continue;
          }
          if (isBingTopUrlsEmptyMessage(message)) {
            topUrlEmptyAttemptsOnFingerprint += 1;
            if (topUrlEmptyAttemptsOnFingerprint >= topUrlEmptySwitchAttempts) {
              console.warn(
                `Row ${keywordRow.rowNumber}: top URLs empty ${topUrlEmptyAttemptsOnFingerprint} time(s); switch fingerprint from ${activeFingerprint?.fingerprintName}`
              );
              activeFingerprint = await switchFingerprint();
              continue;
            }
            if (attempt >= rowRetries) {
              summaries.push({ row: keywordRow.rowNumber, keyword, failed: true, error: message });
              break;
            }
            await sleep(2500);
            continue;
          }
          if (isRecoverablePageMessage(message) && attempt < rowRetries) {
            await restartActiveFingerprint();
            continue;
          }
          if (attempt >= rowRetries) {
            summaries.push({ row: keywordRow.rowNumber, keyword, failed: true, error: message });
          }
        }
      }
    }
  } finally {
    await closeAndStopFingerprintSession(session, hubConfig);
    await fs.mkdir(outDir, { recursive: true });
    await writeJson(path.join(outDir, "last-run-summary.json"), {
      sheetUrl,
      rows: rows.map((row) => row.rowNumber),
      startedAtFingerprint: startFingerprintName,
      summaries
    });
  }

  console.log(`Run summary: ${summaries.length} row(s) handled.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

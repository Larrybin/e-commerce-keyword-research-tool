#!/usr/bin/env node
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  classifyTopSearchResults,
  evaluateSerpOpportunity
} from "./lib/bing-precheck.mjs";
import {
  DEFAULT_GOOGLE_LOCATION,
  buildGoogleSearchUrl
} from "./lib/google-precheck.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import { detachChromePage, evaluate, navigateAndWait, withChromePage } from "./lib/cdp.mjs";
import { sleep } from "./lib/browser-actions.mjs";
import { readArg, readFlag } from "./lib/args.mjs";
import { getSheetValues, updateSheetValues } from "./lib/google-sheets-api.mjs";
import { writeJson } from "./lib/files.mjs";
import {
  KEYWORD_TOTAL_SHEET,
  keywordTotalReadRange
} from "./lib/sheet-write.mjs";

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function rowToObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row?.[index] || ""]));
}

function valuesToTable(values) {
  const headers = values[0] || [];
  return {
    headers,
    rows: values.slice(1).map((row, index) => ({
      rowNumber: index + 2,
      values: row,
      record: rowToObject(headers, row)
    }))
  };
}

function headerIndex(headers, header) {
  const index = headers.indexOf(header);
  if (index === -1) {
    throw new Error(`${KEYWORD_TOTAL_SHEET} 缺少表头: ${header}`);
  }
  return index;
}

function firstHeaderIndex(headers, names, { required = false } = {}) {
  const index = names.map((name) => headers.indexOf(name)).find((item) => item !== -1);
  if (index === undefined && required) {
    throw new Error(`${KEYWORD_TOTAL_SHEET} 缺少表头: ${names.join(" / ")}`);
  }
  return index ?? -1;
}

async function readKeywordTable(sheetUrl) {
  const result = await getSheetValues({ sheetUrl, range: keywordTotalReadRange() });
  if (!result.ok) {
    throw new Error(`读取 ${KEYWORD_TOTAL_SHEET} 失败: ${result.reason || "unknown error"}`);
  }
  return valuesToTable(result.values || []);
}

function selectKeywordRows(keywordTable, { fromRow, toRow, force }) {
  const prefilterIndex = headerIndex(keywordTable.headers, "agent预判断");
  const judgementIndex = headerIndex(keywordTable.headers, "判断");
  const serpJudgementIndex = headerIndex(keywordTable.headers, "SERP机会判断");
  const selected = [];

  for (const row of keywordTable.rows) {
    if (fromRow && row.rowNumber < fromRow) continue;
    if (toRow && row.rowNumber > toRow) break;
    const judgement = String(row.values[judgementIndex] || "").trim();
    if (!judgement && !toRow) break;
    const prefilter = String(row.values[prefilterIndex] || "").trim();
    if (prefilter !== "继续") continue;
    if (judgement !== "继续") continue;
    if (!String(row.record["关键词"] || "").trim()) continue;
    if (String(row.values[serpJudgementIndex] || "").trim() && !force) continue;
    selected.push(row);
  }

  return selected;
}

function buildKeywordTotalGoogleUpdates(keywordHeaders, keywordRow, precheck, competition) {
  const updates = new Map();
  const set = (headers, value, { required = false } = {}) => {
    const index = firstHeaderIndex(keywordHeaders, Array.isArray(headers) ? headers : [headers], { required });
    if (index !== -1) {
      updates.set(index, value);
    }
  };

  set("SERP机会判断", precheck.judgement, { required: true });
  set("top10大平台数", String(competition.platformCount));
  set("top10独立站数", String(competition.independentSiteCount));
  set("疑似低权重独立站", competition.suspiciousLowAuthorityIndependentSite);
  set("SERP格局", precheck.pattern);

  const existing = [...keywordRow.values];
  for (const [columnIndex, value] of updates.entries()) {
    existing[columnIndex] = value;
  }
  return existing;
}

async function resolveGoogleLocation({ location, hl, gl, latitude, longitude }) {
  if (!location) {
    return { hl, gl, latitude, longitude, place: "" };
  }

  const url = new URL("https://valentin.app/geocode");
  url.searchParams.set("address", location.toLowerCase());
  url.searchParams.set("hl", hl);
  url.searchParams.set("gl", gl);
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  const first = data.results?.[0];
  if (!response.ok || data.status !== "OK" || !first?.geometry?.location) {
    throw new Error(`Valentin geocode failed for ${location}: ${data.status || response.status}`);
  }
  return {
    hl,
    gl,
    latitude: first.geometry.location.lat,
    longitude: first.geometry.location.lng,
    place: first.formatted_address || location
  };
}

async function dismissGoogleConsent(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const buttons = [...document.querySelectorAll("button, input[type=submit], div[role=button]")];
    const button = buttons.find((item) => /^(Accept all|I agree|同意|全部接受)$/i.test(clean(item.innerText || item.value)));
    if (!button) return false;
    button.click();
    return true;
  })()`, 5000).catch(() => false);
}

async function extractGoogleTopUrls(cdp, sessionId) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = await evaluate(cdp, sessionId, `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const normalizeUrl = (href) => {
        try {
          const parsed = new URL(href);
          const unwrapped = parsed.hostname.endsWith("google.com") && parsed.pathname === "/url" && parsed.searchParams.get("q")
            ? new URL(parsed.searchParams.get("q"))
            : parsed;
          if (!/^https?:$/.test(unwrapped.protocol)) return "";
          if (/(^|\\.)google\\./i.test(unwrapped.hostname)) return "";
          return unwrapped.toString();
        } catch {
          return "";
        }
      };
      const text = clean(document.body.innerText);
      if (/unusual traffic|sorry\\/index|detected unusual/i.test(document.title + " " + location.href + " " + text)) {
        return { blocked: true, urls: [] };
      }
      const urls = [];
      const seen = new Set();
      const addUrl = (href) => {
        const url = normalizeUrl(href || "");
        if (!url || seen.has(url)) return false;
        seen.add(url);
        urls.push(url);
        return true;
      };
      for (const h3 of document.querySelectorAll("#search #rso h3")) {
        const title = clean(h3.textContent);
        if (!title || /^(Sponsored|Related searches|People also ask)$/i.test(title)) continue;
        if (h3.closest("#tads,#tvcap,#atvcap,[aria-label*=Ads]")) continue;
        const link = h3.closest("a") || h3.parentElement?.closest("a");
        addUrl(link?.href);
        if (urls.length >= 10) break;
      }
      for (const card of document.querySelectorAll("#search #rso .MjjYud, #search #rso .g")) {
        if (urls.length >= 10) break;
        if (card.closest("#tads,#tvcap,#atvcap,[aria-label*=Ads]")) continue;
        const link = [...card.querySelectorAll("a[href]")].find((item) => normalizeUrl(item.href));
        addUrl(link?.href);
      }
      return { blocked: false, urls };
    })()`, 15000).catch((error) => ({ blocked: false, urls: [], error: error.message }));

    if (result.blocked) {
      throw new Error("GOOGLE_SERP_BLOCKED");
    }
    if (result.urls?.length >= 10 || (result.urls?.length && attempt === 10)) {
      return result.urls;
    }
    await evaluate(cdp, sessionId, "window.scrollBy({ top: Math.floor(window.innerHeight * 0.8), left: 0, behavior: 'instant' })", 5000).catch(() => {});
    await sleep(800);
  }
  return [];
}

async function fetchGoogleTopUrlsForKeyword(cdp, sessionId, { keyword, location, num }) {
  const url = buildGoogleSearchUrl({ keyword, ...location, num });
  await navigateAndWait(cdp, sessionId, url, 45000);
  await dismissGoogleConsent(cdp, sessionId);
  await sleep(1800);
  return extractGoogleTopUrls(cdp, sessionId);
}

async function writeKeywordTotalRow({ sheetUrl, rowNumber, headers, values, dryRun }) {
  const endColumn = columnName(Math.max(headers.length, values.length) - 1);
  const range = `${KEYWORD_TOTAL_SHEET}!A${rowNumber}:${endColumn}${rowNumber}`;
  if (dryRun) {
    return { skipped: true, reason: "dry_run", range };
  }
  const result = await updateSheetValues({
    sheetUrl,
    range,
    values: [values.slice(0, Math.max(headers.length, values.length))]
  });
  if (!result.ok) {
    throw new Error(`写入 ${KEYWORD_TOTAL_SHEET} 第 ${rowNumber} 行失败: ${result.reason || "unknown error"}`);
  }
  return result;
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const rowArg = readArg("row", "");
  const fromRow = Number(rowArg || readArg("from-row", "0")) || 0;
  const toRow = Number(rowArg || readArg("to-row", "0")) || 0;
  const force = readFlag("force");
  const dryRun = readFlag("dry-run");
  const outDir = readArg("out-dir", "output/google-precheck");
  const minDelayMs = Number(readArg("min-delay-ms", "6000")) || 6000;
  const maxDelayMs = Number(readArg("max-delay-ms", "12000")) || 12000;
  const num = Number(readArg("num", "20")) || 20;
  const location = await resolveGoogleLocation({
    location: readArg("location", ""),
    hl: readArg("hl", DEFAULT_GOOGLE_LOCATION.hl),
    gl: readArg("gl", DEFAULT_GOOGLE_LOCATION.gl),
    latitude: Number(readArg("lat", String(DEFAULT_GOOGLE_LOCATION.latitude))),
    longitude: Number(readArg("lng", String(DEFAULT_GOOGLE_LOCATION.longitude)))
  });

  const keywordTable = await readKeywordTable(sheetUrl);
  const keywordRows = selectKeywordRows(keywordTable, { fromRow, toRow, force });
  const summaries = [];

  console.log(`Selected ${keywordRows.length} keyword row(s).`);
  console.log(`Google location: ${location.place || `${location.latitude},${location.longitude}`} (${location.hl}-${location.gl})`);
  console.log(`Mode: ${dryRun ? "dry-run" : "write"}`);

  await withChromePage(async ({ cdp, sessionId, targetId }) => {
    for (const keywordRow of keywordRows) {
      try {
        const keyword = String(keywordRow.record["关键词"] || "").trim();
        const topUrls = await fetchGoogleTopUrlsForKeyword(cdp, sessionId, { keyword, location, num });
        const serp = classifyTopSearchResults(topUrls, 10);
        const precheck = evaluateSerpOpportunity(serp);
        const values = buildKeywordTotalGoogleUpdates(keywordTable.headers, keywordRow, precheck, serp);
        const writeResult = await writeKeywordTotalRow({
          sheetUrl,
          rowNumber: keywordRow.rowNumber,
          headers: keywordTable.headers,
          values,
          dryRun
        });
        summaries.push({
          row: keywordRow.rowNumber,
          keyword,
          judgement: precheck.judgement,
          top10PlatformCount: serp.platformCount,
          top10IndependentSiteCount: serp.independentSiteCount,
          suspiciousLowAuthorityIndependentSite: serp.suspiciousLowAuthorityIndependentSite,
          serpPattern: precheck.pattern,
          urls: topUrls,
          writeResult
        });
        console.log(`Row ${keywordRow.rowNumber}: ${keyword} -> ${precheck.judgement}, platform=${serp.platformCount}, independent=${serp.independentSiteCount}`);
        await sleep(Math.floor(Math.random() * (Math.max(minDelayMs, maxDelayMs) - Math.min(minDelayMs, maxDelayMs) + 1)) + Math.min(minDelayMs, maxDelayMs));
      } catch (error) {
        summaries.push({
          row: keywordRow.rowNumber,
          keyword: keywordRow.record["关键词"] || "",
          failed: true,
          error: error.message || String(error)
        });
        console.error(`Row ${keywordRow.rowNumber} failed: ${error.message || String(error)}`);
      }
    }
    await detachChromePage(cdp, sessionId).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  });

  await fs.mkdir(outDir, { recursive: true });
  await writeJson(`${outDir}/last-run-summary.json`, {
    sheetUrl,
    mode: dryRun ? "dry-run" : "write",
    location,
    rows: keywordRows.map((row) => row.rowNumber),
    summaries
  });
  console.log(`Run summary: ${summaries.length} row(s) handled.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

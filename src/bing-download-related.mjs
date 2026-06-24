#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { sleep } from "./lib/browser-actions.mjs";
import { readArg, readFlag } from "./lib/args.mjs";
import { getRelatedKeywords, readBingWebmasterApiKey } from "./lib/bing-webmaster-api.mjs";
import { getSheetValues } from "./lib/google-sheets-api.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import {
  KEYWORD_TOTAL_SHEET,
  keywordTotalReadRange
} from "./lib/sheet-write.mjs";

const ACCOUNT_SHEET = "工具账号密码";

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

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function readBingAccounts(accountTable, requestedAccount) {
  const index = accountTable.headers.indexOf("bing webmaster所在的chrome账号");
  if (index === -1) {
    throw new Error(`${ACCOUNT_SHEET} 缺少表头: bing webmaster所在的chrome账号`);
  }
  const accounts = uniqueNonEmpty(accountTable.rows.map((row) => row.values[index]));
  const expected = String(requestedAccount || "").trim().toLowerCase();
  if (!expected) {
    return accounts;
  }
  const filtered = accounts.filter((account) => account.toLowerCase() === expected);
  if (filtered.length === 0) {
    throw new Error(`${ACCOUNT_SHEET} 未找到 Bing Chrome 账号: ${requestedAccount}`);
  }
  return filtered;
}

function selectRows(keywordTable, { fromRow, toRow, limit }) {
  const keywordIndex = headerIndex(keywordTable.headers, "关键词");
  const prefilterIndex = headerIndex(keywordTable.headers, "agent预判断");
  const bingJudgementIndex = headerIndex(keywordTable.headers, "bing初步判断");
  const selected = [];
  for (const row of keywordTable.rows) {
    if (fromRow && row.rowNumber < fromRow) {
      continue;
    }
    if (toRow && row.rowNumber > toRow) {
      break;
    }
    const keyword = String(row.values[keywordIndex] || "").trim();
    const prefilter = String(row.values[prefilterIndex] || "").trim();
    const bingJudgement = String(row.values[bingJudgementIndex] || "").trim();
    if (!keyword) {
      continue;
    }
    if (prefilter !== "继续") {
      continue;
    }
    if (bingJudgement !== "继续") {
      continue;
    }
    selected.push(row);
    if (limit && selected.length >= limit) {
      break;
    }
  }
  return selected;
}

async function readRequiredSheet(sheetUrl, range) {
  const result = await getSheetValues({ sheetUrl, range });
  if (!result.ok) {
    throw new Error(`读取 ${range} 失败: ${result.reason || "unknown error"}`);
  }
  return valuesToTable(result.values || []);
}

function safeFolderName(keyword) {
  return String(keyword || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120) || "keyword";
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function relatedKeywordsToCsv(rows) {
  const lines = [["Keyword", "Impressions", "BroadImpressions"]];
  for (const row of rows) {
    lines.push([
      row.Query || "",
      Number(row.Impressions) || 0,
      Number(row.BroadImpressions) || 0
    ]);
  }
  return `${lines.map((line) => line.map(csvEscape).join(",")).join("\n")}\n`;
}

function formatApiDate(date) {
  return date.toISOString().slice(0, 10) + "T00:00:00";
}

function defaultDateRange() {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 86);
  return {
    startDate: formatApiDate(start),
    endDate: formatApiDate(end)
  };
}

async function withRetries(label, retries, task) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        break;
      }
      console.warn(`${label}: attempt ${attempt}/${retries} failed: ${error.message || error}`);
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const requestedBingAccount = readArg("bing-account", "vc.ddom@gmail.com");
  const fromRow = Number(readArg("from-row", "0")) || 0;
  const toRow = Number(readArg("to-row", "0")) || 0;
  const limit = Number(readArg("limit", "0")) || 0;
  const outDir = readArg("out-dir", "output/bing-related-keywords");
  const dryRun = readFlag("dry-run");
  const rowRetries = Number(readArg("row-retries", "3")) || 3;
  const defaults = defaultDateRange();
  const startDate = readArg("start-date", defaults.startDate);
  const endDate = readArg("end-date", defaults.endDate);
  const country = readArg("country", "");
  const language = readArg("language", "");

  const [accountTable, keywordTable] = await Promise.all([
    readRequiredSheet(sheetUrl, `${ACCOUNT_SHEET}!A:Z`),
    readRequiredSheet(sheetUrl, keywordTotalReadRange())
  ]);
  const accounts = readBingAccounts(accountTable, requestedBingAccount);
  const rows = selectRows(keywordTable, { fromRow, toRow, limit });
  const apiKey = await readBingWebmasterApiKey();
  console.log(`Selected ${rows.length} keyword row(s) for related keyword export via official Bing API.`);
  console.log(`Bing account policy row: ${accounts[0]}; API date range: ${startDate} -> ${endDate}`);
  if (rows.length === 0) {
    return;
  }
  if (dryRun) {
    console.log("Dry run OK. No files written.");
    return;
  }

  await fs.mkdir(outDir, { recursive: true });
  for (const row of rows) {
    const keyword = String(row.record["关键词"] || "").trim();
    const folder = path.join(outDir, safeFolderName(keyword));
    await fs.mkdir(folder, { recursive: true });
    const related = await withRetries(`Row ${row.rowNumber} ${keyword}`, rowRetries, () =>
      getRelatedKeywords({ apiKey, keyword, country, language, startDate, endDate })
    );
    const csv = relatedKeywordsToCsv(related);
    const filePath = path.join(folder, "related-keywords.csv");
    await fs.writeFile(filePath, csv, "utf8");
    console.log(`Row ${row.rowNumber}: downloaded ${related.length} related keywords for ${keyword} -> ${filePath}`);
    await sleep(250);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

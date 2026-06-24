#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { readArg } from "./lib/args.mjs";
import { findChromeProfile } from "./lib/chrome-profiles.mjs";
import { rowsToObjects } from "./lib/csv.mjs";
import { buildCsvUrl, getGid } from "./lib/google-sheet.mjs";
import { getSheetValues } from "./lib/google-sheets-api.mjs";
import {
  DEFAULT_SHEET_URL,
  getRequiredValueByAliases,
  redactSecrets
} from "./lib/tool-config.mjs";

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

async function readSheetWithApi({ sheetUrl, sheetName, expectedHeaders = [] }) {
  const result = await getSheetValues({
    sheetUrl,
    range: `${quoteSheetName(sheetName)}!A:Z`
  });
  if (!result.ok) {
    throw new Error(`读取 ${sheetName} 失败: ${result.reason || "unknown error"}`);
  }

  const rawRows = result.values || [];
  const headers = rawRows[0] || [];
  const missing = expectedHeaders.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(`${sheetName} 表头缺失: ${missing.join(", ")}. 当前表头: ${headers.join(", ")}`);
  }

  return {
    range: result.range,
    csvUrl: buildCsvUrl({ sheetUrl, sheetName }),
    headers,
    rows: rowsToObjects(rawRows),
    rawRows,
    clientEmail: result.clientEmail
  };
}

function resolveChromeProfile(findProfile, browserAccount) {
  try {
    return findProfile(browserAccount);
  } catch {
    return {
      directory: "",
      name: "",
      email: browserAccount,
      fullName: ""
    };
  }
}

export async function readGoogleSheetInput({
  sheetUrl = DEFAULT_SHEET_URL,
  gid = getGid(sheetUrl),
  accountSheetName = "工具账号密码",
  keywordSheetName = "词根拓展",
  readSheet = readSheetWithApi,
  findProfile = findChromeProfile,
  now = () => new Date()
} = {}) {
  const accountSheet = await readSheet({
    sheetUrl,
    sheetName: accountSheetName,
    expectedHeaders: ["semrush账号", "semrush密码"]
  });
  const toolAccount = accountSheet.rows[0] || {};
  const browserAccount = getRequiredValueByAliases(toolAccount, [
    "运行浏览器账号",
    "运行浏览器的账号"
  ]);
  const chromeProfile = resolveChromeProfile(findProfile, browserAccount);

  const keywordSheet = await readSheet({
    sheetUrl,
    sheetName: keywordSheetName,
    expectedHeaders: ["词根", "关键词"]
  });

  return {
    source: {
      sheetUrl,
      gid,
      accountSheetName,
      accountSheetCsvUrl: accountSheet.csvUrl,
      keywordSheetName,
      keywordSheetCsvUrl: keywordSheet.csvUrl,
      readAt: now().toISOString()
    },
    toolAccount: {
      semrush账号: toolAccount["semrush账号"] || "",
      运行浏览器账号: browserAccount
    },
    chromeProfile: {
      directory: chromeProfile.directory,
      name: chromeProfile.name,
      email: chromeProfile.email,
      fullName: chromeProfile.fullName
    },
    sheets: {
      [accountSheetName]: {
        headers: accountSheet.headers,
        rows: redactSecrets(accountSheet.rows)
      },
      [keywordSheetName]: {
        headers: keywordSheet.headers,
        rows: keywordSheet.rows
      }
    }
  };
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const gid = readArg("gid", process.env.GOOGLE_SHEET_GID || getGid(sheetUrl));
  const accountSheetName = readArg("account-sheet", "工具账号密码");
  const keywordSheetName = readArg("keyword-sheet", "词根拓展");
  const output = readArg("out", "output/google-sheet-input.json");

  const payload = await readGoogleSheetInput({
    sheetUrl,
    gid,
    accountSheetName,
    keywordSheetName
  });

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Browser account: ${payload.toolAccount["运行浏览器账号"]}`);
  console.log(`Chrome profile: ${payload.chromeProfile.directory} (${payload.chromeProfile.email || payload.chromeProfile.name})`);
  console.log(`Read ${payload.sheets[accountSheetName].rows.length} row(s) from ${accountSheetName}`);
  console.log(`Read ${payload.sheets[keywordSheetName].rows.length} row(s) from ${keywordSheetName}`);
  console.log(`Wrote ${output}`);
  console.log(JSON.stringify(payload.sheets[keywordSheetName].rows[0] || {}, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

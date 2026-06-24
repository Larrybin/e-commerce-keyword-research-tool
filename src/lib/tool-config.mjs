import {
  ensureChromeProfileTargetWithCdp,
  findChromeProfile
} from "./chrome-profiles.mjs";
import {
  attachChromePage,
  createChromePage,
  detachChromePage
} from "./cdp.mjs";
import { rowsToObjects } from "./csv.mjs";
import { getGid, getSpreadsheetId } from "./google-sheet.mjs";
import { getSheetValues } from "./google-sheets-api.mjs";
import { KEYWORD_TOTAL_READ_COLUMNS } from "./sheet-write.mjs";

export const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1zPTig9pqL-AOiwnBUOXPpx72ZRpZbu0LKi37mK8YK_U/edit?gid=0#gid=0";

export function buildProfileWorkUrl(sheetUrl) {
  const url = new URL(sheetUrl);
  const marker = `keyword-tool-${Date.now()}`;
  url.searchParams.set("keyword_tool_run", marker);
  url.hash = `${url.hash.replace(/^#/, "") || `gid=${getGid(sheetUrl)}`}&${marker}`;
  return {
    marker,
    url: url.toString()
  };
}

function findExistingSheetTarget(targetInfos, spreadsheetId) {
  return targetInfos.find(
    (target) =>
      target.type === "page" &&
      target.url.includes(`/spreadsheets/d/${spreadsheetId}`)
  );
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

async function readSheetWithApi({ sheetUrl, sheetName, expectedHeaders = [], columns = "A:Z" }) {
  const result = await getSheetValues({
    sheetUrl,
    range: `${quoteSheetName(sheetName)}!${columns}`
  });
  if (!result.ok) {
    throw new Error(`读取 ${sheetName} 失败: ${result.reason || "unknown error"}`);
  }

  const rawRows = result.values || [];
  const headers = rawRows[0] || [];
  const missing = expectedHeaders.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(
      `${sheetName} 表头缺失: ${missing.join(", ")}. 当前表头: ${headers.join(", ")}`
    );
  }

  return {
    range: result.range,
    headers,
    rows: rowsToObjects(rawRows),
    rawRows,
    clientEmail: result.clientEmail
  };
}

export function getRequiredValue(record, key) {
  const value = record?.[key]?.trim();
  if (!value) {
    throw new Error(`Missing required value in Google Sheet: ${key}`);
  }
  return value;
}

export function getRequiredValueByAliases(record, aliases) {
  for (const key of aliases) {
    const value = record?.[key]?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required value in Google Sheet. Tried columns: ${aliases.join(", ")}`);
}

export function redactSecrets(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        /密码|password/i.test(key) && value ? "***" : value
      ])
    )
  );
}

export function pickKeywordTask(keywordRows, rowNumber = 2) {
  const index = Math.max(0, Number(rowNumber) - 2);
  const row = keywordRows[index];
  if (!row) {
    throw new Error(`No task row found in 词根拓展 at spreadsheet row ${rowNumber}`);
  }

  const rootKeyword = (row["词根"] || "").trim();
  const keyword = (row["关键词"] || "").trim();
  const query = rootKeyword || keyword;
  if (!query) {
    throw new Error(`Spreadsheet row ${rowNumber} has neither 词根 nor 关键词`);
  }

  const valueOrDefault = (value, fallback) => {
    const text = (value || "").trim();
    return text || fallback;
  };

  return {
    rowNumber,
    row,
    query,
    mode: rootKeyword ? "root" : "keyword",
    rootKeyword,
    keyword,
    matchType: valueOrDefault(row["匹配类型"], "词组匹配"),
    matchCountry: (row["匹配国家"] || "").trim(),
    volumeMin: valueOrDefault(row["搜索量范围（小）"], "1000"),
    volumeMax: (row["搜索量范围（大）"] || "").trim(),
    kdMin: valueOrDefault(row["KD范围（小）"], "0"),
    kdMax: valueOrDefault(row["KD范围（大）"], "60"),
    machineFilter: (row["是否进行机器筛选"] || row["进行机器筛选"] || "").trim()
  };
}

export async function readToolConfig(cdp, options) {
  const {
    sheetUrl,
    accountSheetName = "工具账号密码",
    keywordSheetName = "词根拓展",
    keywordTotalSheetName = "关键词总表",
    taskRow = 2,
    requireTask = true
  } = options;

  let bootstrapPage;
  let closeBootstrapPage = false;
  let targetPage;

  try {
    const spreadsheetId = getSpreadsheetId(sheetUrl);
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    const existingSheetTarget = findExistingSheetTarget(targetInfos, spreadsheetId);

    const accountSheet = await readSheetWithApi({
      sheetUrl,
      sheetName: accountSheetName,
      expectedHeaders: ["semrush账号", "semrush密码"]
    });

    const toolAccount = accountSheet.rows[0] || {};
    const browserAccount = getRequiredValueByAliases(toolAccount, [
      "运行浏览器账号",
      "运行浏览器的账号"
    ]);
    const chromeProfile = findChromeProfile(browserAccount);

    if (existingSheetTarget) {
      bootstrapPage = await attachChromePage(cdp, existingSheetTarget.targetId);
      targetPage = bootstrapPage;
    } else {
      bootstrapPage = await createChromePage(cdp);
      closeBootstrapPage = true;
      const target = await ensureChromeProfileTargetWithCdp(cdp, chromeProfile, sheetUrl);
      targetPage = await attachChromePage(cdp, target.targetId);
    }

    const keywordSheet = await readSheetWithApi({
      sheetUrl,
      sheetName: keywordSheetName,
      expectedHeaders: ["词根", "关键词"]
    });

    const keywordTotalSheet = await readSheetWithApi({
      sheetUrl,
      sheetName: keywordTotalSheetName,
      columns: KEYWORD_TOTAL_READ_COLUMNS,
      expectedHeaders: ["词根", "关键词", "国家", "搜索量", "KD"]
    });

    return {
      accountSheet,
      keywordSheet,
      keywordTotalSheet,
      toolAccount,
      browserAccount,
      chromeProfile,
      task: requireTask ? pickKeywordTask(keywordSheet.rows, taskRow) : null,
      targetPage
    };
  } finally {
	    if (bootstrapPage && bootstrapPage.sessionId !== targetPage?.sessionId) {
	      if (closeBootstrapPage) {
	        await cdp.send("Target.closeTarget", { targetId: bootstrapPage.targetId }).catch(() => {});
	      } else {
        await detachChromePage(cdp, bootstrapPage.sessionId);
      }
    }
  }
}

#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { readArg } from "./lib/args.mjs";
import {
  ensureChromeProfileTargetWithCdp,
  findChromeProfile
} from "./lib/chrome-profiles.mjs";
import {
  attachChromePage,
  CdpClient,
  createChromePage,
  detachChromePage,
  navigateAndWait,
  readChromeWebSocketEndpoint
} from "./lib/cdp.mjs";
import {
  getGid,
  getSpreadsheetId,
  readSheetInSession
} from "./lib/google-sheet.mjs";

const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1Ea3mSRW431QP08sq9tn3VoYEkj52hNRzY_GVizVLy3A/edit?gid=0#gid=0";

function buildProfileWorkUrl(sheetUrl) {
  const url = new URL(sheetUrl);
  const marker = `keyword-tool-${Date.now()}`;
  url.searchParams.set("keyword_tool_run", marker);
  url.hash = `${url.hash.replace(/^#/, "") || `gid=${getGid(sheetUrl)}`}&${marker}`;
  return {
    marker,
    url: url.toString()
  };
}

function getRequiredValue(record, key) {
  const value = record?.[key]?.trim();
  if (!value) {
    throw new Error(`Missing required value in Google Sheet: ${key}`);
  }
  return value;
}

function getRequiredValueByAliases(record, aliases) {
  for (const key of aliases) {
    const value = record?.[key]?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required value in Google Sheet. Tried columns: ${aliases.join(", ")}`);
}

function redactSecrets(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        /密码|password/i.test(key) && value ? "***" : value
      ])
    )
  );
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const gid = readArg("gid", process.env.GOOGLE_SHEET_GID || getGid(sheetUrl));
  const accountSheetName = readArg("account-sheet", "工具账号密码");
  const keywordSheetName = readArg("keyword-sheet", "词根拓展");
  const output = readArg("out", "output/google-sheet-input.json");

  const cdp = new CdpClient(readChromeWebSocketEndpoint());
  await cdp.connect();

  let bootstrapPage;
  let closeBootstrapPage = false;
  let targetPage;
  let accountSheet;
  let keywordSheet;
  let toolAccount;
  let browserAccount;
  let chromeProfile;

  try {
    const spreadsheetId = getSpreadsheetId(sheetUrl);
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    const existingSheetTarget = targetInfos.find(
      (target) =>
        target.type === "page" &&
        target.url.includes(`/spreadsheets/d/${spreadsheetId}`)
    );

    if (existingSheetTarget) {
      bootstrapPage = await attachChromePage(cdp, existingSheetTarget.targetId);
    } else {
      bootstrapPage = await createChromePage(cdp);
      closeBootstrapPage = true;
      await navigateAndWait(cdp, bootstrapPage.sessionId, "https://docs.google.com/", 30000);
    }

    accountSheet = await readSheetInSession({
      cdp,
      sessionId: bootstrapPage.sessionId,
      sheetUrl,
      sheetName: accountSheetName,
      expectedHeaders: ["semrush账号", "semrush密码"]
    });

    toolAccount = accountSheet.rows[0] || {};
    browserAccount = getRequiredValueByAliases(toolAccount, [
      "运行浏览器账号",
      "运行浏览器的账号"
    ]);
    chromeProfile = findChromeProfile(browserAccount);

    const workUrl = buildProfileWorkUrl(sheetUrl);
    const target = await ensureChromeProfileTargetWithCdp(cdp, chromeProfile, workUrl.url);
    targetPage = await attachChromePage(cdp, target.targetId);

    keywordSheet = await readSheetInSession({
      cdp,
      sessionId: targetPage.sessionId,
      sheetUrl,
      sheetName: keywordSheetName,
      expectedHeaders: ["词根", "关键词"]
    });
  } finally {
    if (targetPage) {
      await detachChromePage(cdp, targetPage.sessionId);
    }
    if (bootstrapPage) {
      if (closeBootstrapPage) {
        await cdp.send("Target.closeTarget", { targetId: bootstrapPage.targetId }).catch(() => {});
      } else {
        await detachChromePage(cdp, bootstrapPage.sessionId);
      }
    }
    cdp.close();
  }

  const payload = {
    source: {
      sheetUrl,
      gid,
      accountSheetName,
      accountSheetCsvUrl: accountSheet.csvUrl,
      keywordSheetName,
      keywordSheetCsvUrl: keywordSheet.csvUrl,
      readAt: new Date().toISOString()
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

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Browser account: ${browserAccount}`);
  console.log(`Chrome profile: ${chromeProfile.directory} (${chromeProfile.email || chromeProfile.name})`);
  console.log(`Read ${accountSheet.rows.length} row(s) from ${accountSheetName}`);
  console.log(`Read ${keywordSheet.rows.length} row(s) from ${keywordSheetName}`);
  console.log(`Wrote ${output}`);
  console.log(JSON.stringify(keywordSheet.rows[0] || {}, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

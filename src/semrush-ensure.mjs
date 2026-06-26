#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readArg } from "./lib/args.mjs";
import {
  attachChromePage,
  CdpClient,
  createChromePage,
  detachChromePage,
  navigateAndWait,
  waitForChromeTargetWithCdp
} from "./lib/cdp.mjs";
import { sleep } from "./lib/browser-actions.mjs";
import {
  closeSemrushCoachmark,
  detectPage,
  loginDash,
  openSemrushFromDash
} from "./lib/semrush-page.mjs";
import { DEFAULT_SHEET_URL, readToolConfig } from "./lib/tool-config.mjs";
import {
  ensureSemrushSharedChrome,
  withSemrushSharedLock
} from "./lib/semrush-shared-chrome.mjs";

const DASH_LOGIN_URL = "https://dash.3ue.com/zh-Hans/#/login";

export function isSemrushReadyKind(kind) {
  return ["semrush_home", "semrush_keyword_overview", "semrush_keyword_magic"].includes(kind);
}

async function closePage(cdp, page) {
  if (!page) return;
  await detachChromePage(cdp, page.sessionId).catch(() => {});
  await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
}

async function pageTargetIds(cdp) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
  return new Set(targetInfos.filter((target) => target.type === "page").map((target) => target.targetId));
}

async function switchToOpenedSemrushPage(cdp, currentPage, existingTargetIds) {
  const target = await waitForChromeTargetWithCdp(
    cdp,
    (item) =>
      item.type === "page" &&
      item.url.includes("sem.3ue.com") &&
      (item.targetId === currentPage.targetId || !existingTargetIds.has(item.targetId)),
    60000
  );
  if (target.targetId === currentPage.targetId) return currentPage;
  await closePage(cdp, currentPage);
  return attachChromePage(cdp, target.targetId);
}

async function ensureReady(cdp, page, toolAccount) {
  const username = toolAccount["semrush账号"] || "";
  const password = toolAccount["semrush密码"] || toolAccount["密码"] || "";
  if (!username || !password) {
    throw new Error("工具账号密码 子表缺少 semrush账号 或 semrush密码");
  }

  for (let step = 0; step < 12; step += 1) {
    await closeSemrushCoachmark(cdp, page.sessionId).catch(() => {});
    const current = await detectPage(cdp, page.sessionId);

    if (current.kind === "dash_login") {
      await withSemrushSharedLock("dash-login", () => loginDash(cdp, page.sessionId, username, password));
      continue;
    }

    if (current.kind === "dash_home") {
      const existingTargetIds = await pageTargetIds(cdp);
      await withSemrushSharedLock("dash-open-semrush", () => openSemrushFromDash(cdp, page.sessionId));
      page = await switchToOpenedSemrushPage(cdp, page, existingTargetIds);
      continue;
    }

    if (isSemrushReadyKind(current.kind)) {
      return { page, current };
    }

    await withSemrushSharedLock("session-recovery", () =>
      navigateAndWait(cdp, page.sessionId, DASH_LOGIN_URL, 45000).catch(async () => {
        await sleep(3000);
      })
    );
  }

  throw new Error("Semrush shared profile did not reach Semrush.");
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const config = await readToolConfig({
    sheetUrl,
    requireTask: false
  });
  const sharedChrome = await ensureSemrushSharedChrome();
  const cdp = new CdpClient(sharedChrome.webSocketEndpoint);
  await cdp.connect();
  let page;
  try {
    page = await createChromePage(cdp, DASH_LOGIN_URL);
    const result = await ensureReady(cdp, page, config.toolAccount);
    page = result.page;
    console.log(`Semrush ready: ${result.current.url}`);
  } finally {
    await closePage(cdp, page);
    cdp.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

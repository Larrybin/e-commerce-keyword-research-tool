#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { readArg, readFlag } from "./lib/args.mjs";
import {
  attachChromePage,
  CdpClient,
  createChromePage,
  detachChromePage,
  evaluate,
  navigateAndWait,
  readChromeWebSocketEndpoint
} from "./lib/cdp.mjs";
import {
  ensureChromeProfileTargetWithCdp,
  findChromeProfile
} from "./lib/chrome-profiles.mjs";
import { batchUpdateSheetValues, getSheetValues } from "./lib/google-sheets-api.mjs";
import {
  DEFAULT_SHEET_URL,
  getRequiredValueByAliases
} from "./lib/tool-config.mjs";
import {
  KEYWORD_TOTAL_READ_COLUMNS,
  KEYWORD_TOTAL_SHEET
} from "./lib/sheet-write.mjs";
import {
  getSpreadsheetId,
  readSheetInSession
} from "./lib/google-sheet.mjs";
import { sleep } from "./lib/browser-actions.mjs";
import { columnName, headerIndex, valuesToTable } from "./lib/table-utils.mjs";
import {
  buildWorkspaceSnapshotExpression,
  GET_STARTED_LABELS,
  NEXT_LABELS,
  WORKSPACE_BUSINESS_URL,
  WORKSPACE_PAGE_STATES
} from "./lib/workspace-domain-page.mjs";
import {
  buildDomainCandidates,
  DOMAIN_NOT_FOUND_STATUS,
  isWorkspaceNoLongerAvailableMessage,
  parseWorkspaceDomainConfirmation,
  selectDomainResearchRows
} from "./lib/workspace-domain-research.mjs";

const DEFAULT_BUSINESS_NAME = "compound interest calculator";
const DEFAULT_REGION = "Türkiye";
const DEFAULT_OUTPUT = "output/workspace-domain-page.json";
const DOMAIN_RECOMMENDATION_HEADER = "域名推荐";
const DOMAIN_PRICE_HEADER = "价格";

function json(value) {
  return JSON.stringify(value);
}

function pageActionExpression(source) {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const lower = (value) => clean(value).toLowerCase();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clickElement = (el) => {
      el.scrollIntoView({ block: "center", inline: "center" });
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.click();
    };
    ${source}
  })()`;
}

async function maximizeChromeWindow(cdp, targetId) {
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "maximized" }
  }).catch(async () => {
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: 0,
        top: 0,
        width: 1600,
        height: 1000
      }
    });
  });
}

async function readBrowserProfileFromToolAccount(cdp, {
  sheetUrl,
  accountSheetName
}) {
  let page;
  let closePage = false;
  try {
    const spreadsheetId = getSpreadsheetId(sheetUrl);
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    const existingSheetTarget = targetInfos.find(
      (target) =>
        target.type === "page" &&
        target.url.includes(`/spreadsheets/d/${spreadsheetId}`)
    );

    if (existingSheetTarget) {
      page = await attachChromePage(cdp, existingSheetTarget.targetId);
    } else {
      page = await createChromePage(cdp);
      closePage = true;
      await navigateAndWait(cdp, page.sessionId, "https://docs.google.com/", 30000);
    }

    const accountSheet = await readSheetInSession({
      cdp,
      sessionId: page.sessionId,
      sheetUrl,
      sheetName: accountSheetName,
      expectedHeaders: ["semrush账号"]
    });
    const toolAccount = accountSheet.rows[0] || {};
    const browserAccount = getRequiredValueByAliases(toolAccount, [
      "运行浏览器账号",
      "运行浏览器的账号"
    ]);
    return {
      accountSheet,
      toolAccount,
      browserAccount,
      chromeProfile: findChromeProfile(browserAccount)
    };
  } finally {
    if (page) {
      if (closePage) {
        await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
      } else {
        await detachChromePage(cdp, page.sessionId).catch(() => {});
      }
    }
  }
}

async function findExistingWorkspaceTarget(cdp) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets");
  const workspaceTargets = targetInfos.filter(
    (target) =>
      target.type === "page" &&
      /^https:\/\/workspace\.google\.com\/business(?:\/|$)/.test(target.url || "")
  );
  return workspaceTargets.find((target) => target.url.includes("/business/signup/buy")) ||
    workspaceTargets[0] ||
    null;
}

async function openWorkspaceTarget(cdp, profile, startUrl) {
  const existing = await findExistingWorkspaceTarget(cdp);
  if (existing) {
    return existing;
  }

  return ensureChromeProfileTargetWithCdp(cdp, profile, startUrl, 30000);
}

async function snapshot(cdp, sessionId) {
  return evaluate(cdp, sessionId, buildWorkspaceSnapshotExpression(), 15000);
}

async function dismissCookieBanner(cdp, sessionId) {
  return evaluate(cdp, sessionId, pageActionExpression(`
    const labels = ["no thanks", "reject all", "agree", "accept all", "kabul", "hayır", "同意", "不用了"];
    const candidates = [...document.querySelectorAll("button, [role='button']")];
    const button = candidates.find((el) => visible(el) && labels.some((label) => lower(el.innerText || el.textContent).includes(label)));
    if (!button) return { ok: false, reason: "cookie banner not found" };
    clickElement(button);
    return { ok: true, text: clean(button.innerText || button.textContent) };
  `), 10000).catch(() => ({ ok: false }));
}

async function clickByLabels(cdp, sessionId, labels, {
  selector = "button, a, [role='button']",
  includes = true
} = {}) {
  const result = await evaluate(cdp, sessionId, pageActionExpression(`
    const labels = ${json(labels.map((label) => label.toLowerCase()))};
    const items = [...document.querySelectorAll(${json(selector)})];
    const match = items.find((el) => {
      if (!visible(el)) return false;
      const text = lower([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" "));
      if (!text) return false;
      return labels.some((label) => ${includes ? "text.includes(label)" : "text === label"});
    });
    if (!match) return { ok: false, reason: "label not found", labels };
    clickElement(match);
    return { ok: true, text: clean(match.innerText || match.textContent || match.getAttribute("aria-label")) };
  `), 15000);
  if (!result?.ok) {
    throw new Error(result?.reason || `Unable to click labels: ${labels.join(", ")}`);
  }
  return result;
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

async function selectNewDomainMethod(cdp, sessionId) {
  const selected = await evaluate(cdp, sessionId, pageActionExpression(`
    const option = [...document.querySelectorAll("[role='option']")].find((el) => {
      const label = lower([el.getAttribute("aria-label"), el.innerText, el.textContent].filter(Boolean).join(" "));
      return visible(el) && label.includes("get a new custom domain");
    });
    if (!option) return { ok: false, reason: "new custom domain option not found" };
    option.focus();
    clickElement(option);
    option.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    option.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
    return { ok: true, text: clean(option.getAttribute("aria-label") || option.innerText || option.textContent) };
  `), 10000);
  if (!selected?.ok) {
    throw new Error(selected?.reason || "Unable to select new custom domain");
  }

  const startedAt = Date.now();
  let clicked = null;
  while (Date.now() - startedAt < 15000) {
    clicked = await evaluate(cdp, sessionId, pageActionExpression(`
      const buttons = [...document.querySelectorAll("button")].filter(visible);
      const button = buttons.find((el) => {
        const text = lower([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" "));
        return !el.disabled && el.getAttribute("aria-disabled") !== "true" && text.includes("continue");
      });
      if (!button) return { ok: false, reason: "enabled continue button not found" };
      clickElement(button);
      return { ok: true, text: clean(button.innerText || button.textContent || button.getAttribute("aria-label")) };
    `), 10000);
    if (clicked?.ok) {
      return { selected, clicked };
    }
    await sleep(500);
  }
  throw new Error(clicked?.reason || "Unable to continue with new domain method");
}

async function clickGetStarted(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, pageActionExpression(`
    const labels = ${json(GET_STARTED_LABELS.map((label) => label.toLowerCase()))};
    const candidates = [
      ...document.querySelectorAll("a[href*='/business/signup'], a[href*='signup'], button, [role='button']")
    ];
    const match = candidates.find((el) => {
      if (!visible(el)) return false;
      const href = String(el.getAttribute("href") || "");
      const text = lower(el.innerText || el.textContent || el.getAttribute("aria-label"));
      return href.includes("/business/signup") || labels.some((label) => text.includes(label));
    });
    if (!match) return { ok: false, reason: "get started not found" };
    clickElement(match);
    return { ok: true, text: clean(match.innerText || match.textContent || match.getAttribute("aria-label")), href: match.getAttribute("href") || "" };
  `), 15000);
  if (!result?.ok) {
    throw new Error(result?.reason || "Unable to click get started");
  }
  return result;
}

async function ensureWelcomeFields(cdp, sessionId, {
  businessName,
  region
}) {
  let result = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    result = await evaluate(cdp, sessionId, pageActionExpression(`
      const desiredName = ${json(businessName)};
      const desiredRegion = ${json(region)};
      const regionAliases = [desiredRegion, "Turkey", "Türkiye", "土耳其"].map((value) => clean(value).toLowerCase());
      const setValue = (el, value) => {
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value")?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const businessInput = document.querySelector("#ucc-0, input[aria-label*='Business' i], input[type='text']");
      if (!businessInput) return { ok: false, reason: "business input not found" };
      if (clean(businessInput.value) !== desiredName) {
        setValue(businessInput, desiredName);
      }

      const employee = document.querySelector("#c4, input[type='radio'][value='1'], input[type='radio'][aria-label='One']");
      if (!employee) return { ok: false, reason: "employee radio not found" };
      if (!employee.checked) {
        clickElement(employee);
        employee.checked = true;
        employee.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const regionCombobox = document.querySelector("[role='combobox'][aria-haspopup='listbox'], [role='combobox'], .rHGeGc-aPP78e");
      const regionText = clean(regionCombobox?.innerText || regionCombobox?.textContent || regionCombobox?.getAttribute("aria-label"));
      const normalizedRegionText = regionText.toLowerCase();
      const regionAlreadySet = regionAliases.some((alias) => normalizedRegionText.includes(alias));
      return {
        ok: true,
        businessName: clean(businessInput.value),
        employeeJustYou: Boolean(employee.checked),
        regionAlreadySet,
        regionText
      };
    `), 15000);
    if (result?.ok || result?.reason !== "business input not found") {
      break;
    }
    await sleep(500);
  }
  if (!result?.ok) {
    throw new Error(result?.reason || "Unable to fill welcome fields");
  }

  if (!result.regionAlreadySet) {
    await chooseRegion(cdp, sessionId, region);
  }
  return result;
}

async function chooseRegion(cdp, sessionId, region) {
  const control = await evaluate(cdp, sessionId, pageActionExpression(`
    const candidates = [...document.querySelectorAll("[role='combobox'][aria-haspopup='listbox'], [role='combobox'], .rHGeGc-aPP78e")];
    const match = candidates.find((el) => visible(el) && /region|country|ülke|bölge|国家|地區/i.test(clean(el.innerText || el.textContent || el.getAttribute("aria-label"))))
      || candidates.find((el) => visible(el) && lower(el.innerText || el.textContent).includes("united state"))
      || candidates.find((el) => visible(el));
    if (!match) return { ok: false, reason: "region selector not found" };
    match.focus();
    const rect = match.getBoundingClientRect();
    return {
      ok: true,
      text: clean(match.innerText || match.textContent || match.getAttribute("aria-label")),
      expanded: match.getAttribute("aria-expanded"),
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    };
  `), 10000);
  if (!control?.ok) {
    throw new Error(control?.reason || "Unable to locate region selector");
  }
  if (control.expanded !== "true") {
    await clickPoint(cdp, sessionId, control.point);
    await sleep(1000);
  }
  const selected = await evaluate(cdp, sessionId, pageActionExpression(`
    const wanted = ${json(region.toLowerCase())};
    const aliases = [wanted, "turkey", "türkiye", "土耳其"];
    const dispatchSelect = (el) => {
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      for (const event of [
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", button: 0, buttons: 1 }),
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 }),
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0 }),
        new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", button: 0, buttons: 0 }),
        new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0 })
      ]) {
        el.dispatchEvent(event);
      }
    };
    const candidates = [
      ...document.querySelectorAll("[role='option'][data-value='TR'], li[data-value='TR'][role='option']"),
      ...document.querySelectorAll("[role='option'], li[role='option']")
    ];
    const match = candidates.find((el) => {
      if (!visible(el)) return false;
      const text = lower([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" "));
      return el.getAttribute("data-value") === "TR" || aliases.some((alias) => text.includes(alias));
    });
    if (!match) return { ok: false, reason: "region option not found" };
    dispatchSelect(match);
    return { ok: true, text: clean(match.innerText || match.textContent || match.getAttribute("aria-label")), selected: match.getAttribute("aria-selected") };
  `), 10000);
  if (!selected?.ok) {
    throw new Error(selected?.reason || "Unable to select region");
  }
  await sleep(800);
  const verified = await evaluate(cdp, sessionId, pageActionExpression(`
    const aliases = [${json(region)}, "Turkey", "Türkiye", "土耳其"].map((value) => clean(value).toLowerCase());
    const regionCombobox = document.querySelector("[role='combobox'][aria-haspopup='listbox'], [role='combobox'], .rHGeGc-aPP78e");
    const regionText = clean(regionCombobox?.innerText || regionCombobox?.textContent || regionCombobox?.getAttribute("aria-label"));
    const ok = aliases.some((alias) => regionText.toLowerCase().includes(alias));
    return { ok, regionText };
  `), 10000);
  if (!verified?.ok) {
    throw new Error(`Region selection did not stick: ${verified?.regionText || ""}`);
  }
  return { control, selected, verified };
}

async function waitForStateChange(cdp, sessionId, previousState) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < 45000) {
    last = await snapshot(cdp, sessionId).catch(() => null);
    if (last?.state && last.state !== previousState) {
      return last;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for page state to change from ${previousState}. Last=${JSON.stringify(last)}`);
}

async function advanceWorkspacePage(cdp, page, options) {
  const history = [];
  for (let step = 1; step <= options.maxSteps; step += 1) {
    const current = await snapshot(cdp, page.sessionId);
    history.push({
      step,
      state: current.state,
      url: current.url,
      businessName: current.businessName,
      employeeJustYou: current.employeeJustYou,
      regionText: current.regionText
    });
    console.log(`[workspace] step ${step}: ${current.state} ${current.url}`);

    if (current.state === WORKSPACE_PAGE_STATES.BUY) {
      return { ok: true, state: current.state, url: current.url, history };
    }

    await dismissCookieBanner(cdp, page.sessionId);

    if (current.state === WORKSPACE_PAGE_STATES.LANDING) {
      await clickGetStarted(cdp, page.sessionId);
      await waitForStateChange(cdp, page.sessionId, current.state);
      continue;
    }

    if (current.state === WORKSPACE_PAGE_STATES.WELCOME) {
      await ensureWelcomeFields(cdp, page.sessionId, {
        businessName: options.businessName,
        region: options.region
      });
      await clickByLabels(cdp, page.sessionId, NEXT_LABELS);
      await waitForStateChange(cdp, page.sessionId, current.state);
      continue;
    }

    if (current.state === WORKSPACE_PAGE_STATES.CONTACT) {
      await clickByLabels(cdp, page.sessionId, NEXT_LABELS);
      await waitForStateChange(cdp, page.sessionId, current.state);
      continue;
    }

    if (current.state === WORKSPACE_PAGE_STATES.SIGNUP_TYPE_SELECT) {
      await selectNewDomainMethod(cdp, page.sessionId);
      await waitForStateChange(cdp, page.sessionId, current.state);
      continue;
    }

    await navigateAndWait(cdp, page.sessionId, WORKSPACE_BUSINESS_URL, 45000).catch(async () => {
      await sleep(3000);
    });
  }

  const current = await snapshot(cdp, page.sessionId).catch(() => null);
  return {
    ok: false,
    state: current?.state || WORKSPACE_PAGE_STATES.UNKNOWN,
    url: current?.url || "",
    history
  };
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

async function readKeywordTable({ sheetUrl, keywordSheet }) {
  const result = await getSheetValues({
    sheetUrl,
    range: `${keywordSheet}!${KEYWORD_TOTAL_READ_COLUMNS}`
  });
  if (!result.ok) {
    throw new Error(`读取 ${keywordSheet} 失败: ${result.reason || result.status || "unknown_error"}`);
  }
  const table = valuesToTable(result.values || []);
  for (const header of ["关键词", "评级", DOMAIN_RECOMMENDATION_HEADER, DOMAIN_PRICE_HEADER]) {
    headerIndex(table.headers, header, keywordSheet);
  }
  return table;
}

async function ensureDomainSearchPage(cdp, page, options) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await snapshot(cdp, page.sessionId);
    if (current.state === WORKSPACE_PAGE_STATES.BUY) {
      return current;
    }
    if (current.state === WORKSPACE_PAGE_STATES.BUY_CONFIRM) {
      await evaluate(cdp, page.sessionId, "history.back()", 10000).catch(() => {});
      const startedAt = Date.now();
      while (Date.now() - startedAt < 20000) {
        const next = await snapshot(cdp, page.sessionId).catch(() => null);
        if (next?.state === WORKSPACE_PAGE_STATES.BUY) {
          return next;
        }
        await sleep(500);
      }
    }
    const result = await advanceWorkspacePage(cdp, page, options);
    if (result.ok) {
      return snapshot(cdp, page.sessionId);
    }
  }
  const current = await snapshot(cdp, page.sessionId).catch(() => null);
  throw new Error(`Unable to return to domain search page. state=${current?.state || ""} url=${current?.url || ""}`);
}

function domainSearchExpression(domain) {
  return pageActionExpression(`
    const wanted = ${json(domain)};
    const inputs = [...document.querySelectorAll("input")].filter(visible);
    const input = inputs.find((el) => /domain|business name|search/i.test([el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.name].filter(Boolean).join(" ")))
      || inputs.find((el) => el.type === "text" || el.type === "search")
      || inputs[0];
    if (!input) return { ok: false, reason: "domain search input not found" };
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
    input.focus();
    if (setter) setter.call(input, wanted);
    else input.value = wanted;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: wanted }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const rect = input.getBoundingClientRect();
    return {
      ok: true,
      value: clean(input.value),
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    };
  `);
}

async function submitDomainSearch(cdp, sessionId, domain) {
  const prepared = await evaluate(cdp, sessionId, domainSearchExpression(domain), 15000);
  if (!prepared?.ok) {
    throw new Error(prepared?.reason || "Unable to set domain search input");
  }
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  }, sessionId);
  return prepared;
}

function domainResultExpression(domain) {
  return pageActionExpression(`
    const expected = ${json(domain.toLowerCase())};
    const escaped = expected.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, "\\\\$&");
    const exactPattern = new RegExp("(^|\\\\s)" + escaped + "($|\\\\s)", "i");
    const rows = [...document.querySelectorAll("[role='row'], [role='option'], li, tr, div")]
      .filter(visible)
      .map((el) => ({ el, text: clean(el.innerText || el.textContent) }))
      .filter((item) => item.text && item.text.length <= 240 && exactPattern.test(item.text));
    const exact = rows.find((item) => lower(item.text).includes(expected));
    if (!exact) {
      return { ok: false, state: "pending", reason: "exact domain row not found" };
    }
    if (/unavailable/i.test(exact.text)) {
      return { ok: true, state: "unavailable", text: exact.text };
    }
    if (/\\/year/i.test(exact.text) || /available/i.test(exact.text)) {
      clickElement(exact.el);
      return { ok: true, state: "selected", text: exact.text };
    }
    return { ok: false, state: "pending", text: exact.text, reason: "exact row has no availability signal" };
  `);
}

async function inspectDomainResult(cdp, sessionId, domain) {
  const current = await snapshot(cdp, sessionId);
  if (current.state === WORKSPACE_PAGE_STATES.BUY_CONFIRM) {
    return {
      state: "available",
      ...parseWorkspaceDomainConfirmation(current.bodyText, domain)
    };
  }
  if (current.state !== WORKSPACE_PAGE_STATES.BUY) {
    return { state: "pending", reason: `unexpected page state ${current.state}` };
  }
  if (isWorkspaceNoLongerAvailableMessage(current.bodyText)) {
    return {
      state: "unavailable",
      text: "The selected domain name is no longer available."
    };
  }
  const result = await evaluate(cdp, sessionId, domainResultExpression(domain), 15000);
  if (result?.state === "unavailable") {
    return { state: "unavailable", text: result.text };
  }
  if (result?.state === "selected") {
    return { state: "selected", text: result.text };
  }
  return { state: "pending", reason: result?.reason || "result pending", text: result?.text || "" };
}

async function searchDomainCandidate(cdp, page, domain, options) {
  await ensureDomainSearchPage(cdp, page, options);
  await submitDomainSearch(cdp, page.sessionId, domain);

  const attempts = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45000) {
    const result = await inspectDomainResult(cdp, page.sessionId, domain).catch((error) => ({
      state: "pending",
      reason: error.message
    }));
    attempts.push(result);
    if (result.state === "available" && result.available) {
      return {
        available: true,
        domain: result.domain || domain,
        price: result.price || "",
        attempts
      };
    }
    if (result.state === "unavailable") {
      return {
        available: false,
        domain,
        price: "",
        reason: "unavailable",
        attempts
      };
    }
    await sleep(result.state === "selected" ? 1000 : 700);
  }
  return {
    available: false,
    domain,
    price: "",
    reason: "timeout",
    attempts
  };
}

async function writeDomainResult({
  sheetUrl,
  keywordSheet,
  keywordTable,
  rowNumber,
  domainRecommendation,
  price,
  dryRun
}) {
  const domainColumn = columnName(headerIndex(keywordTable.headers, DOMAIN_RECOMMENDATION_HEADER, keywordSheet));
  const priceColumn = columnName(headerIndex(keywordTable.headers, DOMAIN_PRICE_HEADER, keywordSheet));
  const data = [
    {
      range: `${quoteSheetName(keywordSheet)}!${domainColumn}${rowNumber}:${domainColumn}${rowNumber}`,
      values: [[domainRecommendation]]
    },
    {
      range: `${quoteSheetName(keywordSheet)}!${priceColumn}${rowNumber}:${priceColumn}${rowNumber}`,
      values: [[price || ""]]
    }
  ];
  if (dryRun) {
    return {
      skipped: true,
      dryRun: true,
      data
    };
  }
  const result = await batchUpdateSheetValues({
    sheetUrl,
    data
  });
  return {
    ...result,
    data
  };
}

async function runDomainResearch({
  cdp,
  page,
  sheetUrl,
  keywordSheet,
  force,
  limit,
  fromRow,
  toRow,
  dryRun,
  writeDelayMs,
  workspaceOptions
}) {
  const keywordTable = await readKeywordTable({
    sheetUrl,
    keywordSheet
  });
  const { selected, skipped } = selectDomainResearchRows(keywordTable.rows, {
    fromRow,
    toRow,
    limit,
    force
  });

  const rows = [];
  for (const row of selected) {
    const keyword = String(row.record?.["关键词"] || "").trim();
    const candidates = buildDomainCandidates(keyword);
    const attempts = [];
    let domainRecommendation = DOMAIN_NOT_FOUND_STATUS;
    let price = "";

    for (const candidate of candidates) {
      console.log(`[domain] row ${row.rowNumber} ${keyword}: try ${candidate}`);
      const result = await searchDomainCandidate(cdp, page, candidate, workspaceOptions);
      attempts.push({
        candidate,
        available: result.available,
        price: result.price,
        reason: result.reason || "",
        lastState: result.attempts.at(-1)?.state || ""
      });
      if (result.available) {
        domainRecommendation = result.domain || candidate;
        price = result.price || "";
        break;
      }
    }

    const writeResult = await writeDomainResult({
      sheetUrl,
      keywordSheet,
      keywordTable,
      rowNumber: row.rowNumber,
      domainRecommendation,
      price,
      dryRun
    });
    if (!writeResult.ok && !writeResult.dryRun) {
      throw new Error(`写入第 ${row.rowNumber} 行域名推荐失败: ${writeResult.reason || writeResult.status || "unknown_error"}`);
    }

    rows.push({
      rowNumber: row.rowNumber,
      keyword,
      candidates,
      attempts,
      domainRecommendation,
      price,
      writeResult
    });
    await ensureDomainSearchPage(cdp, page, workspaceOptions).catch(() => {});
    if (writeDelayMs > 0) {
      await sleep(writeDelayMs);
    }
  }

  return {
    selectedRows: selected.length,
    updatedRows: dryRun ? 0 : rows.filter((row) => row.writeResult?.ok).length,
    skippedRows: skipped.length,
    skipped,
    rows
  };
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const accountSheetName = readArg("account-sheet", "工具账号密码");
  const keywordSheet = readArg("keyword-sheet", KEYWORD_TOTAL_SHEET);
  const startUrl = readArg("start-url", WORKSPACE_BUSINESS_URL);
  const businessName = readArg("business-name", DEFAULT_BUSINESS_NAME);
  const region = readArg("region", DEFAULT_REGION);
  const output = readArg("out", DEFAULT_OUTPUT);
  const maxSteps = Number(readArg("max-steps", "8"));
  const researchDomains = readFlag("research-domains");
  const dryRun = readFlag("dry-run");
  const force = readFlag("force");
  const limit = Number(readArg("limit", "20"));
  const fromRow = Number(readArg("from-row", "0"));
  const toRow = Number(readArg("to-row", "0"));
  const writeDelayMs = Number(readArg("write-delay-ms", "1200"));

  const cdp = new CdpClient(readChromeWebSocketEndpoint());
  await cdp.connect();

  let page;
  try {
    const config = await readBrowserProfileFromToolAccount(cdp, {
      sheetUrl,
      accountSheetName
    });
    console.log(`Browser account: ${config.browserAccount}`);
    console.log(`Chrome profile: ${config.chromeProfile.directory} (${config.chromeProfile.email || config.chromeProfile.name})`);

    const target = await openWorkspaceTarget(cdp, config.chromeProfile, startUrl);
    page = await attachChromePage(cdp, target.targetId);
    await maximizeChromeWindow(cdp, page.targetId);

    const workspaceOptions = {
      businessName,
      region,
      maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 8
    };
    const result = await advanceWorkspacePage(cdp, page, workspaceOptions);
    let domainResearch = null;
    if (result.ok && researchDomains) {
      domainResearch = await runDomainResearch({
        cdp,
        page,
        sheetUrl,
        keywordSheet,
        force,
        limit: Number.isFinite(limit) && limit >= 0 ? limit : 20,
        fromRow: Number.isFinite(fromRow) && fromRow > 0 ? fromRow : 0,
        toRow: Number.isFinite(toRow) && toRow > 0 ? toRow : 0,
        dryRun,
        writeDelayMs: Number.isFinite(writeDelayMs) && writeDelayMs > 0 ? writeDelayMs : 0,
        workspaceOptions
      });
    }
    const payload = {
      source: {
        sheetUrl,
        accountSheetName,
        keywordSheet,
        startUrl,
        businessName,
        region,
        researchDomains,
        dryRun,
        force,
        limit: Number.isFinite(limit) && limit >= 0 ? limit : 20,
        fromRow: Number.isFinite(fromRow) && fromRow > 0 ? fromRow : 0,
        toRow: Number.isFinite(toRow) && toRow > 0 ? toRow : 0,
        readAt: new Date().toISOString()
      },
      browserAccount: config.browserAccount,
      chromeProfile: {
        directory: config.chromeProfile.directory,
        name: config.chromeProfile.name,
        email: config.chromeProfile.email
      },
      result,
      domainResearch
    };
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Wrote ${output}`);

    if (!result.ok) {
      throw new Error(`Workspace domain page was not reached. Final state=${result.state} url=${result.url}`);
    }
    if (domainResearch) {
      console.log(`Domain research rows: selected=${domainResearch.selectedRows}, updated=${domainResearch.updatedRows}, skipped=${domainResearch.skippedRows}`);
    } else {
      console.log(`Workspace domain page ready: ${result.url}`);
    }
  } finally {
    if (page) {
      await detachChromePage(cdp, page.sessionId).catch(() => {});
    }
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

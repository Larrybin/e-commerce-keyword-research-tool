#!/usr/bin/env node
import {
  attachChromePage,
  CdpClient,
  createChromePage,
  detachChromePage,
  evaluate,
  navigateAndWait,
  readChromeWebSocketEndpoint
} from "./lib/cdp.mjs";
import { readArg, readFlag } from "./lib/args.mjs";
import { sleep } from "./lib/browser-actions.mjs";
import { writeJson } from "./lib/files.mjs";
import { batchUpdateSheetValues, getSheetValues } from "./lib/google-sheets-api.mjs";
import { columnName, headerIndex, valuesToTable } from "./lib/table-utils.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import {
  KEYWORD_TOTAL_READ_COLUMNS,
  KEYWORD_TOTAL_SHEET
} from "./lib/sheet-write.mjs";
import {
  buildDomainInfoStatusUpdates,
  buildDomainInfoValues,
  DOMAIN_INFO_HEADERS,
  findAppendStartRow,
  hasCompleteAddressInfo,
  normalizeAddressInfo,
  selectDomainInfoFillRows
} from "./lib/domain-info-fill.mjs";

const TASK_SHEET = "词根拓展";
const DOMAIN_INFO_SHEET = "域名信息补全";
const DOMAIN_INFO_STATUS_HEADER = "域名信息补全";
const ADDRESS_URL = "https://www.meiguodizhi.com/tr-address";

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

async function readTable({ sheetUrl, sheetName, range = "A:ZZ" }) {
  const result = await getSheetValues({
    sheetUrl,
    range: `${sheetName}!${range}`
  });
  if (!result.ok) {
    throw new Error(`读取 ${sheetName} 失败: ${result.reason || result.status || "unknown_error"}`);
  }
  return valuesToTable(result.values || []);
}

function validateHeaders(tableName, headers, requiredHeaders) {
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(`${tableName} 缺少表头: ${missing.join(", ")}`);
  }
}

function pageActionExpression(source) {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    ${source}
  })()`;
}

async function findOrOpenAddressPage(cdp) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets");
  const existing = targetInfos.find((target) =>
    target.type === "page" &&
    /^https:\/\/www\.meiguodizhi\.com\/tr-address(?:$|[?#])/.test(target.url || "")
  );
  if (existing) {
    return attachChromePage(cdp, existing.targetId);
  }
  const page = await createChromePage(cdp);
  await navigateAndWait(cdp, page.sessionId, ADDRESS_URL, 45000);
  return page;
}

async function extractAddressInfo(cdp, sessionId) {
  const raw = await evaluate(cdp, sessionId, pageActionExpression(`
    const fieldValue = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        const value = clean(el?.value || el?.innerText || el?.textContent);
        if (value) return value;
      }
      return "";
    };
    const rows = [...document.querySelectorAll("tr, .row, p, li, div")]
      .map((el) => clean(el.innerText || el.textContent))
      .filter(Boolean);
    const valueByLabel = (labels) => {
      for (const text of rows) {
        const normalized = text.replace(/\\s+/g, " ").trim();
        for (const label of labels) {
          if (normalized.startsWith(label)) {
            return clean(normalized.slice(label.length).replace(/^[:：\\s]+/, ""));
          }
        }
      }
      return "";
    };
    return {
      street: fieldValue([".data_Address", "[name='data_Address']"]) || valueByLabel(["街道", "地址"]),
      city: fieldValue([".data_City", "[name='data_City']"]) || valueByLabel(["城市"]),
      postalCode: fieldValue([".data_Zip_Code", "[name='data_Zip_Code']"]) || valueByLabel(["邮编"]),
      phone: fieldValue([".data_Telephone", "[name='data_Telephone']"]) || valueByLabel(["电话号码", "电话"])
    };
  `), 15000);
  const info = normalizeAddressInfo(raw);
  if (!hasCompleteAddressInfo(info)) {
    throw new Error(`土耳其地址解析失败: ${JSON.stringify({ raw, info })}`);
  }
  return { raw, info };
}

async function tryExtractAddressInfo(cdp, sessionId) {
  return extractAddressInfo(cdp, sessionId).catch(() => null);
}

async function clickRandomAddress(cdp, sessionId, previousStreet, maxAttempts = 8) {
  let lastInvalid = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const clicked = await evaluate(cdp, sessionId, pageActionExpression(`
      const button = document.querySelector("#for-us-btn-2");
      if (!button || !visible(button)) return { ok: false, reason: "random address button not found" };
      button.click();
      return { ok: true, text: clean(button.innerText || button.textContent) };
    `), 10000);
    if (!clicked?.ok) {
      throw new Error(clicked?.reason || "随机地址按钮不可用");
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const next = await tryExtractAddressInfo(cdp, sessionId);
      if (next?.raw?.street && next.raw.street !== previousStreet) {
        return next;
      }
      if (next?.raw?.street) {
        lastInvalid = next.raw;
      }
      await sleep(500);
    }
  }
  throw new Error(`随机地址未生成有效土耳其地址: ${JSON.stringify(lastInvalid || {})}`);
}

async function extractCurrentOrRandomAddress(cdp, sessionId) {
  const current = await tryExtractAddressInfo(cdp, sessionId);
  if (current) {
    return current;
  }
  return clickRandomAddress(cdp, sessionId, "");
}

function assignDomainInfoRowNumbers(selectedRows, domainInfoTable) {
  let nextAppendRow = findAppendStartRow(domainInfoTable.rows);
  return selectedRows.map((item) => {
    const rowNumber = item.existingRow?.rowNumber || nextAppendRow;
    if (!item.existingRow) {
      nextAppendRow += 1;
    }
    return {
      ...item,
      domainInfoRowNumber: rowNumber
    };
  });
}

function buildDomainInfoWriteData(domainInfoTable, rows) {
  const lastColumn = columnName(domainInfoTable.headers.length - 1);
  return rows.map((row) => {
    const values = {
      "关键词": row.keyword,
      "目标域名": row.targetDomain,
      "公司名称": row.companyName,
      "地址": row.addressInfo.address,
      "邮编": row.addressInfo.postalCode,
      "城市": row.addressInfo.city,
      "州": row.addressInfo.state,
      "电话": row.addressInfo.phone
    };
    return {
      rowNumber: row.domainInfoRowNumber,
      range: `${quoteSheetName(DOMAIN_INFO_SHEET)}!A${row.domainInfoRowNumber}:${lastColumn}${row.domainInfoRowNumber}`,
      values: [
        buildDomainInfoValues(
          domainInfoTable.headers,
          row.existingRow?.values || [],
          values
        )
      ]
    };
  });
}

function domainInfoTableWithProposedRows(domainInfoTable, rows) {
  const rowMap = new Map(domainInfoTable.rows.map((row) => [row.rowNumber, row]));
  for (const row of rows) {
    rowMap.set(row.domainInfoRowNumber, {
      rowNumber: row.domainInfoRowNumber,
      values: [],
      record: {
        "关键词": row.keyword,
        "目标域名": row.targetDomain,
        "公司名称": row.companyName,
        "地址": row.addressInfo.address,
        "邮编": row.addressInfo.postalCode,
        "城市": row.addressInfo.city,
        "州": row.addressInfo.state,
        "电话": row.addressInfo.phone
      }
    });
  }
  return {
    headers: domainInfoTable.headers,
    rows: [...rowMap.values()].sort((a, b) => a.rowNumber - b.rowNumber)
  };
}

function buildStatusWriteData(taskTable, keywordTable, domainInfoTable, touchedKeywordRows = null) {
  const statusColumnIndex = headerIndex(taskTable.headers, DOMAIN_INFO_STATUS_HEADER, TASK_SHEET);
  const statusColumn = columnName(statusColumnIndex);
  return buildDomainInfoStatusUpdates(taskTable, keywordTable, domainInfoTable, { touchedKeywordRows })
    .filter((row) => row.value !== String(
      taskTable.rows.find((taskRow) => taskRow.rowNumber === row.rowNumber)?.record?.[DOMAIN_INFO_STATUS_HEADER] || ""
    ).trim())
    .map((row) => ({
      rowNumber: row.rowNumber,
      root: row.root,
      keyword: row.keyword,
      value: row.value,
      range: `${quoteSheetName(TASK_SHEET)}!${statusColumn}${row.rowNumber}:${statusColumn}${row.rowNumber}`,
      values: [[row.value]]
    }));
}

async function main() {
  const sheetUrl = readArg("sheet", process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL);
  const output = readArg("out", "agent-outputs/domain-info-fill.json");
  const dryRun = readFlag("dry-run");
  const force = readFlag("force");
  const limit = Number(readArg("limit", "20"));
  const fromRow = Number(readArg("from-row", "0"));
  const toRow = Number(readArg("to-row", "0"));
  const writeDelayMs = Number(readArg("write-delay-ms", "1200"));

  const [keywordTable, domainInfoTable, taskTable] = await Promise.all([
    readTable({ sheetUrl, sheetName: KEYWORD_TOTAL_SHEET, range: KEYWORD_TOTAL_READ_COLUMNS }),
    readTable({ sheetUrl, sheetName: DOMAIN_INFO_SHEET }),
    readTable({ sheetUrl, sheetName: TASK_SHEET })
  ]);

  validateHeaders(KEYWORD_TOTAL_SHEET, keywordTable.headers, ["词根", "关键词", "评级", "域名推荐"]);
  validateHeaders(DOMAIN_INFO_SHEET, domainInfoTable.headers, DOMAIN_INFO_HEADERS);
  validateHeaders(TASK_SHEET, taskTable.headers, ["词根", "关键词", DOMAIN_INFO_STATUS_HEADER]);

  const selectedPlan = selectDomainInfoFillRows(keywordTable.rows, domainInfoTable.rows, {
    force,
    limit: Number.isFinite(limit) && limit >= 0 ? limit : 20,
    fromRow: Number.isFinite(fromRow) && fromRow > 0 ? fromRow : 0,
    toRow: Number.isFinite(toRow) && toRow > 0 ? toRow : 0
  });
  const plannedRows = assignDomainInfoRowNumbers(selectedPlan.selected, domainInfoTable);

  const cdp = new CdpClient(readChromeWebSocketEndpoint());
  await cdp.connect();

  let page;
  const completedRows = [];
  try {
    if (plannedRows.length > 0) {
      page = await findOrOpenAddressPage(cdp);
    }

    for (const row of plannedRows) {
      const extracted = await extractCurrentOrRandomAddress(cdp, page.sessionId);
      const completed = {
        ...row,
        addressInfo: extracted.info,
        rawAddressInfo: extracted.raw
      };
      completedRows.push(completed);
      console.log(`[domain-info] row ${row.keywordRow.rowNumber} ${row.keyword}: ${row.targetDomain}`);
      await clickRandomAddress(cdp, page.sessionId, extracted.raw.street);
      if (writeDelayMs > 0) {
        await sleep(writeDelayMs);
      }
    }
  } finally {
    if (page) {
      await detachChromePage(cdp, page.sessionId).catch(() => {});
    }
    cdp.close();
  }

  const domainInfoWriteData = buildDomainInfoWriteData(domainInfoTable, completedRows);
  const proposedDomainInfoTable = domainInfoTableWithProposedRows(domainInfoTable, completedRows);
  const statusWriteData = buildStatusWriteData(
    taskTable,
    keywordTable,
    proposedDomainInfoTable,
    completedRows.map((row) => row.keywordRow)
  );
  const data = [
    ...domainInfoWriteData.map(({ range, values }) => ({ range, values })),
    ...statusWriteData.map(({ range, values }) => ({ range, values }))
  ];

  let writeResult = { skipped: true, dryRun: true };
  if (!dryRun && data.length > 0) {
    writeResult = await batchUpdateSheetValues({ sheetUrl, data, valueInputOption: "RAW" });
    if (!writeResult.ok) {
      throw new Error(`写入域名信息补全失败: ${writeResult.reason || writeResult.status || "unknown_error"}`);
    }
  }

  const summary = {
    source: {
      sheetUrl,
      keywordSheet: KEYWORD_TOTAL_SHEET,
      domainInfoSheet: DOMAIN_INFO_SHEET,
      taskSheet: TASK_SHEET,
      dryRun,
      force,
      limit: Number.isFinite(limit) && limit >= 0 ? limit : 20,
      fromRow: Number.isFinite(fromRow) && fromRow > 0 ? fromRow : 0,
      toRow: Number.isFinite(toRow) && toRow > 0 ? toRow : 0,
      readAt: new Date().toISOString()
    },
    selectedRows: plannedRows.length,
    completedRows: completedRows.length,
    domainInfoWriteRows: domainInfoWriteData.length,
    statusWriteRows: statusWriteData.length,
    skippedRows: selectedPlan.skipped.length,
    rows: completedRows.map((row) => ({
      keywordRowNumber: row.keywordRow.rowNumber,
      domainInfoRowNumber: row.domainInfoRowNumber,
      keyword: row.keyword,
      targetDomain: row.targetDomain,
      companyName: row.companyName,
      addressInfo: row.addressInfo
    })),
    statusRows: statusWriteData.map(({ rowNumber, root, keyword, value, range }) => ({
      rowNumber,
      root,
      keyword,
      value,
      range
    })),
    skipped: selectedPlan.skipped,
    writeResult
  };

  await writeJson(output, summary);
  console.log(
    `${dryRun ? "Dry-run" : "Updated"} ${summary.domainInfoWriteRows} domain info row(s), ${summary.statusWriteRows} status row(s). Wrote ${output}`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

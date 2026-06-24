import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSpreadsheetId } from "./google-sheet.mjs";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function findDefaultServiceAccountKeyPath() {
  const explicit = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const secretsDir = path.resolve("secrets");
  if (!fs.existsSync(secretsDir)) {
    return "";
  }
  const file = fs.readdirSync(secretsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(secretsDir, name))
    .find((candidate) => {
      try {
        const json = JSON.parse(fs.readFileSync(candidate, "utf8"));
        return json.type === "service_account" && json.client_email && json.private_key;
      } catch {
        return false;
      }
    });
  return file || "";
}

export function resolveServiceAccountKeyPath(keyPath = "") {
  if (keyPath) {
    return keyPath;
  }
  return findDefaultServiceAccountKeyPath();
}

export async function getServiceAccountAccessToken(keyPath = "") {
  const resolvedKeyPath = resolveServiceAccountKeyPath(keyPath);
  if (!resolvedKeyPath) {
    return { ok: false, skipped: true, reason: "service_account_key_not_found" };
  }

  const key = JSON.parse(fs.readFileSync(resolvedKeyPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: key.client_email,
    scope: SHEETS_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(key.private_key).toString("base64url")}`;

  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt
        })
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(500 * attempt);
      }
    }
  }
  if (!response) {
    return { ok: false, reason: lastError?.message || "token_fetch_failed" };
  }
  const data = await response.json();
  if (!response.ok) {
    return { ok: false, status: response.status, reason: data.error_description || data.error || "token_request_failed" };
  }

  return {
    ok: true,
    accessToken: data.access_token,
    clientEmail: key.client_email,
    keyPath: resolvedKeyPath
  };
}

async function sheetsApiFetch({
  sheetUrl,
  path,
  method = "GET",
  body,
  keyPath = ""
}) {
  const token = await getServiceAccountAccessToken(keyPath);
  if (!token.ok) {
    return { ok: false, skipped: true, reason: token.reason, status: token.status };
  }

  const spreadsheetId = getSpreadsheetId(sheetUrl);
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json"
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        break;
      }
      if (attempt < 3) {
        await sleep(750 * attempt);
      }
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(750 * attempt);
      }
    }
  }
  if (!response) {
    return { ok: false, reason: lastError?.message || "sheets_api_fetch_failed" };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: data.error?.message || response.statusText || "sheets_api_request_failed",
      data
    };
  }

  return {
    ok: true,
    data,
    clientEmail: token.clientEmail
  };
}

export async function getSheetValues({ sheetUrl, range, keyPath = "" }) {
  const result = await sheetsApiFetch({
    sheetUrl,
    keyPath,
    path: `/values/${encodeURIComponent(range)}`
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    range: result.data.range,
    values: result.data.values || [],
    clientEmail: result.clientEmail
  };
}

export async function getSpreadsheetSheets({ sheetUrl, keyPath = "" }) {
  const result = await sheetsApiFetch({
    sheetUrl,
    keyPath,
    path: "?fields=sheets.properties"
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    sheets: result.data.sheets || [],
    clientEmail: result.clientEmail
  };
}

export async function updateSheetValues({
  sheetUrl,
  range,
  values,
  valueInputOption = "USER_ENTERED",
  keyPath = ""
}) {
  const result = await sheetsApiFetch({
    sheetUrl,
    keyPath,
    method: "PUT",
    path: `/values/${encodeURIComponent(range)}?valueInputOption=${encodeURIComponent(valueInputOption)}`,
    body: { values }
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    ...result.data,
    clientEmail: result.clientEmail
  };
}

export async function batchUpdateSheetValues({
  sheetUrl,
  data,
  valueInputOption = "USER_ENTERED",
  keyPath = ""
}) {
  const result = await sheetsApiFetch({
    sheetUrl,
    keyPath,
    method: "POST",
    path: "/values:batchUpdate",
    body: { valueInputOption, data }
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    ...result.data,
    clientEmail: result.clientEmail
  };
}

export async function clearSheetValues({ sheetUrl, range, keyPath = "" }) {
  const result = await sheetsApiFetch({
    sheetUrl,
    keyPath,
    method: "POST",
    path: `/values/${encodeURIComponent(range)}:clear`,
    body: {}
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    ...result.data,
    clientEmail: result.clientEmail
  };
}

export async function batchUpdateSheet({ sheetUrl, requests, keyPath = "" }) {
  const result = await sheetsApiFetch({
    sheetUrl,
    keyPath,
    method: "POST",
    path: ":batchUpdate",
    body: { requests }
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    replies: result.data.replies || [],
    clientEmail: result.clientEmail
  };
}

export function buildRejectedKeywordCellFormatRequests({ sheetId, startRow, rows }) {
  const requests = [];
  rows.forEach((row, index) => {
    const rowIndex = startRow + index - 1;
    requests.push({
      repeatCell: {
        range: {
          sheetId: Number(sheetId),
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: 1,
          endColumnIndex: 2
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: row?.判断 === "拒绝"
              ? { red: 1, green: 0, blue: 0 }
              : { red: 1, green: 1, blue: 1 }
          }
        },
        fields: "userEnteredFormat.backgroundColor"
      }
    });
  });
  return requests;
}

export async function formatRejectedKeywordCells({
  sheetUrl,
  sheetId,
  startRow,
  rows,
  keyPath = ""
}) {
  const requests = buildRejectedKeywordCellFormatRequests({ sheetId, startRow, rows });
  if (requests.length === 0) {
    return { skipped: true, reason: "no_rejected_rows" };
  }

  const result = await batchUpdateSheet({ sheetUrl, requests, keyPath });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      reason: result.reason || "batch_update_failed"
    };
  }

  return {
    ok: true,
    formattedCells: requests.length,
    clientEmail: result.clientEmail
  };
}

export function buildCellBackgroundRequests({ sheetId, cells, color }) {
  return cells.map((cell) => ({
    repeatCell: {
      range: {
        sheetId: Number(sheetId),
        startRowIndex: Number(cell.row) - 1,
        endRowIndex: Number(cell.row),
        startColumnIndex: Number(cell.column),
        endColumnIndex: Number(cell.column) + 1
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: color
        }
      },
      fields: "userEnteredFormat.backgroundColor"
    }
  }));
}

export async function formatCellBackgrounds({
  sheetUrl,
  sheetId,
  cells,
  color = { red: 1, green: 0, blue: 0 },
  keyPath = ""
}) {
  if (!cells.length) {
    return { skipped: true, reason: "no_cells" };
  }
  const result = await batchUpdateSheet({
    sheetUrl,
    keyPath,
    requests: buildCellBackgroundRequests({ sheetId, cells, color })
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      reason: result.reason || "batch_update_failed"
    };
  }
  return {
    ok: true,
    formattedCells: cells.length,
    clientEmail: result.clientEmail
  };
}

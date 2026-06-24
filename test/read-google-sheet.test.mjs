import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { readGoogleSheetInput } from "../src/read-google-sheet.mjs";
import { DEFAULT_SHEET_URL } from "../src/lib/tool-config.mjs";

test("readGoogleSheetInput builds the read:sheet payload from API sheet rows", async () => {
  const calls = [];
  const payload = await readGoogleSheetInput({
    now: () => new Date("2026-06-24T00:00:00.000Z"),
    findProfile: (account) => ({
      directory: "Profile 1",
      name: "Profile 1",
      email: account,
      fullName: "Profile One"
    }),
    readSheet: async (request) => {
      calls.push(request);
      if (request.sheetName === "工具账号密码") {
        return {
          csvUrl: "https://example.com/account.csv",
          headers: ["semrush账号", "semrush密码", "运行浏览器账号"],
          rows: [
            {
              semrush账号: "demo",
              semrush密码: "secret",
              运行浏览器账号: "browser@example.com"
            }
          ]
        };
      }
      return {
        csvUrl: "https://example.com/keywords.csv",
        headers: ["词根", "关键词"],
        rows: [{ 词根: "filter", 关键词: "" }]
      };
    }
  });

  assert.equal(calls[0].sheetUrl, DEFAULT_SHEET_URL);
  assert.equal(calls[0].sheetName, "工具账号密码");
  assert.equal(calls[1].sheetName, "词根拓展");
  assert.equal(payload.source.sheetUrl, DEFAULT_SHEET_URL);
  assert.equal(payload.source.readAt, "2026-06-24T00:00:00.000Z");
  assert.equal(payload.toolAccount["运行浏览器账号"], "browser@example.com");
  assert.equal(payload.chromeProfile.directory, "Profile 1");
  assert.equal(payload.sheets["工具账号密码"].rows[0].semrush密码, "***");
  assert.deepEqual(payload.sheets["词根拓展"].rows, [{ 词根: "filter", 关键词: "" }]);
});

test("read:sheet uses the shared default sheet URL instead of a local literal", async () => {
  const source = await fs.readFile(new URL("../src/read-google-sheet.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /docs\.google\.com\/spreadsheets\/d/);
});

test("readGoogleSheetInput does not require a local Chrome profile", async () => {
  const payload = await readGoogleSheetInput({
    findProfile: () => {
      throw new Error("profile missing");
    },
    readSheet: async (request) => {
      if (request.sheetName === "工具账号密码") {
        return {
          csvUrl: "https://example.com/account.csv",
          headers: ["semrush账号", "semrush密码", "运行浏览器账号"],
          rows: [
            {
              semrush账号: "demo",
              semrush密码: "secret",
              运行浏览器账号: "browser@example.com"
            }
          ]
        };
      }
      return {
        csvUrl: "https://example.com/keywords.csv",
        headers: ["词根", "关键词"],
        rows: []
      };
    }
  });

  assert.deepEqual(payload.chromeProfile, {
    directory: "",
    name: "",
    email: "browser@example.com",
    fullName: ""
  });
});

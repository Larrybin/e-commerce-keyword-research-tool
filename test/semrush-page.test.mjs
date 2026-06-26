import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import {
  buildKeywordMagicApiPayload,
  buildKeywordMagicUrl,
  isSemrushNodeUnavailableMessage,
  keywordMagicApiKeywordsToRows,
  readCurrentPageUrl,
  semrushNodeNumberFromText
} from "../src/lib/semrush-page.mjs";

function decodeFilter(url) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(url.searchParams.get("filter"), "base64")).toString("utf8"));
}

function excludedTerms(url) {
  return decodeFilter(url).phrase.map((item) => item.value);
}

test("buildKeywordMagicUrl opens Keyword Magic with match type and numeric filters", () => {
  const url = new URL(buildKeywordMagicUrl("https://sem.3ue.com/analytics/keywordoverview/?q=old&db=uk&__gmitm=token", {
    query: "Home Audio & Theater",
    country: "美国",
    matchType: "词组匹配",
    volumeMin: "10000",
    kdMax: "60"
  }));

  assert.equal(url.pathname, "/analytics/keywordmagic/");
  assert.equal(url.searchParams.get("q"), "Home Audio & Theater");
  assert.equal(url.searchParams.get("db"), "us");
  assert.equal(url.searchParams.get("type"), "phrase");
  assert.equal(url.searchParams.get("__gmitm"), "token");
  assert.deepEqual(decodeFilter(url).volume, [{ inverted: false, operation: 5, value: 10000 }]);
  assert.deepEqual(decodeFilter(url).difficulty, [{ inverted: false, operation: 4, value: 60 }]);
  assert.deepEqual(decodeFilter(url).phrase[0].inverted, true);
  assert.ok(excludedTerms(url).includes("how"));
  assert.ok(excludedTerms(url).includes("porn"));
});

test("buildKeywordMagicUrl omits type but keeps default exclude filters", () => {
  const url = new URL(buildKeywordMagicUrl("https://sem.3ue.com/analytics/keywordoverview/?q=old&db=us", {
    query: "camera",
    matchType: "所有关键词"
  }));

  assert.equal(url.searchParams.get("type"), null);
  assert.ok(excludedTerms(url).includes("what"));
});

test("readCurrentPageUrl uses CDP navigation history before page JavaScript", async () => {
  const cdp = {
    async send(method) {
      assert.equal(method, "Page.getNavigationHistory");
      return {
        currentIndex: 1,
        entries: [
          { url: "about:blank" },
          { url: "https://sem.3ue.com/analytics/keywordoverview/?q=Props&db=us" }
        ]
      };
    }
  };

  assert.equal(
    await readCurrentPageUrl(cdp, "session-1"),
    "https://sem.3ue.com/analytics/keywordoverview/?q=Props&db=us"
  );
});

test("semrush node helpers parse node errors", () => {
  assert.equal(semrushNodeNumberFromText("节点4 倍率 X 1 GURU 地区数据库 NO MY ❌"), 4);
  assert.equal(semrushNodeNumberFromText("node 4"), 0);
  assert.equal(isSemrushNodeUnavailableMessage("节点暂不可用，请30分钟后尝试重新打开或切换节点。code: 1"), true);
  assert.equal(isSemrushNodeUnavailableMessage("普通加载失败"), false);
});

test("buildKeywordMagicApiPayload mirrors the opened phrase-match Keyword Magic URL", () => {
  const url = buildKeywordMagicUrl("https://sem.3ue.com/analytics/keywordoverview/?q=old&db=uk&__gmitm=token", {
    query: "water filter",
    country: "美国",
    matchType: "词组匹配",
    volumeMin: "1000",
    kdMax: "60"
  });
  const payload = buildKeywordMagicApiPayload(url, { page: 2, pageSize: 100 });

  assert.equal(payload.method, "ideas.GetKeywords");
  assert.equal(payload.params.mode, 1);
  assert.equal(payload.params.phrase, "water filter");
  assert.equal(payload.params.database, "us");
  assert.deepEqual(payload.params.page, { number: 2, size: 100 });
  assert.deepEqual(payload.params.filter.volume, [{ inverted: false, operation: 5, value: 1000 }]);
  assert.deepEqual(payload.params.filter.difficulty, [{ inverted: false, operation: 4, value: 60 }]);
  assert.deepEqual(payload.params.filter.phrase[0].operation, 7);
  assert.ok(payload.params.filter.phrase.some((item) => item.value === "password generator"));
});

test("keywordMagicApiKeywordsToRows formats API keyword rows like DOM extraction", () => {
  assert.deepEqual(
    keywordMagicApiKeywordsToRows([
      { phrase: "reverse osmosis water filter", volume: 135000, difficulty: 54 },
      { phrase: "culligan water filter", volume: 90500, difficulty: 40 }
    ], {
      root: "water filter",
      query: "water filter",
      page: 3
    }),
    [
      {
        root: "water filter",
        source_query: "water filter",
        keyword: "reverse osmosis water filter",
        volume: "135.0K",
        kd: "54",
        semrush_page: 3
      },
      {
        root: "water filter",
        source_query: "water filter",
        keyword: "culligan water filter",
        volume: "90.5K",
        kd: "40",
        semrush_page: 3
      }
    ]
  );
});

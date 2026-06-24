import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import {
  buildKeywordMagicApiPayload,
  buildKeywordMagicUrl,
  keywordMagicApiKeywordsToRows
} from "../src/lib/semrush-page.mjs";

function decodeFilter(url) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(url.searchParams.get("filter"), "base64")).toString("utf8"));
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
});

test("buildKeywordMagicUrl omits type and filter when no direct URL filter is needed", () => {
  const url = new URL(buildKeywordMagicUrl("https://sem.3ue.com/analytics/keywordoverview/?q=old&db=us", {
    query: "camera",
    matchType: "所有关键词"
  }));

  assert.equal(url.searchParams.get("type"), null);
  assert.equal(url.searchParams.get("filter"), null);
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

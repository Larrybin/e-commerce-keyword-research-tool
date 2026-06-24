import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleSearchUrl,
  buildGoogleUule,
  normalizeGoogleResultUrl
} from "../src/lib/google-precheck.mjs";

test("buildGoogleUule matches Valentin latitude/longitude encoding shape", () => {
  const uule = buildGoogleUule({
    latitude: 37.421,
    longitude: -122.084,
    now: 1591521249034
  });

  assert.equal(uule.startsWith("a "), true);
  const decoded = Buffer.from(uule.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  assert.match(decoded, /latitude_e7:374210000/);
  assert.match(decoded, /longitude_e7:-1220840000/);
  assert.match(decoded, /radius:93000/);
});

test("buildGoogleSearchUrl includes localized Google parameters", () => {
  const url = new URL(buildGoogleSearchUrl({
    keyword: "water filter",
    hl: "en",
    gl: "US",
    latitude: 37.421,
    longitude: -122.084,
    num: 20,
    now: 1591521249034
  }));

  assert.equal(url.origin + url.pathname, "https://www.google.com/search");
  assert.equal(url.searchParams.get("q"), "water filter");
  assert.equal(url.searchParams.get("hl"), "en");
  assert.equal(url.searchParams.get("gl"), "US");
  assert.equal(url.searchParams.get("pws"), "0");
  assert.equal(url.searchParams.get("num"), "20");
  assert.match(url.searchParams.get("uule"), /^a /);
});

test("normalizeGoogleResultUrl unwraps Google redirect links and drops Google-owned URLs", () => {
  assert.equal(
    normalizeGoogleResultUrl("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fproduct&sa=U"),
    "https://example.com/product"
  );
  assert.equal(normalizeGoogleResultUrl("https://www.google.com/search?q=test"), "");
  assert.equal(normalizeGoogleResultUrl("not a url"), "");
});

import assert from "node:assert/strict";
import test from "node:test";
import { isSemrushReadyKind } from "../src/semrush-ensure.mjs";

test("semrush ensure accepts already-open Semrush pages without dummy keyword requests", () => {
  assert.equal(isSemrushReadyKind("semrush_home"), true);
  assert.equal(isSemrushReadyKind("semrush_keyword_overview"), true);
  assert.equal(isSemrushReadyKind("semrush_keyword_magic"), true);
  assert.equal(isSemrushReadyKind("dash_home"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildPrefilterCellUpdate, collectPrefilterRows } from "../src/keyword-agent-prefilter.mjs";
import { evaluateKeywordAgentPrefilter } from "../src/lib/keyword-agent-prefilter.mjs";

function judgement(keyword) {
  return evaluateKeywordAgentPrefilter({ 关键词: keyword });
}

test("agent prefilter keeps ecommerce product and guide keywords", () => {
  assert.equal(judgement("portable generator").judgement, "继续");
  assert.equal(judgement("generator replacement battery").judgement, "继续");
  assert.equal(judgement("best water filter pitcher").judgement, "继续");
  assert.equal(judgement("slim car seats").judgement, "继续");
});

test("agent prefilter rejects non ecommerce, tool, and b2b keywords", () => {
  assert.equal(judgement("barcode generator").reason, "tool_intent");
  assert.equal(judgement("mla citation generator").reason, "tool_intent");
  assert.equal(judgement("generator repair near me").reason, "non_ecommerce_intent");
  assert.equal(judgement("gaming microphone manufacturer").reason, "b2b_intent");
  assert.equal(judgement("replica rolex").reason, "high_risk");
});

test("agent prefilter selects keyword rows without existing prefilter", () => {
  const result = collectPrefilterRows({
    headers: ["关键词", "agent预判断"],
    rows: [
      { rowNumber: 2, values: ["portable generator", ""] },
      { rowNumber: 3, values: ["barcode generator", "拒绝"] }
    ]
  });

  assert.deepEqual(result.rows.map((row) => row.rowNumber), [2]);
  assert.deepEqual(result.skipped, [
    { row: 3, keyword: "barcode generator", status: "skipped", reason: "prefilter_already_filled" }
  ]);
});

test("agent prefilter writes only the agent prefilter column", () => {
  const update = buildPrefilterCellUpdate(
    ["关键词", "agent预判断", "购买意图"],
    { rowNumber: 7, values: ["barcode generator", "", ""] },
    { judgement: "拒绝" }
  );

  assert.deepEqual(update, {
    skipped: false,
    range: "关键词总表!B7",
    values: [["拒绝"]]
  });
});

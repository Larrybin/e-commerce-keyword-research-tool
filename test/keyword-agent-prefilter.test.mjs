import assert from "node:assert/strict";
import test from "node:test";
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


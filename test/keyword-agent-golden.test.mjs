import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateKeywordAgentRow } from "../src/lib/keyword-agent-rules.mjs";
import { validateLLMOutput } from "../src/lib/openai-keyword-agent.mjs";

const fixtureUrl = new URL("./fixtures/keyword-agent-golden.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
function keywordRow(keyword, rowNumber) { return { rowNumber, record: { "关键词": keyword } }; }
function assertIncludesAny(text, needles, label) { const value = String(text || ""); assert.ok(needles.some((needle) => value.includes(needle)), `${label} should include one of ${needles.join(", ")}; got ${value}`); }
function assertWarningsIncludeAny(warnings, needles) { assertIncludesAny((warnings || []).map((warning) => `${warning.field || ""} ${warning.reason || ""}`).join(" "), needles, "warnings"); }
function assertExpectedFields(values, expected) {
  for (const field of ["购买意图", "产品类型", "评级", "agent状态"]) if (Object.hasOwn(expected, field)) assert.equal(values[field], expected[field], `${field} mismatch`);
  if (expected["判断依据IncludesAny"]) assertIncludesAny(values["判断依据"], expected["判断依据IncludesAny"], "判断依据");
  if (expected["建议IncludesAny"]) assertIncludesAny(values["建议"], expected["建议IncludesAny"], "建议");
  if (expected["判断依据Or建议IncludesAny"]) assertIncludesAny(`${values["判断依据"] || ""} ${values["建议"] || ""}`, expected["判断依据Or建议IncludesAny"], "判断依据/建议");
}
for (const [index, currentCase] of fixture.rulesCases.entries()) {
  test(`keyword agent golden rules: ${currentCase.name}`, () => assertExpectedFields(evaluateKeywordAgentRow(keywordRow(currentCase.keyword, index + 2), currentCase.rule).values, currentCase.expect));
}
for (const currentCase of fixture.validatorCases) {
  test(`keyword agent golden validator: ${currentCase.name}`, () => {
    const result = validateLLMOutput(currentCase.row, currentCase.llmOutput, currentCase.customerConfig || {});
    assertExpectedFields(result.values, currentCase.expect);
    if (currentCase.expect.warningsIncludesAny) assertWarningsIncludeAny(result.warnings, currentCase.expect.warningsIncludesAny);
  });
}
test("keyword agent golden fixture has expected ecommerce/B2B coverage", () => {
  assert.equal(fixture.rulesCases.length >= 12, true);
  assert.equal(fixture.validatorCases.length >= 3, true);
});

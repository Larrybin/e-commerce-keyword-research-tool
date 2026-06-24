import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_STATUS_COLUMN, KEYWORD_AGENT_SYSTEM_PROMPT, buildPromptPayload, normalizeDecision, resolveKeywordAgentLLMConfig, validateLLMOutput } from "../src/lib/openai-keyword-agent.mjs";

test("system prompt documents ecommerce and B2B judgement rules", () => {
  for (const expected of ["电子商务 + B端", "实体商品", "配件耗材", "supplier", "manufacturer", "目标模式 / 可售品类", "购买意图", "产品类型", "不能按工具站逻辑排除", "counterfeit", "replica"]) {
    assert.match(KEYWORD_AGENT_SYSTEM_PROMPT, new RegExp(expected.replace(/[()+]/g, "\\$&")));
  }
});

test("prompt payload uses target mode and sellable category rule columns", () => {
  const payload = buildPromptPayload([{ rowNumber: 2, keyword: "generator parts", keywordRecord: { "词根": "generator", "关键词": "generator parts" }, rule: { "词根": "generator", "目标模式": "电商,B端", "可售品类": "parts, accessories" } }]);
  assert.deepEqual(payload.rules.targetColumns, ["购买意图", "产品类型", "建议", "判断依据", "评级"]);
  assert.deepEqual(payload.rules.ruleColumns, ["目标模式", "可售品类"]);
  assert.deepEqual(payload.rows[0].customerConfig.targetModes, ["电商", "B端"]);
  assert.equal(payload.rows[0].customerConfig.sellableCategories, "parts, accessories");
});

test("LLM config defaults to DeepSeek and can select OpenAI", () => {
  const originalProvider = process.env.KEYWORD_AGENT_LLM_PROVIDER;
  const originalAgentModel = process.env.KEYWORD_AGENT_MODEL;
  const originalDeepSeekModel = process.env.DEEPSEEK_MODEL;
  const originalOpenAIModel = process.env.OPENAI_MODEL;
  delete process.env.KEYWORD_AGENT_LLM_PROVIDER;
  delete process.env.KEYWORD_AGENT_MODEL;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.OPENAI_MODEL;
  try {
    assert.deepEqual(
      {
        provider: resolveKeywordAgentLLMConfig().provider,
        model: resolveKeywordAgentLLMConfig().model
      },
      { provider: "deepseek", model: "deepseek-v4-flash" }
    );
    process.env.OPENAI_MODEL = "gpt-test";
    assert.deepEqual(
      {
        provider: resolveKeywordAgentLLMConfig({ provider: "openai" }).provider,
        model: resolveKeywordAgentLLMConfig({ provider: "openai" }).model
      },
      { provider: "openai", model: "gpt-test" }
    );
  } finally {
    if (originalProvider === undefined) delete process.env.KEYWORD_AGENT_LLM_PROVIDER;
    else process.env.KEYWORD_AGENT_LLM_PROVIDER = originalProvider;
    if (originalAgentModel === undefined) delete process.env.KEYWORD_AGENT_MODEL;
    else process.env.KEYWORD_AGENT_MODEL = originalAgentModel;
    if (originalDeepSeekModel === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = originalDeepSeekModel;
    if (originalOpenAIModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = originalOpenAIModel;
  }
});

test("normalizer writes excluded ecommerce rows with new fields and status", () => {
  const result = normalizeDecision({ rowNumber: 1, purchaseIntent: "排除", productType: "高风险品类", recommendation: "", rationale: "仿牌商品存在侵权风险", rating: "" });
  assert.equal(result.values["购买意图"], "排除");
  assert.equal(result.values["产品类型"], "高风险品类");
  assert.equal(result.values[AGENT_STATUS_COLUMN], "排除");
  assert.equal(result.values["建议"], undefined);
});

test("validator preserves ecommerce physical products and recalculates rating", () => {
  const result = validateLLMOutput({ rowNumber: 2, keyword: "portable generator", rule: { "目标模式": "电商", "可售品类": "generators" } }, { rowNumber: 2, purchaseIntent: "中", productType: "实体商品", recommendation: "可做电商候选，先验证供应链", rationale: "实体商品，有购买意图但履约较重", rating: "A" });
  assert.equal(result.values["购买意图"], "中");
  assert.equal(result.values["产品类型"], "实体商品");
  assert.equal(result.values["评级"], "C");
  assert.ok(result.warnings.some((item) => item.field === "评级"));
});

test("validator fills invalid LLM output using ecommerce/B2B fallbacks", () => {
  const result = validateLLMOutput({ rowNumber: 3, keyword: "generator replacement battery", rule: { "目标模式": "电商", "可售品类": "parts" } }, { rowNumber: 3, purchaseIntent: "maybe", productType: "bad", recommendation: "", rationale: "", rating: "Z" });
  assert.equal(result.values["购买意图"], "强");
  assert.equal(result.values["产品类型"], "配件耗材");
  assert.equal(result.values["评级"], "A");
  assert.ok(result.values["建议"]);
  assert.ok(result.values["判断依据"]);
  assert.ok(result.warnings.length >= 4);
});

test("validator hard-excludes high-risk products even if LLM continues", () => {
  const result = validateLLMOutput({ rowNumber: 4, keyword: "replica rolex" }, { rowNumber: 4, purchaseIntent: "强", productType: "实体商品", recommendation: "做电商", rationale: "购买意图强", rating: "A" });
  assert.equal(result.values["购买意图"], "排除");
  assert.equal(result.values["agent状态"], "排除");
});

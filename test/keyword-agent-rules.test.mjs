import assert from "node:assert/strict";
import test from "node:test";
import { evaluateKeywordAgentRow, targetAgentColumns } from "../src/lib/keyword-agent-rules.mjs";

const commerceRule = { "目标模式": "电商,B端", "可售品类": "generator, parts, accessories" };
const ecommerceOnlyRule = { "目标模式": "电商", "可售品类": "consumer products, parts" };
const b2bOnlyRule = { "目标模式": "B端", "可售品类": "industrial products" };
function row(keyword) { return { record: { "关键词": keyword } }; }

test("agent target columns are ecommerce/B2B business fields", () => {
  assert.deepEqual(targetAgentColumns(), ["购买意图", "产品类型", "建议", "判断依据", "评级"]);
});

test("physical ecommerce product keywords are kept instead of excluded", () => {
  for (const keyword of ["portable generator", "solar generator"]) {
    const result = evaluateKeywordAgentRow(row(keyword), commerceRule);
    assert.equal(result.values["agent状态"], "完成");
    assert.equal(result.values["产品类型"], "实体商品");
    assert.notEqual(result.values["购买意图"], "排除");
    assert.match(result.values["判断依据"], /实体商品|物流|履约|认证/);
  }
});

test("parts and accessories are strong ecommerce opportunities", () => {
  const result = evaluateKeywordAgentRow(row("generator replacement battery"), commerceRule);
  assert.equal(result.values["购买意图"], "强");
  assert.equal(result.values["产品类型"], "配件耗材");
  assert.equal(result.values["评级"], "A");
  assert.match(result.values["建议"], /配件|耗材|SKU|毛利/);
});

test("B2B supplier keywords are kept for B端 target mode", () => {
  const result = evaluateKeywordAgentRow(row("gaming microphone manufacturer"), b2bOnlyRule);
  assert.equal(result.values["购买意图"], "B端采购");
  assert.equal(result.values["产品类型"], "B端采购");
  assert.equal(result.values["agent状态"], "完成");
  assert.match(`${result.values["建议"]} ${result.values["判断依据"]}`, /B端|询盘|MOQ|报价|采购/);
});

test("B2B supplier keywords are rejected when only ecommerce target mode is allowed", () => {
  const result = evaluateKeywordAgentRow(row("memory chip distributor"), ecommerceOnlyRule);
  assert.equal(result.values["购买意图"], "排除");
  assert.equal(result.values["agent状态"], "排除");
  assert.match(result.values["判断依据"], /不匹配目标模式|B端/);
});

test("review and comparison keywords become content commerce opportunities", () => {
  const result = evaluateKeywordAgentRow(row("best portable generator reviews"), commerceRule);
  assert.equal(result.values["产品类型"], "导购评测");
  assert.equal(result.values["购买意图"], "中");
  assert.match(result.values["建议"], /内容导购|联盟|评测/);
});

test("brand product keywords are kept but downgraded for trademark/authorization risk", () => {
  const result = evaluateKeywordAgentRow(row("honda generator price"), commerceRule);
  assert.equal(result.values["产品类型"], "品牌商品");
  assert.equal(result.values["购买意图"], "强");
  assert.equal(result.values["评级"], "C");
  assert.match(`${result.values["建议"]} ${result.values["判断依据"]}`, /品牌|商标|授权/);
});

test("manual and local-service terms are weak ecommerce intents", () => {
  assert.equal(evaluateKeywordAgentRow(row("generator manual pdf"), commerceRule).values["产品类型"], "售后信息");
  assert.equal(evaluateKeywordAgentRow(row("generator repair near me"), commerceRule).values["产品类型"], "本地服务");
});

test("hard-risk ecommerce categories are excluded", () => {
  for (const keyword of ["replica rolex", "ozempic pen for sale", "casino chips buy"]) {
    const result = evaluateKeywordAgentRow(row(keyword), commerceRule);
    assert.equal(result.values["购买意图"], "排除", keyword);
    assert.equal(result.values["产品类型"], "高风险品类", keyword);
    assert.equal(result.values["agent状态"], "排除", keyword);
  }
});

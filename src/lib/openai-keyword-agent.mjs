import { AGENT_STATUS_COLUMN } from "./keyword-agent-rules.mjs";
import { summarizeResearchForPrompt } from "./keyword-agent-research.mjs";

const DEFAULT_MODEL = "gpt-5.4-mini";
export { AGENT_STATUS_COLUMN };

export const KEYWORD_AGENT_SYSTEM_PROMPT = `你是电子商务 + B端关键词机会判断 agent，不是工具站筛选器。

输入 rows 已经过前置流量和竞争筛选；不要重新设置搜索量、KD、Bing 展示或 top5 根域名门槛，只做最后商业判断。

目标：同时支持电商和B端。
- 电商：实体商品、品类词、配件耗材、购买词、价格词、best/review/comparison 导购词都可以是候选，不要因为是实体商品而排除。
- B端：supplier、manufacturer、factory、OEM/ODM、wholesale、distributor、bulk、RFQ、quote 等是B端采购/询盘候选。

词根拓展规则列：使用 目标模式 / 可售品类。目标模式可包含 电商、B端、自营电商、affiliate、dropshipping、B2B询盘、内容导购。可售品类用于判断是否匹配客户方向。

输出列改为：购买意图、产品类型、建议、判断依据、评级。
购买意图只能是 强 / 中 / 弱 / B端采购 / 排除。
产品类型只能是 实体商品 / 配件耗材 / 品牌商品 / 导购评测 / B端采购 / 本地服务 / 售后信息 / 高风险品类 / 其他。

判断原则：
- buy/for sale/price/discount/coupon/shop、配件耗材 replacement/parts/accessories/filter/battery/cover/refill/compatible 为强购买意图。
- best/review/vs/comparison 是中等购买意图，推荐内容导购/联盟模式。
- supplier/manufacturer/factory/OEM/ODM/wholesale/distributor/bulk/RFQ/quote 为B端采购，推荐询盘页。
- manual/pdf/how to/troubleshooting 是售后信息，购买意图弱，可作为辅助内容但不优先。
- repair/installation/near me/local service 是本地服务；除非目标模式支持本地服务，否则评级低或排除。
- honda generator、solar generator、portable generator、generator parts 这类实体商品/配件词不能按工具站逻辑排除；应评估物流、售后、认证、品牌授权和毛利。
- 成人、博彩、破解盗版、仿牌 counterfeit/replica/fake、处方药/药物剂量/peptide/steroid 等高风险品类直接排除。

评级：A=强购买或B端采购且可履约/可售；B=有商业价值但竞争、品牌、物流或内容成本较高；C=可做但履约重、品牌风险、低毛利或意图偏弱；排除行 rating 为空字符串。

排除行：购买意图=排除，产品类型按实际风险类型填写，建议和评级为空，判断依据写 8-80 字中文原因。
只返回 JSON Schema 要求的 JSON，不要输出 Markdown。建议 50 字以内，判断依据 80 字以内。`;

const VALID_PURCHASE_INTENTS = ["强", "中", "弱", "B端采购", "排除"];
const VALID_PRODUCT_TYPES = ["实体商品", "配件耗材", "品牌商品", "导购评测", "B端采购", "本地服务", "售后信息", "高风险品类", "其他"];
const VALID_RATINGS = ["A", "B", "C"];
const DEFAULT_EXCLUDED_RATIONALE = "LLM判定为排除，原始判断依据不足，需人工复核";
const DEFAULT_CONTINUE_RATIONALE = "LLM判断依据不足，已按电商/B端字段完成兜底";

const OUTPUT_SCHEMA = {
  name: "keyword_agent_batch_decision",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["decisions"],
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rowNumber", "purchaseIntent", "productType", "recommendation", "rationale", "rating"],
          properties: {
            rowNumber: { type: "integer" },
            purchaseIntent: { type: "string", enum: ["强", "中", "弱", "B端采购", "排除"] },
            productType: { type: "string", enum: VALID_PRODUCT_TYPES },
            recommendation: { type: "string" },
            rationale: { type: "string" },
            rating: { type: "string", enum: ["A", "B", "C", ""] }
          }
        }
      }
    }
  }
};

function compactRecord(record, headers) { return Object.fromEntries(headers.map((header) => [header, record?.[header] || ""])); }
function normalize(value) { return String(value || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim(); }
function compact(parts, limit = 80) { const text = parts.filter(Boolean).join("；"); return text.length <= limit ? text : text.slice(0, limit); }
function warning(warnings, field, reason, from, to) { warnings.push({ field, reason, from: String(from ?? ""), to: String(to ?? "") }); }
function ruleModes(rule) { return String(rule?.["目标模式"] || rule?.["意图"] || "电商,B端").split(/[、,，/|]+/).map((x) => x.trim()).filter(Boolean); }
function normalizeCustomerConfig(row, customerConfig = {}) { return { targetModes: customerConfig.targetModes || ruleModes(row?.rule || {}), sellableCategories: customerConfig.sellableCategories || row?.rule?.["可售品类"] || "" }; }
function rowNumberFor(row, llmOutput) { return Number(llmOutput?.rowNumber || row?.rowNumber || row?.row?.rowNumber || 0); }
function keywordFromRow(row, decision) { return String(row?.keyword || row?.keywordRecord?.["关键词"] || row?.record?.["关键词"] || decision?.keyword || "").trim(); }
function has(pattern, text) { return pattern.test(text); }
function isHardExcluded(text) { return /\b(porn|porno|nsfw|adult|nude|xxx|hentai|casino|betting|gambling|crack|torrent|pirate|replica|fake|counterfeit|ozempic|prescription|dosage|dose|peptide|steroid)\b/.test(text); }
function inferProductType(keyword) {
  const text = normalize(keyword);
  if (isHardExcluded(text)) return "高风险品类";
  if (has(/\b(manufacturers?|suppliers?|factor(?:y|ies)|wholesale|distributors?|vendors?|oem|odm|private\s+label|bulk|industrial|rfq|quotes?|quotation)\b/, text)) return "B端采购";
  if (has(/\b(repair|installation|install|near\s+me|local\s+service)\b/, text)) return "本地服务";
  if (has(/\b(manual|pdf|instructions?|how\s+to|troubleshoot(?:ing)?)\b/, text)) return "售后信息";
  if (has(/\b(parts?|replacement|accessor(?:y|ies)|battery|cover|filter|refill|cartridge|charger|case|kit|compatible)\b/, text)) return "配件耗材";
  if (has(/\b(best|top|review|reviews|vs|versus|comparison|compare)\b/, text)) return "导购评测";
  if (has(/\b(honda|generac|jackery|apple|iphone|dyson|nike|adidas)\b/, text)) return "品牌商品";
  return "实体商品";
}
function inferPurchaseIntent(productType, keyword) {
  const text = normalize(keyword);
  if (productType === "高风险品类") return "排除";
  if (productType === "B端采购") return "B端采购";
  if (productType === "本地服务" || productType === "售后信息") return "弱";
  if (productType === "配件耗材" || /\b(buy|for\s+sale|price|cheap|discount|coupon|deals?|shop|store)\b/.test(text)) return "强";
  return "中";
}
function correctedText(value, fallback, field, warnings, max = 80, min = 1) {
  const raw = String(value || "").trim();
  if (!raw || raw.length < min) { const text = fallback.slice(0, max); warning(warnings, field, `${field}缺失或过短，已兜底`, raw, text); return text; }
  if (raw.length > max) { const text = raw.slice(0, max); warning(warnings, field, `${field}超过长度限制，已截断`, raw, text); return text; }
  return raw;
}
function ratingFrom(intent, type, keyword) {
  if (intent === "排除") return "";
  const text = normalize(keyword);
  let score = 0;
  if (intent === "强" || intent === "B端采购") score += 2;
  if (intent === "中") score += 1;
  if (type === "配件耗材" || type === "B端采购") score += 1;
  if (type === "本地服务" || type === "售后信息") score -= 3;
  if (type !== "配件耗材" && /\b(generator|furniture|mattress|battery|solar|appliance)\b/.test(text)) score -= 1;
  if (/\b(honda|generac|jackery|apple|iphone|dyson|nike|adidas)\b/.test(text)) score -= 1;
  if (score >= 3) return "A";
  if (score >= 1) return "B";
  return "C";
}
function defaultRecommendation(intent, type) {
  if (intent === "排除") return "";
  if (type === "B端采购") return "做B端询盘页，突出MOQ、定制和报价入口";
  if (type === "配件耗材") return "优先做配件/耗材页，验证SKU和毛利";
  if (type === "导购评测") return "做内容导购/联盟，承接比较和评测意图";
  if (type === "品牌商品") return "可做品牌兼容页，但需规避商标授权风险";
  if (type === "本地服务") return "偏本地服务，除非客户可履约否则不优先";
  if (type === "售后信息") return "信息/售后意图偏弱，可作为内容辅助页";
  return "适合电商候选，先验证供应链、竞争和毛利";
}

export function normalizeKeywordForBrand(value) { return normalize(value); }
export function hasExplicitBrandSignal(keyword) { return /\b(honda|generac|jackery|apple|iphone|dyson|nike|adidas)\b/.test(normalize(keyword)); }
export function containsBrandRiskText(text) { return /品牌|商标|授权|brand|trademark/i.test(String(text || "")); }
export function cleanupGenericBrandRiskText(text, fallback) { return containsBrandRiskText(text) ? fallback : String(text || "").trim(); }

export function buildPromptPayload(items) {
  return {
    task: "Classify ecommerce and B2B keyword opportunities for a keyword research spreadsheet.",
    rules: {
      trafficAssumption: "Rows are already prefiltered; do not add search-volume/KD/Bing-impression/top5-domain thresholds.",
      targetColumns: ["购买意图", "产品类型", "建议", "判断依据", "评级"],
      ruleColumns: ["目标模式", "可售品类"],
      ecommerceAndB2B: "Keep ecommerce physical product, purchase, price, parts/accessory, best/review/comparison, and B2B supplier/manufacturer/wholesale/RFQ keywords when commercially viable. Do not exclude physical products merely because they are physical products.",
      exclusions: "Exclude adult, gambling, cracking/piracy, counterfeit/replica/fake, prescription/drug dosage/peptide/steroid high-risk terms.",
      rating: "A strong commercial/B2B and feasible; B valuable but competition/brand/logistics/content cost exists; C weak or heavy fulfillment/brand/low margin; excluded rows have empty rating."
    },
    rows: items.map((item) => ({
      rowNumber: item.rowNumber,
      keyword: item.keyword,
      keywordRow: compactRecord(item.keywordRecord, ["词根", "关键词", "国家", "搜索量", "KD", "3M展示", "top5根域名数量", "根域名1", "根域名1排名", "根域名2", "根域名2排名", "top 1国家", "top 1展示量"]),
      customerConfig: { targetModes: ruleModes(item.rule), sellableCategories: item.rule?.["可售品类"] || "", root: item.rule?.["词根"] || "" },
      research: item.research ? summarizeResearchForPrompt(item.research) : { needed: false, reasons: [], confidence: "none", summary: "", topFindings: [] }
    }))
  };
}

export function validateLLMOutput(row, llmOutput, customerConfig = {}) {
  const config = normalizeCustomerConfig(row, customerConfig);
  const decision = llmOutput || {};
  const warnings = [];
  const outputRowNumber = rowNumberFor(row, decision);
  const keyword = keywordFromRow(row, decision);
  const inferredType = inferProductType(keyword);
  let productType = String(decision.productType || decision["产品类型"] || "").trim();
  if (!VALID_PRODUCT_TYPES.includes(productType)) { warning(warnings, "产品类型", "产品类型不合法，已按关键词兜底", productType, inferredType); productType = inferredType; }
  const inferredIntent = inferPurchaseIntent(productType, keyword);
  let purchaseIntent = String(decision.purchaseIntent || decision["购买意图"] || "").trim();
  if (!VALID_PURCHASE_INTENTS.includes(purchaseIntent)) { warning(warnings, "购买意图", "购买意图不合法，已按关键词兜底", purchaseIntent, inferredIntent); purchaseIntent = inferredIntent; }
  if (isHardExcluded(normalize(keyword))) purchaseIntent = "排除";
  if (purchaseIntent === "排除") {
    const rationale = correctedText(decision.rationale || decision["判断依据"], DEFAULT_EXCLUDED_RATIONALE, "判断依据", warnings, 80, 8);
    return { rowNumber: outputRowNumber, values: { "购买意图": "排除", "产品类型": productType, "判断依据": rationale, [AGENT_STATUS_COLUMN]: "排除" }, modelRationale: String(decision.rationale || "").trim(), warnings };
  }
  const recommendation = correctedText(decision.recommendation || decision["建议"], defaultRecommendation(purchaseIntent, productType), "建议", warnings, 50);
  const rationale = correctedText(decision.rationale || decision["判断依据"], compact([`${productType}，${purchaseIntent}购买意图`, config.sellableCategories ? `可售品类：${config.sellableCategories}` : ""], 80) || DEFAULT_CONTINUE_RATIONALE, "判断依据", warnings, 80);
  const expectedRating = ratingFrom(purchaseIntent, productType, keyword);
  const rating = VALID_RATINGS.includes(decision.rating || decision["评级"]) && (decision.rating || decision["评级"]) === expectedRating ? expectedRating : expectedRating;
  if ((decision.rating || decision["评级"]) !== expectedRating) warning(warnings, "评级", "评级已按购买意图/产品类型/履约风险重算", decision.rating || decision["评级"], expectedRating);
  return { rowNumber: outputRowNumber, values: { "购买意图": purchaseIntent, "产品类型": productType, "建议": recommendation, "判断依据": rationale, "评级": rating, [AGENT_STATUS_COLUMN]: "完成" }, modelRationale: String(decision.rationale || "").trim(), warnings };
}

export function normalizeDecision(decision) { return validateLLMOutput({ rowNumber: decision?.rowNumber || 0 }, decision, {}); }

function extractJsonContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenAI response missing message content: ${JSON.stringify(data).slice(0, 500)}`);
  return content;
}

export async function evaluateKeywordRowsWithOpenAI(items, { apiKey = process.env.OPENAI_API_KEY || "", model = process.env.OPENAI_MODEL || DEFAULT_MODEL } = {}) {
  if (items.length === 0) return [];
  if (!apiKey) throw new Error("缺少 OPENAI_API_KEY。要用大模型 agent，请先设置 OPENAI_API_KEY，或用 --mode=rules 跑规则兜底。");
  const payload = buildPromptPayload(items);
  const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "system", content: KEYWORD_AGENT_SYSTEM_PROMPT }, { role: "user", content: JSON.stringify(payload) }], response_format: { type: "json_schema", json_schema: OUTPUT_SCHEMA } }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenAI API failed: HTTP ${response.status} ${data?.error?.message || response.statusText}`);
  const parsed = JSON.parse(extractJsonContent(data));
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const byRow = new Map(decisions.map((decision) => [Number(decision.rowNumber), decision]));
  return items.map((item) => {
    const decision = byRow.get(Number(item.rowNumber));
    if (!decision) throw new Error(`OpenAI response missing decision for row ${item.rowNumber}`);
    return validateLLMOutput(item, decision, normalizeCustomerConfig(item));
  });
}

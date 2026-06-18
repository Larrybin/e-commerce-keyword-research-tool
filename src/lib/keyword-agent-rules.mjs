const TARGET_COLUMNS = [
  "购买意图",
  "产品类型",
  "建议",
  "判断依据",
  "评级"
];
export const AGENT_STATUS_COLUMN = "agent状态";

const HARD_EXCLUSION_PATTERNS = [
  { type: "成人敏感", pattern: /\b(porn|porno|nsfw|adult|nude|xxx|hentai|erotic|sex)\b/ },
  { type: "赌博博彩", pattern: /\b(casino|slots?|sportsbook|betting|gambling|lottery|poker)\b/ },
  { type: "破解盗版", pattern: /\b(cracks?|cracked|torrent|pirate|mod\s*apk|keygen|activation|bypass|unlocker?)\b/ },
  { type: "处方/医疗高风险", pattern: /\b(ozempic|semaglutide|prescription|rx|drug|dosage|dose|peptide|steroid|syringe)\b/ },
  { type: "仿牌/侵权", pattern: /\b(replica|fake|counterfeit|knockoff)\b/ }
];
const B2B_PATTERNS = [/\b(manufacturers?|suppliers?|factor(?:y|ies)|wholesale|distributors?|vendors?|oem|odm|private\s+label|bulk|industrial|rfq|quotes?|quotation)\b/];
const STRONG_PURCHASE_PATTERNS = [/\b(buy|for\s+sale|price|prices|cheap|discount|coupon|deals?|shop|store)\b/];
const COMPARISON_PATTERNS = [/\b(best|top|review|reviews|vs|versus|comparison|compare)\b/];
const PARTS_PATTERNS = [/\b(parts?|replacement|accessor(?:y|ies)|battery|cover|filter|refill|cartridge|charger|case|kit|compatible)\b/];
const SERVICE_PATTERNS = [/\b(repair|installation|install|near\s+me|local\s+service|service\s+nearby)\b/];
const INFO_PATTERNS = [/\b(manual|pdf|instructions?|how\s+to|troubleshoot(?:ing)?)\b/];
const BRAND_PATTERNS = [/\bhonda\b/, /\bgenerac\b/, /\bjackery\b/, /\bapple\b/, /\biphone\b/, /\bdyson\b/, /\bnike\b/, /\badidas\b/];
const HEAVY_FULFILLMENT_PATTERNS = [/\b(generator|furniture|mattress|battery|solar|appliance|treadmill)\b/];
const LOW_MARGIN_PATTERNS = [/\b(cheap|cable|charger|phone\s+case)\b/];

function normalize(value) {
  return String(value || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function hasAny(patterns, text) { return patterns.some((pattern) => pattern.test(text)); }
function firstMatch(patterns, text) { return patterns.find((item) => item.pattern.test(text)) || null; }
function compact(parts, limit = 80) { const text = parts.filter(Boolean).join("；"); return text.length <= limit ? text : text.slice(0, limit); }
function targetModes(rule) {
  return String(rule?.["目标模式"] || rule?.["意图"] || "电商,B端")
    .split(/[、,，/|]+/).map((item) => item.trim()).filter(Boolean);
}
function sellableCategories(rule) { return String(rule?.["可售品类"] || "").trim(); }
function allowsMode(rule, mode) {
  const modes = targetModes(rule).join(" ").toLowerCase();
  if (!modes) return true;
  if ((/电商|ecommerce/.test(modes)) && (/b端|b2b|询盘/.test(modes))) return true;
  if (mode === "B端" && /b端|b2b|询盘|批发|supplier/.test(modes)) return true;
  if (mode === "电商" && /电商|自营|affiliate|联盟|dropshipping|导购/.test(modes)) return true;
  return false;
}
function productType(keyword) {
  const text = normalize(keyword);
  if (hasAny(SERVICE_PATTERNS, text)) return "本地服务";
  if (hasAny(INFO_PATTERNS, text)) return "售后信息";
  if (hasAny(B2B_PATTERNS, text)) return "B端采购";
  if (hasAny(PARTS_PATTERNS, text)) return "配件耗材";
  if (hasAny(COMPARISON_PATTERNS, text)) return "导购评测";
  if (hasAny(BRAND_PATTERNS, text)) return "品牌商品";
  return "实体商品";
}
function purchaseIntent(type, keyword) {
  const text = normalize(keyword);
  if (type === "B端采购") return "B端采购";
  if (type === "本地服务" || type === "售后信息") return "弱";
  if (hasAny(STRONG_PURCHASE_PATTERNS, text) || type === "配件耗材") return "强";
  if (type === "导购评测" || type === "品牌商品" || type === "实体商品") return "中";
  return "弱";
}
function ratingFor({ intent, type, keyword }) {
  const text = normalize(keyword);
  if (intent === "排除") return "";
  let score = 0;
  if (intent === "强" || intent === "B端采购") score += 2;
  if (intent === "中") score += 1;
  if (type === "配件耗材" || type === "B端采购") score += 1;
  if (type === "导购评测") score += 0;
  if (type === "本地服务" || type === "售后信息") score -= 3;
  if (type !== "配件耗材" && hasAny(HEAVY_FULFILLMENT_PATTERNS, text)) score -= 1;
  if (hasAny(BRAND_PATTERNS, text)) score -= 1;
  if (hasAny(LOW_MARGIN_PATTERNS, text)) score -= 1;
  if (score >= 3) return "A";
  if (score >= 1) return "B";
  return "C";
}
function recommendationFor({ intent, type, keyword, rating }) {
  const text = normalize(keyword);
  if (intent === "排除") return "";
  if (type === "B端采购") return "做B端询盘页，突出MOQ、定制和报价入口";
  if (type === "配件耗材") return "优先做配件/耗材独立页，验证SKU和毛利";
  if (type === "导购评测") return "做内容导购/联盟，承接比较和评测意图";
  if (type === "品牌商品") return "可做品牌兼容页，但需规避商标和授权风险";
  if (type === "本地服务") return "偏本地服务，除非客户可履约否则不优先";
  if (type === "售后信息") return "信息/售后意图偏弱，可作为内容辅助页";
  if (hasAny(HEAVY_FULFILLMENT_PATTERNS, text)) return "可做电商/导购，但需评估物流售后和认证";
  return rating === "A" ? "适合电商落地，优先验证供应链和毛利" : "可做电商候选，先验证竞争和毛利";
}
export function evaluateKeywordAgentRow(keywordRow, rule = {}) {
  const keyword = keywordRow?.record?.["关键词"] || keywordRow?.["关键词"] || "";
  const text = normalize(keyword);
  const excluded = firstMatch(HARD_EXCLUSION_PATTERNS, text);
  const type = excluded ? "高风险品类" : productType(keyword);
  let intent = excluded ? "排除" : purchaseIntent(type, keyword);
  let status = excluded ? "排除" : "完成";
  let reason = excluded ? `${excluded.type}，不适合电商或B端关键词机会` : compact([
    intent === "B端采购" ? "供应商/批发/OEM等B端采购意图" : `${type}，${intent}购买意图`,
    hasAny(BRAND_PATTERNS, text) ? "包含品牌词，需注意商标/授权风险" : "",
    hasAny(HEAVY_FULFILLMENT_PATTERNS, text) ? "物流/售后/认证履约偏重" : "",
    sellableCategories(rule) ? `规则可售品类：${sellableCategories(rule)}` : ""
  ]);
  if (!excluded) {
    const mode = type === "B端采购" ? "B端" : "电商";
    if (!allowsMode(rule, mode)) {
      intent = "排除";
      status = "排除";
      reason = `真实意图是${mode}，不匹配目标模式${targetModes(rule).join("/")}`;
    }
  }
  const rating = ratingFor({ intent, type, keyword });
  const values = {
    "购买意图": intent,
    "产品类型": type,
    "判断依据": reason,
    [AGENT_STATUS_COLUMN]: status
  };
  if (status === "完成") {
    values["建议"] = recommendationFor({ intent, type, keyword, rating });
    values["评级"] = rating;
  }
  return { values, stopAfterFirstJudgement: status === "排除", summary: reason };
}
export function targetAgentColumns() { return [...TARGET_COLUMNS]; }

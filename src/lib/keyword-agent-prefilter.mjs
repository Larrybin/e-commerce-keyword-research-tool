const HIGH_RISK_PATTERNS = [
  /\b(porn|porno|nsfw|adult|nude|xxx|hentai|erotic|sex)\b/,
  /\b(casino|slots?|sportsbook|betting|gambling|lottery|poker)\b/,
  /\b(cracks?|cracked|torrent|pirate|mod\s*apk|keygen|activation|bypass|unlocker?)\b/,
  /\b(replica|fake|counterfeit|knockoff)\b/,
  /\b(ozempic|semaglutide|prescription|rx|drug|dosage|dose|peptide|steroid|syringe)\b/
];

const B2B_PATTERNS = [
  /\b(manufacturers?|suppliers?|factor(?:y|ies)|wholesale|distributors?|vendors?|oem|odm|private\s+label|bulk|industrial|rfq|quotes?|quotation)\b/
];

const NON_ECOMMERCE_PATTERNS = [
  /\b(repair|installation|installer|install|near\s+me|local\s+service|contractor|service\s+nearby)\b/,
  /\b(manual|pdf|instructions?|how\s+to|what\s+is|meaning|definition|troubleshoot(?:ing)?|template)\b/,
  /\b(free\s+online|download|app|software|login)\b/,
  /\b(jobs?|salary|career|hiring|course|certification)\b/,
  /\b(random|meme|quiz|game)\b/
];

const TOOL_INTENT_PATTERNS = [
  /\b(calculator|converter|checker|editor|formatter|citation|qr\s+code|name\s+generator)\b/,
  /\bgenerator\b/
];

const ECOMMERCE_PATTERNS = [
  /\b(buy|for\s+sale|price|prices|cheap|discount|coupon|deals?|shop|store)\b/,
  /\b(parts?|replacement|accessor(?:y|ies)|battery|cover|filter|refill|cartridge|charger|case|kit|compatible)\b/,
  /\b(best|top|review|reviews|vs|versus|comparison|compare|top\s+rated)\b/,
  /\b(portable|solar|water|air|oil|coffee|car|auto|home|rv|diesel|gas|propane|power)\b/,
  /\b(printer|scanner|seat|seats|chair|table|shoe|bag|pump|motor|valve|machine|appliance)\b/
];

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

export function evaluateKeywordAgentPrefilter(row) {
  const keyword = row?.record?.["关键词"] || row?.["关键词"] || row?.keyword || "";
  const text = normalize(keyword);
  const wordCount = text ? text.split(" ").length : 0;

  if (!text) return { judgement: "拒绝", status: "拒绝", reason: "empty_keyword" };
  if (hasAny(HIGH_RISK_PATTERNS, text)) return { judgement: "拒绝", status: "拒绝", reason: "high_risk" };
  if (hasAny(B2B_PATTERNS, text)) return { judgement: "拒绝", status: "拒绝", reason: "b2b_intent" };
  if (hasAny(NON_ECOMMERCE_PATTERNS, text)) return { judgement: "拒绝", status: "拒绝", reason: "non_ecommerce_intent" };
  if (hasAny(ECOMMERCE_PATTERNS, text)) return { judgement: "继续", status: "通过", reason: "ecommerce_signal" };
  if (hasAny(TOOL_INTENT_PATTERNS, text)) return { judgement: "拒绝", status: "拒绝", reason: "tool_intent" };
  if (wordCount > 8) return { judgement: "拒绝", status: "拒绝", reason: "too_many_words" };

  return { judgement: "继续", status: "通过", reason: "uncertain_ecommerce_intent" };
}


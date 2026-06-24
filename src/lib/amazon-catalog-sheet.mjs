export const AMAZON_CATALOG_SHEET = "Amazon目录词";
export const AMAZON_CATALOG_HEADERS = [
  "国家",
  "平台",
  "关键词",
  "一级目录",
  "二级目录",
  "三级目录",
  "目录路径",
  "Amazon URL",
  "深度",
  "抓取时间"
];

export const AMAZON_CATALOG_ROOT_EXCLUDE_PATTERN =
  /\b(?:amazon|kindle|audible|digital|books?|movies?|tv|music|cds?|vinyl|gift\s*cards?|apps?|games?|software|magazines?|subscriptions?)\b/i;

const LEGACY_AMAZON_CATALOG_HEADERS = [
  "关键词",
  "一级目录",
  "二级目录",
  "三级目录",
  "目录路径",
  "Amazon URL",
  "深度",
  "抓取时间"
];

function trim(value) {
  return String(value || "").trim();
}

function normalizeKeyword(value) {
  return trim(value).replace(/\s+/g, " ");
}

function keywordKey(value) {
  return normalizeKeyword(value).toLowerCase();
}

function wordCount(value) {
  return normalizeKeyword(value)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

export function normalizeAmazonCatalogKeywords(values = [], existingRows = []) {
  const seen = new Set(existingRows.map((row) => keywordKey(row?.record?.["关键词"] || row?.[2] || row?.[0])));
  const keywords = [];

  for (const value of values) {
    const keyword = normalizeKeyword(value);
    const key = keywordKey(keyword);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keywords.push(keyword);
  }

  return keywords;
}

export function categoryKey(category = {}) {
  const url = normalizeKeyword(category.url || category["Amazon URL"]);
  if (url) return `url:${url.toLowerCase()}`;
  const path = normalizeKeyword(Array.isArray(category.path) ? category.path.join(" > ") : category["目录路径"]);
  if (path) return `path:${path.toLowerCase()}`;
  return `keyword:${keywordKey(category.keyword || category["关键词"])}`;
}

export function keywordOnlyKey(category = {}) {
  return `keyword:${keywordKey(category.keyword || category["关键词"])}`;
}

export function buildAmazonCatalogRecord(category = {}, crawledAt = new Date().toISOString()) {
  const path = Array.isArray(category.path)
    ? category.path.map(normalizeKeyword).filter(Boolean)
    : String(category["目录路径"] || "").split(">").map(normalizeKeyword).filter(Boolean);
  const keyword = normalizeKeyword(category.keyword || category["关键词"] || path.at(-1));

  return {
    "关键词": keyword,
    "国家": category.country || category["国家"] || "美国",
    "平台": category.platform || category["平台"] || "Amazon",
    "一级目录": path[0] || "",
    "二级目录": path[1] || "",
    "三级目录": path[2] || "",
    "目录路径": path.join(" > "),
    "Amazon URL": normalizeKeyword(category.url || category["Amazon URL"]),
    "深度": String(category.depth || category["深度"] || path.length || ""),
    "抓取时间": crawledAt
  };
}

export function buildAmazonCatalogValues(categories = [], crawledAt = new Date().toISOString()) {
  return categories.map((category) => {
    const record = typeof category === "string"
      ? buildAmazonCatalogRecord({ keyword: category, path: [category] }, crawledAt)
      : buildAmazonCatalogRecord(category, crawledAt);
    return AMAZON_CATALOG_HEADERS.map((header) => record[header] || "");
  });
}

export function buildExistingAmazonCatalogIndex(rows = []) {
  const byKey = new Map();
  const byKeywordOnly = new Map();

  for (const row of rows) {
    const record = row.record || {};
    const key = categoryKey(record);
    if (key !== "keyword:") {
      byKey.set(key, row);
    }
    const keywordKeyValue = keywordOnlyKey(record);
    if (keywordKeyValue !== "keyword:" && !record["Amazon URL"] && !record["目录路径"]) {
      byKeywordOnly.set(keywordKeyValue, row);
    }
  }

  return { byKey, byKeywordOnly };
}

export function planAmazonCatalogWrites(categories = [], existingRows = [], crawledAt = new Date().toISOString()) {
  const index = buildExistingAmazonCatalogIndex(existingRows);
  const planned = { updates: [], appends: [], skipped: 0 };

  for (const category of categories) {
    const record = buildAmazonCatalogRecord(category, crawledAt);
    const key = categoryKey(record);
    if (!record["关键词"] || index.byKey.has(key)) {
      planned.skipped += 1;
      continue;
    }

    const keywordOnlyRow = index.byKeywordOnly.get(keywordOnlyKey(record));
    if (keywordOnlyRow) {
      planned.updates.push({ rowNumber: keywordOnlyRow.rowNumber, record });
      index.byKeywordOnly.delete(keywordOnlyKey(record));
    } else {
      planned.appends.push(record);
    }
    index.byKey.set(key, { record });
  }

  return planned;
}

export function amazonCatalogAppendRange(rowCount, startRow) {
  if (rowCount <= 0) {
    return "";
  }
  const endRow = startRow + rowCount - 1;
  return `${quoteSheetName(AMAZON_CATALOG_SHEET)}!A${startRow}:J${endRow}`;
}

export function migrateAmazonCatalogValues(values = [], { country = "美国", platform = "Amazon" } = {}) {
  const firstRow = values[0] || [];
  if (AMAZON_CATALOG_HEADERS.every((header, index) => firstRow[index] === header)) {
    return { values, migrated: false };
  }

  if (!LEGACY_AMAZON_CATALOG_HEADERS.every((header, index) => firstRow[index] === header)) {
    return { values, migrated: false };
  }

  return {
    migrated: true,
    values: [
      AMAZON_CATALOG_HEADERS,
      ...values.slice(1).map((row) => [
        country,
        platform,
        row[0] || "",
        row[1] || "",
        row[2] || "",
        row[3] || "",
        row[4] || "",
        row[5] || "",
        row[6] || "",
        row[7] || ""
      ])
    ]
  };
}

export function selectAmazonCatalogCandidates(rows = [], {
  minWords = 2,
  minDepth = 3,
  maxDepth = 5,
  limit = 500,
  excludePattern = AMAZON_CATALOG_ROOT_EXCLUDE_PATTERN
} = {}) {
  const seen = new Set();
  const selected = [];
  const skipped = {
    empty: 0,
    tooShort: 0,
    depthOutOfRange: 0,
    excluded: 0,
    duplicate: 0,
    overLimit: 0
  };

  for (const row of rows) {
    const record = row.record || {};
    const keyword = normalizeKeyword(record["关键词"] || row[2] || row[0]);
    if (!keyword) {
      skipped.empty += 1;
      continue;
    }
    if (wordCount(keyword) < minWords) {
      skipped.tooShort += 1;
      continue;
    }

    const depth = Number(record["深度"] || row[8] || row[6] || 0);
    if ((minDepth && depth < minDepth) || (maxDepth && depth > maxDepth)) {
      skipped.depthOutOfRange += 1;
      continue;
    }
    const path = normalizeKeyword(record["目录路径"] || row[6] || row[4]);
    const searchableText = `${keyword} ${path}`;
    if (excludePattern && excludePattern.test(searchableText)) {
      skipped.excluded += 1;
      continue;
    }

    const key = keywordKey(keyword);
    if (seen.has(key)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(key);

    if (limit > 0 && selected.length >= limit) {
      skipped.overLimit += 1;
      continue;
    }
    selected.push({
      keyword,
      sourceRowNumber: row.rowNumber,
      depth,
      path,
      url: normalizeKeyword(record["Amazon URL"] || row[7] || row[5])
    });
  }

  return { selected, skipped };
}

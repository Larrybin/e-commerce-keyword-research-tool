const HARD_EXCLUSION_PATTERNS = [
  /\bnear\s+me\b/,
  /\bporn\b/,
  /\badult\b/,
  /\bnude\b/,
  /\bsex\b/,
  /\binstallation\b/,
  /\binstaller\b/,
  /\brepair\b/,
  /\bservice\b/,
  /\bcontractor\b/,
  /\bjobs?\b/,
  /\bsalary\b/,
  /\bcareer\b/,
  /\bhiring\b/,
  /\bmanual\b/,
  /\bpdf\b/,
  /\binstructions?\b/,
  /\bhow\s+to\b/,
  /\btemplate\b/,
  /\bfree\s+online\b/,
  /\bapp\b/,
  /\bsoftware\b/,
  /\bdownload\b/
];

function normalizeKeyword(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalizeKeyword(value);
  return normalized ? normalized.split(" ") : [];
}

export function evaluateKeywordForEcommerce(row) {
  const keyword = row?.关键词 || row?.keyword || "";
  const normalizedKeyword = normalizeKeyword(keyword);
  const tokens = tokenize(keyword);

  if (!normalizedKeyword || tokens.length === 0) {
    return { accepted: false, reason: "empty_keyword" };
  }

  const exclusion = HARD_EXCLUSION_PATTERNS.find((pattern) => pattern.test(normalizedKeyword));
  if (exclusion) {
    return { accepted: false, reason: `contains_excluded_term:${exclusion.source}` };
  }

  if (tokens.length > 8) {
    return { accepted: false, reason: "too_many_words" };
  }

  return { accepted: true, reason: "ecommerce_prefilter_passed" };
}

export function filterKeywordRowsForEcommerce(rows, task) {
  const machineFilter = String(task?.machineFilter || "").trim();
  const enabled = machineFilter !== "否";
  const accepted = [];
  const rejected = [];
  const annotatedRows = [];

  for (const row of rows) {
    const evaluation = enabled
      ? evaluateKeywordForEcommerce(row)
      : { accepted: true, reason: "machine_filter_disabled" };
    const annotated = {
      ...row,
      判断: evaluation.accepted ? "继续" : "拒绝",
      机器筛选状态: evaluation.accepted ? "通过" : "拒绝",
      机器筛选原因: evaluation.reason
    };
    annotatedRows.push(annotated);
    if (evaluation.accepted) {
      accepted.push(annotated);
    } else {
      rejected.push(annotated);
    }
  }

  return {
    rows: annotatedRows,
    accepted,
    rejected,
    summary: {
      enabled,
      rawRows: rows.length,
      acceptedRows: accepted.length,
      rejectedRows: rejected.length
    }
  };
}

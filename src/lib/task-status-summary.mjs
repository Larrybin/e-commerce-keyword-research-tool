const STATUS_COLUMNS = [
  "3M采集状态",
  "二次判断状态",
  "国家采集状态",
  "Agent 判断流程"
];

function trim(value) {
  return String(value || "").trim();
}

function normalize(value) {
  return trim(value).toLowerCase();
}

function countWhere(rows, predicate) {
  return rows.reduce((count, row) => count + (predicate(row) ? 1 : 0), 0);
}

function hasValue(row, key) {
  return Boolean(trim(row?.record?.[key]));
}

function progress(done, total) {
  return `已完成${done}个，总数${total}个`;
}

function existingStatus(taskRow, key) {
  return trim(taskRow?.record?.[key]);
}

function semCollectionCompleted(taskRow) {
  const status = existingStatus(taskRow, "SEM完成状态");
  return /^已完成\d+个关键词采集$/.test(status) || status === "已完成关键词采集";
}

function ratingSummary(rows) {
  const total = rows.length;
  const countA = countWhere(rows, (row) => trim(row.record["评级"]) === "A");
  const countB = countWhere(rows, (row) => trim(row.record["评级"]) === "B");
  const countC = countWhere(rows, (row) => trim(row.record["评级"]) === "C");
  const excluded = countWhere(rows, (row) =>
    trim(row.record["agent状态"]) === "排除" || trim(row.record["第一次判断"]) === "排除"
  );
  return `总数${total}个，评级A ${countA}个，评级B ${countB}个，评级C ${countC}个，排除${excluded}个`;
}

export function statusColumns() {
  return [...STATUS_COLUMNS];
}

export function keywordRowsForTask(taskRow, keywordRows) {
  const root = normalize(taskRow?.record?.["词根"]);
  const keyword = normalize(taskRow?.record?.["关键词"]);
  if (root) {
    return keywordRows.filter((row) => normalize(row.record["词根"]) === root);
  }
  if (keyword) {
    return keywordRows.filter((row) => normalize(row.record["关键词"]) === keyword);
  }
  return [];
}

export function summarizeTaskStatus(taskRow, keywordRows) {
  const rows = keywordRowsForTask(taskRow, keywordRows);
  const machineContinueRows = rows.filter((row) => trim(row.record["判断"]) === "继续");
  const initialBingContinueRows = rows.filter((row) => trim(row.record["bing初步判断"]) === "继续");
  const serpOpportunityRows = rows.filter((row) => ["继续", "机会"].includes(trim(row.record["SERP机会判断"])));
  const ratingARows = rows.filter((row) => trim(row.record["评级"]) === "A");
  const agentStarted = serpOpportunityRows.length > 0;
  const zeroCandidateFlowCompleted = semCollectionCompleted(taskRow) && machineContinueRows.length === 0;

  const threeMDone = countWhere(machineContinueRows, (row) => hasValue(row, "3M展示"));
  const secondDone = countWhere(initialBingContinueRows, (row) => hasValue(row, "SERP机会判断"));
  const countryDone = countWhere(ratingARows, (row) => hasValue(row, "top 1国家"));
  const agentDone = countWhere(serpOpportunityRows, (row) =>
    trim(row.record["agent状态"]) === "完成" || trim(row.record["agent状态"]) === "排除"
  );

  const agentStatus = agentStarted && agentDone === serpOpportunityRows.length
    ? ratingSummary(serpOpportunityRows)
    : agentStarted ? progress(agentDone, serpOpportunityRows.length) : existingStatus(taskRow, "Agent 判断流程");

  return {
    "3M采集状态": machineContinueRows.length > 0 || zeroCandidateFlowCompleted
      ? progress(threeMDone, machineContinueRows.length)
      : existingStatus(taskRow, "3M采集状态"),
    "二次判断状态": initialBingContinueRows.length > 0 || zeroCandidateFlowCompleted
      ? progress(secondDone, initialBingContinueRows.length)
      : existingStatus(taskRow, "二次判断状态"),
    "国家采集状态": agentStarted || ratingARows.length > 0 || zeroCandidateFlowCompleted
      ? progress(countryDone, ratingARows.length)
      : existingStatus(taskRow, "国家采集状态"),
    "Agent 判断流程": zeroCandidateFlowCompleted ? progress(0, 0) : agentStatus
  };
}

export function buildTaskStatusUpdates(taskTable, keywordTable) {
  return taskTable.rows
    .filter((row) => trim(row.record["词根"]) || trim(row.record["关键词"]))
    .map((row) => ({
      rowNumber: row.rowNumber,
      root: trim(row.record["词根"]),
      keyword: trim(row.record["关键词"]),
      values: summarizeTaskStatus(row, keywordTable.rows)
    }));
}

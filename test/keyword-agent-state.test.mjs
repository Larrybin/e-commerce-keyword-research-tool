import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_STATUS_COLUMN,
  assertOptionalHeaders,
  buildHeaderDiagnostics,
  buildRuleIndex,
  buildRowUpdate,
  collectKeywordAgentPendingRows,
  findRule,
  shouldSkipKeywordAgentRow,
  validateHeaders
} from "../src/keyword-agent.mjs";

function row(values) {
  return { values };
}

function taskRow(rowNumber, record) {
  return { rowNumber, record };
}

function keywordRow(rowNumber, record) {
  return { rowNumber, record, values: [] };
}

const keywordTableHeaders = [
  "词根",
  "关键词",
  "agent预判断",
  "SERP机会判断",
  "意图",
  "第一次判断",
  "难度",
  "第二次判断",
  "变现渠道",
  "第三次判断",
  "建议",
  "判断依据",
  "评级",
  AGENT_STATUS_COLUMN
];

function keywordTableRow(rowNumber, {
  root = "generator",
  keyword = `keyword ${rowNumber}`,
  prefilter = "继续",
  serpOpportunity = "继续",
  intent = "",
  firstJudgement = "",
  difficulty = "",
  secondJudgement = "",
  monetization = "",
  thirdJudgement = "",
  recommendation = "",
  rationale = "",
  rating = "",
  agentStatus = ""
} = {}) {
  const values = [
    root,
    keyword,
    prefilter,
    serpOpportunity,
    intent,
    firstJudgement,
    difficulty,
    secondJudgement,
    monetization,
    thirdJudgement,
    recommendation,
    rationale,
    rating,
    agentStatus
  ];
  return {
    rowNumber,
    values,
    record: Object.fromEntries(keywordTableHeaders.map((header, index) => [header, values[index] || ""]))
  };
}

test("keyword agent validates headers without optional agent status column", () => {
  assert.doesNotThrow(() => validateHeaders([
    "词根",
    "关键词",
    "agent预判断",
    "SERP机会判断",
    "购买意图",
    "产品类型",
    "建议",
    "判断依据",
    "评级"
  ]));
});

test("keyword agent row update reports ignored proposed agent status when header is missing", () => {
  const result = buildRowUpdate(
    ["关键词", "意图"],
    row(["example keyword", ""]),
    {
      "意图": "工具站",
      [AGENT_STATUS_COLUMN]: "完成"
    }
  );

  assert.deepEqual(result.changed, ["意图"]);
  assert.equal(result.proposedValues[AGENT_STATUS_COLUMN], "完成");
  assert.equal(result.ignoredHeaders.includes(AGENT_STATUS_COLUMN), true);
  assert.equal(Object.hasOwn(result.writableValues, AGENT_STATUS_COLUMN), false);
  assert.deepEqual(result.writableValues, { "意图": "工具站" });
});

test("keyword agent row update writes proposed agent status when header exists", () => {
  const result = buildRowUpdate(
    ["关键词", "意图", AGENT_STATUS_COLUMN],
    row(["example keyword", "", ""]),
    {
      "意图": "工具站",
      [AGENT_STATUS_COLUMN]: "完成"
    }
  );

  assert.equal(result.changed.includes(AGENT_STATUS_COLUMN), true);
  assert.equal(result.ignoredHeaders.includes(AGENT_STATUS_COLUMN), false);
  assert.equal(result.writableValues[AGENT_STATUS_COLUMN], "完成");
});

test("keyword agent row update reports blocked headers when force is false", () => {
  const result = buildRowUpdate(
    ["关键词", "意图", "第一次判断"],
    row(["example keyword", "工具站", ""]),
    {
      "意图": "其他",
      "第一次判断": "排除"
    },
    { force: false }
  );

  assert.deepEqual(result.changed, ["第一次判断"]);
  assert.deepEqual(result.blockedHeaders, ["意图"]);
  assert.equal(result.writableValues["第一次判断"], "排除");
  assert.equal(Object.hasOwn(result.writableValues, "意图"), false);
});

test("keyword agent header diagnostics reports optional agent status presence", () => {
  const withStatus = buildHeaderDiagnostics(keywordTableHeaders);
  assert.equal(withStatus.agentStatusHeaderPresent, true);
  assert.equal(withStatus.agentStatusHeaderIndex >= 0, true);
  assert.equal(withStatus.optionalHeadersMissing.includes(AGENT_STATUS_COLUMN), false);

  const withoutStatus = buildHeaderDiagnostics(keywordTableHeaders.filter((header) => header !== AGENT_STATUS_COLUMN));
  assert.equal(withoutStatus.agentStatusHeaderPresent, false);
  assert.equal(withoutStatus.agentStatusHeaderIndex, -1);
  assert.equal(withoutStatus.optionalHeadersMissing.includes(AGENT_STATUS_COLUMN), true);
});

test("keyword agent optional header assertion can require agent status column", () => {
  const headersWithoutStatus = keywordTableHeaders.filter((header) => header !== AGENT_STATUS_COLUMN);

  assert.doesNotThrow(() => assertOptionalHeaders(headersWithoutStatus, {
    requireAgentStatusColumn: false
  }));
  assert.throws(
    () => assertOptionalHeaders(headersWithoutStatus, { requireAgentStatusColumn: true }),
    /agent状态/
  );
  assert.doesNotThrow(() => assertOptionalHeaders(keywordTableHeaders, {
    requireAgentStatusColumn: true
  }));
});

test("keyword agent skips terminal rows when optional agent status exists", () => {
  const headers = [
    "关键词",
    "意图",
    "第一次判断",
    "判断依据",
    AGENT_STATUS_COLUMN
  ];

  assert.deepEqual(shouldSkipKeywordAgentRow({
    headers,
    row: row(["done keyword", "工具站", "继续", "ok", "完成"]),
    force: false
  }), { skip: true, reason: "agent_status_done" });

  assert.deepEqual(shouldSkipKeywordAgentRow({
    headers,
    row: row(["excluded keyword", "其他", "排除", "not a tool", "排除"]),
    force: false
  }), { skip: true, reason: "agent_status_excluded" });
});

test("keyword agent force ignores terminal agent status", () => {
  const headers = ["关键词", "意图", "第一次判断", "判断依据", AGENT_STATUS_COLUMN];
  assert.deepEqual(shouldSkipKeywordAgentRow({
    headers,
    row: row(["done keyword", "工具站", "继续", "ok", "完成"]),
    force: true
  }), { skip: false, reason: "" });
});

test("keyword agent keeps old blank-column logic without agent status column", () => {
  const headers = ["关键词", "意图", "第一次判断", "判断依据"];

  assert.deepEqual(shouldSkipKeywordAgentRow({
    headers,
    row: row(["old done", "工具站", "继续", "ok"]),
    force: false
  }), { skip: true, reason: "target_columns_already_filled" });

  assert.deepEqual(shouldSkipKeywordAgentRow({
    headers,
    row: row(["old pending", "工具站", "继续", ""]),
    force: false
  }), { skip: false, reason: "" });
});

test("keyword agent matches a single root rule", () => {
  const rule = taskRow(3, { "词根": "generator", "意图": "工具站" });
  const index = buildRuleIndex({ rows: [rule] });

  assert.equal(findRule(keywordRow(12, { "词根": "generator", "关键词": "mla citation generator" }), index), rule.record);
});

test("keyword agent matches by keyword when keyword total root is empty", () => {
  const rule = taskRow(5, { "词根": "", "关键词": "invoice generator", "意图": "工具站" });
  const index = buildRuleIndex({ rows: [rule] });

  assert.equal(findRule(keywordRow(12, { "词根": "", "关键词": "invoice generator" }), index), rule.record);
});

test("keyword agent fails fast on duplicate root rules", () => {
  const index = buildRuleIndex({
    rows: [
      taskRow(3, { "词根": "generator", "意图": "工具站" }),
      taskRow(8, { "词根": "generator", "意图": "B端展示站" })
    ]
  });

  assert.throws(
    () => findRule(keywordRow(12, { "词根": "generator", "关键词": "signature generator" }), index),
    (error) =>
      /规则不唯一/.test(error.message) &&
      /词根=generator/.test(error.message) &&
      /第 3, 8 行/.test(error.message)
  );
});

test("keyword agent fails fast on duplicate keyword rules", () => {
  const index = buildRuleIndex({
    rows: [
      taskRow(4, { "词根": "", "关键词": "invoice generator", "意图": "工具站" }),
      taskRow(9, { "词根": "", "关键词": "invoice generator", "意图": "B端展示站" })
    ]
  });

  assert.throws(
    () => findRule(keywordRow(12, { "词根": "", "关键词": "invoice generator" }), index),
    /规则不唯一/
  );
});

test("keyword agent returns null when no rule matches", () => {
  const index = buildRuleIndex({
    rows: [taskRow(3, { "词根": "calculator", "意图": "工具站" })]
  });

  assert.equal(findRule(keywordRow(12, { "词根": "generator", "关键词": "signature generator" }), index), null);
});

test("keyword agent pending limit is not consumed by completed rows", () => {
  const ruleIndex = buildRuleIndex({
    rows: [taskRow(3, { "词根": "generator", "意图": "工具站" })]
  });
  const completedRows = Array.from({ length: 20 }, (_, index) =>
    keywordTableRow(index + 2, {
      keyword: `completed ${index + 1}`,
      intent: "工具站",
      firstJudgement: "继续",
      difficulty: "轻：已完成",
      secondJudgement: "推荐",
      monetization: "广告",
      thirdJudgement: "推荐",
      recommendation: "done",
      rationale: "done",
      rating: "A",
      agentStatus: "完成"
    })
  );
  const pendingRow = keywordTableRow(22, { keyword: "actual pending generator" });

  const result = collectKeywordAgentPendingRows({
    keywordTable: { headers: keywordTableHeaders, rows: [...completedRows, pendingRow] },
    ruleIndex,
    limit: 1,
    force: false
  });

  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].keyword, "actual pending generator");
  assert.equal(result.summaries.some((summary) => summary.reason === "agent_status_done"), true);
});

test("keyword agent accepts SERP opportunity rows", () => {
  const ruleIndex = buildRuleIndex({
    rows: [taskRow(3, { "词根": "generator", "意图": "工具站" })]
  });

  const result = collectKeywordAgentPendingRows({
    keywordTable: {
      headers: keywordTableHeaders,
      rows: [keywordTableRow(12, { keyword: "opportunity generator", serpOpportunity: "机会" })]
    },
    ruleIndex,
    limit: 1,
    force: false
  });

  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].keyword, "opportunity generator");
});

test("keyword agent requires agent prefilter to continue", () => {
  const ruleIndex = buildRuleIndex({
    rows: [taskRow(3, { "词根": "generator", "意图": "工具站" })]
  });

  const result = collectKeywordAgentPendingRows({
    keywordTable: {
      headers: keywordTableHeaders,
      rows: [keywordTableRow(12, { keyword: "barcode generator", prefilter: "拒绝" })]
    },
    ruleIndex,
    limit: 1,
    force: false
  });

  assert.equal(result.pending.length, 0);
});

test("keyword agent skips terminal rows before duplicate rule lookup", () => {
  const ruleIndex = buildRuleIndex({
    rows: [
      taskRow(3, { "词根": "generator", "意图": "工具站" }),
      taskRow(8, { "词根": "generator", "意图": "B端展示站" })
    ]
  });

  const result = collectKeywordAgentPendingRows({
    keywordTable: {
      headers: keywordTableHeaders,
      rows: [keywordTableRow(12, { keyword: "completed generator", agentStatus: "完成" })]
    },
    ruleIndex,
    limit: 1,
    force: false
  });

  assert.equal(result.pending.length, 0);
  assert.equal(result.summaries[0].reason, "agent_status_done");
});

test("keyword agent force ignores terminal state and enters pending", () => {
  const ruleIndex = buildRuleIndex({
    rows: [taskRow(3, { "词根": "generator", "意图": "工具站" })]
  });

  const result = collectKeywordAgentPendingRows({
    keywordTable: {
      headers: keywordTableHeaders,
      rows: [keywordTableRow(12, { keyword: "completed generator", agentStatus: "完成" })]
    },
    ruleIndex,
    limit: 1,
    force: true
  });

  assert.equal(result.pending.length, 1);
});

test("keyword agent force still fails fast on duplicate rules", () => {
  const ruleIndex = buildRuleIndex({
    rows: [
      taskRow(3, { "词根": "generator", "意图": "工具站" }),
      taskRow(8, { "词根": "generator", "意图": "B端展示站" })
    ]
  });

  assert.throws(
    () => collectKeywordAgentPendingRows({
      keywordTable: {
        headers: keywordTableHeaders,
        rows: [keywordTableRow(12, { keyword: "completed generator", agentStatus: "完成" })]
      },
      ruleIndex,
      limit: 1,
      force: true
    }),
    /规则不唯一/
  );
});

test("keyword agent missing rules do not consume pending limit", () => {
  const ruleIndex = buildRuleIndex({
    rows: [taskRow(3, { "词根": "calculator", "意图": "工具站" })]
  });

  const result = collectKeywordAgentPendingRows({
    keywordTable: {
      headers: keywordTableHeaders,
      rows: [
        keywordTableRow(12, { root: "generator", keyword: "missing rule generator" }),
        keywordTableRow(13, { root: "calculator", keyword: "age calculator" })
      ]
    },
    ruleIndex,
    limit: 1,
    force: false
  });

  assert.equal(result.summaries.some((summary) => summary.reason === "missing_rule"), true);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].keyword, "age calculator");
});

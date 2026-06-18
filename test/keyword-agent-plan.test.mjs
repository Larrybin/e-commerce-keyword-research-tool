import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanOnlySummary } from "../src/keyword-agent.mjs";

function pendingItem(rowNumber, keyword, rule) {
  return {
    rowNumber,
    keyword,
    keywordRecord: { "关键词": keyword },
    rule
  };
}

test("buildPlanOnlySummary generates skipped and planned rows", () => {
  const summary = buildPlanOnlySummary({
    sheetUrl: "https://docs.google.com/spreadsheets/d/example",
    mode: "llm",
    model: "gpt-test",
    force: false,
    limit: 2,
    selectedRows: [{ rowNumber: 5 }, { rowNumber: 10 }, { rowNumber: 11 }],
    pending: [
      pendingItem(10, "invoice generator", {
        "词根": "generator",
        "关键词": "",
        "目标模式": "电商",
        "可售品类": "parts",
        "完整规则不应暴露": "secret"
      }),
      pendingItem(11, "canva qr code generator", {
        "词根": "generator",
        "关键词": "",
        "目标模式": "电商",
        "可售品类": "brand accessories"
      })
    ],
    collectedSummaries: [
      {
        row: 5,
        keyword: "old keyword",
        status: "skipped",
        reason: "agent_status_done"
      }
    ],
    ranAt: "2026-05-31T00:00:00.000Z"
  });

  assert.equal(summary.source.planOnly, true);
  assert.equal(summary.pendingRows, 2);
  assert.equal(summary.wouldEvaluateRows, 2);
  assert.equal(summary.wouldWriteRows, 0);
  assert.equal(summary.updatedRows, 0);
  assert.equal(summary.skippedRows, 1);
  assert.equal(summary.rows[0].status, "skipped");
  assert.equal(summary.rows[0].reason, "agent_status_done");

  const plannedRows = summary.rows.filter((row) => row.status === "planned");
  assert.equal(plannedRows.length, 2);
  assert.equal(plannedRows[0].wouldEvaluate, true);
  assert.equal(plannedRows[0].wouldWrite, false);
  assert.deepEqual(plannedRows[0].rule.targetModes, ["电商"]);
  assert.equal(plannedRows[0].rule.sellableCategories, "parts");
  assert.equal(Object.hasOwn(plannedRows[0].rule, "完整规则不应暴露"), false);
  assert.equal(Object.hasOwn(plannedRows[0], "researchNeeded"), false);
});

test("buildPlanOnlySummary detects research needs without provider data", () => {
  const summary = buildPlanOnlySummary({
    mode: "llm",
    researchEnabled: true,
    researchEndpoint: "https://research.example.test",
    pending: [
      pendingItem(20, "canva qr code generator", {
        "词根": "generator",
        "意图": "工具站",
        "变现渠道1": "广告"
      }),
      pendingItem(21, "401(k) calculator", {
        "词根": "calculator",
        "意图": "工具站",
        "变现渠道1": "广告"
      })
    ],
    ranAt: "2026-05-31T00:00:00.000Z"
  });

  assert.equal(summary.source.research.enabled, true);
  assert.equal(summary.source.research.effective, false);
  assert.equal(summary.source.research.planOnlyProviderSkipped, true);
  assert.equal(summary.source.research.endpointConfigured, true);

  const canva = summary.rows.find((row) => row.keyword === "canva qr code generator");
  assert.equal(canva.researchNeeded, true);
  assert.equal(canva.researchReasons.includes("brand_boundary"), true);
  assert.equal(canva.researchSkipped, true);
  assert.equal(canva.researchSkipReason, "plan_only");
  assert.equal(canva.researchProvider, "");

  const calculator = summary.rows.find((row) => row.keyword === "401(k) calculator");
  assert.equal(calculator.researchNeeded, false);
  assert.deepEqual(calculator.researchReasons, []);
  assert.equal(calculator.researchLevel, "none");
  assert.equal(calculator.researchSkipped, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskStatusUpdates,
  keywordRowsForTask,
  summarizeTaskStatus
} from "../src/lib/task-status-summary.mjs";

function row(rowNumber, record) {
  return { rowNumber, record };
}

test("task status summary matches keyword rows by root", () => {
  const task = row(2, { "词根": "generator", "关键词": "" });
  const keywordRows = [
    row(10, { "词根": "generator", "关键词": "signature generator" }),
    row(11, { "词根": "calculator", "关键词": "loan calculator" })
  ];

  assert.deepEqual(
    keywordRowsForTask(task, keywordRows).map((item) => item.rowNumber),
    [10]
  );
});

test("task status summary matches keyword rows by keyword when root is blank", () => {
  const task = row(2, { "词根": "", "关键词": "invoice generator" });
  const keywordRows = [
    row(10, { "词根": "generator", "关键词": "invoice generator" }),
    row(11, { "词根": "generator", "关键词": "signature generator" })
  ];

  assert.deepEqual(
    keywordRowsForTask(task, keywordRows).map((item) => item.rowNumber),
    [10]
  );
});

test("task status summary records in-progress collection and agent counts", () => {
  const task = row(2, { "词根": "calculator", "关键词": "" });
  const keywordRows = [
    row(10, {
      "词根": "calculator",
      "关键词": "age calculator",
      "agent预判断": "继续",
      "3M展示": "120",
      "bing初步判断": "继续",
      "SERP机会判断": "机会",
      "评级": "A",
      "top 1国家": "United States",
      "agent状态": "完成"
    }),
    row(11, {
      "词根": "calculator",
      "关键词": "loan calculator",
      "agent预判断": "继续",
      "3M展示": "",
      "bing初步判断": "继续",
      "SERP机会判断": "",
      "评级": "",
      "top 1国家": "",
      "agent状态": ""
    }),
    row(12, {
      "词根": "calculator",
      "关键词": "calculator app",
      "agent预判断": "拒绝",
      "3M展示": "",
      "bing初步判断": "",
      "SERP机会判断": "",
      "评级": "",
      "top 1国家": "",
      "agent状态": ""
    })
  ];

  assert.deepEqual(summarizeTaskStatus(task, keywordRows), {
    "3M采集状态": "已完成1个，总数2个",
    "二次判断状态": "已完成1个，总数2个",
    "国家采集状态": "已完成1个，总数1个",
    "Agent 判断流程": "总数1个，评级A 1个，评级B 0个，评级C 0个，排除0个"
  });
});

test("task status summary keeps agent progress while pending rows remain", () => {
  const task = row(2, { "词根": "generator", "关键词": "" });
  const keywordRows = [
    row(10, {
      "词根": "generator",
      "关键词": "portable generator",
      "agent预判断": "继续",
      "3M展示": "90",
      "bing初步判断": "继续",
      "SERP机会判断": "继续",
      "评级": "A",
      "agent状态": "完成"
    }),
    row(11, {
      "词根": "generator",
      "关键词": "solar generator",
      "agent预判断": "继续",
      "3M展示": "80",
      "bing初步判断": "继续",
      "SERP机会判断": "继续",
      "评级": "",
      "agent状态": ""
    })
  ];

  assert.equal(
    summarizeTaskStatus(task, keywordRows)["Agent 判断流程"],
    "已完成1个，总数2个"
  );
});

test("task status summary leaves unstarted stages blank", () => {
  const task = row(2, { "词根": "unstarted", "关键词": "" });
  const keywordRows = [
    row(10, {
      "词根": "unstarted",
      "关键词": "unstarted keyword",
      "agent预判断": "",
      "3M展示": "",
      "bing初步判断": "",
      "SERP机会判断": "",
      "评级": "",
      "top 1国家": "",
      "agent状态": ""
    })
  ];

  assert.deepEqual(summarizeTaskStatus(task, keywordRows), {
    "3M采集状态": "",
    "二次判断状态": "",
    "国家采集状态": "",
    "Agent 判断流程": ""
  });
});

test("task status summary preserves existing zero progress for stages already recorded", () => {
  const task = row(2, {
    "词根": "started",
    "关键词": "",
    "3M采集状态": "已完成0个，总数0个",
    "二次判断状态": "已完成0个，总数0个",
    "国家采集状态": "已完成0个，总数0个",
    "Agent 判断流程": "已完成0个，总数0个"
  });
  const keywordRows = [
    row(10, {
      "词根": "started",
      "关键词": "started keyword",
      "agent预判断": "",
      "3M展示": "",
      "bing初步判断": "",
      "SERP机会判断": "",
      "评级": "",
      "top 1国家": "",
      "agent状态": ""
    })
  ];

  assert.deepEqual(summarizeTaskStatus(task, keywordRows), {
    "3M采集状态": "已完成0个，总数0个",
    "二次判断状态": "已完成0个，总数0个",
    "国家采集状态": "已完成0个，总数0个",
    "Agent 判断流程": "已完成0个，总数0个"
  });
});

test("task status summary records zero progress when Semrush completed with no candidates", () => {
  const task = row(2, {
    "词根": "zero",
    "关键词": "",
    "SEM完成状态": "已完成0个关键词采集"
  });

  assert.deepEqual(summarizeTaskStatus(task, []), {
    "3M采集状态": "已完成0个，总数0个",
    "二次判断状态": "已完成0个，总数0个",
    "国家采集状态": "已完成0个，总数0个",
    "Agent 判断流程": "已完成0个，总数0个"
  });
});

test("task status summary reports completed agent rating distribution", () => {
  const task = row(2, { "词根": "generator", "关键词": "" });
  const keywordRows = [
    row(10, {
      "词根": "generator",
      "关键词": "portable generator",
      "agent预判断": "继续",
      "SERP机会判断": "继续",
      "评级": "A",
      "第一次判断": "继续",
      "agent状态": "完成"
    }),
    row(11, {
      "词根": "generator",
      "关键词": "solar generator",
      "agent预判断": "继续",
      "SERP机会判断": "继续",
      "评级": "B",
      "第一次判断": "继续",
      "agent状态": "完成"
    }),
    row(12, {
      "词根": "generator",
      "关键词": "inverter generator",
      "agent预判断": "继续",
      "SERP机会判断": "继续",
      "评级": "C",
      "第一次判断": "继续",
      "agent状态": "完成"
    }),
    row(13, {
      "词根": "generator",
      "关键词": "gas generator",
      "agent预判断": "继续",
      "SERP机会判断": "继续",
      "评级": "",
      "第一次判断": "排除",
      "agent状态": "排除"
    })
  ];

  assert.equal(
    summarizeTaskStatus(task, keywordRows)["Agent 判断流程"],
    "总数4个，评级A 1个，评级B 1个，评级C 1个，排除1个"
  );
});

test("task status update builder skips empty task rows", () => {
  const taskTable = {
    rows: [
      row(2, { "词根": "", "关键词": "" }),
      row(3, { "词根": "generator", "关键词": "" })
    ]
  };
  const keywordTable = {
    rows: [
      row(10, {
        "词根": "generator",
        "关键词": "portable generator",
        "agent预判断": "继续",
        "3M展示": "10",
        "bing初步判断": "",
        "SERP机会判断": "",
        "评级": "",
        "top 1国家": "",
        "agent状态": ""
      })
    ]
  };

  const updates = buildTaskStatusUpdates(taskTable, keywordTable);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].rowNumber, 3);
  assert.equal(updates[0].values["3M采集状态"], "已完成1个，总数1个");
});

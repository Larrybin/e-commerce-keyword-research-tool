import assert from "node:assert/strict";
import test from "node:test";
import { isFatalSemrushWorkflowError } from "../src/semrush-step1.mjs";

test("isFatalSemrushWorkflowError stops environment-level browser failures", () => {
  assert.equal(isFatalSemrushWorkflowError(new Error("3ue did not open Semrush within 30s. current=about:blank")), true);
  assert.equal(isFatalSemrushWorkflowError(new Error("3ue opened about:blank instead of Semrush.")), true);
  assert.equal(isFatalSemrushWorkflowError(new Error("Session with given id not found.")), true);
  assert.equal(isFatalSemrushWorkflowError(new Error("Google Sheets cell limit guard: 关键词总表 需要新增 1 行")), true);
  assert.equal(isFatalSemrushWorkflowError(new Error("No keyword rows found")), false);
});

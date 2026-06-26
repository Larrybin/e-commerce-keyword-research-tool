import assert from "node:assert/strict";
import test from "node:test";
import {
  isStaleSemrushLockRecord,
  semrushSharedChromeConfig,
  semrushSharedChromeLaunchArgs
} from "../src/lib/semrush-shared-chrome.mjs";

test("semrushSharedChromeConfig uses shared profile defaults and env overrides", () => {
  assert.equal(semrushSharedChromeConfig({}).port, 9333);
  assert.equal(
    semrushSharedChromeConfig({
      SEMRUSH_CHROME_PORT: "9444",
      SEMRUSH_CHROME_USER_DATA_DIR: "/tmp/semrush-profile",
      SEMRUSH_LOCK_PATH: "/tmp/semrush.lock"
    }).userDataDir,
    "/tmp/semrush-profile"
  );
});

test("semrushSharedChromeLaunchArgs points Chrome at the shared profile and explicit port", () => {
  assert.deepEqual(
    semrushSharedChromeLaunchArgs({ port: 9444, userDataDir: "/tmp/semrush-profile" }).slice(0, 2),
    ["--user-data-dir=/tmp/semrush-profile", "--remote-debugging-port=9444"]
  );
});

test("isStaleSemrushLockRecord treats old or dead locks as stale", () => {
  const nowMs = Date.parse("2026-06-25T12:00:00.000Z");
  assert.equal(
    isStaleSemrushLockRecord(
      { pid: 123, started_at: "2026-06-25T11:59:00.000Z" },
      { nowMs, isPidAlive: () => true }
    ),
    false
  );
  assert.equal(
    isStaleSemrushLockRecord(
      { pid: 123, started_at: "2026-06-25T11:59:00.000Z" },
      { nowMs, isPidAlive: () => false }
    ),
    true
  );
  assert.equal(
    isStaleSemrushLockRecord(
      { pid: 123, started_at: "2026-06-25T11:00:00.000Z" },
      { nowMs, isPidAlive: () => true }
    ),
    true
  );
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("CLI arg module loads .env from the working directory", async () => {
  const previousCwd = process.cwd();
  const key = "CODEX_ARGS_ENV_TEST";
  const previousValue = process.env[key];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-tool-env-"));

  delete process.env[key];
  await fs.writeFile(path.join(tempDir, ".env"), `${key}=loaded\n`, "utf8");

  try {
    process.chdir(tempDir);
    await import(`../src/lib/args.mjs?env-test=${Date.now()}`);
    assert.equal(process.env[key], "loaded");
  } finally {
    process.chdir(previousCwd);
    if (previousValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

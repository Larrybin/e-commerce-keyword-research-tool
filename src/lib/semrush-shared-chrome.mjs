import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readDebuggerEndpointFromPort } from "./cdp.mjs";
import { sleep } from "./browser-actions.mjs";

const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_PORT = 9333;
const DEFAULT_USER_DATA_DIR = path.join(os.homedir(), "Library/Application Support/Codex/SemrushChrome");
const DEFAULT_LOCK_PATH = path.join(os.tmpdir(), "semrush-shared-chrome.lock");
const LOCK_MAX_AGE_MS = 10 * 60 * 1000;

export function semrushSharedChromeConfig(env = process.env) {
  const port = Number(env.SEMRUSH_CHROME_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SEMRUSH_CHROME_PORT: ${env.SEMRUSH_CHROME_PORT}`);
  }
  return {
    port,
    userDataDir: env.SEMRUSH_CHROME_USER_DATA_DIR || DEFAULT_USER_DATA_DIR,
    lockPath: env.SEMRUSH_LOCK_PATH || DEFAULT_LOCK_PATH
  };
}

export function semrushSharedChromeLaunchArgs(config = semrushSharedChromeConfig()) {
  return [
    `--user-data-dir=${config.userDataDir}`,
    `--remote-debugging-port=${config.port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ];
}

export function isStaleSemrushLockRecord(record, {
  nowMs = Date.now(),
  maxAgeMs = LOCK_MAX_AGE_MS,
  isPidAlive = pidIsAlive
} = {}) {
  const pid = Number(record?.pid || 0);
  const startedMs = Date.parse(record?.started_at || "");
  if (!pid || !Number.isFinite(startedMs)) return true;
  if (nowMs - startedMs > maxAgeMs) return true;
  return !isPidAlive(pid);
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function removeStaleLock(lockPath) {
  let record = null;
  try {
    record = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    record = {};
  }
  if (!isStaleSemrushLockRecord(record)) return false;
  await fs.unlink(lockPath).catch(() => {});
  return true;
}

export async function acquireSemrushSharedLock(action, {
  config = semrushSharedChromeConfig(),
  timeoutMs = 120000
} = {}) {
  await fs.mkdir(path.dirname(config.lockPath), { recursive: true });
  const startedAt = Date.now();
  const payload = JSON.stringify({
    pid: process.pid,
    repo: process.cwd(),
    action,
    started_at: new Date().toISOString()
  }, null, 2);

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const handle = await fs.open(config.lockPath, "wx");
      await handle.writeFile(payload);
      await handle.close();
      return async () => {
        await fs.unlink(config.lockPath).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await removeStaleLock(config.lockPath)) continue;
      await sleep(500);
    }
  }

  throw new Error(`Timed out waiting for Semrush shared lock: ${config.lockPath}`);
}

export async function withSemrushSharedLock(action, callback, options = {}) {
  const release = await acquireSemrushSharedLock(action, options);
  try {
    return await callback();
  } finally {
    await release();
  }
}

export function semrushChromeWebSocketEndpoint(config = semrushSharedChromeConfig()) {
  const endpoint = readDebuggerEndpointFromPort(String(config.port));
  if (!endpoint) {
    throw new Error(`Shared Semrush Chrome is not reachable on 127.0.0.1:${config.port}. Run npm run semrush:ensure first.`);
  }
  return endpoint;
}

export async function ensureSemrushSharedChrome({
  config = semrushSharedChromeConfig()
} = {}) {
  const existingEndpoint = readDebuggerEndpointFromPort(String(config.port));
  if (existingEndpoint) {
    return { ...config, webSocketEndpoint: existingEndpoint, started: false };
  }

  return withSemrushSharedLock("start", async () => {
    const lockedEndpoint = readDebuggerEndpointFromPort(String(config.port));
    if (lockedEndpoint) {
      return { ...config, webSocketEndpoint: lockedEndpoint, started: false };
    }
    if (process.platform !== "darwin") {
      throw new Error("Shared Semrush Chrome auto-start is only supported on macOS.");
    }

    await fs.mkdir(config.userDataDir, { recursive: true });
    const child = spawn(CHROME_BIN, semrushSharedChromeLaunchArgs(config), {
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const endpoint = readDebuggerEndpointFromPort(String(config.port));
      if (endpoint) {
        return { ...config, webSocketEndpoint: endpoint, started: true };
      }
      await sleep(500);
    }

    child.kill("SIGTERM");
    throw new Error(`Timed out starting shared Semrush Chrome on 127.0.0.1:${config.port}`);
  }, { config });
}

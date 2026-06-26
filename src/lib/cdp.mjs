import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ACTIVE_PORT_FILES = [
  "Library/Application Support/Google/Chrome/DevToolsActivePort",
  "Library/Application Support/Google/Chrome Canary/DevToolsActivePort",
  ".config/google-chrome/DevToolsActivePort",
  ".config/chromium/DevToolsActivePort"
];

const FALLBACK_DEBUGGING_PORTS = ["9222", "9333"];
const MACOS_CHROME_REMOTE_DEBUGGING_ALLOW_CLICKER = fileURLToPath(
  new URL("../../scripts/click-chrome-remote-debugging-allow.applescript", import.meta.url)
);

export function chromeWebSocketEndpointFromDevToolsActivePort(port, browserPath) {
  if (!port || !browserPath) {
    return "";
  }
  if (/^wss?:\/\//.test(browserPath)) {
    return browserPath;
  }
  if (!browserPath.startsWith("/")) {
    return "";
  }
  return `ws://127.0.0.1:${port}${browserPath}`;
}

export function readDebuggerEndpointFromPort(port) {
  try {
    const output = execFileSync("curl", [
      "-fsS",
      `http://127.0.0.1:${port}/json/version`
    ], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return JSON.parse(output).webSocketDebuggerUrl || "";
  } catch {
    return "";
  }
}

function startMacChromeRemoteDebuggingAllowClicker() {
  if (
    process.platform !== "darwin" ||
    process.env.CHROME_AUTO_ALLOW_REMOTE_DEBUGGING === "0" ||
    !fs.existsSync(MACOS_CHROME_REMOTE_DEBUGGING_ALLOW_CLICKER)
  ) {
    return null;
  }

  const child = spawn("osascript", [MACOS_CHROME_REMOTE_DEBUGGING_ALLOW_CLICKER], {
    stdio: "ignore"
  });
  child.on("error", () => {});
  child.unref();
  return child;
}

function stopMacChromeRemoteDebuggingAllowClicker(child) {
  if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
    child.kill();
  }
}

export function readChromeWebSocketEndpoint() {
  const userDataDir = process.env.CHROME_USER_DATA_DIR;
  const files = userDataDir
    ? [path.join(userDataDir, "DevToolsActivePort")]
    : DEFAULT_ACTIVE_PORT_FILES.map((file) => path.join(os.homedir(), file));

  const checkedPorts = new Set();

  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue;
    }

    const [port, browserPath] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    if (port && browserPath) {
      checkedPorts.add(port);
      const liveEndpoint = readDebuggerEndpointFromPort(port);
      if (liveEndpoint) {
        return liveEndpoint;
      }
    }
  }

  for (const port of [
    process.env.CHROME_REMOTE_DEBUGGING_PORT,
    ...FALLBACK_DEBUGGING_PORTS
  ].filter(Boolean)) {
    if (checkedPorts.has(port)) {
      continue;
    }
    const liveEndpoint = readDebuggerEndpointFromPort(port);
    if (liveEndpoint) {
      return liveEndpoint;
    }
  }

  throw new Error(
    "Cannot find Chrome DevToolsActivePort. Open Chrome with remote debugging enabled, then retry."
  );
}

export class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    const allowClicker = startMacChromeRemoteDebuggingAllowClicker();
    try {
      this.ws = new WebSocket(this.webSocketUrl);
      this.ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject, timer } = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(timer);
          if (message.error) {
            reject(new Error(message.error.message));
          } else {
            resolve(message.result ?? {});
          }
          return;
        }

        const handlers = this.eventHandlers.get(message.method);
        if (handlers) {
          handlers.forEach((handler) => handler({
            ...(message.params ?? {}),
            sessionId: message.sessionId
          }));
        }
      });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out connecting to Chrome CDP WebSocket"));
        }, 15000);
        this.ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        this.ws.addEventListener("error", (error) => {
          clearTimeout(timer);
          reject(error);
        }, { once: true });
      });
    } finally {
      stopMacChromeRemoteDebuggingAllowClicker(allowClicker);
    }
  }

	  send(method, params = {}, sessionId) {
	    const id = this.nextId;
	    this.nextId += 1;

    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

	    this.ws.send(JSON.stringify(payload));
	    return new Promise((resolve, reject) => {
	      const timer = setTimeout(() => {
	        this.pending.delete(id);
	        reject(new Error(`Timed out waiting for CDP response: ${method}`));
	      }, params?.timeout || 60000);
	      this.pending.set(id, { resolve, reject, timer });
	    });
	  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set());
    }
    this.eventHandlers.get(method).add(handler);
    return () => this.eventHandlers.get(method)?.delete(handler);
  }

  close() {
    this.ws?.close();
  }
}

export async function createChromePage(cdp, url = "about:blank") {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  return attachChromePage(cdp, targetId);
}

export async function attachChromePage(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  return { cdp, sessionId, targetId };
}

export async function detachChromePage(cdp, sessionId) {
  await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
}

export async function withChromePage(callback) {
  const cdp = new CdpClient(readChromeWebSocketEndpoint());
  await cdp.connect();
  const { sessionId, targetId } = await createChromePage(cdp);

  try {
    return await callback({ cdp, sessionId, targetId });
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
}

export async function withExistingChromePage(targetId, callback) {
  const cdp = new CdpClient(readChromeWebSocketEndpoint());
  await cdp.connect();
  const { sessionId } = await attachChromePage(cdp, targetId);

  try {
    return await callback({ cdp, sessionId, targetId });
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    cdp.close();
  }
}

export async function listChromeTargets() {
  const cdp = new CdpClient(readChromeWebSocketEndpoint());
  await cdp.connect();
  try {
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    return targetInfos;
  } finally {
    cdp.close();
  }
}

export async function waitForChromeTarget(predicate, timeoutMs = 15000) {
  const cdp = new CdpClient(readChromeWebSocketEndpoint());
  await cdp.connect();

  try {
    return await waitForChromeTargetWithCdp(cdp, predicate, timeoutMs);
  } finally {
    cdp.close();
  }
}

export async function waitForChromeTargetWithCdp(cdp, predicate, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    const match = targetInfos.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Timed out waiting for Chrome target.");
}

export async function navigateAndWait(cdp, sessionId, url, timeoutMs = 30000) {
  let timer;
  let unsubscribe = () => {};
  const loaded = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out while loading ${url}`));
    }, timeoutMs);

    unsubscribe = cdp.on("Page.loadEventFired", () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });

  try {
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;
  } catch (error) {
    clearTimeout(timer);
    unsubscribe();
    throw error;
  }
}

export async function evaluate(cdp, sessionId, expression, timeoutMs = 30000) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs
    },
    sessionId
  );

  if (result.exceptionDetails) {
    const message =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "Evaluation failed";
    throw new Error(message);
  }

  return result.result?.value;
}

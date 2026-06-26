import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachChromePage, detachChromePage, evaluate, waitForChromeTarget, waitForChromeTargetWithCdp } from "./cdp.mjs";

const CHROME_ROOT = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

export function listChromeProfiles() {
  if (!fs.existsSync(CHROME_ROOT)) {
    return [];
  }

  return fs
    .readdirSync(CHROME_ROOT)
    .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
    .flatMap((directory) => {
      const preferencesPath = path.join(CHROME_ROOT, directory, "Preferences");
      if (!fs.existsSync(preferencesPath)) {
        return [];
      }

      const preferences = readJson(preferencesPath);
      const accounts = preferences.account_info || [];
      return [
        {
          directory,
          name: preferences.profile?.name || "",
          email: accounts[0]?.email || "",
          fullName: accounts[0]?.full_name || "",
          accounts: accounts.map((account) => ({
            email: account.email || "",
            fullName: account.full_name || ""
          }))
        }
      ];
    });
}

export function findChromeProfile(account) {
  const expected = normalize(account);
  const profiles = listChromeProfiles();
  const match = profiles.find((profile) => {
    const candidates = [
      profile.directory,
      profile.name,
      profile.email,
      profile.fullName,
      ...profile.accounts.flatMap((item) => [item.email, item.fullName])
    ];
    return candidates.some((candidate) => normalize(candidate) === expected);
  });

  if (!match) {
    const available = profiles
      .map((profile) => `${profile.email || profile.name || profile.directory} (${profile.directory})`)
      .join(", ");
    throw new Error(`Cannot find Chrome profile for "${account}". Available profiles: ${available}`);
  }

  return match;
}

export async function openChromeProfileUrl(profile, url) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      CHROME_BIN,
      [`--profile-directory=${profile.directory}`, url],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    const timer = setTimeout(resolve, 1000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Failed to open Chrome profile ${profile.directory}; open exited ${code}`));
      }
    });
    child.unref();
  });
}

export async function ensureChromeProfileTarget(profile, url, timeoutMs = 20000) {
  await openChromeProfileUrl(profile, url);
  return waitForChromeTarget(
    (target) => target.type === "page" && target.url.startsWith(url),
    timeoutMs
  );
}

export async function ensureChromeProfileTargetWithCdp(cdp, profile, url, timeoutMs = 20000) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const target = await waitForChromeTargetWithCdp(
    cdp,
    (target) => target.type === "page" && target.targetId === targetId && target.url.startsWith(url),
    timeoutMs
  );
  const page = await attachChromePage(cdp, target.targetId);
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const location = await evaluate(cdp, page.sessionId, "location.href", 3000).catch(() => "");
      if (location && location !== "about:blank") {
        return target;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for Chrome target to leave about:blank: ${url}`);
  } finally {
    await detachChromePage(cdp, page.sessionId);
  }
}

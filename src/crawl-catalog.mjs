#!/usr/bin/env node
import path from "node:path";
import { readArg, readFlag } from "./lib/args.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import { writeAmazonCatalogCategories } from "./amazon-catalog-to-sheet.mjs";
import {
  DEFAULT_PLATFORM_IDS,
  crawlCatalog,
  createCatalogState,
  getPlatformConfig,
  readCatalogState
} from "./lib/catalog-crawler.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, fallback));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} 必须是非负数字`);
  }
  return value;
}

export function parsePlatformIds(value = "all") {
  const raw = String(value || "all").trim().toLowerCase();
  if (raw === "all") {
    return DEFAULT_PLATFORM_IDS;
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

export function createCatalogSheetWriteQueue({
  sheetUrl,
  batchSize = 200,
  delayMs = 1000,
  dryRun = false,
  crawledAt = new Date().toISOString(),
  writeCategories = writeAmazonCatalogCategories,
  logStatus = () => {}
}) {
  let pending = [];
  let writeChain = Promise.resolve();
  let lastWriteAt = 0;
  const totals = { writtenRows: 0, updatedRows: 0, skippedRows: 0, batches: 0 };

  async function writeBatch(categories) {
    if (dryRun || categories.length === 0) {
      return;
    }
    const batch = categories.slice();
    writeChain = writeChain.then(async () => {
      const waitMs = Math.max(delayMs - (Date.now() - lastWriteAt), 0);
      if (lastWriteAt && waitMs > 0) {
        await sleep(waitMs);
      }
      logStatus(`writing batch categories=${batch.length}`);
      const result = await writeCategories({ sheetUrl, categories: batch, crawledAt });
      lastWriteAt = Date.now();
      totals.writtenRows += result.writtenRows || 0;
      totals.updatedRows += result.updatedRows || 0;
      totals.skippedRows += result.skippedRows || 0;
      totals.batches += 1;
      logStatus(`sheet written=${totals.writtenRows} updated=${totals.updatedRows} skipped=${totals.skippedRows}`);
    });
    await writeChain;
  }

  return {
    async enqueue(categories = []) {
      if (dryRun || categories.length === 0) {
        return;
      }
      pending.push(...categories);
      if (pending.length >= batchSize) {
        const batch = pending;
        pending = [];
        await writeBatch(batch);
      }
    },
    async flush() {
      const batch = pending;
      pending = [];
      await writeBatch(batch);
    },
    stats() {
      return { ...totals, pendingRows: pending.length };
    }
  };
}

function logStatus(message) {
  console.error(`[catalog:crawl] ${new Date().toISOString()} ${message}`);
}

function statePathFor({ platformId, stateDir, statePath }) {
  return statePath || path.join(stateDir, `${platformId}.json`);
}

async function main() {
  const sheetUrl = readArg("sheet", DEFAULT_SHEET_URL);
  const platformIds = parsePlatformIds(readArg("platform", "all"));
  const rootUrl = readArg("root", "");
  const maxDepth = readNumberArg("max-depth", 10);
  const maxPages = readNumberArg("max-pages", 0);
  const delayMs = readNumberArg("delay-ms", 1500);
  const batchSize = readNumberArg("batch-size", 200);
  const logEveryMs = readNumberArg("log-every-ms", 5000);
  const sheetWriteDelayMs = readNumberArg("sheet-write-delay-ms", 1000);
  const stateDir = readArg("state-dir", "state/catalog-crawl");
  const statePath = readArg("state", "");
  const dryRun = readFlag("dry-run");
  const resume = readFlag("resume");
  const resetState = readFlag("reset-state");
  const crawledAt = new Date().toISOString();

  if (rootUrl && platformIds.length !== 1) {
    throw new Error("--root 只能和单个平台一起使用");
  }
  if (statePath && platformIds.length !== 1) {
    throw new Error("--state 只能和单个平台一起使用");
  }

  const writeQueue = createCatalogSheetWriteQueue({
    sheetUrl,
    batchSize,
    delayMs: sheetWriteDelayMs,
    dryRun,
    crawledAt,
    logStatus
  });
  const lastLogByPlatform = new Map();

  async function crawlPlatform(platformId) {
    const baseConfig = getPlatformConfig(platformId);
    const config = rootUrl ? { ...baseConfig, rootUrls: [rootUrl] } : baseConfig;
    const platformStatePath = statePathFor({ platformId: config.id, stateDir, statePath });
    const state = resume && !resetState
      ? readCatalogState(platformStatePath) || createCatalogState(config)
      : createCatalogState(config);
    const initialVisited = new Set(state.visited || []).size;
    const startedAt = Date.now();

    logStatus(`${config.platform} start resume=${resume} maxDepth=${maxDepth} maxPages=${maxPages} state=${platformStatePath}`);
    if (!dryRun && state.categories?.length) {
      await writeQueue.enqueue(state.categories);
    }

    const result = await crawlCatalog({
      config,
      maxDepth,
      maxPages,
      delayMs,
      state,
      statePath: platformStatePath,
      persistState: !dryRun,
      onCategories: async (categories) => {
        await writeQueue.enqueue(categories);
      },
      onProgress: async (progress) => {
        const now = Date.now();
        const lastLogAt = lastLogByPlatform.get(config.id) || 0;
        if (logEveryMs > 0 && now - lastLogAt < logEveryMs && !progress.paused) {
          return;
        }
        lastLogByPlatform.set(config.id, now);
        const pagesThisRun = Math.max(progress.pagesVisited - initialVisited, 0);
        const elapsedSeconds = Math.max((now - startedAt) / 1000, 1);
        const pagesPerMinute = Math.round((pagesThisRun / elapsedSeconds) * 60);
        logStatus(`${config.platform} visited=${progress.pagesVisited} run=${pagesThisRun} queue=${progress.queueLength} categories=${progress.categoryCount} new=${progress.newCategoryCount} errors=${progress.errorCount} rate=${pagesPerMinute}/min${progress.paused ? ` paused=${progress.pauseReason}` : ""}`);
      }
    });

    logStatus(`${config.platform} done visited=${result.pagesVisited} queue=${result.queueLength} categories=${result.categories.length} errors=${result.errors.length}${result.paused ? ` paused=${result.pauseReason}` : ""}`);
    return result;
  }

  const settled = await Promise.allSettled(platformIds.map(crawlPlatform));
  await writeQueue.flush();
  const results = settled.map((item, index) => item.status === "fulfilled"
    ? item.value
    : { platformId: platformIds[index], paused: true, pauseReason: item.reason?.message || String(item.reason), errors: [{ reason: item.reason?.message || String(item.reason) }] });
  const writeStats = writeQueue.stats();

  console.log(JSON.stringify({
    platforms: platformIds,
    maxDepth,
    maxPages,
    delayMs,
    batchSize,
    sheetWriteDelayMs,
    stateDir,
    dryRun,
    results: results.map((result) => ({
      platformId: result.platformId,
      paused: result.paused,
      pauseReason: result.pauseReason,
      pagesVisited: result.pagesVisited || 0,
      categoryCount: result.categories?.length || 0,
      errorCount: result.errors?.length || 0,
      queueLength: result.queueLength || 0
    })),
    ...writeStats
  }, null, 2));

  if (results.some((result) => result.paused || result.errors?.length)) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { readArg, readFlag } from "./lib/args.mjs";
import { DEFAULT_SHEET_URL } from "./lib/tool-config.mjs";
import { writeAmazonCatalogCategories } from "./amazon-catalog-to-sheet.mjs";
import {
  DEFAULT_ROOT_URL,
  crawlAmazonCatalog,
  createAmazonCatalogState,
  readAmazonCatalogState
} from "./lib/amazon-catalog-crawler.mjs";

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, fallback));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} 必须是非负数字`);
  }
  return value;
}

function logStatus(message) {
  console.error(`[amazon:crawl] ${new Date().toISOString()} ${message}`);
}

async function main() {
  const sheetUrl = readArg("sheet", DEFAULT_SHEET_URL);
  const rootUrl = readArg("root", DEFAULT_ROOT_URL);
  const maxDepth = readNumberArg("max-depth", 10);
  const maxPages = readNumberArg("max-pages", 0);
  const delayMs = readNumberArg("delay-ms", 1500);
  const batchSize = readNumberArg("batch-size", 200);
  const logEveryMs = readNumberArg("log-every-ms", 5000);
  const statePath = readArg("state", "state/amazon-catalog-crawl.json");
  const dryRun = readFlag("dry-run");
  const resume = readFlag("resume");
  const resetState = readFlag("reset-state");
  const crawledAt = new Date().toISOString();

  const state = resume && !resetState
    ? readAmazonCatalogState(statePath) || createAmazonCatalogState(rootUrl)
    : createAmazonCatalogState(rootUrl);
  let pending = [];
  let writtenRows = 0;
  let updatedRows = 0;
  let skippedRows = 0;
  const startedAt = Date.now();
  const initialVisited = new Set(state.visited || []).size;
  let lastLogAt = 0;

  async function writeBatch(categories) {
    if (dryRun || categories.length === 0) {
      return;
    }
    logStatus(`writing batch categories=${categories.length}`);
    const result = await writeAmazonCatalogCategories({ sheetUrl, categories, crawledAt });
    writtenRows += result.writtenRows || 0;
    updatedRows += result.updatedRows || 0;
    skippedRows += result.skippedRows || 0;
    logStatus(`sheet written=${writtenRows} updated=${updatedRows} skipped=${skippedRows}`);
  }

  function logProgress(progress, force = false) {
    const now = Date.now();
    if (!force && logEveryMs > 0 && now - lastLogAt < logEveryMs) {
      return;
    }
    lastLogAt = now;
    const pagesThisRun = Math.max(progress.pagesVisited - initialVisited, 0);
    const elapsedSeconds = Math.max((now - startedAt) / 1000, 1);
    const pagesPerMinute = Math.round((pagesThisRun / elapsedSeconds) * 60);
    logStatus(`visited=${progress.pagesVisited} run=${pagesThisRun} queue=${progress.queueLength} categories=${progress.categoryCount} new=${progress.newCategoryCount} errors=${progress.errorCount} depth=${progress.depth} rate=${pagesPerMinute}/min pendingWrite=${pending.length}`);
  }

  logStatus(`start resume=${resume} maxDepth=${maxDepth} maxPages=${maxPages} delayMs=${delayMs} batchSize=${batchSize} state=${statePath}`);
  logStatus(`loaded visited=${initialVisited} rawQueue=${state.queue?.length || 0} categories=${state.categories?.length || 0} errors=${state.errors?.length || 0}`);
  if (resume && state.categories?.length) {
    logStatus(`sync state categories=${state.categories.length}`);
    await writeBatch(state.categories);
  }

  const result = await crawlAmazonCatalog({
    rootUrl,
    maxDepth,
    maxPages,
    delayMs,
    state,
    statePath,
    persistState: !dryRun,
    onCategories: async (categories) => {
      pending.push(...categories);
      if (pending.length >= batchSize) {
        const batch = pending;
        pending = [];
        await writeBatch(batch);
      }
    },
    onProgress: async (progress) => {
      logProgress(progress);
    }
  });
  await writeBatch(pending);
  logProgress({
    pagesVisited: result.pagesVisited,
    queueLength: result.queueLength,
    categoryCount: result.categories.length,
    newCategoryCount: 0,
    errorCount: result.errors.length,
    depth: "-"
  }, true);

  console.log(JSON.stringify({
    rootUrl,
    maxDepth,
    maxPages,
    delayMs,
    batchSize,
    logEveryMs,
    statePath,
    pagesVisited: result.pagesVisited,
    categoryCount: result.categories.length,
    errorCount: result.errors.length,
    queueLength: result.queueLength,
    writtenRows,
    updatedRows,
    skippedRows,
    dryRun
  }, null, 2));

  if (result.errors.length > 0) {
    console.error(JSON.stringify({ errors: result.errors.slice(0, 5) }, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

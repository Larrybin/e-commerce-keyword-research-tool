export function resolveTaskRows({ rowArg = "", fromRowArg = "", toRowArg = "" }) {
  if (fromRowArg || toRowArg) {
    const fromRow = Number(fromRowArg || toRowArg);
    const toRow = Number(toRowArg || fromRowArg);
    if (!Number.isInteger(fromRow) || !Number.isInteger(toRow) || fromRow < 2 || toRow < fromRow) {
      throw new Error(`Invalid row range: from-row=${fromRowArg || ""}, to-row=${toRowArg || ""}`);
    }
    return Array.from({ length: toRow - fromRow + 1 }, (_, index) => fromRow + index);
  }

  const row = Number(rowArg || "2");
  if (!Number.isInteger(row) || row < 2) {
    throw new Error(`Invalid row: ${rowArg}`);
  }
  return [row];
}

export function hasTaskInput(row) {
  return Boolean((row?.["词根"] || "").trim() || (row?.["关键词"] || "").trim());
}

export function isCompletedTask(row) {
  const status = (row?.["SEM完成状态"] || "").trim();
  return /^已完成\d+个关键词采集$/.test(status) || status === "已完成关键词采集";
}

export function taskRunKey(task) {
  const rowPrefix = task.rowNumber ? `row-${task.rowNumber}-` : "";
  return `${rowPrefix}${task.mode}-${task.query}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
}

export function toOutputRows(rows, { country = "", source = "" } = {}) {
  return rows.map((row) => ({
    词根: row.root,
    关键词: row.keyword,
    国家: country || row.country || row.国家 || "",
    来源: source || row.来源 || "semrush",
    搜索量: row.volume,
    KD: row.kd,
    semrush_page: row.semrush_page
  }));
}

export function shortErrorMessage(error) {
  const message = error?.message || String(error);
  return message.replace(/\s+/g, " ").slice(0, 120);
}

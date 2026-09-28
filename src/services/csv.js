"use strict";

/**
 * CSV export (T2 check 7).
 *
 * RFC 4180: fields containing a comma, a quote or a newline are quoted, and an
 * embedded quote is doubled. Project titles in the fixtures are plain, but a
 * real submission titled `Hello, "world"` must not shift every column, so the
 * quoting is exercised by a unit test rather than assumed.
 */

const COLUMNS = [
  "mode",
  "rank",
  "project_id",
  "project_title",
  "track",
  "weighted_score",
  "review_count",
  "judge_count",
  "flagged",
];

function cell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(values) {
  return values.map(cell).join(",");
}

function buildCsv(results, { mode = "both" } = {}) {
  const lines = [row(COLUMNS)];
  if (results.mode === "none") return lines.join("\n") + "\n";

  const modes = mode === "both" ? ["raw", "normalized"] : [mode];
  for (const m of modes) {
    for (const r of results[m] || []) {
      lines.push(
        row([m, r.rank, r.projectId, r.title, r.track, fmt(r.score), r.reviewCount, r.judgeCount, r.flagged ? "yes" : "no"]),
      );
    }
  }
  return lines.join("\n") + "\n";
}

function fmt(n) {
  if (typeof n !== "number") return "";
  return (Math.round(n * 10000) / 10000).toFixed(4);
}

module.exports = { buildCsv, COLUMNS };

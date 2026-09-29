"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCsv } = require("../../src/services/csv");

test("export neutralizes spreadsheet formulas in project titles", () => {
  const hostile = ["=1+1", "+cmd", "-2+3", "@SUM(1,2)", "\t=1+1", "\r=1+1", "  =1+1"];
  const csv = buildCsv({ mode: "both", raw: hostile.map((title, index) => ({
    rank: index + 1, projectId: `p${index}`, title, track: "Test", score: 3,
    reviewCount: 1, judgeCount: 1, flagged: false,
  })) }, { mode: "raw" });

  for (const title of hostile) {
    assert.ok(csv.includes(`'${title}`), `formula cell was not neutralized: ${JSON.stringify(title)}`);
  }
  assert.ok(csv.startsWith("mode,rank,project_id,project_title,"));
});

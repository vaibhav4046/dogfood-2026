"use strict";

/**
 * Prints the distortion scenario so the test's thresholds are set from an
 * observed run rather than from a guess. Nothing here asserts; it is a
 * measuring instrument used while writing the test.
 */

const { normalize } = require("../src/lib/normalize");
const { CRITERIA } = require("../tests/fixtures/synthetic");

const flat = (n) => ({ functionality: n, quality: n, innovation: n });

/*
 * One body of work, two panels.
 *
 *   prj_P  reviewed only by lenient judges  -> raw looks excellent
 *   prj_Q  reviewed only by harsh judges    -> raw looks terrible
 *
 * They are the same submission. Raw averaging reports a four-point spread
 * that exists only because of who was on the panel. Each judge is given a
 * spread of scores on other projects so their personal sd is real, not zero.
 */
const reviews = [
  // lenient panel
  { judgeId: "lenient_1", projectId: "prj_P", scores: flat(5) },
  { judgeId: "lenient_2", projectId: "prj_P", scores: flat(5) },
  // harsh panel
  { judgeId: "harsh_1", projectId: "prj_Q", scores: flat(1) },
  { judgeId: "harsh_2", projectId: "prj_Q", scores: flat(1) },

  // history, so every judge has a personal baseline with non-zero sd
  { judgeId: "lenient_1", projectId: "prj_L1", scores: flat(4) },
  { judgeId: "lenient_1", projectId: "prj_L2", scores: flat(4) },
  { judgeId: "lenient_2", projectId: "prj_L1", scores: flat(4) },
  { judgeId: "lenient_2", projectId: "prj_L2", scores: flat(4) },
  { judgeId: "harsh_1", projectId: "prj_H1", scores: flat(2) },
  { judgeId: "harsh_1", projectId: "prj_H2", scores: flat(2) },
  { judgeId: "harsh_2", projectId: "prj_H1", scores: flat(2) },
  { judgeId: "harsh_2", projectId: "prj_H2", scores: flat(2) },
];

const r = normalize(reviews, CRITERIA);
const pick = (rows, id) => rows.find((x) => x.projectId === id);

console.log("judge severity:");
for (const s of r.judgeStats) {
  console.log(
    `  ${s.judgeId.padEnd(10)} n=${s.reviewCount} mean=${s.mean.toFixed(3)} sd=${s.sd.toFixed(3)} lambda=${s.lambda.toFixed(3)} degenerate=${s.degenerate}`,
  );
}
console.log(`global mean=${r.global.mean.toFixed(4)} sd=${r.global.sd.toFixed(4)}`);

for (const id of ["prj_P", "prj_Q"]) {
  const a = pick(r.raw, id);
  const b = pick(r.normalized, id);
  console.log(
    `${id}: raw=${a.score.toFixed(4)} rank=${a.rank}   normalized=${b.score.toFixed(4)} rank=${b.rank}`,
  );
}

const rawGap = Math.abs(pick(r.raw, "prj_P").score - pick(r.raw, "prj_Q").score);
const normGap = Math.abs(pick(r.normalized, "prj_P").score - pick(r.normalized, "prj_Q").score);
console.log(`\nraw gap       = ${rawGap.toFixed(4)}`);
console.log(`normalized gap= ${normGap.toFixed(4)}`);
console.log(`reduction     = ${(100 * (1 - normGap / rawGap)).toFixed(1)}%`);
console.log(`fingerprint   = ${r.fingerprint}`);

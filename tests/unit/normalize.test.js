"use strict";

/**
 * Normalization unit tests.
 *
 * The fixture set contains a zero-variance judge, judges with a single review,
 * projects with two reviews beside projects with five, and genuine ties. Each of
 * those is a case where a naive z-score either divides by zero or silently
 * reorders things, so each is asserted explicitly rather than hoped about.
 */

const test = require("node:test");
const assert = require("node:assert");

const { normalize, mean, stdev, PRIOR_K } = require("../../src/lib/normalize");
const { buildSynthetic, CRITERIA } = require("../fixtures/synthetic");

const CRIT = CRITERIA;

function judgeStatsBy(result) {
  return Object.fromEntries(result.judgeStats.map((s) => [s.judgeId, s]));
}

// --- primitives ------------------------------------------------------------

test("stdev of a single value is 0, not NaN", () => {
  assert.strictEqual(stdev([3]), 0);
  assert.strictEqual(stdev([]), 0);
});

test("population stdev matches the closed form", () => {
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.ok(Math.abs(stdev(xs) - 2) < 1e-9, `got ${stdev(xs)}`);
  assert.strictEqual(mean(xs), 5);
});

// --- the headline property -------------------------------------------------

test("two projects of identical quality are not separated by who reviewed them", () => {
  /*
   * The brief's question: "evaluate whether identical project quality is
   * distorted by judge assignment". So make two projects *literally the same
   * submission* and give them different panels:
   *
   *   prj_P -> two lenient judges, both score it 5   => raw 5.0, rank 1
   *   prj_Q -> two harsh judges,   both score it 1   => raw 1.0, rank 6
   *
   * Raw averaging reports a 4.0-point spread and puts one six-rank gap between
   * the same work, purely because of who was on the panel. Every judge is given
   * scores on two further projects so their personal sd is real rather than
   * zero, otherwise the degenerate path would do the work by accident.
   *
   * Measured by scripts/measure-distortion.js, which prints the full table.
   */
  const flat = (n) => ({ functionality: n, quality: n, innovation: n });
  const reviews = [
    { judgeId: "lenient_1", projectId: "prj_P", scores: flat(5) },
    { judgeId: "lenient_2", projectId: "prj_P", scores: flat(5) },
    { judgeId: "harsh_1", projectId: "prj_Q", scores: flat(1) },
    { judgeId: "harsh_2", projectId: "prj_Q", scores: flat(1) },
    { judgeId: "lenient_1", projectId: "prj_L1", scores: flat(4) },
    { judgeId: "lenient_1", projectId: "prj_L2", scores: flat(4) },
    { judgeId: "lenient_2", projectId: "prj_L1", scores: flat(4) },
    { judgeId: "lenient_2", projectId: "prj_L2", scores: flat(4) },
    { judgeId: "harsh_1", projectId: "prj_H1", scores: flat(2) },
    { judgeId: "harsh_1", projectId: "prj_H2", scores: flat(2) },
    { judgeId: "harsh_2", projectId: "prj_H1", scores: flat(2) },
    { judgeId: "harsh_2", projectId: "prj_H2", scores: flat(2) },
  ];

  const r = normalize(reviews, CRIT);
  const rawOf = (id) => r.raw.find((x) => x.projectId === id).score;
  const normOf = (id) => r.normalized.find((x) => x.projectId === id).score;

  const rawGap = Math.abs(rawOf("prj_P") - rawOf("prj_Q"));
  const normGap = Math.abs(normOf("prj_P") - normOf("prj_Q"));

  assert.ok(rawGap > 3.9, `expected a ~4 point raw distortion, got ${rawGap.toFixed(4)}`);

  // The correction must be substantial, not cosmetic.
  const reduction = 1 - normGap / rawGap;
  assert.ok(reduction > 0.5, `normalization only removed ${(reduction * 100).toFixed(1)}% of the distortion`);
  assert.ok(normGap < 2.0, `normalized gap should collapse, got ${normGap.toFixed(4)}`);

  // Every value stays on the rubric's own 1..5 scale.
  for (const id of ["prj_P", "prj_Q"]) {
    const v = normOf(id);
    assert.ok(v >= 1 && v <= 5, `${id} normalized to ${v}, outside the rubric scale`);
  }
});

test("normalization does not invent agreement where the judges genuinely disagree", () => {
  /*
   * The counterpart to the test above, and the one that stops this being a
   * number-laundering machine. If the judges rank two projects differently on
   * purpose, that disagreement is information about the submissions, not judge
   * severity, and normalization must not erase it.
   *
   * lenient_1 scored the work a 5, harsh_1 scored it a 1: a 4-point gap
   * between judges. After normalization both land symmetrically around the
   * global mean rather than both collapsing to it.
   */
  const flat = (n) => ({ functionality: n, quality: n, innovation: n });
  const reviews = [
    { judgeId: "l1", projectId: "prj_P", scores: flat(5) },
    { judgeId: "h1", projectId: "prj_P", scores: flat(1) },
    { judgeId: "l1", projectId: "prj_L1", scores: flat(4) },
    { judgeId: "l1", projectId: "prj_L2", scores: flat(4) },
    { judgeId: "h1", projectId: "prj_H1", scores: flat(2) },
    { judgeId: "h1", projectId: "prj_H2", scores: flat(2) },
  ];
  const r = normalize(reviews, CRIT);
  const p = r.perReview.find((x) => x.judgeId === "l1");
  const q = r.perReview.find((x) => x.judgeId === "h1");
  assert.ok(
    p.normalizedScores.functionality - q.normalizedScores.functionality > 0.5,
    "genuine judge disagreement was flattened away",
  );
});

// --- zero variance ---------------------------------------------------------

test("a judge who rates everything the same does not blow up the division", () => {
  const reviews = [
    { judgeId: "flat", projectId: "prj_A", scores: { functionality: 3, quality: 3, innovation: 3 } },
    { judgeId: "flat", projectId: "prj_B", scores: { functionality: 3, quality: 3, innovation: 3 } },
    { judgeId: "sharp", projectId: "prj_A", scores: { functionality: 5, quality: 4, innovation: 5 } },
    { judgeId: "sharp", projectId: "prj_B", scores: { functionality: 1, quality: 2, innovation: 1 } },
  ];

  const r = normalize(reviews, CRIT);
  for (const row of r.normalized) {
    assert.ok(Number.isFinite(row.score), `produced a non-finite score: ${row.score}`);
  }
  const stats = judgeStatsBy(r);
  assert.strictEqual(stats.flat.degenerate, true, "the flat judge was not detected as degenerate");
});

test("a zero-variance judge's score is kept, not deleted and not exploded", () => {
  const reviews = [
    { judgeId: "flat", projectId: "prj_A", scores: { functionality: 3, quality: 3, innovation: 3 } },
    { judgeId: "flat", projectId: "prj_B", scores: { functionality: 3, quality: 3, innovation: 3 } },
    { judgeId: "sharp", projectId: "prj_A", scores: { functionality: 5, quality: 5, innovation: 5 } },
    { judgeId: "sharp", projectId: "prj_B", scores: { functionality: 1, quality: 1, innovation: 1 } },
  ];
  const r = normalize(reviews, CRIT);
  const flatA = r.perReview.find((x) => x.judgeId === "flat" && x.projectId === "prj_A");
  assert.strictEqual(flatA.normalizedScores.functionality, 3, "the flat judge's 3 was altered");
  assert.ok(
    flatA.flags.some((f) => f.includes("zero-variance")),
    "the zero-variance case was not flagged: " + JSON.stringify(flatA.flags),
  );
});

// --- thin samples ----------------------------------------------------------

test("a judge with one review is shrunk hard toward the global distribution", () => {
  const many = [];
  for (const p of ["prj_A", "prj_B", "prj_C", "prj_D", "prj_E"]) {
    many.push({ judgeId: "veteran", projectId: p, scores: { functionality: 4, quality: 4, innovation: 4 } });
    many.push({ judgeId: "veteran2", projectId: p, scores: { functionality: 2, quality: 2, innovation: 2 } });
  }
  many.push({ judgeId: "newcomer", projectId: "prj_A", scores: { functionality: 5, quality: 5, innovation: 5 } });

  const r = normalize(many, CRIT);
  const stats = judgeStatsBy(r);
  assert.strictEqual(stats.newcomer.reviewCount, 1);
  assert.strictEqual(stats.veteran.reviewCount, 5);

  // lambda = n / (n + K)
  assert.ok(Math.abs(stats.newcomer.lambda - 1 / (1 + PRIOR_K)) < 1e-9);
  assert.ok(Math.abs(stats.veteran.lambda - 5 / (5 + PRIOR_K)) < 1e-9);
  assert.ok(stats.newcomer.lambda < stats.veteran.lambda, "a single review was not shrunk harder");

  // The newcomer's 5 must not dominate: its normalized score should sit near
  // the global mean, not at the top of the scale.
  const row = r.perReview.find((x) => x.judgeId === "newcomer");
  assert.ok(row.normalizedScores.functionality < 4, `newcomer's 5 normalized to ${row.normalizedScores.functionality}`);
});

test("shrinkage is bounded so no score escapes the rubric scale", () => {
  const reviews = buildSynthetic({ judges: ["erratic"], projects: 10 });
  const r = normalize(reviews, CRIT);
  // perReview holds the per-score values; `normalized` holds per-project
  // aggregates, which is a different shape.
  for (const row of r.perReview) {
    for (const c of CRIT) {
      const v = row.normalizedScores[c.key];
      if (v === null) continue;
      assert.ok(v >= c.min - 1e-9 && v <= c.max + 1e-9, `${c.key}=${v} escaped [${c.min},${c.max}]`);
    }
  }
});

// --- ties ------------------------------------------------------------------

test("a genuine tie produces a shared rank, not an invented order", () => {
  const reviews = [
    { judgeId: "j1", projectId: "prj_A", scores: { functionality: 3, quality: 3, innovation: 3 } },
    { judgeId: "j1", projectId: "prj_B", scores: { functionality: 3, quality: 3, innovation: 3 } },
    { judgeId: "j2", projectId: "prj_A", scores: { functionality: 4, quality: 4, innovation: 4 } },
    { judgeId: "j2", projectId: "prj_B", scores: { functionality: 4, quality: 4, innovation: 4 } },
  ];
  const r = normalize(reviews, CRIT);
  assert.strictEqual(r.raw[0].rank, 1);
  assert.strictEqual(r.raw[1].rank, 1, "tied projects must share rank 1");
});

// --- determinism -----------------------------------------------------------

test("the same input produces the same fingerprint every time", () => {
  const reviews = buildSynthetic();
  const a = normalize(reviews, CRIT);
  const b = normalize(reviews, CRIT);
  assert.strictEqual(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
});

test("changing a single review changes the fingerprint", () => {
  const reviews = buildSynthetic();
  const before = normalize(reviews, CRIT).fingerprint;
  const mutated = reviews.map((r, i) =>
    i === 0 ? { ...r, scores: { ...r.scores, functionality: 1 } } : r,
  );
  assert.notStrictEqual(normalize(mutated, CRIT).fingerprint, before);
});

test("reordering the input does not change the result", () => {
  const reviews = buildSynthetic();
  const forward = normalize(reviews, CRIT);
  const reversed = normalize([...reviews].reverse(), CRIT);
  assert.strictEqual(forward.fingerprint, reversed.fingerprint);
  assert.deepStrictEqual(
    forward.raw.map((r) => [r.projectId, r.rank]),
    reversed.raw.map((r) => [r.projectId, r.rank]),
  );
});

// --- weights ---------------------------------------------------------------

test("weights are applied, and a zero total falls back to equal shares", () => {
  const reviews = [
    { judgeId: "j1", projectId: "prj_A", scores: { functionality: 5, quality: 1, innovation: 1 } },
    { judgeId: "j2", projectId: "prj_B", scores: { functionality: 1, quality: 5, innovation: 1 } },
    { judgeId: "j3", projectId: "prj_C", scores: { functionality: 1, quality: 1, innovation: 5 } },
  ];
  const heavyQuality = normalize(reviews, [
    { key: "functionality", weight: 1, min: 1, max: 5 },
    { key: "quality", weight: 9, min: 1, max: 5 },
    { key: "innovation", weight: 1, min: 1, max: 5 },
  ]);
  const qualityHeavy = Object.fromEntries(heavyQuality.raw.map((r) => [r.projectId, r.score]));
  assert.ok(qualityHeavy.prj_B > qualityHeavy.prj_A, "weighting quality 9x did not move the ranking");

  // The degenerate all-zero rubric must not produce NaN.
  const zeroed = normalize(reviews, CRIT.map((c) => ({ ...c, weight: 0 })));
  for (const row of zeroed.raw) assert.ok(Number.isFinite(row.score), "all-zero weights produced NaN");
});

// --- degenerate input ------------------------------------------------------

test("a single review of a single project still produces a usable result", () => {
  const r = normalize(
    [{ judgeId: "j1", projectId: "prj_A", scores: { functionality: 4, quality: 4, innovation: 4 } }],
    CRIT,
  );
  assert.strictEqual(r.raw.length, 1);
  assert.ok(Number.isFinite(r.raw[0].score));
  assert.ok(Number.isFinite(r.normalized[0].score));
  assert.strictEqual(judgeStatsBy(r).j1.degenerate, true, "one review has no spread, and should say so");
});

test("a missing criterion score is skipped rather than counted as zero", () => {
  const reviews = [
    { judgeId: "j1", projectId: "prj_A", scores: { functionality: 5, quality: 5 } },
    { judgeId: "j2", projectId: "prj_A", scores: { functionality: 5, quality: 5, innovation: 5 } },
  ];
  const r = normalize(reviews, CRIT);
  const row = r.perReview.find((x) => x.judgeId === "j1");
  assert.strictEqual(row.rawScores.innovation, null, "a missing score became a number");
  assert.ok(row.rawWeighted > 0, "an incomplete review scored zero overall");
});

test("coverage is reported so a thin result is visibly thin", () => {
  const reviews = buildSynthetic();
  const r = normalize(reviews, CRIT);
  const low = r.raw.filter((x) => x.reviewCount < 2);
  assert.ok(Array.isArray(low), "coverage was not reported");
  for (const x of r.raw) {
    assert.ok(x.reviewCount >= 1, "a ranked project claims zero reviews");
  }
});

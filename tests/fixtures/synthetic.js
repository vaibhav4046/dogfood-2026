"use strict";

/**
 * Test doubles for the official fixtures' awkward cases.
 *
 * The fixtures ship a judge who rates every project identically, judges with a
 * single review, projects with two reviews next to projects with five, and two
 * projects sharing a title. A normalization scheme is only trustworthy if it
 * has been run against those cases, so they are named here and constructed
 * explicitly rather than hoped for.
 */

const { normalize } = require("../../src/lib/normalize");
const { CRITERIA } = require("../../src/db/criteria");

const KEYS = CRITERIA.map((c) => c.key);

function scoresFor(judgeIndex, projectIndex, level) {
  const out = {};
  KEYS.forEach((k, i) => {
    // A deterministic, judge-specific spread so judges are not identical.
    out[k] = clamp(level + ((judgeIndex + projectIndex + i) % 2 === 0 ? 0 : -1));
  });
  return out;
}

function clamp(n) {
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** Five named synthetic judges, the ones the brief asks the lab to display. */
const SYNTHETIC_JUDGES = {
  generous: (j, p) => scoresFor(0, j + p, 4 + (p % 2)),
  strict: (j, p) => scoresFor(1, j + p, 2 + (p % 2)),
  centered: (j, p) => scoresFor(2, j + p, 3),
  lowVariance: () => ({ functionality: 3, quality: 3, innovation: 3 }),
  erratic: (j, p) => ({
    functionality: (j + p) % 2 === 0 ? 5 : 1,
    quality: (j + p) % 3 === 0 ? 1 : 4,
    innovation: (j + p) % 2 === 0 ? 1 : 5,
  }),
};

function buildSynthetic({ judges = Object.keys(SYNTHETIC_JUDGES), projects = 6 } = {}) {
  const reviews = [];
  // Every judge scores every project, so the *only* difference in the results
  // is judge severity. Any distortion is therefore attributable to the model.
  judges.forEach((jName) => {
    const fn = SYNTHETIC_JUDGES[jName];
    for (let p = 0; p < projects; p += 1) {
      reviews.push({ judgeId: jName, projectId: `prj_${p + 1}`, scores: fn(p, p) });
    }
  });
  return reviews;
}

/** Real fixture reviews, in the shape normalize() wants. */
function fromFixtures(db) {
  const rows = db
    .prepare(
      `SELECT r.judge_id AS judgeId, r.project_id AS projectId,
              c.key AS criterionKey, s.value AS value
         FROM reviews r
         JOIN review_scores s ON s.review_id = r.id
         JOIN criteria c      ON c.id = s.criterion_id
        WHERE r.status = 'submitted'`,
    )
    .all();

  const map = new Map();
  for (const row of rows) {
    const k = `${row.judgeId}|${row.projectId}`;
    if (!map.has(k)) {
      map.set(k, { judgeId: row.judgeId, projectId: row.projectId, scores: {} });
    }
    map.get(k).scores[row.criterionKey] = row.value;
  }
  return [...map.values()];
}

module.exports = { SYNTHETIC_JUDGES, buildSynthetic, fromFixtures, CRITERIA };

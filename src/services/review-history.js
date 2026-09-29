"use strict";

const crypto = require("crypto");

/**
 * Append-only review versions. Each save of a review adds a row holding the
 * full state (status, comment, every score). Rows are never updated or deleted;
 * the table has triggers that refuse both.
 */

function currentState(db, reviewId) {
  const review = db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(reviewId);
  const scores = {};
  for (const s of db
    .prepare(
      `SELECT c.key, s.value FROM review_scores s JOIN criteria c ON c.id = s.criterion_id
        WHERE s.review_id = ? ORDER BY c.key`,
    )
    .all(reviewId)) {
    scores[s.key] = s.value;
  }
  return { review, scores };
}

function appendVersion(db, reviewId) {
  const { review, scores } = currentState(db, reviewId);
  const next =
    db.prepare(`SELECT COALESCE(MAX(version),0)+1 AS n FROM review_versions WHERE review_id = ?`).get(reviewId).n;
  db.prepare(
    `INSERT INTO review_versions (id,review_id,judge_id,project_id,version,status,comment,scores_json,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    `rvv_${crypto.randomUUID().slice(0, 12)}`,
    reviewId,
    review.judge_id,
    review.project_id,
    next,
    review.status,
    review.comment || "",
    JSON.stringify(scores),
    new Date().toISOString(),
  );
  return next;
}

/** Record the pre-edit state once, so a seeded review's original is not lost. */
function ensureBaseline(db, reviewId) {
  const has = db.prepare(`SELECT 1 FROM review_versions WHERE review_id = ? LIMIT 1`).get(reviewId);
  if (!has) appendVersion(db, reviewId);
}

function listVersions(db, reviewId) {
  return db
    .prepare(
      `SELECT version, status, comment, scores_json AS scoresJson, created_at AS createdAt
         FROM review_versions WHERE review_id = ? ORDER BY version`,
    )
    .all(reviewId)
    .map(({ scoresJson, ...v }) => ({ ...v, scores: JSON.parse(scoresJson) }));
}

module.exports = { appendVersion, ensureBaseline, listVersions };

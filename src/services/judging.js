"use strict";

/**
 * Aggregates fixture reviews into raw and normalized rankings, and persists
 * both so the organizer can toggle between them without recomputing.
 *
 * Raw is never overwritten by normalized. Both modes are stored, and the
 * control room shows the movement between them with a reason, because a
 * normalization that silently moves a project down is indistinguishable from
 * one that fixes a harsh judge.
 */

const { normalize } = require("../lib/normalize");
const { normaliseWeights } = require("../db/criteria");

function gatherReviews(db) {
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

function computeResults(db, { persist = false } = {}) {
  const event = db.prepare(`SELECT * FROM events LIMIT 1`).get();
  const criteria = normaliseWeights(
    db
      .prepare(`SELECT * FROM criteria WHERE event_id = ? ORDER BY sort_order, key`)
      .all(event.id),
  );
  const reviews = gatherReviews(db);

  if (reviews.length === 0) {
    return {
      mode: "none",
      message: "No completed reviews yet.",
      raw: [], normalized: [], judgeStats: [], projects: [], global: null,
    };
  }

  const result = normalize(reviews, criteria);

  const projectMeta = Object.fromEntries(
    db
      .prepare(
        `SELECT p.id, p.title, t.name AS track FROM projects p
           JOIN tracks t ON t.id = p.track_id WHERE p.event_id = ?`,
      )
      .all(event.id)
      .map((r) => [r.id, r]),
  );
  const judgeMeta = Object.fromEntries(
    db
      .prepare(`SELECT id, name, email FROM users WHERE role='judge'`)
      .all()
      .map((r) => [r.id, r]),
  );
  const totalAssigned = db
    .prepare(`SELECT COUNT(*) n FROM assignments WHERE event_id = ?`)
    .get(event.id).n;

  if (persist) {
    const now = new Date().toISOString();
    const put = db.prepare(
      `INSERT INTO results (id,event_id,project_id,mode,weighted_score,review_count,rank,detail,computed_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id,project_id,mode)
       DO UPDATE SET weighted_score=excluded.weighted_score, review_count=excluded.review_count,
                     rank=excluded.rank, detail=excluded.detail, computed_at=excluded.computed_at`,
    );
    const tx = db.transaction(() => {
      for (const r of result.raw) {
        put.run(
          `res_raw_${r.projectId}`, event.id, r.projectId, "raw",
          r.score, r.reviewCount, r.rank, JSON.stringify({ judgeCount: r.judgeCount }), now,
        );
      }
      for (const r of result.normalized) {
        put.run(
          `res_nrm_${r.projectId}`, event.id, r.projectId, "normalized",
          r.score, r.reviewCount, r.rank, JSON.stringify({ flagged: r.flagged }), now,
        );
      }
    });
    tx();
  }

  return {
    mode: "both",
    computedAt: new Date().toISOString(),
    fingerprint: result.fingerprint,
    global: result.global,
    criteria: criteria.map((c) => ({
      key: c.key, label: c.label, weight: c.normalisedWeight, min: c.min, max: c.max,
    })),
    raw: result.raw.map((r) => decorate(r, projectMeta, judgeMeta)),
    normalized: result.normalized.map((r) => decorate(r, projectMeta, judgeMeta)),
    judgeStats: result.judgeStats.map((s) => ({
      judgeId: s.judgeId,
      name: judgeMeta[s.judgeId]?.name || s.judgeId,
      reviewCount: s.reviewCount,
      projectCount: s.projects,
      mean: round(s.mean),
      sd: round(s.sd),
      lambda: round(s.lambda),
      degenerate: s.degenerate,
      constantCriteria: s.constantCriteria || [],
      perCriterion: Object.fromEntries(
        Object.entries(s.perCriterion).map(([k, v]) => [k, { n: v.n, mean: round(v.mean), sd: round(v.sd) }]),
      ),
    })),
    projects: result.projects.map((p) => ({
      ...p,
      title: projectMeta[p.projectId]?.title || p.projectId,
      track: projectMeta[p.projectId]?.track || null,
      rawScore: p.raw ? round(p.raw.score) : null,
      normalizedScore: p.normalized ? round(p.normalized.score) : null,
    })),
    coverage: {
      assigned: totalAssigned,
      completedReviews: reviews.length,
      distinctJudges: new Set(reviews.map((r) => r.judgeId)).size,
      distinctProjects: new Set(reviews.map((r) => r.projectId)).size,
    },
  };
}

function decorate(r, projectMeta, judgeMeta) {
  return {
    projectId: r.projectId,
    title: projectMeta[r.projectId]?.title || r.projectId,
    track: projectMeta[r.projectId]?.track || null,
    score: round(r.score),
    rank: r.rank,
    reviewCount: r.reviewCount,
    judgeCount: r.judgeCount,
    flagged: r.flagged,
  };
}

function round(n) {
  return typeof n === "number" ? Math.round(n * 1e4) / 1e4 : n;
}

/**
 * Teams holding more than one live submission in the same track.
 *
 * The schema does not forbid this, on purpose: the official fixtures contain
 * prj_07 and prj_41, both tm_07 in trk_03, both titled "Dry Harbour", both
 * submitted before the 18:00 deadline. That is a real duplicate that slipped
 * through while the event was open, and an organizer cannot un-submit it after
 * the fact. Rejecting it at seed time would delete real data and fail the
 * gallery acceptance check.
 *
 * So new duplicates are refused by `POST /api/projects` (409), and the
 * historical one is surfaced here for a human to resolve. Silently merging it,
 * or silently keeping it without saying so, would both be worse than naming it.
 */
function duplicateSubmissions(db) {
  return db
    .prepare(
      `SELECT tm.id AS team_id, tm.name AS team_name, t.id AS track_id, t.name AS track_name,
              GROUP_CONCAT(p.id || ' "' || p.title || '" @ ' || p.submitted_at, ' | ') AS projects,
              COUNT(*) AS n
         FROM projects p
         JOIN teams  tm ON tm.id = p.team_id
         JOIN tracks t   ON t.id  = p.track_id
        WHERE p.status = 'submitted'
        GROUP BY tm.id, tm.name, t.id, t.name
       HAVING COUNT(*) > 1`,
    )
    .all()
    .map((r) => ({
      teamId: r.team_id,
      teamName: r.team_name,
      trackId: r.track_id,
      trackName: r.track_name,
      count: r.n,
      projects: String(r.projects).split(" | "),
    }));
}

module.exports = { computeResults, gatherReviews, duplicateSubmissions };

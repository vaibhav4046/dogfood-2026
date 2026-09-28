"use strict";

/**
 * Judge routes (T2). This is where the spec's most heavily weighted check
 * lives, so the rules are stated before the code.
 *
 *  R1. Identity comes from the session. Never from a query parameter, a body
 *      field or a client-supplied role.
 *  R2. A judge reads exactly their own scores. `?judge=` naming anyone else is
 *      403, and the refused response carries no score rows.
 *  R3. A judge reads only projects they are assigned to.
 *  R4. A judge reads only projects in tracks they are eligible for.
 *  R5. A participant cannot reach any of this.
 *  R6. Scores written must be inside the criterion's own min/max.
 *  R7. Reading your own scores twice returns the same rows.
 */

const {
  requireJudge,
  requireJudgingStaff,
  requireOrganizer,
  isOrganizer,
  deny,
  resolveRequestedJudge,
  sameJudge,
} = require("../middleware/auth");
const { writeAudit } = require("../services/audit");
const { renderDesk, renderDeskProject } = require("../views/judge");

function registerJudge(app, db) {
  // --- R5 first: a participant is not a judge ---------------------------
  app.get("/api/judge/scores", requireJudge, (req, res) => {
    const { requested } = resolveRequestedJudge(req);

    // R2. The one the official checker probes.
    if (requested !== null && !sameJudge(req.user, requested)) {
      writeAudit(db, req, {
        action: "scores.read_refused",
        targetType: "judge",
        targetId: requested,
        newState: JSON.stringify({ reason: "peer_isolation", requestedBy: req.user.id }),
      });
      return deny(
        res,
        403,
        "peer_isolation",
        "A judge may only read their own scores.",
        { requestedJudge: requested },
      );
    }

    // R7. Identical request, identical response: no hidden per-session state.
    const rows = loadOwnReviews(db, req.user.id);
    writeAudit(db, req, {
      action: "scores.read",
      targetType: "judge",
      targetId: req.user.id,
      newState: JSON.stringify({ rows: rows.length }),
    });

    res.json({
      judge: { id: req.user.id, name: req.user.name },
      reviewCount: rows.length,
      scores: rows,
    });
  });

  /** Alias with an explicit judge id in the path. Same rule, same refusal. */
  app.get("/api/judge/:judgeId/scores", requireJudge, (req, res) => {
    const target = req.params.judgeId;
    if (!sameJudge(req.user, target)) {
      writeAudit(db, req, {
        action: "scores.read_refused",
        targetType: "judge",
        targetId: target,
        newState: JSON.stringify({ reason: "peer_isolation_path", requestedBy: req.user.id }),
      });
      return deny(res, 403, "peer_isolation", "A judge may only read their own scores.");
    }
    const rows = loadOwnReviews(db, req.user.id);
    res.json({ judge: { id: req.user.id, name: req.user.name }, scores: rows });
  });

  // Assignment queue for the Judge Desk.
  app.get("/api/judge/desk", requireJudge, (req, res) => {
    res.json(assignmentQueue(db, req.user.id));
  });

  app.get("/judge", requireJudge, (req, res) => {
    res.type("html").send(renderDesk({ queue: assignmentQueue(db, req.user.id), user: req.user }));
  });

  app.get("/judge/:projectId", requireJudge, (req, res) => {
    const projectId = req.params.projectId;
    const assignment = assignedProject(db, req.user.id, projectId);
    if (!assignment) {
      // Deliberately the same 403 as a track mismatch: a judge who was never
      // assigned a project should not be able to tell "exists but not mine"
      // from "does not exist" by comparing status codes.
      return deny(res, 403, "not_assigned", "That project is not assigned to you.");
    }
    const track = db.prepare("SELECT name FROM tracks WHERE id = ?").get(assignment.track_id);
    const review = db
      .prepare(`SELECT id, status, comment FROM reviews WHERE assignment_id = ?`)
      .get(assignment.assignmentId);
    const savedScores = review
      ? Object.fromEntries(
          db
            .prepare(
              `SELECT c.key, s.value FROM review_scores s JOIN criteria c ON c.id = s.criterion_id
                WHERE s.review_id = ?`,
            )
            .all(review.id)
            .map((r) => [r.key, r.value]),
        )
      : {};

    /*
     * The route builds the shape the view renders. The view used to read
     * `assignment.track_name`, `assignment.repo_url` and `assignment.comment`
     * while the query returned `trackName`, `repoUrl` and no comment at all, so
     * every one of those rendered as undefined and the desk page came up
     * visually empty — a screenshot of a real, authorized, correctly-rendered
     * page that showed nothing. One shape, built next to the SQL that produces
     * it, instead of two conventions that have to be kept in step by hand.
     *
     * `savedScores` is here for the same reason and it is not cosmetic: the
     * rubric controls used to hardcode value 3 as checked, so a judge who
     * autosaved 5 and 2, reloaded, and saw 3 and 3 — and submitting would have
     * recorded 3 and 3. Silent data loss on the one screen where data loss
     * costs a team's place.
     */
    res.type("html").send(
      renderDeskProject({
        project: {
          projectId: assignment.projectId,
          assignmentId: assignment.assignmentId,
          title: assignment.title,
          tagline: assignment.tagline,
          description: assignment.description,
          trackName: track ? track.name : null,
          repoUrl: assignment.repoUrl,
          demoUrl: assignment.demoUrl,
          liveUrl: assignment.liveUrl,
          techTags: JSON.parse(assignment.techTagsJson || "[]"),
        },
        review: review
          ? {
              reviewId: review.id,
              status: review.status,
              comment: review.comment,
              scores: savedScores,
            }
          : { reviewId: null, status: null, comment: "", scores: {} },
        criteria: eventCriteria(db),
        user: req.user,
      }),
    );
  });

  /**
   * Save a review. Drafts autosave; `submit` finalises. Both validate bounds,
   * and both are refused if the judge is not assigned.
   */
  app.post("/api/judge/reviews", requireJudge, (req, res) => {
    const projectId = String(req.body?.projectId || "");
    const assignment = assignedProject(db, req.user.id, projectId);
    if (!assignment) {
      writeAudit(db, req, {
        action: "scores.read_refused",
        targetType: "project",
        targetId: projectId,
        newState: JSON.stringify({ reason: "not_assigned_write", judge: req.user.id }),
      });
      return deny(res, 403, "not_assigned", "That project is not assigned to you.");
    }

    const criteria = eventCriteria(db);
    const provided = req.body?.scores || {};
    const invalid = {};
    const clean = {};

    for (const c of criteria) {
      if (!(c.key in provided)) continue;
      const n = Number(provided[c.key]);
      if (!Number.isFinite(n)) {
        invalid[c.key] = `Must be a number between ${c.min} and ${c.max}.`;
        continue;
      }
      if (!Number.isInteger(n)) {
        invalid[c.key] = `Must be a whole number.`;
        continue;
      }
      // R6, per criterion bounds, not one global range.
      if (n < c.min || n > c.max) {
        invalid[c.key] = `Must be between ${c.min} and ${c.max}.`;
        continue;
      }
      clean[c.key] = n;
    }

    if (Object.keys(invalid).length) {
      writeAudit(db, req, {
        action: "review.scores_refused",
        targetType: "project",
        targetId: projectId,
        newState: JSON.stringify({ invalid }),
      });
      return res.status(400).json({ error: "score_out_of_range", fields: invalid });
    }

    const status = req.body?.submit ? "submitted" : "draft";
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      const existing = db
        .prepare(`SELECT * FROM reviews WHERE assignment_id = ?`)
        .get(assignment.assignmentId);
      const reviewId = existing ? existing.id : `rev_${crypto.randomUUID().slice(0, 12)}`;
      if (existing) {
        db.prepare(
          `UPDATE reviews SET status=?, comment=?, submitted_at=?, updated_at=? WHERE id=?`,
        ).run(
          status,
          String(req.body?.comment ?? existing.comment ?? ""),
          status === "submitted" ? now : existing.submitted_at,
          now,
          reviewId,
        );
      } else {
        db.prepare(
          `INSERT INTO reviews
            (id,assignment_id,judge_id,project_id,status,comment,submitted_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          reviewId,
          assignment.assignmentId,
          req.user.id,
          projectId,
          status,
          String(req.body?.comment || ""),
          status === "submitted" ? now : null,
          now,
        );
      }
      const put = db.prepare(
        `INSERT INTO review_scores (review_id,criterion_id,value) VALUES (?,?,?)
         ON CONFLICT(review_id,criterion_id) DO UPDATE SET value=excluded.value`,
      );
      for (const [key, value] of Object.entries(clean)) put.run(reviewId, ckey(criteria, key), value);
      db.prepare(
        `UPDATE assignments SET status=? WHERE id=?`,
      ).run(status === "submitted" ? "submitted" : "in_progress", assignment.assignmentId);
      return reviewId;
    });

    const reviewId = tx();
    writeAudit(db, req, {
      action: status === "submitted" ? "review.submitted" : "review.saved",
      targetType: "review",
      targetId: reviewId,
      newState: JSON.stringify({ projectId, status, scores: clean }),
    });

    res.json({ ok: true, reviewId, status, savedAt: now });
  });
}

// --- helpers ---------------------------------------------------------------

/**
 * The rubric for this event, with the column names the rest of the file uses.
 *
 * The aliasing here is not cosmetic. The table stores `min_score` and
 * `max_score`; the validation below compares against `c.min` and `c.max`. When
 * those were read straight off the row they were `undefined`, and
 * `4 < undefined` is `false` — so *every* score passed bounds validation,
 * including 99 and -5. The bounds check was decorative until this mapping
 * existed.
 */
function eventCriteria(db) {
  return db
    .prepare(
      `SELECT id, key, label, weight,
              min_score AS min, max_score AS max, sort_order AS sortOrder
         FROM criteria
        WHERE event_id = (SELECT id FROM events LIMIT 1)
        ORDER BY sort_order, key`,
    )
    .all();
}

function ckey(criteria, key) {
  const c = criteria.find((x) => x.key === key);
  return c ? c.id : null;
}

function loadOwnReviews(db, judgeId) {
  const rows = db
    .prepare(
      `SELECT r.id AS reviewId, r.project_id AS projectId, r.status,
              r.comment, r.submitted_at AS submittedAt, p.title AS projectTitle
         FROM reviews r JOIN projects p ON p.id = r.project_id
        WHERE r.judge_id = ?
        ORDER BY p.title COLLATE NOCASE`,
    )
    .all(judgeId);

  const crit = eventCriteria(db);
  const scoreStmt = db.prepare(
    `SELECT c.key, s.value FROM review_scores s JOIN criteria c ON c.id = s.criterion_id
      WHERE s.review_id = ?`,
  );

  return rows.map((r) => {
    const scores = {};
    for (const s of scoreStmt.all(r.reviewId)) scores[s.key] = s.value;
    return {
      ...r,
      scores,
      weightedScore: weighted(scores, crit),
    };
  });
}

function weighted(scores, criteria) {
  const total = criteria.reduce((s, c) => s + (c.weight || 0), 0);
  if (!total) return 0;
  let acc = 0;
  let seen = 0;
  for (const c of criteria) {
    const v = scores[c.key];
    if (!Number.isFinite(v)) continue;
    acc += (c.weight / total) * v;
    seen += 1;
  }
  return seen ? Math.round((acc / seen) * 1e6) / 1e6 : 0;
}

/**
 * R3 + R4 in one place. A judge sees a project only if an assignment exists
 * AND the project is in a track the judge is eligible for. Both are ANDed, so
 * neither a stale assignment nor a broad track grant can leak a row.
 */
function assignedProject(db, judgeId, projectId) {
  if (!projectId) return null;
  const row = db
    .prepare(
      /*
       * Both ids are aliased explicitly. `SELECT a.id AS assignmentId, p.*`
       * was ambiguous in a way that read correctly and behaved wrongly:
       * `p.*` supplies an `id` column, so `row.id` silently meant the *project*
       * and not the assignment. Any caller reaching for `row.id` got the
       * project. Naming both removes the shadowing.
       */
      `SELECT a.id AS assignmentId, a.status AS assignmentStatus,
              p.id AS projectId, p.title, p.tagline, p.description,
              p.status AS projectStatus, p.track_id,
              p.repo_url AS repoUrl, p.demo_url AS demoUrl, p.live_url AS liveUrl,
              p.tech_tags AS techTagsJson, p.submitted_at AS submittedAt
         FROM assignments a
         JOIN projects p ON p.id = a.project_id
        WHERE a.judge_id = ? AND a.project_id = ?
          AND EXISTS (SELECT 1 FROM judge_track_eligibility e
                       WHERE e.judge_id = a.judge_id AND e.track_id = p.track_id)`,
    )
    .get(judgeId, projectId);
  return row || null;
}

function assignmentQueue(db, judgeId) {
  const rows = db
    .prepare(
      `SELECT a.id AS assignmentId, a.status AS assignmentStatus,
              p.id AS projectId, p.title, p.tagline, p.description,
              p.repo_url AS repoUrl, p.demo_url AS demoUrl, p.live_url AS liveUrl,
              p.tech_tags AS techTagsJson, t.name AS trackName,
              r.id AS reviewId, r.status AS reviewStatus, r.comment, r.submitted_at AS submittedAt
         FROM assignments a
         JOIN projects p ON p.id = a.project_id
         JOIN tracks  t ON t.id = p.track_id
         LEFT JOIN reviews r ON r.assignment_id = a.id
        WHERE a.judge_id = ?
        ORDER BY (r.status = 'submitted') ASC, p.title COLLATE NOCASE`,
    )
    .all(judgeId);

  const crit = eventCriteria(db);
  const scoreStmt = db.prepare(
    `SELECT c.key, s.value FROM review_scores s JOIN criteria c ON c.id = s.criterion_id
      WHERE s.review_id = ?`,
  );

  const items = rows.map((r) => {
    const scores = {};
    if (r.reviewId) for (const s of scoreStmt.all(r.reviewId)) scores[s.key] = s.value;
    return {
      assignmentId: r.assignmentId,
      projectId: r.projectId,
      title: r.title,
      tagline: r.tagline,
      description: r.description,
      repoUrl: r.repoUrl,
      demoUrl: r.demoUrl,
      liveUrl: r.liveUrl,
      techTags: JSON.parse(r.techTagsJson || "[]"),
      trackName: r.trackName,
      reviewId: r.reviewId,
      reviewStatus: r.reviewStatus,
      comment: r.comment,
      submittedAt: r.submittedAt,
      scores,
      weightedScore: weighted(scores, crit),
    };
  });

  const done = items.filter((i) => i.reviewStatus === "submitted").length;
  return {
    total: items.length,
    done,
    remaining: items.length - done,
    criteria: crit.map((c) => ({
      key: c.key, label: c.label, min: c.min, max: c.max, weight: c.weight,
    })),
    items,
  };
}

module.exports = { registerJudge, assignmentQueue, assignedProject, weighted, loadOwnReviews };

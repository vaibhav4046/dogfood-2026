"use strict";

const crypto = require("crypto");

/**
 * Organizer routes: assignments, rubric, CSV export, audit viewer, publishing.
 *
 * Every mutation writes an audit row. Nothing here trusts a client-supplied
 * role: `requireOrganizer` has already resolved the session.
 */

const { requireOrganizer, requireJudgingStaff, deny } = require("../middleware/auth");
const { writeAudit, listAudit, verifyChain } = require("../services/audit");
const { computeResults, duplicateSubmissions } = require("../services/judging");
const { buildCsv } = require("../services/csv");
const { renderControlRoom, renderAudit } = require("../views/organizer");

function registerOrganizer(app, db) {
  app.get("/organizer", requireOrganizer, (req, res) => {
    res.type("html").send(renderControlRoom({ ...controlRoomData(db), user: req.user }));
  });

  app.get("/organizer/audit", requireOrganizer, (req, res) => {
    const rows = listAudit(db, { limit: 300 });
    res.type("html").send(renderAudit({ rows, user: req.user, chain: verifyChain(db) }));
  });

  app.get("/api/organizer/audit/verify", requireOrganizer, (req, res) => {
    res.json(verifyChain(db));
  });

  /**
   * T2 check 7. Organizer only, and the first line must contain a comma.
   *
   * The export is built from the same `computeResults` the control room shows,
   * in both modes, so the CSV cannot disagree with the screen.
   */
  app.get("/api/export.csv", requireOrganizer, (req, res) => {
    const results = computeResults(db, { persist: true });
    const includeRaw = req.query.mode !== "normalized";
    const csv = buildCsv(results, { mode: includeRaw ? "both" : "normalized" });

    writeAudit(db, req, {
      action: "export.csv",
      targetType: "event",
      targetId: results.mode === "none" ? null : "all",
      newState: JSON.stringify({ mode: includeRaw ? "both" : "normalized", bytes: csv.length }),
    });

    res.type("text/csv; charset=utf-8")
      .setHeader("Content-Disposition", 'attachment; filename="dogfood-results.csv"')
      .send(csv);
  });

  app.get("/api/organizer/calibration", requireOrganizer, (req, res) => {
    res.json(computeResults(db, { persist: true }));
  });

  app.get("/api/organizer/audit", requireOrganizer, (req, res) => {
    res.json({ events: listAudit(db, { limit: Number(req.query.limit) || 200 }) });
  });

  app.post("/api/organizer/assignments", requireOrganizer, (req, res) => {
    const event = db.prepare(`SELECT id FROM events LIMIT 1`).get();
    const judgeId = String(req.body?.judgeId || "");
    const projectIds = Array.isArray(req.body?.projectIds) ? req.body.projectIds : [];

    const judge = db.prepare(`SELECT id FROM users WHERE id = ? AND role='judge'`).get(judgeId);
    if (!judge) {
      return res.status(400).json({ error: "unknown_judge", message: "No such judge." });
    }

    const eligible = new Set(
      db
        .prepare(`SELECT track_id FROM judge_track_eligibility WHERE judge_id = ?`)
        .all(judgeId)
        .map((r) => r.track_id),
    );

    const created = [];
    const skipped = [];
    for (const pid of projectIds) {
      const project = db.prepare(`SELECT id, track_id FROM projects WHERE id = ?`).get(pid);
      if (!project) {
        skipped.push({ projectId: pid, reason: "unknown_project" });
        continue;
      }
      // Track eligibility is enforced at assignment time, not only at read
      // time, so an organizer cannot create an assignment that is guaranteed
      // to be unreadable.
      if (eligible.size > 0 && !eligible.has(project.track_id)) {
        skipped.push({ projectId: pid, reason: "judge_not_eligible_for_track" });
        continue;
      }
      const id = `asg_${crypto.randomUUID().slice(0, 10)}`;
      const res2 = db
        .prepare(
          `INSERT OR IGNORE INTO assignments (id,event_id,judge_id,project_id,status,assigned_at)
           VALUES (?,?,?,?,'pending',?)`,
        )
        .run(id, event.id, judgeId, pid, new Date().toISOString());
      if (res2.changes) {
        created.push({ projectId: pid, assignmentId: id });
        writeAudit(db, req, {
          action: "assignment.created",
          targetType: "assignment",
          targetId: id,
          newState: JSON.stringify({ judgeId, projectId: pid }),
        });
      } else {
        skipped.push({ projectId: pid, reason: "already_assigned" });
      }
    }

    res.status(201).json({ created, skipped });
  });

  app.delete("/api/organizer/assignments/:id", requireOrganizer, (req, res) => {
    const row = db.prepare(`SELECT * FROM assignments WHERE id = ?`).get(req.params.id);
    if (!row) return deny(res, 404, "no_such_assignment", "No such assignment.");
    db.prepare(`DELETE FROM reviews WHERE assignment_id = ?`).run(row.id);
    db.prepare(`DELETE FROM assignments WHERE id = ?`).run(row.id);
    writeAudit(db, req, {
      action: "assignment.deleted",
      targetType: "assignment",
      targetId: row.id,
      previousState: JSON.stringify({ judgeId: row.judge_id, projectId: row.project_id }),
    });
    res.json({ ok: true, deleted: row.id });
  });

  app.post("/api/organizer/rubric", requireOrganizer, (req, res) => {
    const event = db.prepare(`SELECT id FROM events LIMIT 1`).get();
    const updates = Array.isArray(req.body?.criteria) ? req.body.criteria : [];
    const invalid = {};
    const clean = [];

    for (const u of updates) {
      const c = db
        .prepare(`SELECT * FROM criteria WHERE event_id = ? AND key = ?`)
        .get(event.id, String(u.key || ""));
      if (!c) {
        invalid[u.key] = "No such criterion.";
        continue;
      }
      const weight = Number(u.weight);
      if (!Number.isFinite(weight) || weight < 0) {
        invalid[u.key] = "Weight must be a non-negative number.";
        continue;
      }
      if (weight === 0) {
        invalid[u.key] = "A criterion cannot be weighted zero; remove it instead.";
        continue;
      }
      const min = u.min == null ? c.min_score : Number(u.min);
      const max = u.max == null ? c.max_score : Number(u.max);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) {
        invalid[u.key] = "Bounds must be whole numbers with min < max.";
        continue;
      }
      clean.push({ id: c.id, key: c.key, weight, min, max, previous: c.weight });
    }

    if (Object.keys(invalid).length) {
      return res.status(400).json({ error: "validation_failed", fields: invalid });
    }
    if (clean.length === 0) {
      return res.status(400).json({
        error: "empty_rubric",
        message: "A rubric needs at least one weighted criterion.",
      });
    }

    const tx = db.transaction(() => {
      const upd = db.prepare(`UPDATE criteria SET weight=?, min_score=?, max_score=? WHERE id=?`);
      for (const c of clean) upd.run(c.weight, c.min, c.max, c.id);
    });
    tx();

    for (const c of clean) {
      writeAudit(db, req, {
        action: "rubric.updated",
        targetType: "criterion",
        targetId: c.id,
        previousState: JSON.stringify({ weight: c.previous }),
        newState: JSON.stringify({ key: c.key, weight: c.weight, min: c.min, max: c.max }),
      });
    }

    res.json({ ok: true, updated: clean.map((c) => c.key) });
  });

  app.post("/api/organizer/publish", requireOrganizer, (req, res) => {
    const event = db.prepare(`SELECT * FROM events LIMIT 1`).get();
    const mode = req.body?.mode === "normalized" ? "normalized" : "raw";
    const results = computeResults(db, { persist: true });
    if (results.mode === "none") {
      return deny(res, 409, "nothing_to_publish", "There are no completed reviews to publish.");
    }
    const next = "published";
    db.prepare(`UPDATE events SET status = ? WHERE id = ?`).run(next, event.id);
    writeAudit(db, req, {
      action: "results.published",
      targetType: "event",
      targetId: event.id,
      previousState: JSON.stringify({ status: event.status }),
      newState: JSON.stringify({ status: next, mode, fingerprint: results.fingerprint }),
    });
    res.json({
      ok: true,
      mode,
      fingerprint: results.fingerprint,
      published: results.mode === "none" ? 0 : (mode === "raw" ? results.raw.length : results.normalized.length),
    });
  });
}

function controlRoomData(db) {
  const event = db.prepare(`SELECT * FROM events LIMIT 1`).get();
  const results = computeResults(db, { persist: true });

  const kpis = {
    projects: db.prepare(`SELECT COUNT(*) n FROM projects WHERE status='submitted'`).get().n,
    teams: db.prepare(`SELECT COUNT(*) n FROM teams`).get().n,
    tracks: db.prepare(`SELECT COUNT(*) n FROM tracks`).get().n,
    judges: db.prepare(`SELECT COUNT(*) n FROM users WHERE role='judge'`).get().n,
    assignments: db.prepare(`SELECT COUNT(*) n FROM assignments`).get().n,
    completedReviews: db.prepare(`SELECT COUNT(*) n FROM reviews WHERE status='submitted'`).get().n,
  };

  const trackDistribution = db
    .prepare(
      `SELECT t.name AS track, COUNT(p.id) AS projects
         FROM tracks t LEFT JOIN projects p ON p.track_id = t.id AND p.status='submitted'
        GROUP BY t.id, t.name ORDER BY t.name`,
    )
    .all();

  const judgeProgress = db
    .prepare(
      `SELECT u.id, u.name,
              COUNT(a.id) AS assigned,
              SUM(CASE WHEN r.status='submitted' THEN 1 ELSE 0 END) AS done
         FROM users u
         LEFT JOIN assignments a ON a.judge_id = u.id
         LEFT JOIN reviews r     ON r.assignment_id = a.id
        WHERE u.role='judge'
        GROUP BY u.id, u.name
        ORDER BY (CAST(COALESCE(SUM(CASE WHEN r.status='submitted' THEN 1 ELSE 0 END),0) AS REAL)
                  / NULLIF(COUNT(a.id),0)) ASC, assigned DESC`,
    )
    .all();

  const unassigned = db
    .prepare(
      `SELECT p.id, p.title, t.name AS track FROM projects p
         JOIN tracks t ON t.id = p.track_id
        WHERE p.status='submitted'
          AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = p.id)
        ORDER BY p.title LIMIT 50`,
    )
    .all();

  const underReviewed = db
    .prepare(
      `SELECT p.id, p.title, COUNT(a.id) AS assigned
         FROM projects p LEFT JOIN assignments a ON a.project_id = p.id
        WHERE p.status='submitted'
        GROUP BY p.id, p.title
       HAVING assigned < 2
        ORDER BY assigned, p.title LIMIT 50`,
    )
    .all();

  const overloaded = judgeProgress.filter((j) => j.assigned > 0 && j.done / j.assigned < 0.34);

  const rubric = db
    .prepare(`SELECT * FROM criteria WHERE event_id = ? ORDER BY sort_order, key`)
    .all(event.id)
    .map((c) => ({ key: c.key, label: c.label, weight: c.weight, min: c.min_score, max: c.max_score }));

  return {
    event,
    kpis,
    results,
    trackDistribution,
    judgeProgress,
    unassigned,
    underReviewed,
    overloaded,
    rubric,
    duplicates: duplicateSubmissions(db),
    recentAudit: listAudit(db, { limit: 25 }),
  };
}

module.exports = { registerOrganizer, controlRoomData };

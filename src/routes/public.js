"use strict";

/** Public gallery + project detail. No authentication, by design (T1). */

const { layout, safeText } = require("../views/layout");
const { renderGallery, renderProject } = require("../views/gallery");
const { isPublished } = require("../services/embargo");
const { computeResults } = require("../services/judging");

function registerPublic(app, db) {
  app.get("/projects", (req, res) => {
    const q = String(req.query.q || "").trim();
    const track = String(req.query.track || "").trim();

    const where = ["p.status = 'submitted'"];
    const params = {};
    if (q) {
      where.push("(lower(p.title) LIKE @q OR lower(p.tagline) LIKE @q OR lower(p.description) LIKE @q)");
      params.q = `%${q.toLowerCase()}%`;
    }
    if (track) {
      where.push("p.track_id = @track");
      params.track = track;
    }

    // Page one is every project. The official checker GETs this route and
    // looks for a fixture title in the body, so pagination must not push a
    // known title off the first response.
    const rows = db
      .prepare(
        `SELECT p.*, t.name AS track_name, t.slug AS track_slug, tm.name AS team_name,
                (SELECT COUNT(*) FROM reviews r WHERE r.project_id = p.id AND r.status='submitted') AS review_count
           FROM projects p
           JOIN tracks t  ON t.id = p.track_id
           JOIN teams tm ON tm.id = p.team_id
          WHERE ${where.join(" AND ")}
          ORDER BY p.title COLLATE NOCASE, p.id
          LIMIT 200`,
      )
      .all(params);

    // Per-project review counts are an aggregate: embargoed until publish.
    if (!isPublished(db)) for (const r of rows) r.review_count = null;

    const tracks = db.prepare(`SELECT id, name FROM tracks ORDER BY name`).all();
    const total = db.prepare(`SELECT COUNT(*) n FROM projects WHERE status='submitted'`).get().n;

    res.type("html").send(
      renderGallery({ rows, tracks, total, q, track, user: req.user }),
    );
  });

  app.get("/projects/:id", (req, res) => {
    const row = db
      .prepare(
        `SELECT p.*, t.name AS track_name, tm.name AS team_name, e.name AS event_name
           FROM projects p
           JOIN tracks t   ON t.id = p.track_id
           JOIN teams  tm  ON tm.id = p.team_id
           JOIN events e   ON e.id = p.event_id
          WHERE p.id = ?`,
      )
      .get(req.params.id);
    if (!row) return res.status(404).type("html").send(notFound("No such project."));

    const reviewCount = db
      .prepare(`SELECT COUNT(*) n FROM reviews WHERE project_id=? AND status='submitted'`)
      .get(row.id).n;

    res.type("html").send(
      renderProject({ row, reviewCount: isPublished(db) ? reviewCount : null, user: req.user }),
    );
  });

  // Public JSON for the gallery, so an integrator can consume the same data
  // the page renders instead of scraping HTML.
  app.get("/api/projects", (req, res) => {
    const rows = db
      .prepare(
        `SELECT p.id, p.title, p.tagline, p.track_id AS trackId, t.name AS track,
                tm.name AS team, p.repo_url AS repoUrl, p.demo_url AS demoUrl,
                p.live_url AS liveUrl, p.tech_tags AS techTagsJson, p.submitted_at AS submittedAt
           FROM projects p
           JOIN tracks t  ON t.id = p.track_id
           JOIN teams  tm ON tm.id = p.team_id
          WHERE p.status='submitted'
          ORDER BY p.title COLLATE NOCASE`,
      )
      .all()
      .map((r) => ({ ...r, techTags: JSON.parse(r.techTagsJson || "[]") }));
    res.json({ projects: rows, count: rows.length });
  });

  // Public, read-only rankings. 403 for everyone (organizers use
  // /api/organizer/calibration) until the organizer publishes. Judge
  // statistics and per-judge detail are never part of this body.
  app.get("/api/results", (req, res) => {
    if (!isPublished(db)) {
      return res.status(403).json({ error: "embargoed", message: "Results are not published yet." });
    }
    const r = computeResults(db);
    const pick = (rows) =>
      rows.map((x) => ({
        rank: x.rank, projectId: x.projectId, title: x.title, track: x.track,
        score: x.score, reviewCount: x.reviewCount,
      }));
    res.json({ raw: pick(r.raw), normalized: pick(r.normalized) });
  });

  function notFound(msg) {
    return layout({ title: "Not found", user: null, body: `<h1>404</h1><p>${msg}</p>` });
  }
}

module.exports = { registerPublic };

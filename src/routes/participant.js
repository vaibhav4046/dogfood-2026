"use strict";

const crypto = require("crypto");

const { requireParticipant, deny } = require("../middleware/auth");
const { writeAudit } = require("../services/audit");
const { renderSubmit } = require("../views/participant");

/**
 * Participant submissions (T1).
 *
 * The deadline is enforced here, on the server, from the event row. The seeded
 * event's `submissions_close` is the fixture's own past date, so a POST is
 * refused on a freshly seeded instance regardless of what the browser shows.
 * The form is still rendered — the refusal is the honest behaviour, and hiding
 * the form would make the deadline invisible instead of enforced.
 */

function registerParticipant(app, db) {
  app.get("/submit", requireParticipant, (req, res) => {
    const event = db.prepare(`SELECT * FROM events LIMIT 1`).get();
    const team = db
      .prepare(
        `SELECT tm.* FROM teams tm
           JOIN team_members m ON m.team_id = tm.id
          WHERE m.user_id = ? LIMIT 1`,
      )
      .get(req.user.id);
    const tracks = db.prepare(`SELECT id, name FROM tracks ORDER BY name`).all();
    res.type("html").send(
      renderSubmit({ event, team, tracks, user: req.user, error: null, notice: null }),
    );
  });

  app.post("/api/projects", requireParticipant, (req, res) => {
    const event = db.prepare(`SELECT * FROM events LIMIT 1`).get();
    const now = Date.now();
    const closesAt = Date.parse(event.submissions_close);

    // Backend-enforced, first, before anything else is trusted. An unparseable
    // date must not become an eternal open window.
    if (!Number.isFinite(closesAt)) {
      return deny(res, 500, "bad_deadline", "This event has an unreadable submission deadline.", {
        submissionsClose: event.submissions_close,
      });
    }
    if (now >= closesAt) {
      writeAudit(db, req, {
        action: "project.submit_refused",
        targetType: "event",
        targetId: event.id,
        newState: JSON.stringify({ reason: "event_closed", title: req.body?.title || null }),
      });
      return deny(
        res,
        403,
        "event_closed",
        `Submissions for "${event.name}" closed at ${event.submissions_close}.`,
        { submissionsClose: event.submissions_close, now: new Date().toISOString() },
      );
    }
    if (event.status === "draft") {
      return deny(res, 403, "event_not_open", "This event is not open for submissions.");
    }

    const body = req.body || {};
    const title = String(body.title || "").trim();
    const summary = String(body.summary || "").trim();
    const errors = {};
    if (!title) errors.title = "A title is required.";
    if (title.length > 140) errors.title = "Title must be 140 characters or fewer.";
    if (!summary) errors.summary = "A one-line summary is required.";
    if (body.repoUrl && !isHttpUrl(body.repoUrl)) errors.repoUrl = "Must be an http(s) URL.";
    if (body.demoUrl && !isHttpUrl(body.demoUrl)) errors.demoUrl = "Must be an http(s) URL.";
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: "validation_failed", fields: errors });
    }

    const team = db
      .prepare(
        `SELECT tm.* FROM teams tm JOIN team_members m ON m.team_id = tm.id
          WHERE m.user_id = ? LIMIT 1`,
      )
      .get(req.user.id);
    if (!team) {
      return deny(res, 400, "no_team", "Join or create a team before submitting a project.", {
        createTeam: "POST /api/teams",
      });
    }

    const trackId = String(body.trackId || "");
    const track = db.prepare(`SELECT id FROM tracks WHERE id = ? AND event_id = ?`).get(trackId, event.id);
    if (!track) {
      return res.status(400).json({
        error: "validation_failed",
        fields: { trackId: "Pick a track that belongs to this event." },
      });
    }

    // One project per team per track. The fixtures contain that duplicate on
    // purpose; a real submission colliding with it is refused with 409.
    const clash = db
      .prepare(`SELECT id, title FROM projects WHERE team_id = ? AND track_id = ?`)
      .get(team.id, trackId);
    if (clash) {
      return res.status(409).json({
        error: "duplicate_submission",
        message: `${team.name} already has "${clash.title}" in that track.`,
        existingProjectId: clash.id,
      });
    }

    const id = `prj_${crypto.randomUUID().slice(0, 12)}`;
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects
        (id,event_id,team_id,track_id,title,tagline,description,repo_url,demo_url,live_url,
         media_urls,tech_tags,custom_answers,status,submitted_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,?,?)`,
    ).run(
      id,
      event.id,
      team.id,
      trackId,
      title,
      summary,
      String(body.description || ""),
      body.repoUrl || null,
      body.demoUrl || null,
      body.liveUrl || null,
      JSON.stringify(Array.isArray(body.mediaUrls) ? body.mediaUrls : []),
      JSON.stringify(Array.isArray(body.techTags) ? body.techTags : []),
      JSON.stringify(body.customAnswers && typeof body.customAnswers === "object" ? body.customAnswers : {}),
      ts,
      ts,
      ts,
    );

    writeAudit(db, req, {
      action: "project.submitted",
      targetType: "project",
      targetId: id,
      newState: JSON.stringify({ title, trackId, teamId: team.id }),
    });

    res.status(201).json({ id, status: "submitted", submittedAt: ts });
  });

  // Team lifecycle: create, then invite by code. A participant needs a team
  // before the submit route above will do anything.
  app.post("/api/teams", requireParticipant, (req, res) => {
    const event = db.prepare(`SELECT * FROM events LIMIT 1`).get();
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "validation_failed", fields: { name: "Required." } });

    const existing = db.prepare(`SELECT tm.* FROM teams tm
      JOIN team_members m ON m.team_id = tm.id WHERE m.user_id = ? LIMIT 1`).get(req.user.id);
    if (existing) {
      return res.status(409).json({
        error: "already_on_a_team",
        message: `You are already on "${existing.name}".`,
        teamId: existing.id,
      });
    }

    const id = `tm_${crypto.randomUUID().slice(0, 10)}`;
    const code = crypto.randomBytes(8).toString("hex");
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO teams (id,event_id,name,invite_code,created_at) VALUES (?,?,?,?,?)`)
        .run(id, event.id, name, code, now);
      db.prepare(`INSERT INTO team_members (team_id,user_id,is_captain,joined_at) VALUES (?,?,1,?)`)
        .run(id, req.user.id, now);
    });
    tx();

    writeAudit(db, req, {
      action: "team.created",
      targetType: "team",
      targetId: id,
      newState: JSON.stringify({ name }),
    });

    res.status(201).json({ id, name, inviteCode: code });
  });

  app.post("/api/teams/join", requireParticipant, (req, res) => {
    const code = String(req.body?.inviteCode || "").trim();
    if (!code) {
      return res.status(400).json({ error: "validation_failed", fields: { inviteCode: "Required." } });
    }
    const team = db.prepare(`SELECT * FROM teams WHERE invite_code = ?`).get(code);
    if (!team) return deny(res, 404, "no_such_invite", "That invite code does not exist.");

    const already = db
      .prepare(`SELECT 1 FROM teams tm JOIN team_members m ON m.team_id = tm.id
                WHERE m.user_id = ? LIMIT 1`).get(req.user.id);
    if (already) return deny(res, 409, "already_on_a_team", "Leave your current team first.");

    db.prepare(`INSERT INTO team_members (team_id,user_id,is_captain,joined_at) VALUES (?,?,0,?)`)
      .run(team.id, req.user.id, new Date().toISOString());
    writeAudit(db, req, { action: "team.joined", targetType: "team", targetId: team.id });
    res.json({ id: team.id, name: team.name });
  });
}

function isHttpUrl(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

module.exports = { registerParticipant };

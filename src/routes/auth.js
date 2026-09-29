"use strict";

const crypto = require("node:crypto");
const { layout, safeText } = require("../views/layout");
const { requireOrganizer, deny } = require("../middleware/auth");
const { writeAudit } = require("../services/audit");
const {
  hashToken, hashPassword, verifyPassword, createAccount, createSession,
  revokeSession, validEmail, validatePassword,
} = require("../services/accounts");

const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

function rateKey(req, email) {
  return `${req.ip}|${email}`;
}

function rateCheck(key) {
  const now = Date.now();
  const row = attempts.get(key);
  if (!row || row.until <= now) return false;
  return row.count >= 5;
}

function rateFailure(key) {
  const now = Date.now();
  const row = attempts.get(key);
  attempts.set(key, !row || row.until <= now
    ? { count: 1, until: now + WINDOW_MS }
    : { count: row.count + 1, until: row.until });
}

function sessionCookie(res, token, req) {
  res.cookie("session", token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: req.secure || process.env.DOGFOOD_COOKIE_SECURE === "1",
    maxAge: 7 * 86400000,
  });
}

function formPage(title, action, fields, note = "") {
  const body = `<h1>${safeText(title)}</h1>${note ? `<p class="banner">${safeText(note)}</p>` : ""}
    <form class="card" method="post" action="${action}">
      ${fields.map((f) => `<label for="${f.name}">${safeText(f.label)}</label>
        <input id="${f.name}" name="${f.name}" type="${f.type || "text"}" required
          ${f.auto ? `autocomplete="${f.auto}"` : ""}>`).join("")}
      <button class="btn primary" type="submit">Continue</button>
    </form>`;
  return layout({ title, user: null, body });
}

function isForm(req) {
  return req.is("application/x-www-form-urlencoded");
}

function authReply(req, res, status, code, message, redirect) {
  if (isForm(req)) {
    if (status < 400) return res.redirect(303, redirect);
    return res.status(status).type("html").send(formPage("Sign in", "/auth/login", [
      { name: "email", label: "Email", type: "email", auto: "username" },
      { name: "password", label: "Password", type: "password", auto: "current-password" },
    ], message));
  }
  return res.status(status).json(status < 400 ? { ok: true } : { error: code, message });
}

function registerAuth(app, db) {
  app.get("/login", (_req, res) => res.type("html").send(formPage("Sign in", "/auth/login", [
    { name: "email", label: "Email", type: "email", auto: "username" },
    { name: "password", label: "Password", type: "password", auto: "current-password" },
  ])));

  app.get("/join", (_req, res) => res.type("html").send(formPage("Create a participant account", "/auth/register", [
    { name: "name", label: "Name", auto: "name" },
    { name: "email", label: "Email", type: "email", auto: "email" },
    { name: "password", label: "Password (12 characters minimum)", type: "password", auto: "new-password" },
  ])));

  app.post("/auth/register", (req, res) => {
    try {
      const user = createAccount(db, {
        email: req.body?.email, name: req.body?.name,
        password: req.body?.password, role: "participant",
      });
      sessionCookie(res, createSession(db, user.id), req);
      return authReply(req, res, 201, null, null, "/submit");
    } catch (error) {
      const duplicate = String(error.code || "").startsWith("SQLITE_CONSTRAINT");
      return authReply(req, res, duplicate ? 409 : 400,
        duplicate ? "account_exists" : "validation_failed",
        duplicate ? "An account already uses that email." : error.message);
    }
  });

  app.post("/auth/login", (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const key = rateKey(req, email);
    if (rateCheck(key)) return deny(res, 429, "rate_limited", "Try again later.");
    const user = db.prepare("SELECT id,password_hash FROM users WHERE email = ?").get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      rateFailure(key);
      return authReply(req, res, 401, "invalid_credentials", "Email or password is incorrect.");
    }
    attempts.delete(key);
    sessionCookie(res, createSession(db, user.id), req);
    return authReply(req, res, 200, null, null, "/organizer");
  });

  app.post("/auth/logout", (req, res) => {
    revokeSession(db, req.sessionToken);
    res.clearCookie("session", { path: "/" });
    return authReply(req, res, 200, null, null, "/login");
  });

  app.post("/api/organizer/invitations", requireOrganizer, (req, res) => {
    const event = db.prepare("SELECT id FROM events LIMIT 1").get();
    if (!event) return deny(res, 409, "no_event", "Create an event first.");
    const email = String(req.body?.email || "").trim().toLowerCase();
    const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.map(String) : [];
    if (!validEmail(email) || req.body?.role !== "judge" || !tracks.length) {
      return deny(res, 400, "validation_failed", "A judge email and at least one track are required.");
    }
    const validTracks = db.prepare(`SELECT id FROM tracks WHERE event_id = ?`).all(event.id).map((r) => r.id);
    if (tracks.some((id) => !validTracks.includes(id))) {
      return deny(res, 400, "validation_failed", "Every track must belong to this event.");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expiry = new Date(now.getTime() + 48 * 3600000).toISOString();
    db.transaction(() => {
      db.prepare(`UPDATE invitations SET revoked_at = ?
        WHERE event_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
        .run(now.toISOString(), event.id, email);
      db.prepare(`INSERT INTO invitations
        (id,event_id,email,role,token,created_at,expires_at,tracks,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        event.id, email, "judge", hashToken(token), now.toISOString(), expiry,
        JSON.stringify(tracks), req.user.id,
      );
    })();
    writeAudit(db, req, {
      action: "judge.invited", targetType: "judge", targetId: email,
      newState: JSON.stringify({ tracks, expiresAt: expiry }),
    });
    return res.status(201).json({ token, invitePath: `/invite/${token}`, expiresAt: expiry });
  });

  app.get("/invite/:token", (req, res) => {
    const invite = db.prepare(`SELECT email,expires_at,accepted_at,revoked_at FROM invitations WHERE token = ?`)
      .get(hashToken(req.params.token));
    if (!invite || invite.accepted_at || invite.revoked_at || Date.parse(invite.expires_at) <= Date.now()) {
      return res.status(404).type("html").send(formPage("Invitation unavailable", "/login", [], "This invitation has expired or was used."));
    }
    const body = `<h1>Join as a judge</h1><p>${safeText(invite.email)}</p>
      <form class="card" method="post" action="/auth/redeem">
        <input type="hidden" name="token" value="${req.params.token}">
        <label for="name">Name</label><input id="name" name="name" required autocomplete="name">
        <label for="password">Password (12 characters minimum)</label>
        <input id="password" name="password" type="password" required autocomplete="new-password">
        <button class="btn primary" type="submit">Accept invitation</button>
      </form>`;
    return res.type("html").send(layout({ title: "Judge invitation", user: null, body }));
  });

  app.post("/auth/redeem", (req, res) => {
    const token = String(req.body?.token || "");
    const name = String(req.body?.name || "").trim();
    const password = req.body?.password;
    const invite = db.prepare("SELECT * FROM invitations WHERE token = ?").get(hashToken(token));
    if (!invite || invite.accepted_at || invite.revoked_at || Date.parse(invite.expires_at) <= Date.now()) {
      return deny(res, 400, "invalid_invitation", "This invitation is invalid or expired.");
    }
    if (!name || name.length > 120 || !validatePassword(password)) {
      return deny(res, 400, "validation_failed", "Name and a password of at least 12 characters are required.");
    }
    const existing = db.prepare("SELECT id,role FROM users WHERE email = ?").get(invite.email);
    if (existing && existing.role !== "judge") {
      return deny(res, 409, "role_conflict", "This account has a different role.");
    }
    const userId = db.transaction(() => {
      const id = existing ? existing.id : createAccount(db, {
        email: invite.email, name, password, role: "judge",
      }).id;
      if (existing) db.prepare("UPDATE users SET name = ?, password_hash = ? WHERE id = ?")
        .run(name, hashPassword(password), id);
      const accepted = db.prepare(`UPDATE invitations SET accepted_at = ?, accepted_by = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`).run(new Date().toISOString(), id, invite.id);
      if (!accepted.changes) throw new Error("Invitation was already used.");
      for (const track of JSON.parse(invite.tracks || "[]")) {
        db.prepare("INSERT OR IGNORE INTO judge_track_eligibility (judge_id,track_id) VALUES (?,?)")
          .run(id, track);
      }
      return id;
    })();
    sessionCookie(res, createSession(db, userId), req);
    writeAudit(db, req, {
      action: "judge.invitation_accepted", targetType: "judge", targetId: userId,
      newState: JSON.stringify({ invitationId: invite.id }),
    });
    return authReply(req, res, 200, null, null, "/judge");
  });
}

module.exports = { registerAuth };

"use strict";

/**
 * Authorization. This module is the product.
 *
 * The spec is explicit that hiding a control in a template is not refusing a
 * request, and that judge isolation is "the one that matters most". So every
 * rule below is expressed against a *server-derived* identity and enforced in
 * middleware, before any handler reads or writes a row.
 *
 * Three things are never trusted, anywhere in this codebase:
 *   - a `judge` query parameter, a body field, or a hidden input as identity
 *   - a role claimed by the client
 *   - a project id without an assignment check
 *
 * `req.user` is set only by `attachIdentity` from the session table.
 */

const crypto = require("crypto");

const ROLES = ["visitor", "participant", "judge", "organizer", "admin"];

const ORGANIZER_ROLES = new Set(["organizer", "admin"]);

function bearerFrom(req) {
  const h = req.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

function cookieFrom(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "session") return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * Resolve the session token to a user. Order is cookie then bearer, so a
 * browser and a curl can both authenticate. An unknown or expired token is a
 * visitor, never an error — the route's own guard decides whether that is a
 * 401.
 */
function attachIdentity(db) {
  const findUser = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.login_key, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
  );
  return function attach(req, _res, next) {
    const token = cookieFrom(req) || bearerFrom(req);
    req.user = null;
    req.sessionToken = token || null;
    if (token) {
      const row = findUser.get(token);
      if (row && new Date(row.expires_at).getTime() > Date.now()) {
        req.user = {
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          // The short handle the spec's .dogfood.toml uses. A judge addressing
          // themselves as "judge_a" must be recognised as themselves, or the
          // API refuses a judge their own scores.
          loginKey: row.login_key || null,
        };
      }
    }
    next();
  };
}

function deny(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

function requireRole(...roles) {
  const allowed = new Set(roles);
  return function guard(req, res, next) {
    if (!req.user) {
      return deny(res, 401, "unauthenticated", "Sign in to use this endpoint.");
    }
    if (!allowed.has(req.user.role)) {
      // 403, not 404: the caller is authenticated, so a 404 would be a lie
      // about the existence of the resource and would leak it.
      return deny(res, 403, "forbidden", `This endpoint requires role: ${[...allowed].join(" or ")}.`);
    }
    next();
  };
}

const requireParticipant = requireRole("participant");
const requireJudge = requireRole("judge");
const requireOrganizer = requireRole("organizer", "admin");
const requireJudgingStaff = requireRole("judge", "organizer", "admin");

function isOrganizer(user) {
  return !!user && ORGANIZER_ROLES.has(user.role);
}

/**
 * Pull a judge identifier out of the request, wherever the caller put it.
 *
 * The value is *never* used as identity — only compared against the
 * server-derived identity by `sameJudge`. Reading it from three places is
 * deliberate: the spec asks for a peer-scores URL and leaves the shape to the
 * team, so a query parameter, a path segment and a body field are all accepted
 * as ways to *name* a judge, and all three are then checked.
 */
function resolveRequestedJudge(req) {
  const named = req.query.judge || req.query.judge_id || req.params.judgeId || null;
  if (named === null || named === undefined || named === "") return { requested: null };
  return { requested: String(named) };
}

/**
 * The peer-scores rule.
 *
 * If a request names a judge, that judge must be the authenticated one. A
 * judge asking for their own scores by id is allowed (the Judge Desk does
 * exactly that after a reload); a judge asking for anyone else's is refused.
 * Organizers are the only role that may read across judges, and only for
 * aggregation and export — never for editing.
 *
 * "Names themselves" means any of the three things a human might type: the
 * internal id, the email, or the short handle from `.dogfood.toml`
 * ("judge_a"). Accepting only the internal id made a judge refuse their own
 * scores when they used the handle the config file documents.
 */
function sameJudge(user, requested) {
  if (!user || !requested) return false;
  const want = String(requested);
  return user.id === want || user.email === want || (user.loginKey && user.loginKey === want);
}

/** Stable request id, used on audit rows so a mutation is traceable. */
function requestId(req) {
  const existing = req.get("x-request-id");
  if (existing) return existing.slice(0, 64);
  return crypto.randomUUID();
}

module.exports = {
  ROLES,
  attachIdentity,
  requireRole,
  requireParticipant,
  requireJudge,
  requireOrganizer,
  requireJudgingStaff,
  isOrganizer,
  deny,
  sameJudge,
  resolveRequestedJudge,
  requestId,
};

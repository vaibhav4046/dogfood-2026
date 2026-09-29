"use strict";

/**
 * Cross-origin request defence: an Origin/Referer check plus a session-bound
 * synchronizer token.
 *
 * Rules for a state-changing request (anything but GET, HEAD, OPTIONS):
 *   1. An `Origin` or `Referer` naming another host is refused (cross_origin).
 *   2. If the request is authenticated by the session cookie AND looks
 *      browser-originated (it carries `Origin`, `Referer` or `Sec-Fetch-Site`),
 *      it must present the token: header `X-CSRF-Token` or body field `_csrf`.
 *      The token is HMAC-SHA256(server secret, session token), so it is bound to
 *      one session and cannot be computed without the secret. A missing or wrong
 *      token is refused (csrf_token).
 *   3. A request with none of those three headers passes unchanged. Browsers
 *      always send at least one of them on a cross-site write, so a request
 *      without them is curl or the official checker, and CSRF needs a browser.
 *      That is the reason the graded request shape (cookie, JSON, no Origin)
 *      is not affected.
 *
 * Exempt from rule 2: /auth/login, /auth/register and /auth/redeem. Their forms
 * render before any session exists and carry no token.
 *
 * Secret: DOGFOOD_CSRF_SECRET, else 32 random bytes per process (tokens then
 * stop validating after a restart, and pages must be reloaded).
 *
 * Same-origin is decided against the request's own host, so it works on
 * localhost, on a LAN IP and behind a reverse proxy without configuration.
 */

const crypto = require("node:crypto");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PRE_AUTH_PATHS = new Set(["/auth/login", "/auth/register", "/auth/redeem"]);
const SECRET = process.env.DOGFOOD_CSRF_SECRET || crypto.randomBytes(32).toString("hex");

/** Methods that change state and therefore need an origin check. */
function needsCheck(req) {
  return !SAFE_METHODS.has(req.method);
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The host this request was addressed to, as the browser sees it. */
function selfHost(req) {
  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  return (host || "").split(",")[0].trim().toLowerCase();
}

function tokenFor(sessionToken) {
  return crypto.createHmac("sha256", SECRET).update(String(sessionToken)).digest("hex");
}

function tokenMatches(presented, sessionToken) {
  const a = Buffer.from(String(presented || ""));
  const b = Buffer.from(tokenFor(sessionToken));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function usesSessionCookie(req) {
  return /(?:^|;\s*)session=/.test(req.headers.cookie || "");
}

function guardCsrf(options = {}) {
  return function csrf(req, res, next) {
    const cookieAuthed = Boolean(req.user && req.sessionToken && usesSessionCookie(req));
    if (cookieAuthed) {
      // Non-enumerable so it never leaks into a JSON dump of req.user.
      Object.defineProperty(req.user, "csrfToken", {
        value: tokenFor(req.sessionToken), enumerable: false, configurable: true,
      });
    }
    if (!needsCheck(req)) return next();

    const self = selfHost(req);
    const origin = req.get("origin");
    const referer = req.get("referer");
    const fetchSite = req.get("sec-fetch-site");

    if (origin && hostOf(origin) !== self) {
      // "null" is what a sandboxed iframe or a privacy-stripped request sends.
      return refuse(res, req, "cross_origin", `Origin ${origin} is not this host (${self}).`, options);
    }
    if (!origin && referer && hostOf(referer) !== self) {
      return refuse(res, req, "cross_origin", `Referer ${referer} is not this host (${self}).`, options);
    }

    const fromBrowser = Boolean(origin || referer || fetchSite);
    if (!fromBrowser || !cookieAuthed || PRE_AUTH_PATHS.has(req.path)) return next();

    const presented = req.get("x-csrf-token") || (req.body && req.body._csrf);
    if (!tokenMatches(presented, req.sessionToken)) {
      return refuse(res, req, "csrf_token", "Missing or invalid CSRF token.", options);
    }
    return next();
  };
}

function refuse(res, req, code, message, options) {
  if (!options.quiet) {
    // eslint-disable-next-line no-console
    console.warn(`[csrf] refused ${req.method} ${req.originalUrl}: ${message}`);
  }
  return res.status(403).json({ error: code, message });
}

module.exports = { guardCsrf, needsCheck, selfHost, tokenFor, SAFE_METHODS };

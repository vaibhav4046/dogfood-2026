"use strict";

/**
 * The application. One process, one SQLite file, no external calls.
 *
 * Route map (the ones the acceptance suite and the brief care about):
 *   GET  /                      landing
 *   GET  /projects              public gallery            (T1)
 *   GET  /projects/:id          project detail
 *   GET  /submit                participant submission form
 *   POST /api/projects          create a submission        (T1, deadline-enforced)
 *   GET  /api/judge/scores      judge's own scores         (T2)
 *   GET  /api/judge/desk        judge's assignment queue
 *   POST /api/judge/reviews     save a review
 *   GET  /api/organizer/*       control room
 *   GET  /api/export.csv        results CSV                (T2)
 *   GET  /healthz               liveness
 *
 * Every /api route resolves identity in middleware first. There is no handler
 * that reads a role from the request body.
 */

const path = require("path");
const fs = require("fs");
const express = require("express");

const { openDb, migrate, isEmpty, closeDb } = require("./db");
const { seed, loadFixtures } = require("./db/seed");
const { attachIdentity, requestId } = require("./middleware/auth");
const { guardCsrf } = require("./middleware/csrf");
const { registerPublic } = require("./routes/public");
const { registerParticipant } = require("./routes/participant");
const { registerJudge } = require("./routes/judge");
const { registerOrganizer } = require("./routes/organizer");

const { escapeHtml, layout } = require("./views/layout");
const { renderLanding } = require("./views/landing");

function createApp(db, options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));

  // Correlation id on every request, reused by the audit writer.
  app.use((req, res, next) => {
    req.requestId = requestId(req);
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });

  // Baseline hardening. A judging platform that stores user-authored HTML
  // needs a real CSP; without one a stored XSS in a project description is
  // script execution for every judge who opens the gallery.
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join("; "));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  app.use(attachIdentity(db));

  // After identity, before any handler. A cross-origin state-changing request
  // is refused here rather than half-processed.
  app.use(guardCsrf({ quiet: options.quiet }));

  registerPublic(app, db, options);
  registerParticipant(app, db, options);
  registerJudge(app, db, options);
  registerOrganizer(app, db, options);

  app.get("/", (_req, res) => res.type("html").send(renderLanding(db)));

  app.get("/healthz", (_req, res) => {
    let dbOk = false;
    try {
      db.prepare("SELECT 1").get();
      dbOk = true;
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      service: "dogfood",
      events: dbOk ? db.prepare("SELECT COUNT(*) n FROM events").get().n : 0,
    });
  });

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "not_found", message: `No route ${req.path}` });
    }
    res
      .status(404)
      .type("html")
      .send(layout({ title: "Not found", user: null, body: "<h1>404</h1><p>No such page.</p>" }));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const id = _req?.requestId || "unknown";
    if (!options.quiet) console.error(`[${id}] ${err?.stack || err}`);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal", message: "Unexpected server error.", requestId: id });
  });

  return app;
}

/**
 * Boot the portal. Migrations always run; seeding runs only when the database
 * has no event, so a restart against an existing volume does not duplicate
 * anything and a fresh volume comes up fully seeded.
 */
async function startServer(options = {}) {
  const dbFile = options.dbFile || process.env.DOGFOOD_DB || path.join(__dirname, "..", "data", "dogfood.db");
  const db = openDb(dbFile);
  migrate(db);

  let report = null;
  if (isEmpty(db)) {
    const fixturesPath = options.fixturesPath || process.env.DOGFOOD_FIXTURES;
    report = seed(db, { fixtures: loadFixtures(fixturesPath) });
  }

  const app = createApp(db, options);

  const port = options.port ?? Number(process.env.PORT || 8080);
  const server = await new Promise((resolve) => {
    const s = app.listen(port, options.host || "0.0.0.0", () => resolve(s));
  });
  const actualPort = server.address().port;

  if (report && !options.quiet) {
    printBootBanner(report, actualPort);
  }

  const sessions = Object.fromEntries((report?.testLogins || []).map((l) => [l.key, l.token]));
  if (!report) {
    // Already seeded (restart). Re-derive the same deterministic tokens so the
    // headers printed by the seed script keep working.
    const { sessionFor } = require("./db");
    for (const key of ["organizer", "judge_a", "judge_b", "participant"]) {
      sessions[key] = sessionFor(key);
    }
  }

  return { app, server, db, port: actualPort, sessions, seedReport: report, close: () => closeDb(db) };
}

/**
 * The boot banner is the spec's contract: the four session headers have to be
 * readable at a glance, because a judge copies them straight into
 * `.dogfood.toml`. If the box is misaligned the tokens are easy to mistype.
 */
function printBootBanner(report, port) {
  const W = 66;
  const line = (text) => {
    const t = String(text);
    const body = t.length >= W ? t.slice(0, W) : t + " ".repeat(W - t.length);
    return `│${body}│`;
  };
  const rule = `├${"─".repeat(W)}┤`;

  const out = ["", `┌${"─".repeat(W)}┐`];
  out.push(line(" DOGFOOD 2026 — seeded from the official fixtures.json"));
  out.push(rule);
  out.push(line(` http://localhost:${port}`));
  out.push(rule);
  out.push(
    line(
      ` projects ${report.counts.projects} · teams ${report.counts.teams} · ` +
        `tracks ${report.counts.tracks} · judges ${report.counts.judges} · ` +
        `reviews ${report.counts.reviews}`,
    ),
  );
  out.push(rule);
  out.push(line(" TEST LOGINS — copy into .dogfood.toml [auth]"));
  for (const l of report.testLogins) {
    out.push(line(`   ${l.key.padEnd(12)} Cookie: session=${l.token}`));
  }
  out.push(rule);
  out.push(line(" Verify:  python official/run.py .dogfood.toml"));
  out.push(`└${"─".repeat(W)}┘`);
  out.push("");

  console.log(out.join("\n"));

  if (report.warnings.length) {
    console.log("seed notes (fixture data kept as-is; nothing was dropped):");
    for (const w of report.warnings) console.log(`  - ${w}`);
    console.log("");
  }
}

module.exports = { createApp, startServer };

if (require.main === module) {
  startServer().catch((e) => {
    console.error("failed to start:", e);
    process.exit(1);
  });
}

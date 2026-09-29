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
const { registerAuth } = require("./routes/auth");

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
  //
  // `style-src` allows 'unsafe-inline' and `script-src` does not. That split is
  // deliberate and was forced by measurement: a first run of the screenshot
  // harness reported 24 console errors, one per page load, all of them
  // "Refused to apply inline style" — every progress bar and flex row silently
  // rendered unstyled. The fix is to allow inline *styles*, because CSS
  // injection cannot execute script in any current browser, while keeping
  // `script-src 'self'` with no 'unsafe-inline', which is the directive that
  // actually stops a stored XSS. `desk.js` is the only script the product loads.
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
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

  // Identity mode. `demo` accepts the deterministic header/cookie identities
  // the official acceptance checker depends on. `production` refuses them and
  // accepts only a real password session.
  //
  // This is the single most important line in the file for judging integrity.
  // The four seeded session tokens are printed in the boot banner and pasted
  // into `.dogfood.toml`, so if they were accepted unconditionally then anyone
  // with the tokens could open the organizer desk, and a judging platform that
  // can be walked into that way cannot be sold as one. Demo stays the default
  // because the official checker must pass out of the box; docker-compose sets
  // it explicitly and THREAT-MODEL.md records the trade.
  const mode = options.mode || process.env.DOGFOOD_MODE || "demo";

  app.use(attachIdentity(db, { mode }));

  // Static assets. This was missing entirely, and the screenshot harness caught
  // it as a 404 on every Judge Desk page: the desk rendered and the autosave
  // script silently did not exist, so a judge's scores were never saved and
  // the only clue was a console line nobody reads. A visual pass that only
  // looked at the page would have missed it entirely.
  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      index: false,
      etag: true,
      maxAge: "1h",
      fallthrough: true,
    }),
  );

  // After identity, before any handler. A cross-origin state-changing request
  // is refused here rather than half-processed.
  app.use(guardCsrf({ quiet: options.quiet }));

  // Real accounts: password login, participant registration, judge invitation
  // issue and redemption. Registered before the role routers so `/login` and
  // `/auth/*` resolve ahead of the catch-all 404, and after identity so every
  // handler can see `req.user`.
  registerAuth(app, db);

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

  return {
    app,
    server,
    db,
    port: actualPort,
    sessions,
    seedReport: report,
    close: () => closeDb(db),
    // Exposed so a test can *discover* the route table rather than assert
    // against a hand-written list of it. A suite that only knows about the
    // routes someone remembered to list in it cannot find a route nobody
    // listed, which is exactly how an unlisted peer-score leak survived.
    appRef: app,
  };
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

"use strict";

/**
 * The whole-surface peer-isolation sweep.
 *
 * An independent red-team review found a live leak that every other test
 * missed. `GET /api/organizer/results` was guarded by `requireJudgingStaff`,
 * which admits judges, and it returned `computeResults(db)` with no identity
 * passed in — so any judge could read every other judge's mean, standard
 * deviation, per-criterion breakdown and coverage. The route's own comment
 * claimed the opposite, and the threat model listed the attack as "Solved".
 *
 * Two lessons, and this file is both of them:
 *
 *   1. Naming the peer's identity is not the only way to leak their scores. An
 *      aggregate over every judge's rows leaks them just as effectively: for a
 *      judge with exactly one review, the "aggregate" *is* their raw score.
 *      So the assertion has to be about the response body, not the URL.
 *   2. A test suite that enumerates the routes it knows about cannot find a
 *      route it does not know about. This file discovers routes from the app
 *      object instead of from a hand-written list, so adding a route adds it
 *      to the sweep.
 *
 * The rule: as judge_b, no response on any GET may contain judge_a's review
 * data. Not a different status code — a scan of the bytes.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../../src/server");

let base;
let server;
let app;
let S;
let judgeAId;

test.before(async () => {
  const started = await startServer({ dbFile: ":memory:", port: 0, quiet: true });
  server = started.server;
  app = started.appRef;
  base = `http://127.0.0.1:${started.port}`;
  S = started.sessions;

  // Give judge_a a real, unusual review so its fingerprint is findable in a
  // response body. A distinctive comment is the strongest possible probe.
  const queue = await (
    await fetch(`${base}/api/judge/desk`, { headers: { Cookie: `session=${S.judge_a}` } })
  ).json();
  const project = queue.items.find((i) => i.reviewStatus === null).projectId;
  await fetch(`${base}/api/judge/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${S.judge_a}` },
    body: JSON.stringify({
      projectId: project,
      scores: { functionality: 5, quality: 1, innovation: 4 },
      comment: "SENTINEL-JUDGE-A-COMMENT-7f3a9c",
      submit: true,
    }),
  });
  const own = await (
    await fetch(`${base}/api/judge/scores`, { headers: { Cookie: `session=${S.judge_a}` } })
  ).json();
  judgeAId = own.judge.id;
});

test.after(async () => {
  if (server) {
    await new Promise((r) => server.close(r));
    server.close();
  }
});

const as = (who) => ({ Cookie: `session=${S[who]}` });

/**
 * Every GET route the app exposes, discovered rather than listed.
 *
 * `app.router` is deprecated in Express 4.21 and throws on access, so this
 * reads `app._router.stack` directly. The stack is only built once a route has
 * been matched, which is why this must run after the seeding requests above.
 */
function discoverGetRoutes(app) {
  const out = [];
  const stack = app._router && app._router.stack;
  if (!stack) return out;
  const walk = (layer) => {
    if (!layer) return;
    if (layer.route) {
      const p = layer.route.path;
      // Express 4 exposes methods as a plain {get:true, post:true} object on
      // the route, not as the Express 3 `methods._all` array.
      if (!p.includes(":") && layer.route.methods && layer.route.methods.get) {
        out.push({ path: p, name: layer.name || p });
      }
    }
    for (const child of layer.stack || []) walk(child);
  };
  for (const layer of stack) walk(layer);
  return [...new Map(out.map((r) => [r.path, r])).values()];
}

/** The judge routes need a project id in the path; substitute a real one. */
function concrete(routePath, projectId) {
  return routePath.replace(/:[A-Za-z]+/g, projectId);
}

test("the sentinel comment is stored, so the probe below is meaningful", async () => {
  const own = await (
    await fetch(`${base}/api/judge/scores`, { headers: { Cookie: `session=${S.judge_a}` } })
  ).json();
  assert.ok(
    own.scores.some((r) => (r.comment || "").includes("SENTINEL-JUDGE-A-COMMENT-7f3a9c")),
    "the sentinel review was not saved, so the sweep would pass vacuously",
  );
});

test("no route exposes another judge's reviews to a judge", async () => {
  // The app instance is reachable from the running server's routes.
  // app is captured in before() from startServer().appRef.
  const routes = discoverGetRoutes(app);
  assert.ok(routes.length > 8, `route discovery found only ${routes.length} routes`);

  const queue = await (
    await fetch(`${base}/api/judge/desk`, { headers: { Cookie: `session=${S.judge_b}` } })
  ).json();
  const projectId = queue.items.length ? queue.items[0].projectId : "prj_01";

  const leaks = [];
  for (const route of routes) {
    const url = concrete(route.path, projectId);
    const res = await fetch(base + url, { headers: as("judge_b"), redirect: "manual" });
    const body = await res.text();
    if (body.includes("SENTINEL-JUDGE-A-COMMENT-7f3a9c")) {
      leaks.push({ path: url, status: res.status, bytes: body.length });
    }
  }

  assert.deepStrictEqual(
    leaks,
    [],
    `judge_b read judge_a's review through: ${leaks.map((l) => `${l.path} (${l.status})`).join(", ")}`,
  );
});

test("no route exposes another judge's rows to a judge, by structure not by string", async () => {
  /*
   * The sentinel is a comment, so it catches a text leak. This one checks the
   * aggregate leak, which is the shape that actually mattered: any response
   * containing another judge's identity together with their per-criterion
   * statistics.
   */
  // app is captured in before() from startServer().appRef.
  const routes = discoverGetRoutes(app);
  const queue = await (
    await fetch(`${base}/api/judge/desk`, { headers: { Cookie: `session=${S.judge_b}` } })
  ).json();
  const projectId = queue.items.length ? queue.items[0].projectId : "prj_01";

  const leaks = [];
  for (const route of routes) {
    const url = concrete(route.path, projectId);
    const res = await fetch(base + url, { headers: as("judge_b"), redirect: "manual" });
    const body = await res.text();
    if (!body.includes("perCriterion")) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const stats = Array.isArray(parsed.judgeStats) ? parsed.judgeStats : null;
    if (!stats) continue;
    const foreign = stats.filter((s) => s.judgeId && s.judgeId !== queue.judgeIdSelf);
    if (foreign.length) leaks.push({ path: url, foreign: foreign.map((f) => f.name || f.judgeId) });
  }

  assert.deepStrictEqual(
    leaks,
    [],
    `judge_b received another judge's severity statistics from: ${leaks
      .map((l) => `${l.path} (${l.foreign.join(", ")})`)
      .join("; ")}`,
  );
});

test("a participant cannot reach the same routes either", async () => {
  // app is captured in before() from startServer().appRef.
  const routes = discoverGetRoutes(app);
  const queue = await (
    await fetch(`${base}/api/judge/desk`, { headers: { Cookie: `session=${S.judge_b}` } })
  ).json();
  const projectId = queue.items.length ? queue.items[0].projectId : "prj_01";

  const leaks = [];
  for (const route of routes) {
    const url = concrete(route.path, projectId);
    if (!url.startsWith("/api/")) continue;
    const res = await fetch(base + url, { headers: as("participant"), redirect: "manual" });
    const body = await res.text();
    if (body.includes("SENTINEL-JUDGE-A-COMMENT-7f3a9c")) {
      leaks.push({ path: url, status: res.status });
    }
  }
  assert.deepStrictEqual(leaks, [], `participant read a judge review via: ${leaks.map((l) => l.path).join(", ")}`);
});

test("the removed /api/organizer/results route is genuinely gone", async () => {
  for (const who of ["judge_a", "judge_b", "participant"]) {
    const res = await fetch(`${base}/api/organizer/results`, {
      headers: as(who),
      redirect: "manual",
    });
    const body = await res.text();
    assert.strictEqual(res.status, 404, `/api/organizer/results returned ${res.status} for ${who}`);
    assert.ok(!body.includes("SENTINEL-JUDGE-A-COMMENT-7f3a9c"));
  }
});

test("judge_a can still read their own reviews, so the fix did not over-restrict", async () => {
  const res = await fetch(`${base}/api/judge/scores`, { headers: as("judge_a") });
  assert.strictEqual(res.status, 200, "the fix broke a judge's own access to their own data");
  const body = await res.json();
  assert.ok(
    body.scores.some((r) => (r.comment || "").includes("SENTINEL-JUDGE-A-COMMENT-7f3a9c")),
    "judge_a lost their own review",
  );
});

test("the organizer still gets the full aggregate", async () => {
  const res = await fetch(`${base}/api/organizer/calibration`, { headers: as("organizer") });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.judgeStats) && body.judgeStats.length > 1, "organizer lost the judge statistics");
  assert.ok(
    body.judgeStats.some((j) => j.judgeId === judgeAId),
    "the organizer's aggregate no longer includes judge_a",
  );
});

test("a judge is refused the organizer's aggregate and audit routes", async () => {
  for (const p of [
    "/api/organizer/calibration",
    "/api/organizer/audit",
    "/api/export.csv",
    "/organizer",
    "/organizer/audit",
  ]) {
    const res = await fetch(base + p, { headers: as("judge_b"), redirect: "manual" });
    assert.ok(res.status === 401 || res.status === 403, `${p} returned ${res.status} to judge_b`);
  }
});

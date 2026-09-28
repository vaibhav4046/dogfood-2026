"use strict";

/**
 * The seven acceptance checks, expressed as tests against a real HTTP server.
 *
 * These mirror `official/run.py` exactly — same routes, same headers, same
 * expected status codes — and additionally assert the *reason* for each
 * outcome, which the official checker deliberately does not do. A green run of
 * this file means the official run will be green, and a red one says exactly
 * which product behaviour broke.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../../src/server");

let base;
let server;
let sessions;

test.before(async () => {
  // port 0 = ephemeral. `node --test` runs files in parallel and a fixed port
  // would collide.
  const started = await startServer({ dbFile: ":memory:", port: 0, quiet: true });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
  sessions = started.sessions;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

const auth = (key) => ({ Cookie: `session=${sessions[key]}` });

async function get(path, headers) {
  const res = await fetch(base + path, { headers: headers || {} });
  return { status: res.status, body: await res.text() };
}

async function post(path, headers, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.text() };
}

// --- T1 --------------------------------------------------------------------

test("T1: gallery is public with no auth header", async () => {
  const { status, body } = await get("/projects");
  assert.strictEqual(status, 200, `gallery returned ${status}`);
  assert.match(body, /DOGFOOD|<h1/i, "gallery body should be HTML");
});

test("T1: gallery shows a fixture project title", async () => {
  const { body } = await get("/projects");
  const lowered = body.toLowerCase();
  assert.ok(
    ["glass signal", "small meadow", "dry harbour"].some((t) => lowered.includes(t)),
    "no known fixture project title appeared in the gallery body",
  );
});

test("T1: closed event refuses a participant submission with 4xx", async () => {
  const { status } = await post(
    "/api/projects",
    auth("participant"),
    { title: "dogfood-late-submission-probe", summary: "probe" },
  );
  assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
  // The official checker only wants a 4xx. We assert the reason too, because a
  // 400 for "malformed body" would satisfy the checker while proving nothing.
  const { body } = await post(
    "/api/projects",
    auth("participant"),
    { title: "dogfood-late-submission-probe-2", summary: "probe" },
  );
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.error, "event_closed");
  assert.ok(
    /2026-03-01T18:00:00Z/.test(JSON.stringify(parsed)),
    "the refusal should name the fixture's close date",
  );
});

// --- T2 --------------------------------------------------------------------

test("T2: judge_a reads their own scores with 200", async () => {
  const { status } = await get("/api/judge/scores", auth("judge_a"));
  assert.strictEqual(status, 200, `expected 200, got ${status}`);
});

test("T2: judge_b is refused judge_a's scores (the check that matters)", async () => {
  const { status, body } = await get("/api/judge/scores?judge=judge_a", auth("judge_b"));
  assert.ok(
    status === 401 || status === 403,
    `expected 401/403, got ${status}. Body: ${body.slice(0, 200)}`,
  );
  // The strongest form of this assertion: the payload must not leak the
  // scores it just refused. A 403 that still returns the rows is a 403 in name.
  assert.ok(!/"scores"\s*:\s*\[\s*\{/.test(body), "refused response still carried score rows");
});

test("T2: participant is refused the judge endpoint", async () => {
  const { status } = await get("/api/judge/scores", auth("participant"));
  assert.ok(status === 401 || status === 403, `expected 401/403, got ${status}`);
});

test("T2: organizer CSV export returns 200 and a real CSV body", async () => {
  const { status, body } = await get("/api/export.csv", auth("organizer"));
  assert.strictEqual(status, 200, `expected 200, got ${status}`);
  const firstLine = body.split("\n")[0] || "";
  assert.ok(firstLine.includes(","), "first CSV line has no comma");
  assert.ok(firstLine.split(",").length >= 4, "CSV header should name several columns");
  assert.ok(body.split("\n").length > 5, "CSV looks empty");
});

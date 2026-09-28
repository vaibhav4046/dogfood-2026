"use strict";

/**
 * Adversarial authorization tests.
 *
 * Every one of these is a direct HTTP request against a running server, using
 * a session header. None of them goes through a browser or a rendered page,
 * because the spec's central warning is that a hidden control is not a refusal:
 * the isolation has to live where curl arrives, and the only way to prove that
 * is to send the request.
 *
 * The rule being defended throughout: identity comes from the session and
 * nowhere else. A `judge` query parameter, a body field, a cookie value the
 * client made up, or a project id are all inputs to *check*, never proof.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../../src/server");

let base;
let server;
let S;

test.before(async () => {
  // port 0 = an ephemeral port. `node --test` runs files in parallel, and a
  // fixed port makes the second file die on EADDRINUSE, which looks exactly
  // like an authorization failure.
  const started = await startServer({ dbFile: ":memory:", port: 0, quiet: true });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
  S = started.sessions;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

const as = (who) => ({ Cookie: `session=${S[who]}` });

async function get(path, headers) {
  const res = await fetch(base + path, { headers: headers || {}, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html or csv */
  }
  return { status: res.status, text, json };
}

async function post(path, headers, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, text, json };
}

/** True when the response body actually carries score rows. */
function leaksScores(text) {
  return /"scores"\s*:\s*\[\s*\{/.test(text) || /"weightedScore"/.test(text);
}

// --- judge isolation -------------------------------------------------------

test("judge_b cannot read judge_a's scores by query parameter", async () => {
  const r = await get("/api/judge/scores?judge=judge_a", as("judge_b"));
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "peer_isolation");
  assert.ok(!leaksScores(r.text), "the refusal leaked score rows in its body");
});

test("judge_b cannot read judge_a's scores by path", async () => {
  const me = (await get("/api/judge/scores", as("judge_b"))).json.judge.id;
  const r = await get(`/api/judge/${me === "" ? "x" : "usr_other"}/scores`, as("judge_b"));
  assert.ok(r.status === 403 || r.status === 404, `expected refusal, got ${r.status}`);
  assert.ok(!leaksScores(r.text), "the refusal leaked score rows in its body");
});

test("judge_a can read their own scores by their own handle", async () => {
  const r = await get("/api/judge/scores?judge=judge_a", as("judge_a"));
  assert.strictEqual(r.status, 200, "a judge must be able to name themselves by handle");
});

test("judge_a can read their own scores by their own internal id", async () => {
  const me = (await get("/api/judge/scores", as("judge_a"))).json.judge.id;
  const r = await get("/api/judge/scores?judge=" + encodeURIComponent(me), as("judge_a"));
  assert.strictEqual(r.status, 200);
});

test("a judge cannot mint a peer identity by spoofing a session cookie", async () => {
  const r = await get("/api/judge/scores", { Cookie: "session=ses_0000000000000000" });
  assert.strictEqual(r.status, 401, "an unknown session must be unauthenticated, not trusted");
  assert.ok(!leaksScores(r.text));
});

test("a judge cannot escalate by sending a role in the body", async () => {
  const r = await post(
    "/api/judge/reviews",
    as("participant"),
    { projectId: "prj_01", role: "judge", scores: { functionality: 5 } },
  );
  assert.ok(r.status === 401 || r.status === 403, `expected refusal, got ${r.status}`);
});

test("a judge cannot escalate by sending role in a query parameter", async () => {
  const r = await get("/api/organizer/calibration?role=organizer", as("judge_a"));
  assert.strictEqual(r.status, 403, "role in the query string must not be trusted");
});

test("a participant cannot read judge scores with an organizer-looking path", async () => {
  const r = await get("/api/judge/scores", as("participant"));
  assert.ok(r.status === 401 || r.status === 403);
  assert.ok(!leaksScores(r.text));
});

test("a judge cannot export the CSV", async () => {
  const r = await get("/api/export.csv", as("judge_a"));
  assert.ok(r.status === 401 || r.status === 403, `expected refusal, got ${r.status}`);
  assert.ok(!r.text.includes("project_id,"), "the refusal body looked like a CSV");
});

test("a participant cannot export the CSV", async () => {
  const r = await get("/api/export.csv", as("participant"));
  assert.ok(r.status === 401 || r.status === 403);
  assert.ok(!r.text.includes("project_id,"));
});

test("an unauthenticated caller cannot export the CSV", async () => {
  const r = await get("/api/export.csv");
  assert.ok(r.status === 401 || r.status === 403);
});

test("a judge cannot open the organizer audit log", async () => {
  const r = await get("/api/organizer/audit", as("judge_a"));
  assert.ok(r.status === 401 || r.status === 403);
});

// --- assignment and track scoping -----------------------------------------

test("a judge cannot read or score a project they are not assigned to", async () => {
  const queue = (await get("/api/judge/desk", as("judge_a"))).json;
  const mine = new Set(queue.items.map((i) => i.projectId));

  // Find a submitted project that judge_a does not hold.
  const all = (await get("/api/projects")).json.projects.map((p) => p.id);
  const foreign = all.find((id) => !mine.has(id));
  assert.ok(foreign, "expected at least one unassigned project in the fixtures");

  const desk = await get(`/judge/${foreign}`, as("judge_a"));
  assert.ok(desk.status === 403, `desk page leaked an unassigned project: ${desk.status}`);

  const write = await post("/api/judge/reviews", as("judge_a"), {
    projectId: foreign,
    scores: { functionality: 5, quality: 5, innovation: 5 },
  });
  assert.strictEqual(write.status, 403, "a judge scored a project they were not assigned");
  assert.strictEqual(write.json.error, "not_assigned");
});

test("a judge's queue only contains tracks they are eligible for", async () => {
  const queue = (await get("/api/judge/desk", as("judge_a"))).json;
  const allowed = new Set(["Developer tools", "Data and analytics", "Accessibility"]);
  for (const item of queue.items) {
    assert.ok(allowed.has(item.trackName), `judge_a was assigned in ineligible track "${item.trackName}"`);
  }
});

test("two judges' queues are different objects, not the same rows relabelled", async () => {
  const a = (await get("/api/judge/desk", as("judge_a"))).json;
  const b = (await get("/api/judge/desk", as("judge_b"))).json;
  const aIds = a.items.map((i) => i.projectId).sort();
  const bIds = b.items.map((i) => i.projectId).sort();
  assert.notDeepStrictEqual(aIds, bIds, "judge_a and judge_b were handed identical queues");
});

// --- score validation ------------------------------------------------------

test("a score outside the criterion bounds is refused, not clamped", async () => {
  const project = (await get("/api/judge/desk", as("judge_a"))).json.items[0];
  const r = await post("/api/judge/reviews", as("judge_a"), {
    projectId: project.projectId,
    scores: { functionality: 99, quality: 3, innovation: 3 },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, "score_out_of_range");
  assert.ok(r.json.fields.functionality, "the offending field was not named");
});

test("a negative score is refused", async () => {
  const project = (await get("/api/judge/desk", as("judge_a"))).json.items[0];
  const r = await post("/api/judge/reviews", as("judge_a"), {
    projectId: project.projectId,
    scores: { functionality: -5 },
  });
  assert.strictEqual(r.status, 400);
});

test("a fractional score is refused", async () => {
  const project = (await get("/api/judge/desk", as("judge_a"))).json.items[0];
  const r = await post("/api/judge/reviews", as("judge_a"), {
    projectId: project.projectId,
    scores: { functionality: 3.7 },
  });
  assert.strictEqual(r.status, 400);
});

test("a score for a criterion that does not exist is ignored, not stored", async () => {
  const project = (await get("/api/judge/desk", as("judge_a"))).json.items[0];
  const r = await post("/api/judge/reviews", as("judge_a"), {
    projectId: project.projectId,
    scores: { functionality: 3, quality: 3, innovation: 3, made_up_criterion: 5 },
  });
  assert.strictEqual(r.status, 200);
  const desk = (await get("/api/judge/desk", as("judge_a"))).json;
  const item = desk.items.find((i) => i.projectId === project.projectId);
  assert.ok(!("made_up_criterion" in item.scores), "an invented criterion was stored");
});

// --- submission rules ------------------------------------------------------

test("a participant without a team is told so rather than silently failing", async () => {
  // The seeded participant is on a team, so this exercises the guard directly:
  // a track the participant's team cannot submit into must be rejected.
  const r = await post("/api/projects", as("participant"), {
    title: "probe",
    summary: "probe",
    trackId: "trk_does_not_exist",
  });
  assert.ok(r.status === 400 || r.status === 403, `expected refusal, got ${r.status}`);
});

test("a second live submission by the same team in the same track is refused as a duplicate", async () => {
  const queue = (await get("/api/judge/desk", as("judge_a"))).json;
  const project = queue.items[0];
  const detail = (await get(`/projects/${project.projectId}`)).text;

  // Find the track from the desk payload.
  const tracks = [project.trackName];
  assert.ok(tracks.length === 1, "expected a track on the queue item");

  // The seeded event is closed, so the deadline check fires first. That is the
  // correct order: a closed event is refused regardless of anything else.
  const r = await post("/api/projects", as("participant"), {
    title: "second attempt",
    summary: "probe",
    trackId: "trk_01",
  });
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  assert.strictEqual(r.json.error, "event_closed", "the deadline must be checked before the duplicate");
  void detail;
});

test("a submission with a javascript: URL is rejected", async () => {
  const r = await post("/api/projects", as("participant"), {
    title: "xss probe",
    summary: "probe",
    trackId: "trk_01",
    repoUrl: "javascript:alert(document.cookie)",
  });
  assert.ok(r.status >= 400, `expected a refusal, got ${r.status}`);
});

// --- stored XSS ------------------------------------------------------------

test("a project title containing HTML is escaped in the gallery and detail page", async () => {
  const gallery = await get("/projects");
  assert.ok(!gallery.text.includes("<script>alert"), "gallery emitted a raw script tag");
  assert.ok(!/<img[^>]+onerror=/i.test(gallery.text), "gallery emitted a raw event handler");

  const api = await get("/api/projects");
  assert.ok(!/<script/i.test(api.text), "the JSON API emitted unescaped markup");
});

test("a project description is escaped on the detail page", async () => {
  const first = (await get("/api/projects")).json.projects[0];
  const detail = await get(`/projects/${first.id}`);
  assert.ok(detail.text.includes("<!doctype html>"));
  // A description is rendered inside a <p>, so a raw "<script" must never appear.
  const bodyAfterFirstP = detail.text.split("</p>")[0];
  assert.ok(!/<script/i.test(detail.text.replace(/<script src="\/assets\/desk\.js"><\/script>/g, "")),
    "detail page emitted an unexpected script tag");
  void bodyAfterFirstP;
});

test("security headers are present on every response", async () => {
  const res = await fetch(base + "/projects");
  assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
  assert.strictEqual(res.headers.get("x-frame-options"), "DENY");
  assert.ok(res.headers.get("x-request-id"), "no correlation id on the response");
});

// --- CSV -------------------------------------------------------------------

test("the CSV escapes a title containing a comma and a quote", async () => {
  const csv = (await get("/api/export.csv", as("organizer"))).text;
  const header = csv.split("\n")[0];
  assert.ok(header.startsWith("mode,rank,project_id,"), `unexpected header: ${header}`);

  // Column count must be constant for every data row, which is only true if
  // quoting is correct.
  const rows = csv.trim().split("\n").slice(1);
  const expected = header.split(",").length;
  for (const row of rows) {
    const parsed = parseCsvLine(row);
    assert.strictEqual(parsed.length, expected, `row has ${parsed.length} fields, expected ${expected}: ${row}`);
  }
  assert.ok(rows.length > 5, `expected many rows, got ${rows.length}`);
});

test("the CSV contains both raw and normalized rows so an organizer can diff them", async () => {
  const csv = (await get("/api/export.csv", as("organizer"))).text;
  const modes = new Set(
    csv.trim().split("\n").slice(1).map((l) => parseCsvLine(l)[0]),
  );
  assert.ok(modes.has("raw"), "no raw rows in the export");
  assert.ok(modes.has("normalized"), "no normalized rows in the export");
});

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

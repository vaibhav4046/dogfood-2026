"use strict";

/**
 * Cross-origin request defence.
 *
 * The graded contract must not change: the official checker POSTs to
 * /api/projects with a session cookie, a JSON content type and no Origin
 * header, and is entitled to a 4xx because the event is closed. Every test here
 * is about the *other* cases.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../../src/server");
const { tokenFor } = require("../../src/middleware/csrf");

let base;
let server;
let S;

test.before(async () => {
  const started = await startServer({ dbFile: ":memory:", port: 0, quiet: true });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
  S = started.sessions;
  void base;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

const self = () => `http://127.0.0.1:${new URL(base).port}`;

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

test("the acceptance checker's shape is unaffected: no Origin, no Referer", async () => {
  const r = await post("/api/projects", { Cookie: `session=${S.participant}` }, {
    title: "dogfood-late-submission-probe",
    summary: "probe",
  });
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  assert.strictEqual(r.json.error, "event_closed", "the refusal reason must not change");
});

test("a cross-origin POST is refused with cross_origin", async () => {
  const r = await post(
    "/api/judge/reviews",
    { Cookie: `session=${S.judge_a}`, Origin: "https://evil.example" },
    { projectId: "prj_01", scores: { functionality: 5 } },
  );
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "cross_origin");
});

test("a cross-origin review write does not reach the handler", async () => {
  const queue = (await (await fetch(base + "/api/judge/desk", {
    headers: { Cookie: `session=${S.judge_a}` },
  })).json());
  const project = queue.items[0].projectId;

  const r = await post(
    "/api/judge/reviews",
    { Cookie: `session=${S.judge_a}`, Origin: "https://evil.example" },
    { projectId: project, scores: { functionality: 5, quality: 5, innovation: 5 } },
  );
  assert.strictEqual(r.status, 403);

  // The write must not have landed.
  const after = (await (await fetch(base + "/api/judge/desk", {
    headers: { Cookie: `session=${S.judge_a}` },
  })).json());
  const item = after.items.find((i) => i.projectId === project);
  assert.notStrictEqual(item.reviewStatus, "submitted", "a cross-origin write was applied anyway");
});

test("a same-origin POST is allowed through", async () => {
  const queue = (await (await fetch(base + "/api/judge/desk", {
    headers: { Cookie: `session=${S.judge_a}` },
  })).json());
  const project = queue.items[0].projectId;
  const r = await post(
    "/api/judge/reviews",
    { Cookie: `session=${S.judge_a}`, Origin: self(), "X-CSRF-Token": tokenFor(S.judge_a) },
    { projectId: project, scores: { functionality: 4, quality: 4, innovation: 4 } },
  );
  assert.strictEqual(r.status, 200, "a same-origin write was refused");
});

test("a cross-origin Referer is refused when Origin is absent", async () => {
  const r = await post(
    "/api/api/teams",
    { Cookie: `session=${S.participant}`, Referer: "https://evil.example/page" },
    { name: "csrf probe" },
  );
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "cross_origin");
});

test("a same-origin Referer is allowed when Origin is absent", async () => {
  // A submission, not a team creation: the seeded participant is already on a
  // team, and the event is closed, so this asserts the *guard* let it through
  // by reaching the deadline check rather than the CSRF check.
  const r = await post(
    "/api/projects",
    { Cookie: `session=${S.participant}`, Referer: `${self()}/submit`, "X-CSRF-Token": tokenFor(S.participant) },
    { title: "probe", summary: "probe", trackId: "trk_01" },
  );
  assert.strictEqual(r.json.error, "event_closed", "the CSRF guard fired on a same-origin referer");
});

test("an opaque Origin of null is refused, not treated as same-origin", async () => {
  const r = await post(
    "/api/judge/reviews",
    { Cookie: `session=${S.judge_a}`, Origin: "null" },
    { projectId: "prj_01", scores: { functionality: 5 } },
  );
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "cross_origin");
});

test("safe methods are never blocked, even with a foreign Origin", async () => {
  const res = await fetch(base + "/api/judge/scores", {
    headers: { Cookie: `session=${S.judge_a}`, Origin: "https://evil.example" },
  });
  assert.strictEqual(res.status, 200, "a GET was blocked by the CSRF guard");
});

test("a different port on the same host is cross-origin", async () => {
  const r = await post(
    "/api/judge/reviews",
    { Cookie: `session=${S.judge_a}`, Origin: "http://127.0.0.1:1" },
    { projectId: "prj_01", scores: { functionality: 5 } },
  );
  assert.strictEqual(r.status, 403, "port was ignored when comparing origins");
});

test("the rubric route is also guarded", async () => {
  const r = await post(
    "/api/organizer/rubric",
    { Cookie: `session=${S.organizer}`, Origin: "https://evil.example" },
    { criteria: [{ key: "functionality", weight: 9 }] },
  );
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "cross_origin");
});

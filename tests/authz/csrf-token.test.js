"use strict";

/**
 * Synchronizer token. A cookie-authenticated write that looks browser-originated
 * (Origin, Referer or Sec-Fetch-Site present) must carry the session-bound token.
 * A request with none of those headers is curl or the official checker and is
 * unchanged.
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
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

async function review(headers) {
  const res = await fetch(base + "/api/judge/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${S.judge_a}`, ...headers },
    body: JSON.stringify({ projectId: "prj_01", scores: { functionality: 4 } }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test("browser-style POST without a token is refused", async () => {
  const r = await review({ Origin: base });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "csrf_token");
});

test("Sec-Fetch-Site alone marks a request as browser-originated", async () => {
  const r = await review({ "Sec-Fetch-Site": "same-origin" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "csrf_token");
});

test("a wrong token is refused, including another session's token", async () => {
  const wrong = await review({ Origin: base, "X-CSRF-Token": "deadbeef" });
  assert.strictEqual(wrong.status, 403);
  const other = await review({ Origin: base, "X-CSRF-Token": tokenFor(S.judge_b) });
  assert.strictEqual(other.status, 403);
  assert.strictEqual(other.json.error, "csrf_token");
});

test("a valid token passes the guard", async () => {
  const r = await review({ Origin: base, "X-CSRF-Token": tokenFor(S.judge_a) });
  assert.notStrictEqual(r.json.error, "csrf_token", "guard refused a valid token");
});

test("a valid token in the _csrf body field passes the guard", async () => {
  const res = await fetch(base + "/api/projects", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `session=${S.participant}`, Origin: base,
    },
    body: new URLSearchParams({ title: "t", summary: "s", trackId: "trk_01", _csrf: tokenFor(S.participant) }),
    redirect: "manual",
  });
  const text = await res.text();
  assert.ok(!/csrf_token/.test(text), `guard refused a valid body token: ${text.slice(0, 200)}`);
});

test("a request with no Origin, Referer or Sec-Fetch-Site passes unchanged", async () => {
  const r = await review({});
  assert.notStrictEqual(r.json.error, "csrf_token");
});

test("authenticated pages expose the token in a meta tag and the form field", async () => {
  const desk = await (await fetch(base + "/judge", { headers: { Cookie: `session=${S.judge_a}` } })).text();
  assert.ok(desk.includes(`<meta name="csrf-token" content="${tokenFor(S.judge_a)}">`));
  const submit = await (await fetch(base + "/submit", { headers: { Cookie: `session=${S.participant}` } })).text();
  assert.ok(submit.includes(`name="_csrf" value="${tokenFor(S.participant)}"`));
  const anon = await (await fetch(base + "/projects")).text();
  assert.ok(!anon.includes("csrf-token"));
});

test("login is not blocked by an existing session cookie", async () => {
  const res = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${S.judge_a}`, Origin: base },
    body: JSON.stringify({ email: "nobody@example.com", password: "x" }),
  });
  assert.strictEqual(res.status, 401);
});

"use strict";

/**
 * Results embargo and review history.
 *
 * Before publish, no scores, rankings, calibration or per-project aggregates
 * reach anyone but an organizer. The single exception is a judge's own raw
 * reviews at /api/judge/scores. After publish, rankings are public and
 * read-only, and reviews are immutable.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../../src/server");

let base;
let server;
let S;
let projectId;
let reviewId;

const as = (who) => ({ Cookie: `session=${S[who]}` });
const post = (p, who, body) =>
  fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...as(who) },
    body: JSON.stringify(body),
  });

test.before(async () => {
  const started = await startServer({ dbFile: ":memory:", port: 0, quiet: true });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
  S = started.sessions;
  const queue = await (await fetch(`${base}/api/judge/desk`, { headers: as("judge_a") })).json();
  projectId = queue.items.find((i) => i.reviewStatus === null).projectId;
  const r = await post("/api/judge/reviews", "judge_a", {
    projectId,
    scores: { functionality: 5, quality: 1, innovation: 4 },
    comment: "first",
    submit: true,
  });
  reviewId = (await r.json()).reviewId;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
});

const WHO = [null, "participant", "judge_a", "judge_b"];
const headers = (who) => (who ? as(who) : {});

test("before publish, /api/results is refused for public, participant and judges", async () => {
  for (const who of WHO) {
    const res = await fetch(`${base}/api/results`, { headers: headers(who) });
    const body = await res.text();
    assert.strictEqual(res.status, 403, `${who}: ${res.status}`);
    assert.ok(!/"rank"|"score"|"raw"|"normalized"/.test(body), `${who} got score fields: ${body}`);
  }
});

test("before publish, the gallery and project page show no review counts", async () => {
  for (const who of WHO) {
    const list = await (await fetch(`${base}/projects`, { headers: headers(who) })).text();
    assert.ok(!/\d+ reviews?\b/.test(list), `${who}: gallery leaks a review count`);
    const page = await (await fetch(`${base}/projects/${projectId}`, { headers: headers(who) })).text();
    assert.ok(!/\d+ reviews?\b|not yet reviewed/.test(page), `${who}: project page leaks a review count`);
  }
});

test("a judge still reads their own raw reviews before publish", async () => {
  const res = await fetch(`${base}/api/judge/scores`, { headers: as("judge_a") });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.scores.some((s) => s.reviewId === reviewId && s.scores.functionality === 5));
});

test("history is append-only and readable by the organizer and the owning judge only", async () => {
  await post("/api/judge/reviews", "judge_a", {
    projectId, scores: { functionality: 2 }, comment: "second", submit: true,
  });
  const org = await (await fetch(`${base}/api/organizer/reviews/${reviewId}/history`, { headers: as("organizer") })).json();
  assert.strictEqual(org.versions.length, 2);
  assert.deepStrictEqual(org.versions.map((v) => v.version), [1, 2]);
  assert.strictEqual(org.versions[0].scores.functionality, 5, "v1 was overwritten");
  assert.strictEqual(org.versions[1].scores.functionality, 2);

  const own = await fetch(`${base}/api/judge/reviews/${reviewId}/history`, { headers: as("judge_a") });
  assert.strictEqual(own.status, 200);
  const peer = await fetch(`${base}/api/judge/reviews/${reviewId}/history`, { headers: as("judge_b") });
  assert.strictEqual(peer.status, 403);
  assert.ok(!(await peer.text()).includes("first"));
  for (const who of [null, "participant", "judge_b"]) {
    const r = await fetch(`${base}/api/organizer/reviews/${reviewId}/history`, { headers: headers(who) });
    assert.ok(r.status === 401 || r.status === 403, `${who}: ${r.status}`);
  }
});

test("the version table refuses UPDATE and DELETE", () => {
  const { openDb, migrate, closeDb } = require("../../src/db");
  const db = openDb(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO review_versions (id,review_id,judge_id,project_id,version,status,scores_json,created_at)
     VALUES ('v','r','j','p',1,'draft','{}','t')`,
  ).run();
  assert.throws(() => db.prepare(`UPDATE review_versions SET status='x'`).run(), /append-only/);
  assert.throws(() => db.prepare(`DELETE FROM review_versions`).run(), /append-only/);
  closeDb(db);
});

test("after publish, rankings are public and reviews are locked with 409", async () => {
  const pub = await post("/api/organizer/publish", "organizer", { mode: "raw" });
  assert.strictEqual(pub.status, 200);

  for (const who of WHO) {
    const res = await fetch(`${base}/api/results`, { headers: headers(who) });
    assert.strictEqual(res.status, 200, `${who}: ${res.status}`);
    const body = await res.json();
    assert.ok(body.raw.length > 0 && body.normalized.length > 0);
    assert.ok(!("judgeStats" in body), "calibration must not be public");
  }

  const edit = await post("/api/judge/reviews", "judge_a", {
    projectId, scores: { functionality: 1 }, comment: "late", submit: true,
  });
  assert.strictEqual(edit.status, 409);
  assert.strictEqual((await edit.json()).error, "review_locked");
  const own = await (await fetch(`${base}/api/judge/scores`, { headers: as("judge_a") })).json();
  assert.strictEqual(own.scores.find((s) => s.reviewId === reviewId).scores.functionality, 2, "locked review changed");
  const hist = await (await fetch(`${base}/api/organizer/reviews/${reviewId}/history`, { headers: as("organizer") })).json();
  assert.strictEqual(hist.versions.length, 2, "a refused edit still appended a version");
});

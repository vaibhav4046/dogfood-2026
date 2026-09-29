"use strict";

/**
 * The audit log is a hash chain. These tests write through the real routes,
 * then edit, delete and insert rows directly in SQLite and require the verify
 * endpoint to name the first broken position. Each tamper runs inside a
 * transaction that is rolled back, so the next case starts from a valid chain.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../../src/server");
const { openDb, migrate } = require("../../src/db");
const { chainExisting, verifyChain, rowHash } = require("../../src/services/audit-chain");

let started;
let base;
let S;
let db;

const as = (who) => ({ Cookie: `session=${S[who]}` });
const verify = async (who = "organizer") => {
  const res = await fetch(`${base}/api/organizer/audit/verify`, { headers: as(who) });
  return { status: res.status, body: await res.json() };
};

async function withTamper(mutate) {
  db.exec("BEGIN");
  try {
    mutate();
    return await verify();
  } finally {
    db.exec("ROLLBACK");
  }
}

test.before(async () => {
  started = await startServer({ dbFile: ":memory:", port: 0, quiet: true });
  base = `http://127.0.0.1:${started.port}`;
  S = started.sessions;
  db = started.db;

  // Real writes through real routes: a judge saves a review, and a refused read.
  const queue = await (await fetch(`${base}/api/judge/desk`, { headers: as("judge_a") })).json();
  const projectId = queue.items.find((i) => i.reviewStatus === null).projectId;
  for (const submit of [false, true]) {
    await fetch(`${base}/api/judge/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...as("judge_a") },
      body: JSON.stringify({
        projectId,
        scores: { functionality: 5, quality: 3, innovation: 4 },
        comment: "chain test",
        submit,
      }),
    });
  }
  await fetch(`${base}/api/organizer/audit`, { headers: as("organizer") });
});

test.after(async () => {
  await new Promise((r) => started.server.close(r));
  started.close();
});

test("chain is valid after seed and route writes, and head matches the last row", async () => {
  const { status, body } = await verify();
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.ok(body.rows >= 3, `expected seed row plus review rows, got ${body.rows}`);
  const last = db.prepare(`SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1`).get();
  assert.strictEqual(body.headHash, last.hash);
  assert.strictEqual(body.firstBrokenIndex, undefined);
});

test("editing one row is reported at that row's index", async () => {
  const target = 1;
  const r = await withTamper(() => {
    const row = db.prepare(`SELECT rowid AS rid FROM audit_events ORDER BY rowid LIMIT 1 OFFSET ?`).get(target);
    db.prepare(`UPDATE audit_events SET actor_role = 'organizer' WHERE rowid = ?`).run(row.rid);
  });
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.firstBrokenIndex, target);
});

test("deleting a middle row is reported at its successor's index", async () => {
  const target = 1;
  const r = await withTamper(() => {
    const row = db.prepare(`SELECT rowid AS rid FROM audit_events ORDER BY rowid LIMIT 1 OFFSET ?`).get(target);
    db.prepare(`DELETE FROM audit_events WHERE rowid = ?`).run(row.rid);
  });
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.firstBrokenIndex, target);
});

test("inserting a row between two others is reported at the insert position", async () => {
  const target = 1;
  const r = await withTamper(() => {
    const before = db.prepare(`SELECT rowid AS rid FROM audit_events ORDER BY rowid LIMIT 1 OFFSET 0`).get();
    // Make room between the two rows, then insert a forged row into the gap.
    db.prepare(`UPDATE audit_events SET rowid = rowid + 1000000 WHERE rowid > ?`).run(before.rid);
    db.prepare(
      `INSERT INTO audit_events (rowid,id,event_id,actor_role,action,target_type,target_id,request_id,created_at,prev_hash,hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(before.rid + 1, "aud_forged", null, "system", "export.csv", "event", null, "req_x", "2026-01-01T00:00:00Z", "", "00");
  });
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.firstBrokenIndex, target);
});

test("a non-organizer gets 403 and no chain data", async () => {
  for (const who of ["judge_a", "judge_b", "participant"]) {
    const { status, body } = await verify(who);
    assert.strictEqual(status, 403, who);
    assert.strictEqual(body.headHash, undefined, who);
  }
  const anon = await fetch(`${base}/api/organizer/audit/verify`);
  assert.ok([401, 403].includes(anon.status), `anonymous got ${anon.status}`);
});

test("the audit page shows chain status, and shows a break", async () => {
  const ok = await (await fetch(`${base}/organizer/audit`, { headers: as("organizer") })).text();
  assert.match(ok, /data-chain="ok"/);
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE audit_events SET action = 'export.csv' WHERE rowid = (SELECT MIN(rowid) FROM audit_events)`).run();
    const bad = await (await fetch(`${base}/organizer/audit`, { headers: as("organizer") })).text();
    assert.match(bad, /data-chain="broken"/);
    assert.match(bad, /broken at row 0/);
  } finally {
    db.exec("ROLLBACK");
  }
});

test("migration step chains pre-existing unchained rows in insertion order", () => {
  const d = openDb(":memory:");
  migrate(d);
  const ins = d.prepare(
    `INSERT INTO audit_events (id,actor_role,action,target_type,request_id,created_at) VALUES (?,?,?,?,?,?)`,
  );
  ins.run("zzz", "system", "export.csv", "event", "r1", "2026-01-01T00:00:00Z");
  ins.run("aaa", "system", "export.csv", "event", "r2", "2026-01-01T00:00:01Z");
  assert.strictEqual(verifyChain(d).ok, false, "unchained rows must not verify");
  chainExisting(d);
  const v = verifyChain(d);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.rows, 2);
  const first = d.prepare(`SELECT * FROM audit_events ORDER BY rowid LIMIT 1`).get();
  assert.strictEqual(first.prev_hash, "");
  assert.strictEqual(first.hash, rowHash("", first));
  d.close();
});

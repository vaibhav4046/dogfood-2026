"use strict";

/**
 * Integration tests: the workflows an organizer and a judge actually perform,
 * end to end over HTTP against a real seeded database.
 *
 * The unit tests cover the mathematics and the authz tests cover the attacks.
 * This file covers the parts in between — that a rubric change actually changes
 * the aggregate, that a second submit updates rather than duplicates, that a
 * fresh volume seeds identically to a restarted one.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const { startServer } = require("../../src/server");
const { openDb, migrate, isEmpty, closeDb, sessionFor } = require("../../src/db");
const { seed, loadFixtures } = require("../../src/db/seed");
const { computeResults } = require("../../src/services/judging");
const { tempDbFile, cleanup } = require("../helpers/tmpdb");

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
  if (server) {
    await new Promise((r) => server.close(r));
    server.close();
  }
});

const as = (who) => ({ Cookie: `session=${S[who]}` });

async function get(p, headers) {
  const res = await fetch(base + p, { headers: headers || {} });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html or csv */
  }
  return { status: res.status, text, json };
}

async function post(p, headers, body) {
  const res = await fetch(base + p, {
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

const judgeId = async (handle) => (await get("/api/judge/scores", as(handle))).json.judge.id;

// --- rubric ----------------------------------------------------------------

test("a rubric weight change moves the aggregate", async () => {
  const before = (await get("/api/organizer/calibration", as("organizer"))).json;

  const r = await post(
    "/api/organizer/rubric",
    as("organizer"),
    { criteria: [{ key: "innovation", weight: 20 }] },
  );
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const after = (await get("/api/organizer/calibration", as("organizer"))).json;
  assert.notDeepStrictEqual(
    after.raw.map((x) => [x.projectId, x.score]),
    before.raw.map((x) => [x.projectId, x.score]),
    "an 18x weight change did not alter any score",
  );
  assert.ok(after.fingerprint !== before.fingerprint, "the fingerprint did not change");
});

test("a zero weight is refused with the field named", async () => {
  const r = await post(
    "/api/organizer/rubric",
    as("organizer"),
    { criteria: [{ key: "quality", weight: 0 }] },
  );
  assert.strictEqual(r.status, 400);
  assert.ok(r.json.fields.quality, "the offending criterion was not named");
  assert.match(r.json.fields.quality, /zero/i);
});

test("a negative weight is refused", async () => {
  const r = await post("/api/organizer/rubric", as("organizer"), {
    criteria: [{ key: "quality", weight: -1 }],
  });
  assert.strictEqual(r.status, 400);
});

test("a criterion that does not exist is refused, not created", async () => {
  const r = await post("/api/organizer/rubric", as("organizer"), {
    criteria: [{ key: "vibes", weight: 5 }],
  });
  assert.strictEqual(r.status, 400);
  assert.ok(r.json.fields.vibes);
});

test("an inverted score range is refused", async () => {
  const r = await post("/api/organizer/rubric", as("organizer"), {
    criteria: [{ key: "functionality", min: 5, max: 1 }],
  });
  assert.strictEqual(r.status, 400);
});

test("an empty rubric update is refused rather than zeroing every criterion", async () => {
  const r = await post("/api/organizer/rubric", as("organizer"), { criteria: [] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, "empty_rubric");
});

// --- review lifecycle ------------------------------------------------------

test("a judge submitting twice updates the review instead of duplicating it", async () => {
  const queue = (await get("/api/judge/desk", as("judge_a"))).json;
  const project = queue.items[0].projectId;

  const first = await post("/api/judge/reviews", as("judge_a"), {
    projectId: project,
    scores: { functionality: 2, quality: 2, innovation: 2 },
    submit: true,
  });
  assert.strictEqual(first.status, 200);
  const firstId = first.json.reviewId;

  const second = await post("/api/judge/reviews", as("judge_a"), {
    projectId: project,
    scores: { functionality: 5, quality: 5, innovation: 5 },
    submit: true,
  });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.json.reviewId, firstId, "a second review row was created");

  const desk = (await get("/api/judge/desk", as("judge_a"))).json;
  const item = desk.items.find((i) => i.projectId === project);
  assert.strictEqual(item.scores.functionality, 5, "the second submit did not overwrite");
  assert.strictEqual(desk.total, queue.total, "the queue grew by a duplicate");
});

test("a draft autosave is not counted as a completed review", async () => {
  const queue = (await get("/api/judge/desk", as("judge_b"))).json;
  const project = queue.items.find((i) => i.reviewStatus === null).projectId;

  const before = (await get("/api/organizer/calibration", as("organizer"))).json.coverage
    .completedReviews;
  const r = await post("/api/judge/reviews", as("judge_b"), {
    projectId: project,
    scores: { functionality: 4, quality: 4, innovation: 4 },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.status, "draft");

  const after = (await get("/api/organizer/calibration", as("organizer"))).json.coverage
    .completedReviews;
  assert.strictEqual(after, before, "a draft was counted as a completed review");
});

test("a submitted review does move the aggregate", async () => {
  const queue = (await get("/api/judge/desk", as("judge_b"))).json;
  const project = queue.items.find((i) => i.reviewStatus === null).projectId;
  await post("/api/judge/reviews", as("judge_b"), {
    projectId: project,
    scores: { functionality: 5, quality: 5, innovation: 5 },
    submit: true,
  });
  const row = (await get("/api/organizer/calibration", as("organizer"))).json.projects.find(
    (p) => p.projectId === project,
  );
  assert.ok(row, "the newly reviewed project is missing from the results");
  assert.ok(row.raw.reviewCount >= 1, "review count did not increase");
});

// --- assignment ------------------------------------------------------------

test("an assignment outside the judge's tracks is skipped, not created", async () => {
  const all = (await get("/api/projects")).json.projects;
  // judge_a is eligible for trk_01..trk_03 only.
  const foreign = all.find((p) => ["trk_05", "trk_06", "trk_07", "trk_08"].includes(p.trackId));
  assert.ok(foreign, "expected a project in an ineligible track");

  const r = await post("/api/organizer/assignments", as("organizer"), {
    judgeId: await judgeId("judge_a"),
    projectIds: [foreign.id],
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.created.length, 0, "an ineligible assignment was created");
  assert.strictEqual(r.json.skipped[0].reason, "judge_not_eligible_for_track");
});

test("assigning an unknown judge is refused", async () => {
  const r = await post("/api/organizer/assignments", as("organizer"), {
    judgeId: "usr_nope",
    projectIds: ["prj_01"],
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, "unknown_judge");
});

test("a participant cannot create assignments", async () => {
  const r = await post("/api/organizer/assignments", as("participant"), {
    judgeId: await judgeId("judge_a"),
    projectIds: ["prj_01"],
  });
  assert.ok(r.status === 401 || r.status === 403);
});

test("a judge cannot create assignments even with an organizer body", async () => {
  const r = await post("/api/organizer/assignments", as("judge_a"), {
    role: "organizer",
    judgeId: await judgeId("judge_b"),
    projectIds: ["prj_01"],
  });
  assert.ok(r.status === 401 || r.status === 403);
});

// --- publish ---------------------------------------------------------------

test("publishing records the mode and the fingerprint in the audit log", async () => {
  const r = await post("/api/organizer/publish", as("organizer"), { mode: "normalized" });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.fingerprint, "no fingerprint returned");
  assert.strictEqual(r.json.mode, "normalized");

  const audit = (await get("/api/organizer/audit", as("organizer"))).json.events;
  const row = audit.find((a) => a.action === "results.published");
  assert.ok(row, "no results.published row in the audit log");
  assert.ok(
    row.new_state.includes(r.json.fingerprint),
    "the audit row does not carry the fingerprint",
  );
});

test("both result modes are persisted and readable independently", async () => {
  const cal = (await get("/api/organizer/calibration", as("organizer"))).json;
  assert.ok(cal.raw.length > 0, "no raw rows");
  assert.ok(cal.normalized.length > 0, "no normalized rows");
  assert.strictEqual(
    cal.raw.length,
    cal.normalized.length,
    "the two rankings disagree on project count",
  );
});

// --- data integrity --------------------------------------------------------

test("the fixture duplicate is surfaced, not silently merged", async () => {
  const controlRoom = (await get("/organizer", as("organizer"))).text;
  assert.ok(
    controlRoom.includes("duplicate live submission"),
    "the Control Room does not mention the duplicate",
  );
  const csv = (await get("/api/export.csv", as("organizer"))).text;
  const ids = csv.split("\n").slice(1).map((l) => l.split(",")[2]);
  assert.ok(ids.includes("prj_07"), "prj_07 is missing from the export");
  assert.ok(ids.includes("prj_41"), "prj_41 is missing from the export");
});

// --- restart, fresh volume, migrations, constraints ------------------------

test("a restart against an existing database reuses it and does not re-seed", async () => {
  const { dir, file } = tempDbFile("dogfood-restart-");
  try {
    const first = await startServer({ dbFile: file, port: 0, quiet: true });
    const firstSeeded = first.seedReport.counts.projects;
    const firstTokens = { ...first.sessions };
    await new Promise((r) => first.server.close(r));
    first.close();

    const second = await startServer({ dbFile: file, port: 0, quiet: true });
    try {
      assert.strictEqual(second.seedReport, null, "the second boot re-seeded an existing database");
      const count = (await (await fetch(`http://127.0.0.1:${second.port}/api/projects`)).json()).count;
      assert.strictEqual(count, firstSeeded, "the project count changed across a restart");
      for (const k of Object.keys(firstTokens)) {
        assert.strictEqual(second.sessions[k], firstTokens[k], `session ${k} changed across a restart`);
      }
    } finally {
      await new Promise((r) => second.server.close(r));
      second.close();
    }
  } finally {
    cleanup(dir);
  }
});

test("a fresh volume seeds to exactly the same state as another fresh volume", () => {
  const { dir } = tempDbFile("dogfood-fresh-");
  let dbA;
  let dbB;
  try {
    const a = seedFresh(path.join(dir, "a.db"), (d) => {
      dbA = d;
    });
    const b = seedFresh(path.join(dir, "b.db"), (d) => {
      dbB = d;
    });
    assert.strictEqual(a.counts.projects, b.counts.projects);
    assert.strictEqual(a.counts.reviews, b.counts.reviews);
    assert.strictEqual(a.counts.assignments, b.counts.assignments);
    assert.strictEqual(a.fingerprint, b.fingerprint, "two fresh volumes produced different results");
    assert.deepStrictEqual(a.sessions, b.sessions, "two fresh volumes produced different sessions");
  } finally {
    closeDb(dbA);
    closeDb(dbB);
    cleanup(dir);
  }
});

function seedFresh(file, onOpen) {
  const db = openDb(file);
  onOpen(db);
  migrate(db);
  const report = seed(db, { fixtures: loadFixtures() });
  const results = computeResults(db);
  return {
    counts: report.counts,
    fingerprint: results.fingerprint,
    sessions: Object.fromEntries(
      ["organizer", "judge_a", "judge_b", "participant"].map((k) => [k, sessionFor(k)]),
    ),
  };
}

test("migrations are idempotent and record themselves", () => {
  const { dir, file } = tempDbFile("dogfood-mig-");
  let db;
  try {
    db = openDb(file);
    const first = migrate(db);
    const second = migrate(db);

    // The invariant, not a hardcoded list. This test used to assert exactly
    // ["001_core"] and failed the moment the real-auth migrations were added,
    // which is the wrong thing for it to care about: adding a migration is the
    // normal way this schema grows. What has to hold is that the core migration
    // is present, that a second run applies nothing, and that every row the
    // first run claimed to apply is actually recorded.
    assert.ok(first.includes("001_core"), `001_core missing from ${JSON.stringify(first)}`);
    assert.ok(first.length > 0, "the first migrate applied nothing");
    assert.deepStrictEqual(second, [], "a second migrate re-applied a migration");

    const recorded = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((r) => r.id);
    assert.deepStrictEqual(
      recorded.slice().sort(),
      first.slice().sort(),
      "schema_migrations does not match what the first migrate reported",
    );
  } finally {
    cleanup(dir, db);
  }
});

test("foreign keys are enforced, not merely declared", () => {
  const { dir, file } = tempDbFile("dogfood-fk-");
  let db;
  try {
    db = openDb(file);
    migrate(db);
    seed(db, { fixtures: loadFixtures() });
    assert.strictEqual(db.pragma("foreign_keys", { simple: true }), 1, "foreign_keys is OFF");

    // Every NOT NULL column is supplied, so the statement reaches the foreign
    // key check and the failure proves the REFERENCES clause is live. An
    // earlier version omitted them and got SQLITE_CONSTRAINT_NOTNULL, which is
    // a *different* constraint passing — the assertion would have been testing
    // nothing about referential integrity.
    const insert = db.prepare(
      `INSERT INTO reviews
         (id,assignment_id,judge_id,project_id,status,comment,updated_at)
       VALUES (?,?,?,?,'draft','',?)`,
    );
    const now = "2026-01-01T00:00:00.000Z";

    assert.throws(
      () => insert.run("x", "no_such_assignment", "no_such_judge", "no_such_project", now),
      /FOREIGN KEY/,
      "a review with three dangling references was accepted",
    );

    // A real assignment with a bogus project still fails: one bad reference is
    // enough. This one has to use an assignment with no review yet, because
    // SQLite checks UNIQUE before FOREIGN KEY and every fixture assignment
    // already has a review — the earlier version hit
    // SQLITE_CONSTRAINT_UNIQUE and proved nothing about references.
    const spare = db
      .prepare(
        `SELECT a.id AS assignment_id, a.judge_id FROM assignments a
          LEFT JOIN reviews r ON r.assignment_id = a.id
          WHERE r.id IS NULL LIMIT 1`,
      )
      .get();
    assert.ok(spare, "expected an assignment with no review in the fixtures");
    assert.throws(
      () => insert.run("y", spare.assignment_id, spare.judge_id, "no_such_project", now),
      /FOREIGN KEY/,
      "a review with a real assignment but a bogus project was accepted",
    );

    // A valid row is accepted, so the constraint is not simply rejecting
    // everything — which is what makes the two assertions above meaningful.
    const project = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
    assert.doesNotThrow(
      () => insert.run("z", spare.assignment_id, spare.judge_id, project, now),
      "a valid review row was rejected",
    );
  } finally {
    cleanup(dir, db);
  }
});

test("an empty database is detected as empty and a seeded one is not", () => {
  const { dir, file } = tempDbFile("dogfood-empty-");
  let db;
  try {
    db = openDb(file);
    migrate(db);
    assert.strictEqual(isEmpty(db), true);
    seed(db, { fixtures: loadFixtures() });
    assert.strictEqual(isEmpty(db), false);
  } finally {
    cleanup(dir, db);
  }
});

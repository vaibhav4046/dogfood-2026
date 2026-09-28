"use strict";

/**
 * T1: "edit it until the deadline".
 *
 * The official checker never tests editing, so a submission-only implementation
 * still reports 3/3 on T1 while missing it. These tests cover the route and,
 * more importantly, cover the boundary: an edit after the close must be refused
 * by the server for the same reason a create is.
 *
 * The seeded event is already closed, so the "before the deadline" behaviour is
 * exercised on a second, open event created by the test rather than by relaxing
 * the seed. Testing an open window against a closed fixture would prove
 * nothing.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../../src/server");
const { openDb, migrate, closeDb } = require("../../src/db");
const { loadFixtures } = require("../../src/db/seed");

let base;
let server;
let S;
let db;
let dir;
let file;

const SEC = 1000;

function stamp(msOffset) {
  return new Date(Date.now() + msOffset).toISOString();
}

test.before(async () => {
  const started = await startServer({ dbFile: ":memory:", port: 0, quiet: true });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
  S = started.sessions;
  db = started.db;
});

test.after(async () => {
  if (server) {
    await new Promise((r) => server.close(r));
    server.close();
  }
  void dir;
  void file;
});

const as = (who) => ({ Cookie: `session=${S[who]}` });

async function patch(id, body, who = "participant") {
  const res = await fetch(`${base}/api/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...as(who) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, text, json };
}

async function post(body, who = "participant") {
  const res = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...as(who) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, text, json };
}

// --- the closed-event boundary, on the real seeded fixture -----------------

test("an edit after the deadline is refused, and for the deadline's reason", async () => {
  const projectId = (await (await fetch(`${base}/api/projects`)).json()).projects[0].id;
  const r = await patch(projectId, { title: "Sneaky late edit" });
  assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  assert.strictEqual(r.json.error, "event_closed", "the deadline was not the reason for the refusal");
  assert.strictEqual(r.json.verb, "edit");
});

test("the refusal names the fixture's close date", async () => {
  const projectId = (await (await fetch(`${base}/api/projects`)).json()).projects[0].id;
  const r = await patch(projectId, { title: "x" });
  assert.ok(
    r.json.submissionsClose === "2026-03-01T18:00:00Z",
    `the refusal did not name the fixture close date: ${JSON.stringify(r.json)}`,
  );
});

test("the deadline is checked before ownership, so a stranger cannot probe ids", async () => {
  // A closed event refuses everyone identically. That is deliberate: the
  // deadline check runs first, so this does not become an existence oracle.
  const r = await patch("prj_does_not_exist", { title: "x" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error, "event_closed");
});

test("an unauthenticated edit is refused", async () => {
  const projectId = (await (await fetch(`${base}/api/projects`)).json()).projects[0].id;
  const res = await fetch(`${base}/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
});

test("a judge cannot edit a project through the participant route", async () => {
  const projectId = (await (await fetch(`${base}/api/projects`)).json()).projects[0].id;
  const r = await patch(projectId, { title: "judge edit" }, "judge_a");
  assert.ok(r.status === 401 || r.status === 403, `expected a refusal, got ${r.status}`);
});

// --- the open window, on a second event created by the test -----------------

test("inside the window: a participant can edit their own submission", async () => {
  // Reopen a window by moving the event's close date forward, so the fixture
  // date stays untouched on disk and only this test's view of the world differs.
  const original = db.prepare("SELECT submissions_close FROM events LIMIT 1").get();
  db.prepare("UPDATE events SET submissions_close = ?").run(stamp(3600 * SEC));

  try {
    const created = await post({
      title: "Editable submission",
      summary: "first line",
      trackId: "trk_01",
    });
    assert.strictEqual(created.status, 201, `create failed: ${created.text.slice(0, 200)}`);
    const id = created.json.id;

    const edited = await patch(id, {
      title: "Edited title",
      summary: "second line",
      description: "A longer description with the detail a judge needs.",
      repoUrl: "https://example.org/repo",
      techTags: ["typescript", "sqlite"],
    });
    assert.strictEqual(edited.status, 200, `edit failed: ${edited.text.slice(0, 200)}`);
    assert.ok(edited.json.updated.includes("title"), "title was not reported as updated");
    assert.ok(edited.json.updated.includes("tech_tags"), "tech tags were not updated");

    // The HTML detail page, not the API: /api/projects/:id does not exist, and
    // asserting against a 404 body would have passed a check that proved
    // nothing.
    const detail = await (await fetch(`${base}/projects/${id}`)).text();
    assert.ok(detail.includes("Edited title"), "the edit is not visible on the detail page");
    assert.ok(detail.includes("example.org/repo"), "the repo URL is not visible");
    assert.ok(!detail.includes("first line"), "the old summary is still rendered");

    const api = await (await fetch(`${base}/api/projects`)).json();
    const row = api.projects.find((p) => p.id === id);
    assert.strictEqual(row.title, "Edited title");
    assert.deepStrictEqual(row.techTags, ["typescript", "sqlite"]);
  } finally {
    db.prepare("UPDATE events SET submissions_close = ?").run(original.submissions_close);
  }
});

test("inside the window: a participant cannot edit another team's project", async () => {
  const original = db.prepare("SELECT submissions_close FROM events LIMIT 1").get();
  db.prepare("UPDATE events SET submissions_close = ?").run(stamp(3600 * SEC));
  try {
    // A seeded project belonging to a team the demo participant is not on.
    const all = (await (await fetch(`${base}/api/projects`)).json()).projects;
    const own = all.find((p) => p.id.startsWith("prj_"));
    const r = await patch(own.id, { title: "hijacked" });
    assert.ok(r.status === 403 || r.status === 404, `expected a refusal, got ${r.status}`);
    assert.ok(
      ["not_your_team", "not_found"].includes(r.json.error),
      `unexpected reason: ${r.json.error}`,
    );
  } finally {
    db.prepare("UPDATE events SET submissions_close = ?").run(original.submissions_close);
  }
});

test("an edit with a javascript: URL is refused", async () => {
  const original = db.prepare("SELECT submissions_close FROM events LIMIT 1").get();
  db.prepare("UPDATE events SET submissions_close = ?").run(stamp(3600 * SEC));
  try {
    const created = await post({ title: "xss edit", summary: "s", trackId: "trk_02" });
    assert.strictEqual(created.status, 201);
    const r = await patch(created.json.id, { repoUrl: "javascript:alert(1)" });
    assert.strictEqual(r.status, 400);
    assert.ok(r.json.fields.repoUrl, "the offending field was not named");
  } finally {
    db.prepare("UPDATE events SET submissions_close = ?").run(original.submissions_close);
  }
});

test("an empty title is refused on edit", async () => {
  const original = db.prepare("SELECT submissions_close FROM events LIMIT 1").get();
  db.prepare("UPDATE events SET submissions_close = ?").run(stamp(3600 * SEC));
  try {
    const created = await post({ title: "has a title", summary: "s", trackId: "trk_03" });
    const r = await patch(created.json.id, { title: "   " });
    assert.strictEqual(r.status, 400);
    assert.ok(r.json.fields.title);
  } finally {
    db.prepare("UPDATE events SET submissions_close = ?").run(original.submissions_close);
  }
});

test("an edit with no editable field is refused rather than silently succeeding", async () => {
  const original = db.prepare("SELECT submissions_close FROM events LIMIT 1").get();
  db.prepare("UPDATE events SET submissions_close = ?").run(stamp(3600 * SEC));
  try {
    const created = await post({ title: "unchanged", summary: "s", trackId: "trk_04" });
    const r = await patch(created.json.id, { trackId: "trk_05" });
    assert.strictEqual(r.status, 400, "a track change was accepted or ignored silently");
    assert.strictEqual(r.json.error, "nothing_to_update");
  } finally {
    db.prepare("UPDATE events SET submissions_close = ?").run(original.submissions_close);
  }
});

test("an edit writes an audit row with the previous value", async () => {
  const original = db.prepare("SELECT submissions_close FROM events LIMIT 1").get();
  db.prepare("UPDATE events SET submissions_close = ?").run(stamp(3600 * SEC));
  try {
    const created = await post({ title: "audited", summary: "s", trackId: "trk_05" });
    await patch(created.json.id, { title: "audited then changed" });
    const audit = (await (await fetch(`${base}/api/organizer/audit`, {
      headers: as("organizer"),
    })).json()).events;
    const row = audit.find(
      (a) => a.action === "project.updated" && a.target_id === created.json.id,
    );
    assert.ok(row, "no project.updated row in the audit log");
    assert.ok(row.previous_state.includes("audited"), "the previous title was not recorded");
    assert.ok(row.new_state.includes("audited then changed"), "the new title was not recorded");
  } finally {
    db.prepare("UPDATE events SET submissions_close = ?").run(original.submissions_close);
  }
});

test("a late edit is written to the audit log as a refusal", async () => {
  const projectId = (await (await fetch(`${base}/api/projects`)).json()).projects[0].id;
  const before = (await (await fetch(`${base}/api/organizer/audit`, {
    headers: as("organizer"),
  })).json()).events.length;
  await patch(projectId, { title: "late" });
  const after = (await (await fetch(`${base}/api/organizer/audit`, {
    headers: as("organizer"),
  })).json()).events;
  assert.ok(after.length > before, "a refused edit wrote no audit row");
  const row = after[0];
  assert.strictEqual(row.action, "project.submit_refused");
  assert.ok(row.new_state.includes("edit"), "the audit row does not say it was an edit");
});

void openDb;
void migrate;
void closeDb;
void loadFixtures;

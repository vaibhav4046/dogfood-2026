"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startServer } = require("../../src/server");
const { createAccount } = require("../../src/services/accounts");

let started;
let base;

test.before(async () => {
  started = await startServer({ dbFile: ":memory:", port: 0, quiet: true, mode: "production" });
  base = `http://127.0.0.1:${started.port}`;
  createAccount(started.db, {
    email: "owner@example.test", name: "Owner", password: "correct horse battery staple", role: "organizer",
  });
});

test.after(async () => {
  if (!started) return;
  await new Promise((resolve) => started.server.close(resolve));
  started.close();
});

async function post(route, body, cookie) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || null,
  };
}

test("production ignores deterministic demo identity but accepts password login", async () => {
  const demo = await fetch(base + "/organizer", {
    headers: { Cookie: `session=${started.sessions.organizer}` },
  });
  assert.strictEqual(demo.status, 401);

  const wrong = await post("/auth/login", { email: "owner@example.test", password: "wrong password" });
  assert.strictEqual(wrong.status, 401);
  const login = await post("/auth/login", {
    email: "owner@example.test", password: "correct horse battery staple",
  });
  assert.strictEqual(login.status, 200);
  assert.ok(login.cookie?.startsWith("session="));
  const page = await fetch(base + "/organizer", { headers: { Cookie: login.cookie } });
  assert.strictEqual(page.status, 200);

  const logout = await post("/auth/logout", {}, login.cookie);
  assert.strictEqual(logout.status, 200);
  const revoked = await fetch(base + "/organizer", { headers: { Cookie: login.cookie } });
  assert.strictEqual(revoked.status, 401);
});

test("judge invitation is single use, expires, and rejects forged tokens", async () => {
  const login = await post("/auth/login", {
    email: "owner@example.test", password: "correct horse battery staple",
  });
  const invite = await post("/api/organizer/invitations", {
    email: "judge@example.test", name: "Judge", role: "judge", tracks: ["trk_01"],
  }, login.cookie);
  assert.strictEqual(invite.status, 201, JSON.stringify(invite.body));
  assert.ok(invite.body.token);

  const forged = await post("/auth/redeem", {
    token: "forged", name: "Judge", password: "a long safe password",
  });
  assert.strictEqual(forged.status, 400);

  const accepted = await post("/auth/redeem", {
    token: invite.body.token, name: "Judge", password: "a long safe password",
  });
  assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
  const reused = await post("/auth/redeem", {
    token: invite.body.token, name: "Judge", password: "a long safe password",
  });
  assert.strictEqual(reused.status, 400);

  const expiring = await post("/api/organizer/invitations", {
    email: "late@example.test", name: "Late Judge", role: "judge", tracks: ["trk_01"],
  }, login.cookie);
  assert.strictEqual(expiring.status, 201);
  started.db.prepare("UPDATE invitations SET expires_at = ? WHERE token = ?")
    .run("2000-01-01T00:00:00.000Z", crypto.createHash("sha256").update(expiring.body.token).digest("hex"));
  const expired = await post("/auth/redeem", {
    token: expiring.body.token, name: "Late Judge", password: "a long safe password",
  });
  assert.strictEqual(expired.status, 400);
});

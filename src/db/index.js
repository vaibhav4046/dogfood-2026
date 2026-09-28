"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const { migrate } = require("./migrations");

/**
 * Open (or create) the SQLite database, run migrations, and turn on the
 * pragmas that make a file-backed SQLite behave like a server.
 *
 * WAL is what lets the Judge Desk autosave while a judge is reading the
 * gallery. `foreign_keys` is OFF by default in SQLite, which would silently
 * make every REFERENCES clause in the schema decorative.
 */

function openDb(file) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function isEmpty(db) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM events`).get();
  return row.n === 0;
}

/**
 * Deterministic ids and tokens.
 *
 * The acceptance suite needs four identities whose headers are known before it
 * runs, and the spec's own story is that a judge copies them out of startup
 * output. Deriving them from a fixed seed means a fresh volume and a wiped
 * volume produce the *same* logins, so a rerun after `docker compose down -v`
 * still passes. Real randomness here would make acceptance flaky for no
 * benefit — these are development fixtures, not production accounts.
 */
const SEED = "dogfood-2026-v1";

function idFor(kind, n) {
  const h = crypto.createHash("sha256").update(`${SEED}:${kind}:${n}`).digest("hex");
  return `${kind}_${h.slice(0, 10)}`;
}

function sessionFor(role) {
  const h = crypto.createHash("sha256").update(`${SEED}:session:${role}`).digest("hex");
  return `ses_${h.slice(0, 16)}`;
}

module.exports = { openDb, migrate, isEmpty, idFor, sessionFor, SEED };

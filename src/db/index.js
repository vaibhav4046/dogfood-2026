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

/**
 * Close a database and clear its write-ahead log.
 *
 * `db.close()` alone is not enough on Windows: the -wal and -shm sidecar files
 * stay locked for a moment afterwards, so anything that then tries to delete the
 * directory — a test teardown, a `docker compose down -v` equivalent, an
 * operator clearing scratch state — fails with EPERM. Checkpointing and closing
 * explicitly, then unlinking the sidecars, makes the file removable
 * immediately.
 */
function closeDb(db) {
  if (!db || !db.open) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* a read-only or already-closed handle has nothing to checkpoint */
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

/** Remove a database's files, retrying briefly for the Windows lock release. */
function removeDbFiles(file) {
  if (file === ":memory:") return;
  const targets = [file, `${file}-wal`, `${file}-shm`];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      for (const t of targets) fs.rmSync(t, { force: true });
      return true;
    } catch {
      sleepSync(40);
    }
  }
  for (const t of targets) fs.rmSync(t, { force: true });
  return true;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin briefly; this only runs in teardown */
  }
}

module.exports = { openDb, migrate, isEmpty, idFor, sessionFor, SEED, closeDb, removeDbFiles };

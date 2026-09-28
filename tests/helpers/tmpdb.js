"use strict";

/**
 * Test teardown that works on Windows.
 *
 * `fs.rmSync(dir, { recursive: true })` on a directory that held a SQLite
 * database fails with EPERM, because the -wal and -shm sidecar files stay
 * locked for a moment after `db.close()` even on a successful checkpoint. Every
 * test here that touches the filesystem goes through this instead, and the
 * retry is silent — a locked file during teardown is an environment quirk, not
 * a product defect, and a failing test would misattribute it to one.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { closeDb } = require("../../src/db");

function tempDbFile(prefix = "dogfood-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, file: path.join(dir, "d.db") };
}

function cleanup(dir, db) {
  if (db) {
    try {
      closeDb(db);
    } catch {
      /* already closed */
    }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // The Windows lock on the WAL sidecars takes a few ms to release.
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* brief spin */
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { tempDbFile, cleanup };

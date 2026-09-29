"use strict";

const crypto = require("crypto");

/**
 * Hash chain over audit_events.
 *
 * hash = sha256(prev_hash + canonicalJson(row fields except prev_hash/hash)).
 * The first row's prev_hash is the empty string. Rows are chained in rowid
 * order, which is insertion order (the ids are random, so id order is not).
 *
 * Detects: an edited row, a deleted row that has a successor, an inserted row.
 * Does not detect: deleting the newest rows, or recomputing the whole chain
 * with direct database access. Record headHash somewhere the database owner
 * cannot write to if either matters.
 */

const FIELDS = [
  "id", "event_id", "actor_id", "actor_role", "action", "target_type",
  "target_id", "previous_state", "new_state", "request_id", "created_at",
];

function canonicalJson(row) {
  const out = {};
  for (const k of [...FIELDS].sort()) out[k] = row[k] === undefined ? null : row[k];
  return JSON.stringify(out);
}

function rowHash(prevHash, row) {
  return crypto.createHash("sha256").update(prevHash + canonicalJson(row)).digest("hex");
}

function headHash(db) {
  const r = db.prepare(`SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1`).get();
  return r && r.hash ? r.hash : "";
}

/** Insert one audit row and chain it. Returns false if the id already existed. */
function appendRow(db, row, { orIgnore = false } = {}) {
  const prev = headHash(db);
  const info = db
    .prepare(
      `INSERT ${orIgnore ? "OR IGNORE " : ""}INTO audit_events
        (id,event_id,actor_id,actor_role,action,target_type,target_id,
         previous_state,new_state,request_id,created_at,prev_hash,hash)
       VALUES (@id,@event_id,@actor_id,@actor_role,@action,@target_type,@target_id,
         @previous_state,@new_state,@request_id,@created_at,@prev_hash,@hash)`,
    )
    .run({ ...row, prev_hash: prev, hash: rowHash(prev, row) });
  return info.changes === 1;
}

/** Migration step: chain every existing row in rowid order. */
function chainExisting(db) {
  const rows = db.prepare(`SELECT rowid AS rid, * FROM audit_events ORDER BY rowid`).all();
  const upd = db.prepare(`UPDATE audit_events SET prev_hash = ?, hash = ? WHERE rowid = ?`);
  let prev = "";
  for (const r of rows) {
    const h = rowHash(prev, r);
    upd.run(prev, h, r.rid);
    prev = h;
  }
}

/** Walk the chain. firstBrokenIndex is the 0-based position of the first bad row. */
function verifyChain(db) {
  const rows = db.prepare(`SELECT * FROM audit_events ORDER BY rowid`).all();
  let prev = "";
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.prev_hash !== prev || r.hash !== rowHash(prev, r)) {
      return { ok: false, rows: rows.length, headHash: headHash(db), firstBrokenIndex: i };
    }
    prev = r.hash;
  }
  return { ok: true, rows: rows.length, headHash: prev };
}

module.exports = { FIELDS, canonicalJson, rowHash, headHash, appendRow, chainExisting, verifyChain };

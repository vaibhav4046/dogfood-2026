"use strict";

/**
 * Append-only migration: hash-chain columns on audit_events. `up` runs after
 * `sql` in the same transaction and chains any rows that already exist.
 */

const { chainExisting } = require("../services/audit-chain");

module.exports = [
  {
    id: "audit_001_hash_chain",
    sql: `
      ALTER TABLE audit_events ADD COLUMN prev_hash TEXT;
      ALTER TABLE audit_events ADD COLUMN hash TEXT;
    `,
    up: chainExisting,
  },
];

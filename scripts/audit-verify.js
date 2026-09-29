"use strict";

/**
 * Verify the audit hash chain in the database named by DOGFOOD_DB.
 * Exit 0 if intact, 1 if broken, 2 if the file cannot be opened.
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { verifyChain } = require("../src/services/audit-chain");

const file = process.env.DOGFOOD_DB || path.join(__dirname, "..", "data", "dogfood.db");
if (!fs.existsSync(file)) {
  process.stderr.write(`audit:verify: no database at ${file}\n`);
  process.exit(2);
}
const db = new Database(file, { readonly: true });
const result = verifyChain(db);
db.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);

"use strict";

/**
 * Proves the surface sweep is not vacuous.
 *
 * Restores the exact leak the red team found — GET /api/organizer/results,
 * guarded by requireJudgingStaff, returning every judge's statistics with no
 * identity filter — runs the sweep, and reports whether it caught it. The file
 * is restored byte-for-byte afterwards.
 *
 *   node /tmp/reintroduce-leak.js
 *
 * A test suite that has never been shown to fail is not evidence.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(ROOT, "src", "routes", "judge.js");

const LEAK = `
  app.get("/api/organizer/results", requireJudgingStaff, (req, res) => {
    const { computeResults } = require("../services/judging");
    res.json(computeResults(db));
  });
`;

function main() {
  const original = fs.readFileSync(TARGET, "utf8");
  const anchor = "    res.json({ ok: true, reviewId, status, savedAt: now });\n  });\n}";
  const idx = original.indexOf(anchor);
  if (idx === -1) {
    const alt = original.indexOf("    res.json({ ok: true, reviewId, status, savedAt: now });\r\n  });\r\n}");
    if (alt === -1) {
      console.error("could not find the anchor; refusing to guess");
      process.exit(2);
    }
  }
  const patched = original.replace(anchor, anchor.replace("\n}", LEAK + "}"));
  fs.writeFileSync(TARGET, patched);

  let failed = false;
  try {
    const run = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=spec", "tests/authz/surface-sweep.test.js"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const lines = out
      .split("\n")
      .filter((l) => /^(✔|✖)|read judge_a|severity statistics/.test(l.trim()));
    for (const l of lines) console.log(l);
    const caught = /read judge_a's review through|severity statistics from|✖/.test(out);
    failed = !caught;
    console.log(
      caught
        ? "\nRESULT: the sweep CAUGHT the reintroduced leak."
        : "\nRESULT: the sweep did NOT catch it. The test is vacuous and must be fixed.",
    );
  } finally {
    fs.writeFileSync(TARGET, original, "utf8");
    console.log(`restored ${TARGET} (${original.length} bytes)`);
  }
  process.exitCode = failed ? 1 : 0;
}

main();

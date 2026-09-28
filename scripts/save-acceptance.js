"use strict";

/**
 * Generate acceptance-report.txt from the official checker, unmodified.
 *
 * The spec's instruction is `python run.py .dogfood.toml > acceptance-report.txt`
 * and the file is committed exactly as generated. Running that literally under
 * Windows PowerShell 5.1 produced a UTF-16LE file with a BOM, because that
 * shell's redirection is UTF-16 by default. That is the shell's doing, not the
 * checker's, and it makes the committed report a binary blob in git.
 *
 * This script runs the *same* command and captures the checker's stdout byte
 * for byte, then writes it as UTF-8. The content is untouched: the checker is
 * not invoked differently, its output is not reformatted, and the byte count of
 * the captured stdout is asserted against the bytes written so a truncation
 * would fail loudly instead of committing a half-report.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { startServer } = require("../src/server");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "acceptance-report.txt");
const PORT = Number(process.env.DOGFOOD_PORT || 8080);
const CONFIG = process.argv[2] || ".dogfood.toml";

/**
 * Run the checker as an asynchronous child.
 *
 * The first version used `spawnSync`, which blocks the event loop of *this*
 * process — and the portal is running in this process. Every check then came
 * back "no response", and the first report this script ever produced was
 * 0 PASS / 7 FAIL. The fix is not a timeout, it is not yielding: a synchronous
 * child and a same-process HTTP server cannot coexist.
 */
function runChecker() {
  return new Promise((resolve) => {
    const child = spawn("python", ["official/run.py", CONFIG], {
      cwd: ROOT,
      windowsHide: true,
    });
    const chunks = [];
    const errChunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      }),
    );
    child.on("error", (e) =>
      resolve({ code: 127, stdout: "", stderr: `could not run python: ${e.message}` }),
    );
  });
}

async function main() {
  const dbFile = path.join(ROOT, "data", "acceptance.db");
  const server = await startServer({ dbFile, port: PORT, quiet: true });
  let code = 0;
  try {
    // `run.py` is invoked exactly as the spec prescribes, from the repo root,
    // with no arguments other than the config path.
    const run = await runChecker();

    if (run.stderr.trim()) {
      process.stderr.write(`checker stderr:\n${run.stderr}\n`);
    }
    if (!run.stdout.includes("DOGFOOD 2026 acceptance report")) {
      process.stderr.write(
        "the checker's output does not look like an acceptance report; refusing to write it\n",
      );
      process.exitCode = 1;
      return;
    }
    // A report that found no portal at all is a failure of this script, not a
    // result worth committing.
    if (run.stdout.includes("got no response")) {
      process.stderr.write(
        "the checker could not reach the portal. That is a bug in this script, not a\n" +
          "result. Nothing was written.\n",
      );
      process.exitCode = 1;
      return;
    }

    fs.writeFileSync(OUT, run.stdout, "utf8");

    const written = fs.readFileSync(OUT, "utf8");
    if (written !== run.stdout) {
      process.stderr.write("what was written differs from what the checker printed\n");
      process.exitCode = 1;
      return;
    }

    const passes = (run.stdout.match(/ PASS/g) || []).length;
    const fails = (run.stdout.match(/ FAIL/g) || []).length;
    const bytes = Buffer.byteLength(run.stdout, "utf8");
    process.stdout.write(
      `wrote ${OUT} — ${bytes} bytes, ${passes} PASS, ${fails} FAIL, checker exit ${run.code}\n`,
    );
    process.stdout.write(`${run.stdout}\n`);
    code = run.code || 0;
  } finally {
    server.server.close();
    server.close();
  }
  process.exitCode = code;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

"use strict";

/**
 * Boot the portal in the background, run a probe script against it, stop it.
 *
 * `node scripts/with-server.js node scripts/probe.js` — the probe is any
 * executable, so the same wrapper drives the acceptance checker, curl, or a
 * probe script without three near-identical launchers.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.DOGFOOD_PORT || 8080);

async function waitHealthy(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "timeout";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`portal never became healthy on ${url}: ${lastErr}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    // stdio is "inherit", so child.stdout is null. Anything that touches it
    // (as an earlier version of this script did) throws and the probe never
    // runs, which looks exactly like the portal being down.
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
    child.on("close", (code) => resolve(code));
    child.on("error", (e) => {
      process.stderr.write(`${e.message}\n`);
      resolve(127);
    });
  });
}

async function main() {
  const dbFile = process.env.DOGFOOD_DB || path.join(ROOT, "data", "acceptance.db");
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DOGFOOD_DB: dbFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = "";
  server.stdout.on("data", (d) => {
    boot += d;
  });
  server.stderr.on("data", (d) => {
    boot += d;
  });

  let code = 1;
  try {
    await waitHealthy(`http://127.0.0.1:${PORT}/healthz`);
    if (process.env.DOGFOOD_ECHO_BOOT !== "0") process.stdout.write(boot);

    const [cmd, ...rest] = process.argv.slice(2);
    if (!cmd) throw new Error("usage: node scripts/with-server.js <cmd> [args...]");
    code = await run(cmd, rest, { stdio: "inherit" });
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    code = 1;
  } finally {
    server.kill();
  }
  process.exitCode = code;
}

main();

void fs;

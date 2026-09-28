# Operations

Written because part of this submission could not be executed on the machine
that produced it, and the reader deserves to know exactly which part.

## Environment this was built on

- Windows 11, PowerShell 5.1
- Node.js v24.12.0, npm 11.6.2
- Python 3.13.3 (used only to run the official checker)
- **No Docker daemon.** `docker` is not on PATH, `docker.exe` is absent from
  `C:\Program Files\Docker\Docker\resources\bin`, `LOCALAPPDATA\Docker` and
  `C:\ProgramData\DockerDesktop`, and the Docker service is not registered.
  WSL2 is installed (Ubuntu-24.04) but no distribution is running Docker.

## What was verified, and how

| Claim | Command | Result |
|---|---|---|
| The server boots and seeds | `node src/server.js` | 41 projects, 40 teams, 8 tracks, 30 judges, 126 reviews |
| The official acceptance suite passes | `python official/run.py .dogfood.toml` | **7 / 7 PASS**, byte-identical across two runs |
| Every route behaves | `node scripts/probe.js` | 28 / 28 as expected |
| The test suite passes | `npm test` | 101 tests, 101 pass, 0 fail |
| Judge Desk works in a browser | `node scripts/browser-smoke.js` | 18 / 18 browser assertions |
| Peer isolation holds on **every** route | `tests/authz/surface-sweep.test.js` | route table discovered, 8 assertions |
| Security headers, XSS escaping, CSV quoting | `tests/authz/*.test.js` | asserted over real HTTP |
| Cold start on an empty database | `rm -rf data && node src/server.js` | re-seeds to the same state |
| Restart against an existing database | boot twice | second boot skips seeding, same four session tokens |
| Restarts and fresh volumes converge | `tests/integration/workflows.test.js` | identical fingerprint, identical sessions |
| Normalization is deterministic | `scripts/measure-distortion.js`, unit tests | fingerprint stable, order-independent |

`scripts/with-server.js` boots the real `src/server.js` on port 8080, waits for
`/healthz`, runs a command, then shuts it down. It is the same entrypoint the
container runs, so the acceptance result is produced by the shipping binary
rather than by a test double.

## The `better-sqlite3` build — corrected

An earlier draft of this file said the native binding "resolved without
compiling on this machine (Windows/x64), which is good evidence but not proof
for linux/x64", and `docs/STACK-DECISION.md` said the prebuild risk was
therefore "already ruled out".

**That was false, and an independent red-team review caught it.** The install
compiled from source. The evidence is in the tree:

```
node_modules/better-sqlite3/build/
  config.gypi            19,929 B   2026-09-28 19:56:54
  binding.sln             3,200 B   2026-09-28 19:56:54
  better_sqlite3.vcxproj 12,442 B   2026-09-28 19:56:54
  Release/better_sqlite3.node 1,891,328 B  2026-09-28 19:57:12
```

`config.gypi` and `binding.sln` are node-gyp artifacts; `prebuild-install`
creates neither. There is no `prebuilds/` directory and no prebuild-install
cache. better-sqlite3's install script is `prebuild-install || node-gyp rebuild
--release`, so this took the second branch — an ~18 second MSVC build.

What that changes, in both directions:

- **The prebuild path has never been exercised for this project at all.** So
  the platform risk is not "linux prebuild missing" but "unknown on every
  platform", and the image runs `node:22-bookworm-slim` while everything was
  verified on Node v24. Nothing has run under Node 22.
- **But the source-compile fallback is now positively verified**, on Windows
  with MSVC. The `Dockerfile` fallback installs `python3`, `make` and `g++` and
  retries, which is the same mechanism that just worked here. That is real
  evidence the fallback is sufficient, and it is why the fallback exists.

The remaining unproven combination is **linux/x64 + Node 22 + a source build**,
which needs a Docker daemon to confirm.

## What was NOT verified

**`docker compose up --build` has never been executed.** There is no Docker
daemon on this machine.

What is *not* in doubt, because it is shared with the verified path:

- The container's `CMD` is `node src/server.js` — the same file, the same
  dependencies, the same port, the same seed.
- `npm ci --omit=dev` was run against a clean copy of `package.json` +
  `package-lock.json` and installed 105 packages, so the lockfile does not drift.
- `.dockerignore` does not exclude `official/` or `package-lock.json`, so
  `COPY official ./official` and the `npm ci` layer both have what they need.
- `RUN mkdir -p /data && chown -R node:node /data` precedes `VOLUME ["/data"]`,
  so a named volume inherits node ownership. A **bind** mount from the host may
  not, and would need `chown` from outside.
- `server.js` binds `0.0.0.0`, so the port mapping works.

What is genuinely unproven, in the order I expect it to fail:

1. **Node 22 ABI mismatch on linux/x64.** better-sqlite3 publishes prebuilds per
   platform/ABI triple. If the Node 22 asset is absent, `npm ci` drops into
   `node-gyp`, and the image then depends on working Debian mirrors. The
   fallback makes this survivable, not instant.
2. **An unchecksummed third-party download at build time.** npm emits
   `prebuild-install@7.1.3: No longer maintained`, and the binary comes from a
   GitHub release asset with no checksum pinned in the Dockerfile. A 404 or a
   rate limit hands the build to the apt fallback.
3. **Volume permissions** for a bind mount, as above.
4. **Port 8080 already in use** on the judge's machine. Compose fails loudly,
   and the checker's `base_url` is fixed at `http://localhost:8080`, so changing
   it means editing `.dogfood.toml` too.
5. **A restart loop reads as a hang.** `restart: unless-stopped` plus a boot
   crash gives an infinite loop behind a `retries: 5` healthcheck.

## Browser-based checks need Playwright

`npm test`, `probe.js` and the official checker have **no** external
dependency beyond the two runtime packages. `browser-smoke.js` and
`screenshots.js` need Playwright, which is declared as an **optional**
devDependency because installing a browser is a 150 MB download that the
graded contract does not need.

```bash
npm ci
npx playwright install chromium     # once
node scripts/browser-smoke.js
```

If Playwright is absent, the scripts say so and exit non-zero with the command
to run, rather than failing with a bare `Cannot find module`.

## Reproducing the verification on a machine with Docker

```bash
docker compose up --build

# in a second shell
python official/run.py .dogfood.toml
# expect: 7 PASS, "claimed T1 T2, verified T1 T2"

# prove a clean volume is identical
docker compose down -v
docker compose up --build
python official/run.py .dogfood.toml
# expect: byte-identical output, because ids and session tokens are derived
# from a fixed seed rather than generated
```

## Running without Docker

```bash
npm ci
node src/server.js            # http://localhost:8080
node scripts/with-server.js python official/run.py .dogfood.toml
```

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Must match `base_url` in `.dogfood.toml` |
| `DOGFOOD_DB` | `./data/dogfood.db` | `:memory:` is accepted and used by the tests |
| `DOGFOOD_FIXTURES` | `./official/fixtures.json` | Read-only input |

There are no secrets. The four test logins are derived from a fixed seed in
`src/db/index.js` and printed at boot, so a wiped volume and a fresh clone
produce the same headers. That is what makes the acceptance run reproducible,
and it would be the wrong design for real accounts — see `THREAT-MODEL.md`.

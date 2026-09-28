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
| The test suite passes | `npm test` | 50 tests, 50 pass, 0 fail |
| Normalization is deterministic | `scripts/measure-distortion.js`, unit tests | fingerprint stable, order-independent |
| Security headers, XSS escaping, CSV quoting | `tests/authz/adversarial.test.js` | asserted over real HTTP |
| Cold start on an empty database | `rm -rf data && node src/server.js` | re-seeds to the same state |
| Restart against an existing database | boot twice | second boot skips seeding, same four session tokens |

`scripts/with-server.js` boots the real `src/server.js` on port 8080, waits for
`/healthz`, runs a command, then shuts it down. It is the same entrypoint the
container runs, so the acceptance result is produced by the shipping binary
rather than by a test double.

## What was NOT verified

**`docker compose up --build` has never been executed.** There is no Docker
daemon on this machine.

What is *not* in doubt, because it is shared with the verified path:

- The container's `CMD` is `node src/server.js` — the same file, the same
  dependencies, the same port, the same seed.
- `npm ci --omit=dev` installs exactly the two production dependencies that are
  already installed and passing in `node_modules` here.
- The Compose file declares one service, one named volume mounted at `/data`,
  and a `healthcheck` that is the same `fetch` against `/healthz` the test
  harness already runs.

What is genuinely unproven, and could fail on a judge's machine:

1. **The `better-sqlite3` prebuild for `node:22-bookworm-slim`.** `better-sqlite3`
   ships prebuilt binaries per platform and falls back to compiling with
   `node-gyp` if none matches. It resolved without compiling on this machine
   (Windows/x64), which is good evidence but not proof for linux/x64. If the
   prebuild is missing the image build needs `python3`, `make` and `g++`, which
   `bookworm-slim` does not have — **the first thing to add if the build fails
   is a `build-essential` layer.** This is the highest-probability failure.
2. **Volume permissions.** The image runs as `USER node` with `/data` chowned to
   `node` at build time. A named volume mounted over it inherits that ownership;
   a bind mount from the host may not.
3. **Port 8080 already in use on the judge's machine.** Compose will fail
   loudly rather than silently pick another port, and the checker's
   `base_url` is fixed at `http://localhost:8080`, so the port is not
   configurable without editing `.dogfood.toml` too.

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

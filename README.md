# DOGFOOD

**A self-hosted hackathon submission and judging platform that shows you its
working.** One command, one SQLite file, no network, no cloud account.

```bash
docker compose up --build     # -> http://localhost:8080
```

```
T1  gallery is public ................. PASS
T1  project from fixtures shown ....... PASS
T1  closed event refuses submissions .. PASS
T2  judge sees own scores ............. PASS
T2  judge cannot see peer scores ...... PASS
T2  participant blocked ............... PASS
T2  csv export works .................. PASS

claimed T1 T2, verified T1 T2
```

That is the unmodified official checker, printed by
`python official/run.py .dogfood.toml`, committed verbatim as
[`acceptance-report.txt`](acceptance-report.txt). Claimed tiers match verified
tiers.

---

## What it is

Forty teams build forty different portals. This one is a judging platform where
the interesting claims are inspectable rather than asserted:

- **Judge isolation lives in the backend.** `judge_b` asking for `judge_a`'s
  scores over HTTP gets `403` with no score rows in the body. Twenty-seven
  direct API attacks are asserted in `tests/authz/adversarial.test.js`, none of
  which goes through a browser.
- **The deadline is the server's decision.** The seeded event closed in March.
  `POST /api/projects` returns `403 event_closed` naming the fixture's own close
  date, whatever the form renders.
- **Scoring can be audited.** Raw and normalized rankings are published side by
  side with every judge's mean, standard deviation, sample size and shrinkage
  factor. Nothing is adjusted silently.
- **Every high-value mutation is on the audit log**, refusals included. "judge_b
  asked for judge_a's scores" is a row an organizer can read.

Seeded on boot from the official `fixtures.json`: **41 projects, 40 teams,
8 tracks, 30 judges, 126 completed reviews**, plus the four session headers the
checker authenticates as, printed at startup.

## Ten-second tour

| Surface | Route | What to look at |
|---|---|---|
| Public gallery | `/projects` | 41 fixture projects, search and track filter, no account |
| Submission | `/submit` | Closed, and it says why — the refusal is the feature |
| Judge desk | `/judge` | Assignment queue, one-surface scoring, autosave |
| Control room | `/organizer` | Calibration lab, judge progress, what to fix next, audit log |

![Control room at 1440x900](docs/screenshots/organizer-1440x900.png)

*Organizer control room. Real fixture data, captured by
`scripts/screenshots.js` from a running portal — not a mock-up. The same
capture run reports **0 horizontal overflow, 0 console errors and 0 undersized
tap targets** across 6 viewports from 375x812 to 1920x1080.*

| | |
|---|---|
| ![Gallery](docs/screenshots/gallery-1440x900.png) | ![Judge desk](docs/screenshots/judge-review-1440x900.png) |
| Public gallery, no account | Judge desk: rubric, notes and autosave on one surface |
| ![Landing](docs/screenshots/landing-390x844.png) | ![Organizer mobile](docs/screenshots/organizer-390x844.png) |
| Landing at 390x844 | Control room at 390x844 — no overflow, 44px targets |

Session headers are printed at boot and already filled into
[`.dogfood.toml`](.dogfood.toml).

## Architecture in one picture

```
                    ┌──────────────────────────────────────────┐
  browser  ────────▶│  express                                 │
                    │                                          │
                    │   attachIdentity  ──▶ req.user           │  identity is derived
                    │        (session table only)              │  here and nowhere else
                    │            │                             │
                    │            ▼                             │
                    │   requireRole / requireJudge / …          │  every /api route
                    │            │                             │  is behind one
                    │            ▼                             │
                    │   public · participant · judge · organizer│
                    │            │                             │
                    │            ▼                             │
                    │   SQLite (WAL, foreign_keys ON)         │
                    └──────────────────────────────────────────┘
                                  │
                    normalize() ──┴──► raw rank + normalized rank + fingerprint
```

Two runtime dependencies (`express`, `better-sqlite3`). No build step, no
framework, no ORM, no client-side framework, no external service. Details and
the reasoning behind the stack choice: [`ARCHITECTURE.md`](ARCHITECTURE.md) and
[`docs/STACK-DECISION.md`](docs/STACK-DECISION.md).

## Documentation

| Document | What it answers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the process is put together and why |
| [`DATA-MODEL.md`](DATA-MODEL.md) | Every table, every constraint, and the fixture data that forced it |
| [`JUDGING.md`](JUDGING.md) | The scoring model and the normalization mathematics |
| [`normalization-proof.md`](normalization-proof.md) | Worked numbers on the real fixtures, generated not typed |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | Fifteen attacks, current mitigation, and what is still open |

## Testing

```bash
npm test                      # 81 tests: unit, authorization, integration, CSRF
node scripts/probe.js         # 28 routes, expected status for each
node scripts/browser-smoke.js # drives the real Judge Desk in Chrome
node scripts/screenshots.js   # 6 viewports, checks overflow / console / targets
node scripts/measure-distortion.js
node scripts/with-server.js python official/run.py .dogfood.toml
```

`scripts/browser-smoke.js` is the one that matters most, because it is the only
check that would have caught a real product failure: it scores a project in a
browser, waits for the debounce, reads the server back, reloads the page, and
confirms the scores came back. It found three defects that every other layer
passed, listed in `ARCHITECTURE.md`.

Latest measured run, 2026-09-28:

| Check | Result |
|---|---|
| `npm test` | 81 / 81 pass |
| `scripts/browser-smoke.js` | 20 / 20 browser assertions pass |
| `scripts/probe.js` | 28 / 28 routes as expected |
| `scripts/screenshots.js` | 0 overflow, 0 console errors, 0 undersized targets |
| `official/run.py` | **7 / 7 PASS**, `claimed T1 T2, verified T1 T2` |
| `acceptance-report.txt` | byte-identical across consecutive runs |

The official `run.py` and `fixtures.json` are vendored unmodified under
[`official/`](official/) and are never edited. SHA-256 as downloaded on
2026-09-28:

```
07e479728e7e6961fcf5053e159e6dc807bae3e4b371ee088e4a17897950d290  official/spec.md
aa98963841bc8e18e8e5d76f0499697c093dd3c0055f9d73a459f592f4dcf09d  official/run.py
252896bc45d49fca69ad413be40c6bfde9d9b9f9dd8db702b3ff74eaaa181121  official/fixtures.json
```

`acceptance-report.txt` is the checker's own output, unedited. It contains one
machine-specific detail: the `fixtures:` line is the absolute path the checker
found the file at on this machine. That is the checker printing what it loaded,
which is the point of that line, so it is left alone rather than tidied.

## Limitations, stated plainly

- **No community voting.** T3 is not attempted. A T3 that is half-built is worse
  than a T2 that is finished.
- **No pairwise / Bradley-Terry mode.** Documented as future work in
  `JUDGING.md` rather than shipped half-done.
- **Authentication is a seeded session table, not a login flow.** The spec's own
  design says the checker never logs in and asks for a working header, so there
  is no password UI. Sessions do not expire inside the event window, which is
  deliberate for the same reason and would not be acceptable in production.
- **Judges are seeded from fixture identities, not invited accounts.**
  `invitations` and `judge_track_eligibility` exist and are enforced; inviting
  by email is not implemented.
- **No bulk import.** Export is CSV; import is not. See `ARCHITECTURE.md`.
- **The Judge Desk is hand-built, not a component library.** That is a real cost
  in accessibility primitives, and it is the surface to check first.
- **Docker was not executed on the machine that wrote this.** The
  `Dockerfile` and `docker-compose.yml` are complete and the same
  `src/server.js` entrypoint runs in both, but there was no Docker daemon
  available to run `docker compose up` end to end here. See
  [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for exactly what was and was not
  verified, including the single likeliest failure (the `better-sqlite3`
  prebuild for `node:22-bookworm-slim` falling back to `node-gyp` with no
  toolchain in the image). **This is the largest gap in the submission** and it
  is the first thing to fix on a machine that has Docker.

## Tech stack

Node.js 22 · Express 4 · better-sqlite3 11 · server-rendered HTML · vanilla JS
for the Judge Desk · zero build step

## License

Apache-2.0. See [`LICENSE`](LICENSE).

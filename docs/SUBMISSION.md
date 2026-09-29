# DOGFOOD 2026 — submission text

Everything below is form-ready. Paste it into the submission form as written.
Nothing in this file is aspirational: every number is a command's output, and
the "verified" column is not a claim about the product but a claim about what
has actually been run.

Repo: https://github.com/vaibhav4046/dogfood-2026
Licence: Apache-2.0 (matches `package.json` `license`)
Acceptance: `claimed T1 T2, verified T1 T2` (7 of 7 PASS)

---

## Title

DOGFOOD: run a hackathon on your own server, with judging you can verify

## One-line description

A self-hosted hackathon and judging platform. One command starts it, it works
with the network disconnected, and every score it publishes can be traced back
to the judge who wrote it.

## Long description (about 250 words)

DOGFOOD runs a hackathon event end to end: organizers create events, tracks
and weighted rubrics; participants form teams and submit projects; judges are
invited by single-use link, see only the projects assigned to them, and score
against the rubric; organizers watch coverage, publish results, and export CSV.

The problem it targets is that hackathon judging is inconsistent and leaky.
Most hosted platforms trust a judge not to look at a colleague's scores. This
one refuses it in the backend. Judge identity comes from the server-side
session, never from a query parameter, a body field, or frontend state. A route
that would have exposed every judge's scores was found by an independent review
after it had been marked closed in both the code comments and the threat model;
it is now removed, and a test discovers the route table at runtime and asserts
that no response body can contain another judge's rows. That test carries a
mutation proof: it reintroduces the leak, names all 31 exposed judges, and
restores the file.

Judging math is published rather than asserted. Raw scores are normalized with
explicit shrinkage so one harsh judge cannot dominate a thin sample, and the
whole pipeline is regenerated from the real fixtures into a proof document
with an order-independent fingerprint that a judge can recompute. The
Calibration Lab shows raw versus normalized ranking, signed rank movement, and
per-judge severity on those same fixtures.

It is a plain Express server over SQLite with server-rendered HTML, no build
step and no external service. `docker compose up --build` brings up a seeded
portal that runs with the network disconnected.

## Tech stack

- Node.js 22, Express 5, `better-sqlite3` (SQLite, WAL mode)
- Server-rendered HTML, one stylesheet, vanilla JS
- No build step, no ORM, no hosted service, no external API, no CDN
- `node --test` for the suite; Python for the official acceptance checker

## Tiers

Claimed: T1, T2. Verified by the official checker: T1, T2.

Claimed tiers never exceed verified tiers. The line above is copied from
`acceptance-report.txt`, which is regenerated from the official checker's own
output and not hand-edited.

Not claimed, and deliberately: T3 (community voting, discussion, delayed
reveal, randomized ballot, anti-cheat) and T4 (REST API, webhooks,
certificates, embeddable gallery, bulk import). Both are absent. See "Known
limits" rather than a claim.

## Reproduce the acceptance result

```
git clone https://github.com/vaibhav4046/dogfood-2026
cd dogfood-2026
docker compose up --build
python official/run.py .dogfood.toml
```

Expected final line, unchanged:

```
claimed T1 T2, verified T1 T2
```

Without Docker:

```
npm ci
npm start
python official/run.py .dogfood.toml
```

## Evidence table

| Claim | Status | Command | Evidence |
|---|---|---|---|
| Official acceptance 7/7 | verified in CI, see limits | `npm run acceptance` | `acceptance-report.txt` |
| Test suite 109 pass, 0 fail, 0 skipped | verified locally | `npm test` | this commit's CI run |
| All 28 routes behave as expected | verified locally | `npm run probe` | `scripts/probe.js` |
| Judge cannot read peer scores | unit-tested + mutation proof | `npm run prove:sweep` | sweep names all 31 judges when the leak is reintroduced |
| Normalization is reproducible | unit-tested, fingerprint recorded | `npm run proof` | `normalization-proof.md` |
| CSV export neutralises formula injection | verified locally | `npm test` | `docs/evidence/csv-injection/` |
| Demo identity refused outside demo mode | unit-tested | `npm test` | `tests/integration/real-auth.test.js` |
| `docker compose up --build` | **not verified** | see limits | none |

## Known limits, written by us

- **Docker has never been executed.** This machine has no Docker daemon and
  `winget` and `choco` are not available. The `Dockerfile` and
  `docker-compose.yml` exist and are reviewed but unrun. Until a CI run is
  green the README says so in the first screen. Do not claim it works.
- **T3 and T4 are not implemented.** No community voting, no discussion, no
  REST API, no webhooks, no bulk import.
- **No Bradley-Terry pairwise mode.** Normalization is shrinkage only.
- **No collusion detector.** Score-correlation analysis is a named
  non-goal, not a shipped feature.
- **CSRF protection is Origin/Referer only.** There is no synchronizer or
  double-submit token. The refused path is tested; the absence is a known gap.
- **The seeded demo database contains a historical duplicate**
  (`prj_07` / `prj_41`). It is preserved and surfaced rather than silently
  deleted, because the official fixtures ship that way. New duplicate
  submissions are refused.
- `better-sqlite3` compiled from source on Windows/MSVC. The prebuild path was
  never exercised.

## Docs to read

- `README.md` — the first screen: what it is, one command, the acceptance line
- `ARCHITECTURE.md` — dependency table and data flow
- `DATA-MODEL.md` — schema, generated and checked against the real database
- `JUDGING.md` — the rubric and normalization maths, every number from the
  regenerated proof
- `THREAT-MODEL.md` — including the header-identity backdoor and how it is
  gated behind `DOGFOOD_MODE`
- `docs/OPERATIONS.md` — start, stop, back up, restore, common failures
- `docs/WRITEUP.md` — how judging integrity is enforced, and the mistake the
  peer-score leak taught us

## Video

`docs/demo/demo.mp4` (H.264) and `docs/demo/demo.webm`, 1 minute 20 seconds,
captions in `docs/demo/demo.srt`, recorded by script from the real UI against a
real seeded run. No mockups, no fabricated footage.

**Not delivered:** the 5-minute full-lifecycle video (create, submit, judge,
publish) that the brief asks for. What exists covers the participant submission
and the judge desk end to end. Treat this as a known gap; do not describe the
existing clip as the full lifecycle.

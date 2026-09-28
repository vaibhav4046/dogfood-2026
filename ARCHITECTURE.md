# Architecture

## The shape of it

One Node process. One SQLite file. No build step. No client-side framework. Two
runtime dependencies.

```
src/
  server.js              express app, CSP + security headers, boot, seed-on-empty
  db/
    index.js             open db, pragmas, deterministic id/token derivation
    migrations.js        numbered append-only migrations, one transaction each
    seed.js              fixtures -> relational schema, with the awkward cases named
    criteria.js          rubric definition, weight normalisation
  middleware/
    auth.js              session -> req.user, role guards, the peer-scores rule
  routes/
    public.js            gallery, project detail, public JSON
    participant.js       submission (deadline enforced), teams, invites
    judge.js             judge desk, own-scores, review save
    organizer.js         control room, calibration, rubric, assign, publish, CSV
  services/
    judging.js           raw + normalized aggregation, duplicate detection
    normalize.js         the scoring mathematics
    audit.js             one row per high-value mutation, refusals included
    csv.js               RFC 4180 export
  views/                 server-rendered HTML, one layout, no client framework
  lib/
    normalize.js         z-score + shrinkage, deterministic, fingerprinted
public/assets/desk.js    the only JavaScript in the product: Judge Desk autosave
scripts/                 boot harness, route probe, proof generator, measurements
tests/                   unit · authz · acceptance
```

## The decisions that shape everything else

### 1. Identity is derived, never supplied

`attachIdentity` is the only thing that sets `req.user`, and it does it from a
lookup in the `sessions` table. A cookie or a bearer token is resolved to a user
row or to nothing.

Everything else reads `req.user.role`. Nothing anywhere reads a role from a
request body, a query parameter or a form field — there is a test for each of
those, asserting the refusal (`tests/authz/adversarial.test.js`).

`?judge=` is the interesting case, because the spec asks us to *write down* a
peer-scores URL, which means naming a judge in a URL is legitimate. It is read
by `resolveRequestedJudge` and then checked by `sameJudge` against the
server-derived identity. It is an input to a comparison, never proof.

`sameJudge` accepts three spellings of "me": internal id, email, and the short
handle from `.dogfood.toml` (`judge_a`). Accepting only the internal id was a
real bug — a judge typing the handle the config file documents was refused
their own scores.

### 2. Authorization is middleware, and it is centralised

`requireRole`, `requireParticipant`, `requireJudge`, `requireOrganizer` are
factories returning one guard function. Every `/api` route is behind one. A new
route added without a guard is the failure mode, which is why the probe script
asserts a status for 28 routes including the refusals — a route that quietly
became public shows up there.

401 means no identity, 403 means the wrong identity. A 404 is never used to
hide a resource's existence, because that leaks it.

Track scoping and assignment scoping are ANDed in one function,
`assignedProject`, so neither a stale assignment nor a broad track grant can
leak a row on its own.

### 3. The deadline is a server decision

`POST /api/projects` reads the event row and compares `submissions_close` to
`Date.now()` before it looks at anything in the body. An unparseable deadline
is a `500 bad_deadline`, not an eternal open window. The refusal names the
fixture's own close date.

The form is still rendered, disabled, with the reason. Hiding the form would
make the deadline invisible instead of enforced, and the spec's T1 check wants a
4xx — a hidden form would not give one.

### 4. No build step

Recorded in full in [`STACK-DECISION.md`](STACK-DECISION.md). The short version:
the acceptance suite makes seven requests to a running process, so a TypeScript
or bundler error means the process never starts and all seven fail for a reason
unrelated to the product. With no build step a defect is confined to its route.

The cost is real — the four surfaces are hand-built, and the Judge Desk in
particular would benefit from a component library's accessibility primitives.
That is stated in the README's limitations rather than glossed.

### 5. The schema declares the invariants; the API enforces the rules

`users.login_key`, `criteria.min_score`/`max_score`, `assignments UNIQUE(judge,
project)`, `review_scores` bounds — all in the schema, all with tests.

The one rule deliberately *not* in the schema is one-live-submission-per-team-
per-track, because the fixtures contain a genuine duplicate (`prj_07` and
`prj_41`) that arrived before the deadline and cannot be un-submitted. The API
refuses new duplicates with `409 duplicate_submission`; the historical one is
reported to the organizer in the Control Room. See
[`DATA-MODEL.md`](DATA-MODEL.md).

### 6. Everything user-authored is escaped at the boundary

`escapeHtml` in `views/layout.js` is the only way a view turns a value into
markup, and a CSP with no `unsafe-inline` backs it up. URLs are filtered to
`http`/`https` by `safeUrl`, because a `javascript:` URL in a fixture field would
otherwise be live script on the public gallery.

Two tests assert the *absence* of raw markup, rather than asserting that an
escaping function is called.

### 7. Refusals are audited

`writeAudit` records actor, role, action, target, previous state, new state,
request id and time. It is called on refusals as well as successes, and the
action name must be in an explicit allow-list, so a typo is a startup-time
error rather than a silently unrecorded event.

The `X-Request-Id` header is on every response and is the same value written to
the audit row, so an organizer can trace one request through the log.

## Request lifecycle

```
  request
    │
    ├─ X-Request-Id (or generated)          correlation id
    ├─ CSP + nosniff + frame-deny
    ├─ body parser, 256 kB cap
    │
    ├─ attachIdentity ──▶ req.user | null   ← the only identity source
    │
    ├─ route guard (requireRole / requireJudge / …)
    │      401 unauthenticated · 403 wrong role
    │
    ├─ handler
    │      ├─ reads/writes SQLite (WAL, foreign_keys ON, 5 s busy timeout)
    │      └─ writeAudit on anything high-value, success or refusal
    │
    └─ 404 JSON for /api, HTML otherwise
```

## The judging path

```
 reviews + review_scores
        │  gatherReviews()          one row per (judge, project) with a score map
        ▼
 normalize()  src/lib/normalize.js
        │  per judge: mu, sd, lambda = n/(n+K)
        │  per score: z -> shrink -> back onto the global distribution -> clamp
        │  zero-variance and n<2 handled explicitly, never by dividing through
        ▼
 ┌────────────────────┬──────────────────────┐
 │ raw ranking        │ normalized ranking   │   both always published
 │ competition ranks  │ competition ranks    │   normalized never overwrites raw
 └────────────────────┴──────────────────────┘
        │  + rank movement + review/flag counts
        ▼
 computeResults()  src/services/judging.js
        │
        ├─▶ /organizer            Calibration Lab, side by side
        ├─▶ /api/export.csv       both modes, organizer only
        └─▶ results table         both modes persisted
```

`fingerprint()` is a SHA-256 over the ranked output. It is published in the
Calibration Lab and printed in `normalization-proof.md`, so the claim "this is
deterministic" is checkable rather than asserted. `judgeStats` is sorted before
hashing, because it is built by walking a Map in first-appearance order and a
hash that moves when you re-sort the input is not a hash.

## Testing strategy

| Layer | What it covers | How |
|---|---|---|
| `tests/unit` | normalization mathematics, 18 tests | pure functions, no HTTP |
| `tests/authz` | 27 direct API attacks | real HTTP against a real server |
| `tests/acceptance` | the seven official checks, plus the *reason* for each | real HTTP, ephemeral port |
| `scripts/probe.js` | 28 routes and their expected status | real HTTP |
| `official/run.py` | the graded contract | unmodified, against a booted portal |

The acceptance tests assert more than the official checker does. The checker
only requires a 4xx for a closed event; the test also asserts the error code is
`event_closed` and that the body names the fixture's close date — because a 400
for a malformed body would satisfy the checker while proving nothing.

Three real bugs were found by these tests rather than by reading the code:

1. `min_score`/`max_score` were not mapped to `min`/`max`, so `4 < undefined` was
   false and **every** score passed bounds validation, including 99 and −5.
2. `assignment.id` was used where the SQL aliased it `assignmentId`, so every
   review save failed with a foreign key error.
3. The `n < 2` branch kept the raw score, which let the *least* trustworthy
   judge count at full weight — the opposite of what shrinkage is for.

The third was found by a test asserting a property the first implementation
failed. It now standardizes against the global distribution and shrinks.

## What is deliberately not here

- **Community voting (T3).** Not attempted. Ballot-stuffing defence without
  ballots is not a feature.
- **Pairwise Bradley-Terry.** Documented in `JUDGING.md` as future work.
- **Bulk import.** Export exists because organizers get trapped otherwise; import
  is a separate piece of work with its own validation surface.
- **A login UI.** The spec's design is that the checker never logs in and is
  handed a working header. Adding a password form would not be used by the
  grader and would add an unaudited auth surface.
- **A migration runner beyond the single `001_core`.** The mechanism is there
  and append-only; there is one migration because the schema was written once.

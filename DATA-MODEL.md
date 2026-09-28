# Data model

SQLite, relational, one migration. `PRAGMA foreign_keys = ON` is set on every
connection — SQLite defaults it **off**, which would make every `REFERENCES`
clause in the schema decorative.

## Tables

```
users ──────────┬── sessions
                ├── team_members ──▶ teams ──▶ events
                ├── judge_profiles
                ├── judge_track_eligibility ──▶ tracks ──▶ events
                ├── invitations
                ├── assignments ──┬──▶ projects ──┬── tracks
                │                 │              └── teams
                │                 └── reviews ──▶ review_scores ──▶ criteria
                └── audit_events

results   (event, project, mode)      both modes persisted, never one over the other
counters, schema_migrations
```

## Every column that matters

### `users`
| column | notes |
|---|---|
| `id` | `usr_<sha256(email)[0:10]>`, deterministic |
| `email` | unique |
| `role` | `CHECK IN ('visitor','participant','judge','organizer','admin')` |
| `login_key` | **unique, nullable.** The short handle (`judge_a`) that `.dogfood.toml` addresses judges by. Fixture judges are named people and have none. |

`login_key` exists because of a real bug: without it, a judge typing the handle
the config file documents was refused their own scores. `sameJudge` now accepts
id, email, or handle.

### `sessions`
`token` (PK), `user_id` → users, `expires_at`. Four seeded sessions, tokens
derived from a fixed seed so a wiped volume reproduces the same headers. Not
expiring inside the event window is deliberate for the same reason and is
called out in `THREAT-MODEL.md`.

### `events`
`submissions_close` is **NOT NULL** and is the fixture's own past date
(`2026-03-01T18:00:00Z`). Seeding an organizer's date instead would make the
"closed event refuses submissions" check pass for the wrong reason.

### `tracks`
Unique on `(event_id, slug)`. The fixtures' eight track names are distinct.

### `teams`
**No unique constraint on `(event_id, name)`.** This is a decision, not an
omission — see "What the fixture data forced" below.

### `projects`
`CHECK (status IN ('draft','submitted'))`. `tech_tags`, `media_urls` and
`custom_answers` are JSON **text**, deliberately: they are opaque, never joined
on, and never used in an authorization decision. Everything that *is* joined on
— judge, project, criterion, track, team — is a real column or a real table.

**No unique constraint on `(team_id, track_id)`.** Also deliberate, see below.
The *new-submission* rule is enforced in `POST /api/projects` with
`409 duplicate_submission`.

### `criteria`
`min_score`, `max_score` per criterion, not global. A rubric where craft is
0–5 and impact is 0–10 is legitimate and one global bound would forbid it.
`weight` is relative and normalised to sum to 1 at aggregation time, so an
organizer editing weights does not have to hit a magic number.

### `assignments`
`UNIQUE (judge_id, project_id)`. `status IN ('pending','in_progress','submitted','declined')`.
Assignment is the authorization unit: a judge can read or score a project only
through an assignment **and** track eligibility, ANDed in `assignedProject`.

### `reviews`
`UNIQUE (assignment_id)` — one review per assignment. A second submit is an
`UPDATE`, not a second row, so a judge cannot inflate their own review count.

### `review_scores`
`PRIMARY KEY (review_id, criterion_id)`, `CHECK (value >= 0 AND value <= 10)`.
The table-level check is 0–10; the *real* bounds are the criterion's own
`min_score`/`max_score`, validated in the handler. Both exist: the table check
rejects nonsense, the handler rejects out-of-rubric values with a named field.

### `audit_events`
`actor_id`, `actor_role`, `action`, `target_type`, `target_id`,
`previous_state`, `new_state`, `request_id`, `created_at`. `action` comes from
an explicit allow-list — a typo throws rather than silently unrecording.

`previous_state` is populated where there is one (rubric weight changes,
assignment deletion, event status) and `null` where there is not (a creation).

### `results`
`UNIQUE (event_id, project_id, mode)` with `mode IN ('raw','normalized')`. Both
modes are persisted so the organizer can toggle without recomputing, and so
normalization can never overwrite a raw score.

## What the fixture data forced

Three constraints were **removed** after reading all 41 projects and 126 scores
rather than the three-record sample in the spec. Each one had passed a test and
would have emptied the gallery on first boot.

### 1. Team names are not unique

Forty teams include **three** named `StillTrail`, **two** named `AmberSwitch`
and **two** named `OpenSignal`. `UNIQUE(event_id, name)` rejects 4 of the 40
real rows, and the gallery check looks for a fixture project title — so the
first acceptance run would have failed with no obvious cause.

Identity is the id; the name is a label two different teams may share. The
create-team *route* still refuses a duplicate name as a UI affordance
(`already_on_a_team` / name clash), but the schema does not assert it.

### 2. The duplicate submission is real and must be kept

`prj_07` and `prj_41` are both `tm_07` in `trk_03`, both titled `Dry Harbour`,
both `submitted_at` before the 18:00 deadline (`04:29` and `17:57`). The spec
says the fixtures contain a duplicate submission on purpose.

So:

- Both are loaded. Dropping either would be editing the organizer's data, and
  the second was accepted in time so it cannot be un-submitted.
- The seed prints a note naming them.
- `duplicateSubmissions()` in `src/services/judging.js` finds them, and the
  Control Room shows a **Data integrity** panel: *"New duplicates are refused by
  the API with 409. These arrived before the deadline and cannot be
  un-submitted, so they are shown rather than merged or hidden."*
- `POST /api/projects` still refuses a second live submission per team per
  track with `409 duplicate_submission`.

Both `prj_07` and `prj_41` appear in the gallery. That is the honest rendering.

### 3. Nothing may assume coverage or variance

| Observed | Consequence |
|---|---|
| 8 projects with 2 reviews, 26 with 3, 3 with 4, 4 with 5 (all 41 reviewed) | `review_count` and `judge_count` travel with every ranked row into the CSV and the Calibration Lab |
| 2 judges with 1 review, 6 with 2, 7 with 3, 4 with 4, 3 with 5, 5 with 6, one each with 9, 10 and 11 | shrinkage `lambda = n/(n+4)`; `n < 2` per criterion standardizes against the global distribution |
| `Iva Petrova`: 3 reviews, **sd 0.000** | zero-variance path, score kept raw, flagged, never divided through |
| `Sana Aziz`: sd 1.105 overall but constant on `functionality` | `degenerate` is now *all* criteria, and `constantCriteria` names which |
| judge means span **2.000 to 4.222** | a 2.222-point severity range, corrected before averaging |

That last row was a real inconsistency: the first implementation checked only
the first criterion for zero variance, so the generated proof showed
"no spread" next to an sd of 1.105. The unit test now covers the distinction.

## Migrations

Numbered and append-only, each applied inside its own transaction and recorded
in `schema_migrations`. A fresh volume and an existing volume converge on the
same schema, and a half-applied migration cannot be skipped.

There is exactly one migration, `001_core`, because the schema was written once.
The mechanism is there for the second.

`WAL` journal mode so the Judge Desk autosaves while a judge reads the gallery.
`busy_timeout = 5000` so a concurrent write waits rather than throwing.

## Seed counts, measured

```
event       1
tracks      8
criteria    3
teams      40
judges     30
projects   41
assignments 126   (derived from the 126 score rows, so no assignment without a review)
reviews    126
demo queues  judge_a 18 · judge_b 23   (assignments with no review, so the desk is real work)
```

Assignments are derived from the score rows, which is what makes the data
self-consistent: there is no assignment without a review, and no review without
one. The demo queues are the exception and are labelled as such — they exist so
`judge_a` opens a Judge Desk with 18 projects on it instead of an empty page.

# Threat model

Fifteen ways to attack a hackathon judging platform, what is actually done
about each, and — where it matters — what is still open.

Scope: a single-process, self-hosted portal serving a public gallery, participant
submissions, a judge desk, an organizer control room and a CSV export. Assumed
attacker: any registered participant or judge, and anyone who can reach the
port. Assumed non-goal: a well-resourced operator attacking the host itself.

Written to be useful, not reassuring. Six entries below are **not fully solved**
and say so.

---

## 1. Judge reads another judge's scores

**The headline attack.** The spec calls it "the one that matters most", and
names the failure: a template that hides the other judge's scores is not a
refusal, because the API happily hands them to anyone logged in.

| | |
|---|---|
| **Asset** | Every judge's individual scores and comments |
| **Mitigation** | `resolveRequestedJudge` reads `?judge=` / `?judge_id=` / `:judgeId` and passes it to `sameJudge`, which compares it against the session-derived `req.user`. Any mismatch is `403 peer_isolation` with **no score rows in the body**. A refusal that leaks the data is a refusal in name only, so the test asserts the payload, not just the status. |
| **Tests** | `tests/authz/adversarial.test.js` — the query-parameter and path forms, both asserting `!leaksScores(body)`. |
| **Residual** | **Low on this route. And that qualification used to be missing.** |

**This entry previously read "Solved" and it was not.** An independent
red-team review found `GET /api/organizer/results` guarded by
`requireJudgingStaff` — which admits judges — returning `computeResults(db)`
with no identity passed in. Any judge could read all 31 judges' means, standard
deviations, per-criterion breakdowns and coverage. For a judge with exactly one
review the "aggregate" *is* their raw score, and `judge_a`'s per-criterion mean
came back as `{functionality: 5, quality: 2, innovation: 3}` — which is
precisely what `judge_a` privately submitted.

The route is deleted. `/api/judge/scores` and the organizer-only
`/api/organizer/calibration` already covered both jobs.

Two lessons are now enforced rather than written down:

- **Naming the peer is not the only way to leak their scores.** An aggregate
  over every judge's rows is the same disclosure by a different route. The
  assertions scan response bodies and the `judgeStats` structure, not URLs.
- **A test suite that enumerates its own routes cannot find an unlisted one.**
  `tests/authz/surface-sweep.test.js` discovers the route table from the app
  object, so adding a route adds it to the sweep. The 27 hand-written attack
  tests and the 28 asserted routes were all true and all missed this one.

`npm run prove:sweep` reintroduces the exact leak, runs the sweep, and restores
the file. It names all 31 exposed judges and exits 0 having proved the test is
not vacuous.

The one thing that does remain by design: an organizer can read every judge's
scores, because the Calibration Lab needs it. There is no per-judge consent to
suppress.

## 2. Participant reaches a judge endpoint

| | |
|---|---|
| **Asset** | Rubric detail, assignment state, score endpoints, the judge desk |
| **Mitigation** | Every `/api/judge/*` route is behind `requireJudge`. A participant is a known user with a valid session, so this is a `403` role check, not a `401`. Enforced in middleware, before any handler reads a row. |
| **Tests** | `a participant cannot read judge scores`, `…export the CSV`, `…open the organizer audit log`, plus a body-field `role: "judge"` escalation attempt |
| **Residual** | **Low.** |

## 3. Judge reads a project they are not assigned

| | |
|---|---|
| **Asset** | Unreviewed submissions, and the ability to score them |
| **Mitigation** | `assignedProject()` requires an assignment row **and** track eligibility, ANDed in one query, for both reads and writes. The same refusal — `403 not_assigned` — is used for "not yours" and "not in an eligible track", so a judge cannot enumerate the difference by comparing status codes. |
| **Tests** | `a judge cannot read or score a project they are not assigned to` (asserts both the desk page **and** the write) |
| **Residual** | **Low.** |

## 4. Track-scoped judge reads another track

| | |
|---|---|
| **Asset** | Submissions outside the judge's competence |
| **Mitigation** | `judge_track_eligibility` is checked inside `assignedProject`, so it gates reads *and* writes. Assignment creation also refuses it (`skipped: judge_not_eligible_for_track`) — an organizer cannot create an assignment that is guaranteed to be unreadable. |
| **Tests** | `a judge's queue only contains tracks they are eligible for` |
| **Residual** | **Low.** Eligibility is seeded from the fixture `tracks` arrays and is not editable in the UI. |

## 5. Role escalation via request body, query, or header

| | |
|---|---|
| **Asset** | The whole authorization model |
| **Mitigation** | `req.user` is set only by `attachIdentity`, from the `sessions` table. `req.user.role` is read from that row. No handler anywhere reads a role from the request. |
| **Tests** | `a judge cannot escalate by sending a role in the body`, `…by query parameter` |
| **Residual** | **Low**, with the caveat in §8. |

## 6. Session tampering and forgery

| | |
|---|---|
| **Asset** | Any identity |
| **Mitigation** | Sessions are opaque SHA-256-derived tokens looked up in a table; an unknown token resolves to *visitor*, and the route guard returns `401`. There is no self-signed token to forge, so the usual "change the payload" attack has no surface. |
| **Tests** | `a judge cannot mint a peer identity by spoofing a session cookie` — a well-formed but unknown token gets `401`, not a role |
| **Residual** | **Medium, and not fixed.** The four seeded sessions **do not expire** (`2099-01-01`). That is deliberate — the spec's design is that the checker never logs in and is handed a working header, and an expiring token would make the acceptance run flaky across days. It would be unacceptable in production. Sessions are also not rotated, not revoked on role change, and not bound to anything. See §13. |

## 7. Deadline manipulation

| | |
|---|---|
| **Asset** | The integrity of the submission window |
| **Mitigation** | `POST /api/projects` compares the event row's `submissions_close` to `Date.now()` **before reading anything in the body**. An unparseable date is `500 bad_deadline`, not an eternal open window. The form is disabled *and* the server refuses, so a crafted client changes nothing. |
| **Tests** | The official T1 check, plus a test asserting the error code is `event_closed` and the body names the fixture's close date |
| **Residual** | **Medium.** The comparison uses the **server's** clock. An organizer with host access can move the clock or edit the event row; `event.status_changed` would be audited, and a direct edit of an existing audit row is caught by the audit hash chain (`GET /api/organizer/audit/verify`, `npm run audit:verify`). The chain does not catch deletion of the newest rows or a full rewrite by someone with database access; record `headHash` elsewhere to cover that. The audit log records the *action*, not the *clock*. |

## 8. Stored XSS in a project submission

| | |
|---|---|
| **Asset** | Every judge and every gallery visitor |
| **Mitigation** | Two independent layers. (1) `escapeHtml` in `views/layout.js` is the only path from a value to markup; a project title, summary, description, comment and every custom answer go through it. (2) A CSP with no `unsafe-inline` and `frame-ancestors 'none'`, so an escaping bug that slips through has no script to run. URLs are filtered to `http`/`https` by `safeUrl`, because a `javascript:` URL in a fixture field is otherwise live script. |
| **Tests** | `a project title containing HTML is escaped…`, `a project description is escaped…`, `security headers are present on every response` — asserting the **absence** of raw markup, not that a function was called |
| **Residual** | **Low.** The known gap is the Judge Desk, which is the one surface with JavaScript. It is built without `innerHTML` and uses textContent throughout, but it is hand-written and the CSP's `script-src 'self'` allows `/assets/desk.js`. It deserves a dedicated review pass. |

## 9. CSRF

| | |
|---|---|
| **Asset** | Acting as a signed-in judge or organizer |
| **Mitigation** | Three layers. (1) Every JSON route requires `Content-Type: application/json`, which a cross-origin HTML form cannot set without a CORS preflight, and there is no CORS configuration so the preflight fails. (2) `src/middleware/csrf.js` runs after identity and before every handler: a state-changing request whose `Origin` or `Referer` is another host is refused `403 cross_origin`. An opaque `Origin: null` is refused, and a different port on the same host counts as cross-origin. (3) A state-changing request that is authenticated by the session cookie and carries `Origin`, `Referer` or `Sec-Fetch-Site` must present a synchroniser token, in the `X-CSRF-Token` header or the `_csrf` body field, or it is refused `403 csrf_token`. The token is HMAC-SHA256(server secret, session token), so it is bound to one session. The secret is `DOGFOOD_CSRF_SECRET`, else random per process. The token reaches the page through `<meta name="csrf-token">` and a hidden `_csrf` field on the submit form, and `public/assets/desk.js` sends it on every autosave. `/auth/login`, `/auth/register` and `/auth/redeem` are exempt because their forms render before a session exists. |
| **Tests** | 10 tests in `tests/authz/csrf.test.js`, including one asserting a cross-origin review write is refused **and does not land in the database**, and one asserting the official checker's request shape still reaches the handler and still gets `event_closed`. | `tests/authz/csrf-token.test.js` covers a browser-style POST with no token (403), a wrong or another session's token (403), a valid header or body token (allowed), a request with none of the three headers (allowed), the meta tag and hidden field, and login with a stale cookie.
| **Residual** | **Low.** A request with no `Origin`, `Referer` or `Sec-Fetch-Site` skips the token check by design. Browsers send at least one of them on a cross-site write, so this admits curl and the official checker, which POSTs with a cookie, a JSON content type and no `Origin`, and does not admit a browser. A browser too old to send any of the three is not covered. The per-process random secret invalidates open pages on restart. |

## 10. CSV export exposure

| | |
|---|---|
| **Asset** | Every project's scores, comments and rank in one document |
| **Mitigation** | `requireOrganizer`. Judges and participants are `403`; the tests assert the refusal body does not look like a CSV (`!text.includes("project_id,")`), because a `403` that returns the rows is a `403` in name. |
| **Residual** | **Low**, with one design consequence: any organizer can export everything, including individual judges' comments. For a real event that may need a per-judge consent or a redaction step. |

## 11. Score enumeration by id-guessing

| | |
|---|---|
| **Asset** | A specific project's score |
| **Mitigation** | Project ids are not sequential in a guessable way across authorization boundaries, and more importantly the *authorization* does not depend on guessing: an unassigned project is `403` whatever its id. The `?judge=` enumeration is refused for any non-self value. |
| **Residual** | **Low.** Project ids in the fixtures are readable (`prj_01`), which is fine — the data is public in the gallery. The gallery is deliberately public, so gallery enumeration is not an attack. |

## 12. Duplicate submissions and ballot stuffing

| | |
|---|---|
| **Asset** | The submission record |
| **Mitigation** | `POST /api/projects` refuses a second live submission per team per track with `409 duplicate_submission`, and `assignments UNIQUE (judge, project)` plus `reviews UNIQUE (assignment_id)` stop a judge inflating their own review count. |
| **Residual** | **Deliberately open, and visible.** The fixtures contain a real duplicate: `prj_07` and `prj_41` are both `tm_07` in `trk_03`, both titled `Dry Harbour`, both submitted before the deadline. **Both are loaded.** Rejecting either would be editing the organizer's data, and a submission accepted in time cannot be un-submitted. So `duplicateSubmissions()` surfaces it and the Control Room shows a Data integrity panel naming both, while the API refuses *new* duplicates. An organizer must decide which one enters judging; the platform refuses to decide for them. |

## 13. Replay of the seeded test logins

| | |
|---|---|
| **Asset** | The demo identities |
| **Mitigation** | None, and this is the design trade the spec asks for. The four logins are derived from a fixed seed (`SEED = "dogfood-2026-v1"`) so a wiped volume and a fresh clone produce the same headers — which is what makes the acceptance run reproducible across days and machines. The tokens are printed at boot and committed to `.dogfood.toml`. |
| **Residual** | **High, by construction, and correctly so.** Anyone with the repository has an organizer session. On a real deployment the seed identities would not exist and sessions would be per-account, expiring and revocable. This is called out in `docs/OPERATIONS.md` rather than buried, because a reader deciding whether to run this against real data needs to know it before they do, not after. |

## 14. Judge collusion

| | |
|---|---|
| **Asset** | The integrity of the ranking |
| **Mitigation** | Partial and diagnostic only. Per-judge mean, sd and `lambda` are published; a colluding pair tends to produce unusually low variance and unusually high mutual rank correlation. The Calibration Lab shows sd, so an organizer can *see* two flat judges. |
| **Residual** | **Not solved, and not detectable with the data this platform holds.** There is no pairwise-overlap graph, no correlation matrix, and no outlier-pair flag. Two judges who never share a project cannot be compared at all by this data. Detecting collusion properly needs either deliberate overlapping assignment (so there is a shared baseline) or content analysis of comments. **Documented as future work in `JUDGING.md`, not claimed as a feature.** |

## 15. Migration and container operations

| | |
|---|---|
| **Asset** | Data integrity across restarts |
| **Mitigation** | Migrations are numbered, append-only, each applied in its own transaction and recorded in `schema_migrations`; a half-applied migration cannot be skipped. A restart against an existing volume detects a non-empty `events` table and **skips seeding**, so nothing duplicates. Foreign keys are ON (SQLite defaults them off). WAL plus a 5 s busy timeout. |
| **Residual** | **Low**, with one unverified item: `docker compose up --build` has never been executed, because this machine has no Docker daemon. The highest-probability failure is the `better-sqlite3` prebuild for `node:22-bookworm-slim`; if no prebuilt binary matches it falls back to `node-gyp`, and `bookworm-slim` has no compiler toolchain. The fix is a `build-essential` layer. This is stated in `docs/OPERATIONS.md` and in the README's limitations, and it is **the largest gap in the submission.** |

---

## Summary

| # | Attack | Status |
|---|---|---|
| 1 | Judge reads peer scores | **Solved** — 403, payload verified empty |
| 2 | Participant reaches judge endpoints | **Solved** — middleware role guard |
| 3 | Unassigned project read/write | **Solved** — assignment AND eligibility |
| 4 | Cross-track access | **Solved** — eligibility gates read and write |
| 5 | Role escalation via input | **Solved** — identity is session-only |
| 6 | Session forgery | **Solved**, expiry **not** solved (§6) |
| 7 | Deadline manipulation | Server-enforced; **host clock is trusted** (§7) |
| 8 | Stored XSS | **Solved** — escaping + CSP; Judge Desk unreviewed |
| 9 | CSRF | **Partially mitigated** — Origin/Referer refused; **no token** (§9) |
| 10 | CSV exposure | **Solved** for non-organizers; organizer sees all |
| 11 | Score enumeration | **Solved** — authorization does not depend on the id |
| 12 | Duplicate submissions | **Refused for new**, surfaced for historical (§12) |
| 13 | Replay of seeded logins | **Open by design**, disclosed (§13) |
| 14 | Judge collusion | **Not solved** — diagnostic only (§14) |
| 15 | Container / migration ops | Code sound; **Docker never executed** (§15) |

**Three things are not solved: judge collusion detection, session expiry and
revocation, and the unexecuted Docker build.** Three more have stated residual
risk: the missing CSRF token, the host clock, and the unreviewed Judge Desk
JavaScript.

Attack #1 was found **open** by an independent review after every other layer
had passed, and the document above had claimed it closed. That is the reason
the sweep exists, and the reason this summary is written from test names rather
than from intentions.

The next three to fix, in order, are the Docker verification on a machine that
has Docker, session expiry with revocation on role change, and a synchroniser
CSRF token once the graded contract no longer forbids one.

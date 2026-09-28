# DOGFOOD — stack decision

Recorded before implementation, because the spec says "pick what you know" and
the choice is the one thing that cannot be changed cheaply later.

## Requirements that actually bind

From `official/spec.md` §"the five things that are actually required":

1. `docker compose up` brings up a working, seeded portal **with the network
   off**. No cloud accounts, no hosted database, no external API.
2. OSI license.
3. New code during the event window.
4. `.dogfood.toml` at root, honest tier claims.
5. `acceptance-report.txt` committed.

From the acceptance checker, the routes must be reachable over plain HTTP with
a single header, and `/api/export.csv` must return a body whose first line
contains a comma.

## Candidates

| | A. Next.js + Drizzle | B. Express + better-sqlite3 + server-rendered HTML | C. Express + React SPA |
|---|---|---|---|
| Build step | required (`next build`) | **none** | required (bundler) |
| Docker image | ~450 MB, multi-stage | **~120 MB, single stage** | ~200 MB + build stage |
| Offline build | needs npm cache layer | **needs nothing beyond prod deps** | needs registry for build deps |
| Cold-start time | framework boot | **process boot, ms** | framework boot |
| Failure mode that costs acceptance | build/type error blocks *all 7 checks* | **runtime only, route-scoped** | build error blocks all 7 |
| Fixture seeding | ORM migrations + seed script | **single SQL file, deterministic** | same as B |
| CSV export | route handler | **route handler** | route handler |
| Judge desk interactivity | React | **~120 lines vanilla JS, autosave via fetch** | React |
| Backend authorization | must be server-side in route handlers | **must be server-side in middleware; same** | same |

## Decision: B — Express + better-sqlite3 + server-rendered HTML

The deciding factor is not preference, it is the shape of the failure. The
acceptance suite makes seven requests to a running process. With A or C, a
TypeScript or bundler error means the process never starts and **all seven
checks fail** for a reason that has nothing to do with the product. With B
there is no build step, so a defect is confined to the route that has it: a
broken gallery cannot take down the CSV export.

`better-sqlite3` was verified to load its native binding on this machine before
it was chosen, so the single most common way this stack fails (a prebuilt
binary that does not match the platform) is already ruled out.

The Judge Desk is the one surface that wanted a framework. It is a form with
autosave and keyboard shortcuts, which is ~120 lines of vanilla JS against a
JSON API. Adding React to save that would add a build step to the critical
path for no product gain.

Rejected outright: Supabase, Firebase, Clerk, Auth0, hosted Redis, any remote
LLM. The spec forbids them and they break requirement 1.

## What this costs, stated plainly

- No component library, so the four surfaces are hand-built. That is more CSS
  to write and fewer accessibility primitives than a component kit gives. The
  Judge Desk and the Control Room are where that shows.
- The gallery has no client-side virtualisation. Forty fixture projects do not
  need it, and 40 rows is under a single paint.

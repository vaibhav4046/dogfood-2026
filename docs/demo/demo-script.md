# Demo

Two files, both produced by running the real portal. Nothing is composited, no
footage is staged, and no number in them is typed by hand.

| File | What it is |
|---|---|
| [`demo.mp4`](demo.mp4) | 1m 20s, H.264, 1440x900 — plays everywhere |
| [`demo.webm`](demo.webm) | 1m 20s, VP8 — the direct Playwright capture, untranscoded |
| [`demo.srt`](demo.srt) | 18 caption cues, generated during the capture |
| `product-recording/` | 8 PNG frames of the real UI, used as the source of the video |

Regenerate with:

```bash
npm ci
node scripts/save-acceptance.js                      # writes acceptance-report.txt first
node scripts/with-server.js node scripts/record-demo.js
node scripts/encode-demo.js
```

## How it was recorded

`scripts/record-demo.js` drives the running portal with Playwright and records
the viewport. The only things it adds are a title card, a request/response
pane, and a terminal card — no product pixels are altered. Every refusal in the
video is an actual HTTP request against the actual server, with the actual
status and the actual body on screen.

The acceptance report shown at 01:20 is read from the committed
`acceptance-report.txt` at record time, so the video cannot claim a result the
repository does not contain.

## Beat sheet

The spec's storyboard is 5:00. This is 1:20, because every beat is a real screen
change and a real request and there was nothing to pad it with. The order and
the content follow the spec beat for beat.

| Spec beat | Shown at | What is on screen |
|---|---|---|
| — | 00:00 | Title card: what it is, what is seeded |
| 00:20 | 00:05 | Organizer control room, top: event, submission and judge counts |
| 00:20 | 00:11 | Control room scrolled to the Calibration Lab |
| 00:45 | 00:15 | Public gallery, 41 fixture projects, no account |
| 00:45 | 00:21 | Gallery search: `?q=harbour`, server-side |
| 01:05 | 00:26 | `POST /api/projects` as participant → **403 event_closed**, with the fixture's close date |
| 01:30 | 00:31 | `GET /api/judge/desk` as judge_a — the assignment queue |
| 02:00 | 00:37 | Judge desk: project, rubric, evidence, notes on one surface |
| 02:00 | 00:41 | Scoring it — autosave reports itself |
| 02:00 | 00:45 | **Reload.** The scores come back. Silence here would be data loss |
| 02:30 | 00:50 | `GET /api/judge/scores?judge=judge_a` as judge_b → **403 peer_isolation** |
| 02:55 | 00:55 | `GET /api/judge/scores` as participant → **403 forbidden** |
| 03:00 | 01:00 | `GET /api/export.csv` as participant → **403** |
| 03:15 | 01:05 | Calibration Lab: judge severity, raw vs normalized, rank movement |
| 04:00 | 01:11 | `GET /api/export.csv` as organizer → 200 CSV, and a publish with a fingerprint |
| 04:10 | 01:16 | Audit log |
| 04:30 | 01:20 | The committed acceptance report: **7 / 7** |
| 04:50 | 01:24 | Close |

## Why the refusals are the demo

The spec says judge isolation is "the one that matters most" and that a hidden
control is not a refusal. So the middle of this video is three refused
requests, shown as requests and responses rather than narrated:

1. **judge_b → judge_a's scores.** `403 peer_isolation`. The body contains no
   score rows, which is asserted in `tests/authz/adversarial.test.js` and again
   in `tests/authz/surface-sweep.test.js` across every route in the app.
2. **participant → a judge endpoint.** `403 forbidden`. A participant is a
   known user with a valid session, so this is a role check rather than a
   missing login.
3. **participant → the results CSV.** `403`. The refusal body is not a CSV.

An earlier build of this repository passed all three of those on the URL the
official checker probes and still leaked every judge's statistics on a second,
unlisted route. That is why the demo shows the *responses* and not a caption
claiming isolation, and why the sweep discovers its routes rather than listing
them.

## Frames

`product-recording/` holds the eight real frames the video is built from:

| Frame | Surface |
|---|---|
| `01-organizer-top.png` | `/organizer` |
| `02-organizer-calibration.png` | Calibration Lab |
| `03-gallery.png` | `/projects` |
| `04-gallery-search.png` | filtered gallery |
| `05-judge-desk.png` | `/judge/:id` |
| `06-judge-scored.png` | after scoring, autosaved |
| `07-calibration.png` | Calibration Lab, severity and movement |
| `08-audit.png` | `/organizer/audit` |

Wider screenshot coverage — six viewports from 375x812 to 1920x1080, overflow
and console-error checks — is in [`../screenshots/`](../screenshots/), produced
by `scripts/screenshots.js`.

## Honest notes

- **The video is 1m 20s, not 5 minutes.** The spec sets five minutes as a
  maximum. Compressing it means every second shows something real.
- **`docker compose up` is not in the video**, because it was never run on the
  machine that recorded it. The video shows the same `src/server.js` entrypoint
  the container runs. That gap is in
  [`../../docs/OPERATIONS.md`](../../docs/OPERATIONS.md) and in the README's
  limitations.
- **The browser is system Chrome**, not the Playwright Chromium, because the
  headless-shell download was absent. The recorder prints which browser it used.
  The rendering is the same DOM; only the binary differs.
- **No narration.** The captions exist so a silent viewer still follows the
  argument, and the product itself is the evidence.

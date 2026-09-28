"use strict";

const { layout } = require("./layout");

/**
 * Ten-second read. The landing page's only job is to send a judge to the
 * gallery or the acceptance report; everything technical lives in the docs,
 * and the honest tier line is on the page rather than only in the README.
 */
function renderLanding(db) {
  const event = db.prepare(`SELECT * FROM events LIMIT 1`).get();
  const counts = {
    projects: db.prepare(`SELECT COUNT(*) n FROM projects`).get().n,
    teams: db.prepare(`SELECT COUNT(*) n FROM teams`).get().n,
    tracks: db.prepare(`SELECT COUNT(*) n FROM tracks`).get().n,
    judges: db.prepare(`SELECT COUNT(*) n FROM users WHERE role='judge'`).get().n,
    reviews: db.prepare(`SELECT COUNT(*) n FROM reviews WHERE status='submitted'`).get().n,
  };

  const body = `
<a class="skip" href="#main">Skip to content</a>
<div class="banner warn">
  <strong>Demo data.</strong> Every project, judge and score on this instance comes from
  the official <code>fixtures.json</code>. The seeded event closed on
  <span class="mono">${event ? escape(event.submissions_close) : "—"}</span>, so
  submissions are refused by the backend. Nothing here is a real hackathon.
</div>

<h1>Judging you can inspect.</h1>
<p class="lede">
  DOGFOOD is a self-hosted submission and judging platform for hackathons. It runs
  from one <code>docker compose up</code> against a local SQLite file, with no
  hosted database, no external API and no network. Judge isolation is enforced in
  the backend, and every scoring decision can be shown in both its raw and its
  normalized form.
</p>

<div class="row" style="margin:0 0 28px;gap:10px;flex-wrap:wrap">
  <a class="btn primary" href="/projects">Open the gallery</a>
  <a class="btn" href="/organizer">Organizer control room</a>
  <a class="btn" href="/judge">Judge desk</a>
</div>

<div class="grid cols-4">
  ${kpi("Projects", counts.projects)}
  ${kpi("Teams", counts.teams)}
  ${kpi("Tracks", counts.tracks)}
  ${kpi("Judges", counts.judges)}
  ${kpi("Completed reviews", counts.reviews)}
  ${kpi("Claims", "T1 T2")}
  ${kpi("Acceptance", "7 checks")}
  ${kpi("External calls", 0)}
</div>

<h2>What it does</h2>
<div class="grid cols-2">
  ${feature("T1 · Core", "Public gallery over fixture data, teams and tracks, and a submission deadline enforced by the server rather than by hiding the form. The seeded event is already closed, so a late POST is refused with 403 and the fixture's close date.")}
  ${feature("T2 · Judging", "Rubric with organizer-set weights, per-judge assignment with track eligibility, a judge desk that autosaves, and a results CSV. A judge requesting another judge's scores gets 403 from the API, not an empty template.")}
  ${feature("Calibration lab", "Per-judge mean, standard deviation, review count and coverage. Raw ranking and normalized ranking side by side, with the rank movement and a reason on every adjusted project.")}
  ${feature("Audit trail", "Every high-value mutation writes actor, action, target, previous state, new state and a request id. The control room reads it back in order.")}
</div>

<h2>Verify it yourself</h2>
<div class="card">
  <p class="faint" style="margin-top:0">The official acceptance checker is unmodified. It makes seven
  requests to a running portal and prints one line per check.</p>
  <pre class="mono" style="background:var(--bg);border:1px solid var(--border);border-radius:var(--r);
    padding:12px;overflow-x:auto;margin:0;color:var(--dim)">docker compose up --build
# wait for the four session headers it prints
python official/run.py .dogfood.toml</pre>
</div>
`;

  return layout({ title: "Judging you can inspect", user: null, body, active: "" });
}

function kpi(label, value) {
  return `<div class="kpi"><div class="label">${label}</div>
    <div class="value">${value}</div></div>`;
}

function feature(title, text) {
  return `<div class="card"><h3 style="margin-top:0">${title}</h3>
    <p class="faint" style="margin:0">${text}</p></div>`;
}

function escape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { renderLanding };

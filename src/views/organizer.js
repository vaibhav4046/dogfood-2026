"use strict";

const { layout, safeText } = require("./layout");

/**
 * Organizer control room + calibration lab.
 *
 * The rule for this page: a number appears because it changes a decision. There
 * is no chart of project counts over time with no time axis, and no "engagement"
 * tile. A judge who cannot act on a number does not get the number.
 */

function renderControlRoom(d) {
  const { event, kpis, results, trackDistribution, judgeProgress, unassigned, underReviewed, overloaded, rubric, duplicates, recentAudit, user } = d;
  const hasResults = results.mode !== "none";
  const maxProjects = Math.max(1, ...trackDistribution.map((t) => t.projects));

  const body = `
<a class="skip" href="#main">Skip to content</a>
<div class="row" style="align-items:flex-end;margin-bottom:16px">
  <div>
    <h1>${safeText(event.name, "Event")}</h1>
    <p class="lede" style="margin:0">Submissions closed
      <span class="mono">${safeText(event.submissions_close)}</span> ·
      status <span class="pill ${event.status === "published" ? "good" : "dim"}">${safeText(event.status)}</span>
    </p>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <a class="btn" href="/organizer/audit">Audit log</a>
    <a class="btn" href="/api/export.csv">Export CSV</a>
  </div>
</div>

<div class="grid cols-4" style="margin-bottom:24px">
  ${kpi("Projects", kpis.projects, `${kpis.teams} teams`)}
  ${kpi("Judges", kpis.judges, `${kpis.assignments} assignments`)}
  ${kpi("Completed reviews", kpis.completedReviews, `${results.coverage ? results.coverage.assigned - kpis.completedReviews : 0} outstanding`)}
  ${kpi("Normalization", hasResults ? "ready" : "—",
    hasResults ? `fingerprint ${results.fingerprint}` : "no completed reviews")}
</div>

${hasResults ? renderCalibration(results) : `<div class="banner warn">No completed reviews yet,
  so raw and normalized rankings are both empty. ${safeText(event.name)} closed before any
  judge finished.</div>`}

<h2>Where to act next</h2>
<div class="grid cols-3">
  ${list("Unassigned projects", unassigned.map((p) => `${p.title} · ${p.track}`),
    `${unassigned.length} project${unassigned.length === 1 ? "" : "s"} nobody can score yet.`)}
  ${list("Under-reviewed", underReviewed.filter((p) => p.assigned > 0).map((p) => `${p.title} · ${p.assigned} assignment${p.assigned === 1 ? "" : "s"}`),
    "Assigned, but fewer than two independent judges.")}
  ${list("Overloaded judges", overloaded.map((j) => `${j.name} · ${j.done}/${j.assigned} done`),
    "Less than a third of their queue submitted.")}
</div>

${duplicates && duplicates.length
  ? `<h2>Data integrity</h2>
     <div class="banner bad"><strong>${duplicates.length} duplicate live submission${duplicates.length === 1 ? "" : "s"}.</strong>
     New duplicates are refused by the API with <span class="mono">409 duplicate_submission</span>.
     These arrived before the deadline and cannot be un-submitted, so they are shown rather
     than merged or hidden. Decide which one enters judging.</div>
     <div class="card flush"><table>
       <thead><tr><th>Team</th><th>Track</th><th class="num">Count</th><th>Submissions</th></tr></thead>
       <tbody>${duplicates.map((d) => `<tr>
         <td>${safeText(d.teamName)} <span class="faint mono">${safeText(d.teamId)}</span></td>
         <td>${safeText(d.trackName)}</td>
         <td class="num mono">${d.count}</td>
         <td class="mono faint" style="font-size:11px">${d.projects.map((p) => safeText(p)).join("<br>")}</td>
       </tr>`).join("")}</tbody>
     </table></div>`
  : `<h2>Data integrity</h2><div class="banner good">No duplicate live submissions. One live
     submission per team per track is enforced by the API.</div>`}

<h2>Rubric</h2>
<div class="card flush">
  <table>
    <thead><tr><th>Criterion</th><th class="num">Weight</th><th class="num">Scale</th><th>Source</th></tr></thead>
    <tbody>${rubric.map((c) => `<tr>
      <td>${safeText(c.label)}</td>
      <td class="num mono">${c.weight}</td>
      <td class="num mono">${c.min}–${c.max}</td>
      <td class="faint">organizer-configurable · <span class="mono">POST /api/organizer/rubric</span></td>
    </tr>`).join("")}</tbody>
  </table>
</div>

<h2>Projects by track</h2>
<div class="card">
  ${trackDistribution.map((t) => `<div class="bar-row">
    <div><div class="name">${safeText(t.track)}</div>
      <div class="bar" style="margin-top:5px"><span style="width:${Math.round((t.projects / maxProjects) * 100)}%"></span></div></div>
    <div class="mono">${t.projects}</div>
  </div>`).join("")}
</div>

<h2>Judge progress</h2>
<div class="card flush">
  <table>
    <thead><tr><th>Judge</th><th class="num">Assigned</th><th class="num">Done</th><th>Progress</th></tr></thead>
    <tbody>${judgeProgress.map((j) => {
      const pct = j.assigned ? Math.round((j.done / j.assigned) * 100) : 100;
      return `<tr>
        <td>${safeText(j.name)}</td>
        <td class="num mono">${j.assigned}</td>
        <td class="num mono">${j.done}</td>
        <td style="min-width:140px"><div class="bar ${pct === 100 ? "good" : pct >= 50 ? "" : "warn"}">
          <span style="width:${pct}%"></span></div></td>
      </tr>`;
    }).join("") || '<tr><td colspan="4" class="faint">No judges.</td></tr>'}</tbody>
  </table>
</div>

<h2>Recent activity</h2>
<div class="card flush">
  <table>
    <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Target</th></tr></thead>
    <tbody>${recentAudit.map((a) => `<tr>
      <td class="mono faint">${safeText(String(a.created_at).slice(11, 19))}</td>
      <td>${safeText(a.action)}</td>
      <td>${safeText(a.actor_name || a.actor_role || "system")}</td>
      <td class="mono faint">${safeText(a.target_type)}${a.target_id ? " " + safeText(a.target_id) : ""}</td>
    </tr>`).join("") || '<tr><td colspan="4" class="faint">Nothing yet.</td></tr>'}</tbody>
  </table>
</div>
`;

  return layout({ title: "Control room", user, body, active: "organizer" });
}

function renderCalibration(r) {
  const moves = r.projects
    .filter((p) => p.rankMovement !== null && p.rankMovement !== 0)
    .sort((a, b) => Math.abs(b.rankMovement) - Math.abs(a.rankMovement))
    .slice(0, 12);

  return `
<h2>Calibration lab</h2>
<p class="lede">Raw and normalized, side by side. Raw is each judge's own numbers averaged
  by rubric weight. Normalized removes per-judge severity, shrinks toward the global
  distribution when a judge has few reviews, and is left untouched when a judge has no
  spread to remove. The method is in <span class="mono">JUDGING.md</span>; the worked
  numbers are in <span class="mono">normalization-proof.md</span>.</p>
<div class="banner">
  <span class="mono">fingerprint ${safeText(r.fingerprint)}</span> ·
  global mean <span class="mono">${r.global.mean.toFixed(4)}</span> ·
  global sd <span class="mono">${r.global.sd.toFixed(4)}</span> ·
  ${r.coverage.distinctJudges} judges over ${r.coverage.distinctProjects} projects
</div>

<div class="split">
  <div>
    <h3>Judge severity</h3>
    <div class="card flush">
      <table>
        <thead><tr><th>Judge</th><th class="num">n</th><th class="num">mean</th>
          <th class="num">sd</th><th class="num">λ</th><th>Notes</th></tr></thead>
        <tbody>${r.judgeStats
          .sort((a, b) => b.mean - a.mean)
          .map((j) => `<tr>
            <td>${safeText(j.name)}</td>
            <td class="num mono">${j.reviewCount}</td>
            <td class="num mono">${j.mean.toFixed(3)}</td>
            <td class="num mono">${j.sd.toFixed(3)}</td>
            <td class="num mono">${j.lambda.toFixed(2)}</td>
            <td>${
              j.degenerate
                ? '<span class="pill warn">no spread — kept raw</span>'
                : j.reviewCount < 3
                  ? `<span class="pill dim">thin sample, shrunk</span>`
                  : '<span class="faint">—</span>'
            }</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="faint" style="font-size:12px">λ is the shrinkage factor n/(n+4): how much of
      this judge's own spread is trusted before being pulled toward the global
      distribution.</p>
  </div>

  <div>
    <h3>Rank movement</h3>
    <div class="card flush">
      <table>
        <thead><tr><th>Project</th><th class="num">raw</th><th class="num">norm</th><th class="num">Δ</th></tr></thead>
        <tbody>${moves.length
          ? moves.map((p) => `<tr>
              <td>${safeText(p.title)}</td>
              <td class="num mono">${p.raw?.rank ?? "—"}</td>
              <td class="num mono">${p.normalized?.rank ?? "—"}</td>
              <td class="num"><span class="delta ${p.rankMovement > 0 ? "up" : "down"}">${
                p.rankMovement > 0 ? "▲" : "▼"}${Math.abs(p.rankMovement)}</span></td>
            </tr>`).join("")
          : '<tr><td colspan="4" class="faint">No project changed rank.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</div>

<div class="grid cols-2" style="margin-top:16px">
  <div><h3>Raw ranking</h3>${rankTable(r.raw)}</div>
  <div><h3>Normalized ranking</h3>${rankTable(r.normalized)}</div>
</div>
`;
}

function rankTable(rows) {
  if (!rows || !rows.length) return `<div class="card faint">Empty.</div>`;
  return `<div class="card flush"><table>
    <thead><tr><th class="num">#</th><th>Project</th><th class="num">Score</th><th class="num">n</th></tr></thead>
    <tbody>${rows
      .slice(0, 20)
      .map(
        (p) => `<tr><td class="num mono">${p.rank}</td>
        <td>${safeText(p.title)}${p.flagged ? ' <span class="pill dim" title="a zero-variance or thin-sample judge contributed">flag</span>' : ""}</td>
        <td class="num mono">${p.score.toFixed(4)}</td>
        <td class="num mono faint">${p.reviewCount}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
}

function list(title, items, hint) {
  return `<div class="card">
    <h3 style="margin-top:0">${title} <span class="faint" style="font-weight:400">(${items.length})</span></h3>
    <p class="faint" style="font-size:12px;margin:0 0 10px">${hint}</p>
    ${
      items.length
        ? `<ul style="margin:0;padding-left:18px;font-size:13px">${items
            .slice(0, 8)
            .map((i) => `<li>${safeText(i)}</li>`)
            .join("")}${items.length > 8 ? `<li class="faint">…and ${items.length - 8} more</li>` : ""}</ul>`
        : '<span class="faint" style="font-size:13px">Nothing here.</span>'
    }
  </div>`;
}

function renderAudit({ rows, user, chain }) {
  const chainLine = !chain
    ? ""
    : chain.ok
      ? `<p class="mono" data-chain="ok">Hash chain intact: ${chain.rows} rows, head ${esc(chain.headHash.slice(0, 16))}</p>`
      : `<p class="mono" data-chain="broken" role="alert">Hash chain broken at row ${chain.firstBrokenIndex} of ${chain.rows}. Rows are ordered oldest first by position.</p>`;
  const body = `
<a class="skip" href="#main">Skip to content</a>
<p style="margin:0 0 12px"><a href="/organizer">&larr; Control room</a></p>
<h1>Audit log</h1>
<p class="lede">Every high-value mutation, newest first. Refusals are recorded too —
"judge_b asked for judge_a's scores" is exactly the row an organizer needs.</p>
${chainLine}
<div class="card flush scroll">
  <table>
    <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Target</th><th>Request</th><th>State</th></tr></thead>
    <tbody>${rows
      .map(
        (a) => `<tr>
        <td class="mono faint" style="white-space:nowrap">${safeText(a.created_at)}</td>
        <td>${safeText(a.action)}</td>
        <td>${safeText(a.actor_name || a.actor_role || "system")}</td>
        <td class="mono faint">${safeText(a.target_type)} ${safeText(a.target_id || "")}</td>
        <td class="mono faint" style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${safeText(a.request_id)}</td>
        <td class="faint" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${safeText(`${a.previous_state || ""} ${a.new_state || ""}`)}">${safeText(
          [a.previous_state, a.new_state].filter(Boolean).join(" → "),
        )}</td>
      </tr>`,
      )
      .join("")}</tbody>
  </table>
</div>`;
  return layout({ title: "Audit log", user, body, active: "organizer" });
}

function kpi(label, value, sub) {
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}

module.exports = { renderControlRoom, renderAudit };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

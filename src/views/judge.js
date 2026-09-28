"use strict";

const { layout } = require("./layout");

/**
 * Judge desk.
 *
 * A judge has 30-ish projects to get through. Everything needed to score one —
 * the project, the rubric, the evidence links, the score controls, the note,
 * and the next/previous navigation — is on one surface with no page
 * transition. Autosave is a debounced fetch that shows its own state, because
 * a silent autosave is indistinguishable from a broken one.
 *
 * Accessibility that actually matters here: every control is a real button or
 * input with a label, the score group is a radiogroup, and the save status is
 * an aria-live region so a screen reader hears "saved" without moving focus.
 */

function renderDesk({ queue, user }) {
  const pct = queue.total ? Math.round((queue.done / queue.total) * 100) : 0;

  const rows = queue.items
    .map(
      (i) => `<tr>
      <td>
        <a href="/judge/${esc(i.projectId)}">${esc(i.title)}</a>
        <div class="faint" style="font-size:12px">${esc(i.tagline || "—")}</div>
      </td>
      <td><span class="tag">${esc(i.trackName)}</span></td>
      <td class="num mono">${i.reviewStatus === "submitted" ? i.weightedScore.toFixed(2) : "—"}</td>
      <td>${
        i.reviewStatus === "submitted"
          ? '<span class="pill good">submitted</span>'
          : i.reviewStatus === "draft"
            ? '<span class="pill warn">draft</span>'
            : '<span class="pill dim">pending</span>'
      }</td>
    </tr>`,
    )
    .join("");

  const body = `
<a class="skip" href="#main">Skip to content</a>
<h1>Judge desk</h1>
<p class="lede">Only projects assigned to you appear here, and only in tracks you are
eligible for. You cannot see another judge's scores, and they cannot see yours.</p>

<div class="grid cols-4" style="margin-bottom:20px">
  <div class="kpi"><div class="label">Progress</div>
    <div class="value">${queue.done} / ${queue.total}</div>
    <div class="bar ${pct === 100 ? "good" : pct >= 50 ? "" : "warn"}" style="margin-top:8px">
      <span style="width:${pct}%"></span></div></div>
  <div class="kpi"><div class="label">Remaining</div><div class="value">${queue.remaining}</div></div>
  <div class="kpi"><div class="label">Rubric</div><div class="value">${queue.criteria.length}</div>
    <div class="sub">${queue.criteria.map((c) => esc(c.label)).join(" · ")}</div></div>
  <div class="kpi"><div class="label">Isolation</div><div class="value" style="color:var(--good)">enforced</div>
    <div class="sub">server-side, every request</div></div>
</div>

<div class="card" style="padding:0">
  <table>
    <caption class="sr">Your assigned projects</caption>
    <thead><tr>
      <th>Project</th><th>Track</th><th class="num">Score</th><th>Status</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="faint">Nothing assigned to you yet.</td></tr>'}</tbody>
  </table>
</div>
`;

  return layout({ title: "Judge desk", user, body, active: "judge" });
}

function renderDeskProject({ assignment, criteria, user }) {
  const done = assignment.reviewStatus === "submitted";

  const groups = criteria
    .map((c) => {
      const radios = [];
      for (let v = c.min; v <= c.max; v += 1) {
        const id = `s-${c.key}-${v}`;
        radios.push(
          `<label class="scoreopt" for="${id}">
             <input type="radio" id="${id}" name="score-${esc(c.key)}" value="${v}"
               ${v === 3 ? "checked" : ""}>
             <span>${v}</span>
           </label>`,
        );
      }
      return `<fieldset class="scoregroup">
        <legend>${esc(c.label)} <span class="faint">weight ${c.weight}</span></legend>
        <div class="scoreopts" role="radiogroup" aria-label="${esc(c.label)}">${radios.join("")}</div>
      </fieldset>`;
    })
    .join("");

  const body = `
<a class="skip" href="#main">Skip to content</a>
<p style="margin:0 0 12px"><a href="/judge">&larr; Judge desk</a></p>
<h1>${esc(assignment.title)}</h1>
<p class="lede">${esc(assignment.tagline || "")}</p>
<div class="tags" style="margin-bottom:16px"><span class="tag">${esc(assignment.track_name)}</span>
  ${done ? '<span class="pill good">submitted</span>' : '<span class="pill warn">in progress</span>'}</div>

<div class="split">
  <div class="card">
    <h3 style="margin-top:0">Project</h3>
    <p style="white-space:pre-wrap;margin:0 0 12px">${esc(assignment.description || "No description.")}</p>
    <table><tbody>
      <tr><th style="width:110px">Repository</th><td>${assignment.repo_url
        ? `<a href="${esc(assignment.repo_url)}" rel="noopener noreferrer nofollow">${esc(assignment.repo_url)}</a>`
        : '<span class="faint">none</span>'}</td></tr>
      <tr><th>Demo</th><td>${assignment.demo_url
        ? `<a href="${esc(assignment.demo_url)}" rel="noopener noreferrer nofollow">${esc(assignment.demo_url)}</a>`
        : '<span class="faint">none</span>'}</td></tr>
      <tr><th>Live</th><td>${assignment.live_url
        ? `<a href="${esc(assignment.live_url)}" rel="noopener noreferrer nofollow">${esc(assignment.live_url)}</a>`
        : '<span class="faint">none</span>'}</td></tr>
    </tbody></table>
  </div>

  <form class="card" id="review" data-project="${esc(assignment.id)}">
    <h3 style="margin-top:0">Your review</h3>
    ${groups}
    <label for="comment">Notes for the team</label>
    <textarea id="comment" placeholder="What worked, what did not, what you would change.">${esc(assignment.comment || "")}</textarea>
    <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn primary" type="button" id="submit-review">Submit review</button>
      <span id="save-state" class="faint" role="status" aria-live="polite" style="font-size:12px">Not saved yet</span>
    </div>
    <p class="faint" style="font-size:12px;margin:12px 0 0">Changes autosave as a draft.
      Submitting is final for this assignment. Keyboard: <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd>
      to submit, <kbd>j</kbd>/<kbd>k</kbd> to move between projects.</p>
  </form>
</div>

<script src="/assets/desk.js"></script>
`;

  return layout({ title: assignment.title, user, body, active: "judge" });
}

module.exports = { renderDesk, renderDeskProject };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

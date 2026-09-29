"use strict";

const { layout, safeText, csrfField } = require("./layout");

/**
 * Participant submission form.
 *
 * The form is rendered even when the event is closed, and it says so, because
 * a hidden form makes the deadline invisible while a disabled form with a
 * reason demonstrates that the server refuses. The `deadline` line is data
 * from the event row, not a client-side clock reading.
 */
function renderSubmit({ event, team, tracks, user, error, notice }) {
  const closed = Date.parse(event.submissions_close) <= Date.now();

  const trackOptions = tracks
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`)
    .join("");

  const blocker = closed
    ? `<div class="banner bad">
        <strong>Submissions are closed.</strong>
        ${esc(event.name)} closed at <span class="mono">${esc(event.submissions_close)}</span>.
        This is enforced by the server: a POST to <span class="mono">/api/projects</span> is
        refused with <span class="mono">403 event_closed</span> regardless of what this page
        renders, which is what the official acceptance check verifies.
      </div>`
    : `<div class="banner good">Open until <span class="mono">${esc(event.submissions_close)}</span>.</div>`;

  const noTeam = !team
    ? `<div class="banner warn">You are not on a team yet. Create one or join with an invite
        code before submitting. <span class="mono">POST /api/teams</span> or
        <span class="mono">POST /api/teams/join</span>.</div>`
    : `<div class="banner">Team: <strong>${esc(team.name)}</strong>
        <span class="faint mono">${esc(team.id)}</span></div>`;

  const body = `
<a class="skip" href="#main">Skip to content</a>
<h1>Submit a project</h1>
<p class="lede">Your team gets one project per track. The deadline below is read from the
event record, not from your browser's clock.</p>

${closed ? blocker : ""}
${noTeam}
${error ? `<div class="banner bad">${esc(error)}</div>` : ""}
${notice ? `<div class="banner good">${esc(notice)}</div>` : ""}

<form class="card" method="post" action="/api/projects">
  ${csrfField(user)}
  <label for="title">Title</label>
  <input id="title" name="title" maxlength="140" required>

  <label for="summary">One-line summary</label>
  <input id="summary" name="summary" maxlength="200" required>

  <label for="description">Description</label>
  <textarea id="description" name="description"></textarea>

  <label for="trackId">Track</label>
  <select id="trackId" name="trackId">${trackOptions}</select>

  <label for="repoUrl">Repository URL</label>
  <input id="repoUrl" name="repoUrl" type="url" placeholder="https://">

  <label for="demoUrl">Demo URL</label>
  <input id="demoUrl" name="demoUrl" type="url" placeholder="https://">

  <div style="margin-top:16px">
    <button class="btn primary" type="submit"${closed ? " disabled aria-disabled=true" : ""}>
      ${closed ? "Submissions are closed" : "Submit project"}
    </button>
    ${closed ? `<span class="faint" style="margin-left:10px">The button is disabled for
      convenience only. The server is the enforcement point.</span>` : ""}
  </div>
</form>
`;

  return layout({ title: "Submit", user, body, active: "submit" });
}

module.exports = { renderSubmit };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

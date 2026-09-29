"use strict";

const { layout, safeText } = require("../views/layout");

/**
 * Public gallery.
 *
 * The acceptance check is that a fixture project title appears in this HTML,
 * so every card renders the title as text in the server response. Titles,
 * taglines, summaries and custom answers are all attacker-controlled and pass
 * through `safeText`, which escapes them; a project description containing
 * `<script>` appears as those literal characters.
 */
function renderGallery({ rows, tracks, total, q, track, user }) {
  const options = tracks
    .map(
      (t) =>
        `<option value="${esc(t.id)}"${t.id === track ? " selected" : ""}>${esc(t.name)}</option>`,
    )
    .join("");

  const cards = rows.length
    ? rows
        .map((r) => {
          const tags = JSON.parse(r.tech_tags || "[]")
            .map((t) => `<span class="tag">${esc(t)}</span>`)
            .join("");
          return `<article class="proj">
        <h4>${safeText(r.title, "Untitled")}</h4>
        <div class="summary">${safeText(r.tagline || r.description, "No description")}</div>
        <div class="meta">
          <span class="tag">${esc(r.track_name)}</span>
          <span>${esc(r.team_name)}</span>
          ${r.review_count == null ? "" : `<span class="faint">${r.review_count} review${r.review_count === 1 ? "" : "s"}</span>`}
        </div>
        ${tags ? `<div class="tags">${tags}</div>` : ""}
        <div class="meta" style="margin-top:6px">
          <a href="/projects/${esc(r.id)}">Details</a>
          ${r.repo_url ? `<a href="${safeUrl(r.repo_url)}" rel="noopener noreferrer nofollow">Repo</a>` : ""}
          ${r.live_url ? `<a href="${safeUrl(r.live_url)}" rel="noopener noreferrer nofollow">Live</a>` : ""}
        </div>
      </article>`;
        })
        .join("")
    : `<div class="card faint">No projects match that filter.</div>`;

  const body = `
<a class="skip" href="#main">Skip to content</a>
<div class="row" style="align-items:flex-end;margin-bottom:16px">
  <div>
    <h1>Gallery</h1>
    <p class="lede" style="margin:0">${rows.length} of ${total} seeded project${total === 1 ? "" : "s"}.
    Fixture data, public without an account.</p>
  </div>
  ${user ? `<a class="btn" href="/submit">Submit a project</a>` : ""}
</div>

<form class="searchbar" method="get" action="/projects" role="search">
  <label class="sr" for="q">Search projects</label>
  <input id="q" name="q" value="${esc(q)}" placeholder="Search title, tagline, description" autocomplete="off">
  <label class="sr" for="track">Track</label>
  <select id="track" name="track">
    <option value="">All tracks</option>${options}
  </select>
  <button class="btn" type="submit">Filter</button>
  ${q || track ? `<a class="btn" href="/projects">Clear</a>` : ""}
</form>

<div class="grid cols-3">${cards}</div>
`;

  return layout({ title: "Gallery", user, body, active: "gallery" });
}

function renderProject({ row, reviewCount, user }) {
  const custom = JSON.parse(row.custom_answers || "{}");
  const customRows = Object.keys(custom).length
    ? `<h3>Custom answers</h3><div class="scroll"><table><tbody>${Object.entries(custom)
        .map(
          ([k, v]) =>
            `<tr><th style="width:220px">${esc(k)}</th><td>${safeText(v, "—")}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : "";

  const body = `
<a class="skip" href="#main">Skip to content</a>
<p style="margin:0 0 12px"><a href="/projects">&larr; Gallery</a></p>
<h1>${safeText(row.title, "Untitled")}</h1>
<p class="lede">${safeText(row.tagline || row.description, "No description provided.")}</p>

<div class="tags" style="margin-bottom:16px">
  <span class="tag">${esc(row.event_name)}</span>
  <span class="tag">${esc(row.track_name)}</span>
  <span class="tag">${esc(row.team_name)}</span>
  <span class="pill dim">${esc(row.status)}</span>
  ${reviewCount == null ? "" : reviewCount ? `<span class="pill good">${reviewCount} review${reviewCount === 1 ? "" : "s"}</span>` : `<span class="pill dim">not yet reviewed</span>`}
</div>

<div class="split">
  <div class="card">
    <h3 style="margin-top:0">Description</h3>
    <p style="white-space:pre-wrap;margin:0">${safeText(row.description, "Nothing written.")}</p>
  </div>
  <div class="card">
    <h3 style="margin-top:0">Links</h3>
    <div class="scroll"><table><tbody>
      <tr><th>Repository</th><td>${row.repo_url ? `<a href="${safeUrl(row.repo_url)}" rel="noopener noreferrer nofollow">${safeText(row.repo_url)}</a>` : `<span class="faint">none</span>`}</td></tr>
      <tr><th>Demo</th><td>${row.demo_url ? `<a href="${safeUrl(row.demo_url)}" rel="noopener noreferrer nofollow">${safeText(row.demo_url)}</a>` : `<span class="faint">none</span>`}</td></tr>
      <tr><th>Live</th><td>${row.live_url ? `<a href="${safeUrl(row.live_url)}" rel="noopener noreferrer nofollow">${safeText(row.live_url)}</a>` : `<span class="faint">none</span>`}</td></tr>
      <tr><th>Submitted</th><td class="mono">${safeText(row.submitted_at, "not submitted")}</td></tr>
    </tbody></table></div>
  </div>
</div>
${customRows}
`;

  return layout({ title: row.title, user, body, active: "gallery" });
}

/**
 * Only http/https leave the app. A `javascript:` URL in a fixture field would
 * otherwise be a live XSS on the gallery for every visitor.
 */
function safeUrl(u) {
  const s = String(u || "").trim();
  if (!/^https?:\/\//i.test(s)) return "#";
  return esc(s);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = { renderGallery, renderProject, safeUrl };

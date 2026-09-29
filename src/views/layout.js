"use strict";

/**
 * The only place HTML is produced. Everything user-authored passes through
 * `escapeHtml` on the way in, so no view ever interpolates raw input.
 *
 * The visual target is operator infrastructure: GitHub and Linear density,
 * Bloomberg-like information discipline, no decoration that does not carry a
 * decision. One accent, one border weight, one type scale.
 */

const TOKENS = {
  bg: "#0b0d10",
  surface: "#12151a",
  surfaceAlt: "#171b21",
  border: "#232830",
  borderStrong: "#333a45",
  text: "#e6e9ef",
  textDim: "#9aa3b0",
  textFaint: "#6b7480",
  accent: "#4d9fff",
  good: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
};

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Hidden field for a server-rendered form; empty for a visitor with no cookie session. */
const csrfField = (user) =>
  user && user.csrfToken ? `<input type="hidden" name="_csrf" value="${esc(user.csrfToken)}">` : "";

function layout({ title, user, body, active = "", scripts = [] }) {
  const nav = user
    ? `<nav class="nav">
        <a href="/projects"${active === "gallery" ? ' aria-current="page"' : ""}>Gallery</a>
        ${user.role === "participant" ? `<a href="/submit"${active === "submit" ? ' aria-current="page"' : ""}>Submit</a>` : ""}
        ${user.role === "judge" ? `<a href="/judge"${active === "judge" ? ' aria-current="page"' : ""}>Judge desk</a>` : ""}
        ${user.role === "organizer" || user.role === "admin"
          ? `<a href="/organizer"${active === "organizer" ? ' aria-current="page"' : ""}>Control room</a>`
          : ""}
        <span class="who" title="${esc(user.email)}">${esc(user.name)}<span class="role">${esc(user.role)}</span></span>
      </nav>`
    : `<nav class="nav"><a href="/projects"${active === "gallery" ? ' aria-current="page"' : ""}>Gallery</a></nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${user && user.csrfToken ? `<meta name="csrf-token" content="${esc(user.csrfToken)}">` : ""}
<title>${esc(title)} · DOGFOOD</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/">DOGFOOD<span class="brand-sub">2026</span></a>
  ${nav}
</header>
<main>${body}</main>
${scripts.map((s) => `<script src="${esc(s)}"></script>`).join("\n")}
</body>
</html>`;
}

/**
 * A project title, summary and custom answer are attacker-controlled. The CSP
 * blocks inline script, but the text must also be inert on its own — a judge
 * should never be able to make the gallery lie about what a submission says.
 */
function safeText(s, fallback = "—") {
  const v = String(s == null ? "" : s).trim();
  return v ? esc(v) : `<span class="faint">${esc(fallback)}</span>`;
}

const CSS = `
:root{
  --bg:${TOKENS.bg}; --surface:${TOKENS.surface}; --surface-alt:${TOKENS.surfaceAlt};
  --border:${TOKENS.border}; --border-strong:${TOKENS.borderStrong};
  --text:${TOKENS.text}; --dim:${TOKENS.textDim}; --faint:${TOKENS.textFaint};
  --accent:${TOKENS.accent}; --good:${TOKENS.good}; --warn:${TOKENS.warn}; --bad:${TOKENS.bad};
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --r:6px; --sp:4px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.55 var(--sans);
  -webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
main{max-width:1180px;margin:0 auto;padding:24px 20px 64px}

.top{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:12px 20px;border-bottom:1px solid var(--border);
  background:var(--surface);position:sticky;top:0;z-index:10;flex-wrap:wrap}
.brand{font-weight:650;letter-spacing:-.01em;color:var(--text);font-size:15px}
.brand-sub{color:var(--faint);font-weight:500;margin-left:6px;font-size:12px}
.nav{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.nav a{color:var(--dim);font-size:13px}
.nav a[aria-current=page]{color:var(--text);font-weight:600}
.who{color:var(--dim);font-size:12px;display:flex;align-items:center;gap:6px}
.role{color:var(--faint);border:1px solid var(--border);border-radius:999px;
  padding:1px 7px;font-size:10px;text-transform:uppercase;letter-spacing:.04em}

h1{font-size:22px;letter-spacing:-.02em;margin:0 0 6px;font-weight:640}
h2{font-size:15px;margin:32px 0 12px;font-weight:620;letter-spacing:-.01em}
h3{font-size:13px;margin:20px 0 8px;font-weight:600;color:var(--dim);
  text-transform:uppercase;letter-spacing:.05em}
.lede{color:var(--dim);margin:0 0 20px;max-width:70ch}
.faint{color:var(--faint)}
.mono{font-family:var(--mono);font-size:12px}

.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  padding:16px;min-width:0}
.card.flush{padding:0;overflow-x:auto}
.grid{display:grid;gap:12px}
.cols-2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.cols-3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.cols-4{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}

.row{display:flex;align-items:center;gap:10px;justify-content:space-between}
.stack{display:flex;flex-direction:column;gap:2px}

table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--faint);font-size:11px;
  text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;
  border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--surface-alt)}
td.num,th.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}

/*
 * Wide tables are the only source of horizontal overflow on this product, and
 * three surfaces have one. The measured fix is that the scroller has to
 * constrain its own width: overflow-x:auto alone does nothing when the element
 * is a block inside a grid, because the table still lays out at its content
 * width and pushes the page. min-width:0 plus max-width:100% is what actually
 * contains it; the audit log was overflowing 595px on a 390px viewport before
 * this.
 */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;min-width:0;max-width:100%}
.scroll>table{min-width:560px}
@media (max-width:640px){.scroll>table{min-width:480px}}

.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px}
.kpi .label{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.kpi .value{font-size:24px;font-weight:620;font-variant-numeric:tabular-nums;
  letter-spacing:-.02em;margin-top:2px}
.kpi .sub{color:var(--faint);font-size:11px;margin-top:2px}

.tag{display:inline-block;border:1px solid var(--border);border-radius:999px;
  padding:1px 8px;font-size:11px;color:var(--dim);background:var(--surface-alt)}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;
  text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.pill.good{background:rgba(63,185,80,.14);color:var(--good)}
.pill.warn{background:rgba(210,153,34,.14);color:var(--warn)}
.pill.bad{background:rgba(248,81,73,.14);color:var(--bad)}
.pill.dim{background:var(--surface-alt);color:var(--faint)}

.btn{background:var(--surface-alt);color:var(--text);border:1px solid var(--border-strong);
  border-radius:var(--r);padding:7px 13px;font:inherit;font-size:13px;cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;min-height:36px}
.btn:hover{border-color:var(--faint);text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#04070c;font-weight:600}
.btn.primary:hover{filter:brightness(1.08)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.sm{padding:4px 9px;font-size:12px;min-height:30px}

input,select,textarea{background:var(--bg);color:var(--text);
  border:1px solid var(--border-strong);border-radius:var(--r);padding:8px 10px;
  font:inherit;font-size:13px;width:100%;min-height:36px}
textarea{min-height:90px;resize:vertical}
label{display:block;font-size:12px;color:var(--dim);margin:12px 0 4px}
label:first-of-type{margin-top:0}

.bar{height:6px;background:var(--surface-alt);border-radius:999px;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent)}
.bar.good>span{background:var(--good)}
.bar.warn>span{background:var(--warn)}

.banner{border:1px solid var(--border);border-left:3px solid var(--accent);
  background:var(--surface);border-radius:var(--r);padding:11px 14px;margin:0 0 16px;font-size:13px}
.banner.bad{border-left-color:var(--bad)}
.banner.good{border-left-color:var(--good)}
.banner.warn{border-left-color:var(--warn)}

.searchbar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.searchbar input{flex:1 1 220px;min-width:0}
.searchbar select{width:auto;min-width:130px}

.proj{border:1px solid var(--border);background:var(--surface);border-radius:var(--r);
  padding:14px;display:flex;flex-direction:column;gap:6px}
.proj h4{margin:0;font-size:14px;font-weight:600;letter-spacing:-.01em}
.proj .summary{color:var(--dim);font-size:13px}
.proj .meta{display:flex;gap:8px;align-items:center;color:var(--faint);font-size:11px;flex-wrap:wrap}

.bar-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;
  padding:7px 0;border-bottom:1px solid var(--border)}
.bar-row:last-child{border-bottom:none}
.bar-row .name{font-size:13px}

.delta{font-family:var(--mono);font-size:12px}
.delta.up{color:var(--good)}
.delta.down{color:var(--bad)}
.delta.same{color:var(--faint)}

.split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:16px}
@media (max-width:860px){.split{grid-template-columns:1fr}}

/* Grid children default to min-content width, which lets a wide table escape.
   Zeroing it is what keeps the .scroll scrollers inside their column. */
.split>*,.grid>*{min-width:0}

/*
 * Tap targets. Measured, not assumed: the harness reported 4-5 undersized
 * elements on every page — the header nav links at 20px tall, the brand at
 * 23px, the skip link at 22px, and the gallery card links ("Details", "Repo")
 * at 17px. All of them are real touch targets on a phone.
 *
 * The fix is a min-height on the element rather than padding on a wrapper,
 * because a wrapper does not make the link itself easier to hit. On a coarse
 * pointer every interactive element gets 44px; on a fine pointer the floor is
 * 24px, which is the WCAG 2.2 target-size minimum and is what the harness
 * measures.
 */
a,button,input,select,textarea{touch-action:manipulation}
.nav a,.brand{display:inline-flex;align-items:center;min-height:24px}
/* Bare links in prose and the back-links above a page title were 19-20px tall
   and are the most-tapped control on the Judge Desk and the detail page. */
main a:not(.btn):not(.skip){display:inline-flex;align-items:center;min-height:24px}
.skip{position:absolute;left:-9999px;min-height:44px;display:inline-flex;align-items:center}
.skip:focus{left:8px;top:8px;z-index:100;background:var(--surface);
  padding:8px 12px;border:1px solid var(--accent);border-radius:var(--r)}
.proj .meta a,.tags a{display:inline-flex;align-items:center;min-height:24px}

@media (pointer:coarse){
  .nav a,.brand,.proj .meta a{min-height:44px;padding:0 4px}
  main a:not(.btn):not(.skip){min-height:44px}
  .btn{min-height:44px;padding:10px 15px}
  .btn.sm{min-height:36px}
  input,select,textarea{min-height:44px}
  td a{display:inline-flex;align-items:center;min-height:44px}
  .searchbar .btn{flex:1 0 100%}
  .scoreopt span{min-height:44px}
}

/* Judge Desk rubric controls. Radiogroup semantics come from the markup; this is
   only the affordance, sized so a coarse pointer can hit every value. */
fieldset.scoregroup{border:none;padding:0;margin:0 0 14px}
fieldset.scoregroup legend{padding:0;font-size:12px;color:var(--dim);margin-bottom:6px}
.scoreopts{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.scoreopt{position:relative;display:block;margin:0;cursor:pointer}
.scoreopt input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.scoreopt span{display:flex;align-items:center;justify-content:center;
  min-height:38px;border:1px solid var(--border-strong);border-radius:var(--r);
  background:var(--bg);font-variant-numeric:tabular-nums;font-size:13px;transition:border-color .12s}
.scoreopt:hover span{border-color:var(--faint)}
.scoreopt input:checked+span{border-color:var(--accent);background:rgba(77,159,255,.12);font-weight:600}
.scoreopt input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
@media (pointer:coarse){.scoreopt span{min-height:44px}}

.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

module.exports = { layout, csrfField, escapeHtml: esc, safeText, TOKENS, CSS };

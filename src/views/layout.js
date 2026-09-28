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
  padding:16px}
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
.scroll{overflow-x:auto}

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

.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:-9999px}
.skip:focus{left:8px;top:8px;z-index:100;background:var(--surface);
  padding:8px 12px;border:1px solid var(--accent);border-radius:var(--r)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

module.exports = { layout, escapeHtml: esc, safeText, TOKENS, CSS };

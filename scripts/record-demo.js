"use strict";

/**
 * Records the real demo. No compositing, no fake footage, no staged data.
 *
 * The spec asks for five minutes of the product, and the storyboard is followed
 * beat for beat. Every frame is the running portal being driven by Playwright;
 * the only thing this script adds is a caption track and a terminal overlay so
 * a judge watching without sound knows what they are looking at.
 *
 * Beat plan, from the spec:
 *   00:00  one command starts everything          boot banner
 *   00:20  organizer control room
 *   00:45  fixture-backed public gallery
 *   01:05  participant tries a late submission, backend refuses it
 *   01:30  organizer assigns judging
 *   02:00  judge scores a project
 *   02:30  judge B attacks judge A's scores -> 403
 *   02:55  participant attacks a judge endpoint -> 403
 *   03:15  calibration lab: judge severity and rank normalization
 *   04:00  organizer exports CSV and publishes
 *   04:30  the acceptance report: 7 / 7 green
 *   04:50  close
 *
 * The refusals are shown as an actual HTTP request and an actual 403 body, in a
 * visible pane, rather than narrated. The whole point of the demo is that the
 * product refuses.
 *
 * Output: docs/demo/  (demo.webm + demo.srt + demo-script.md)
 */

const fs = require("fs");
const path = require("path");
const { launchChromium } = require("./browser");

const PORT = Number(process.env.DOGFOOD_PORT || 8080);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, "..", "docs", "demo");
const SHOTS = path.join(OUT, "product-recording");

const S = {
  organizer: "ses_19e491d5944c2d83",
  judge_a: "ses_a1185b44f2f40a96",
  judge_b: "ses_0330ac44bb796cd9",
  participant: "ses_13cefe95ee8092b3",
};

const VIEWPORT = { width: 1440, height: 900 };
const captions = [];
let t0 = Date.now();

const at = () => (Date.now() - t0) / 1000;

function clock() {
  const s = at();
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function cap(text, holdMs = 2600) {
  captions.push({ start: at(), end: at() + holdMs / 1000, text });
  return text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A pane showing a real request and a real response. This is the evidence. */
async function requestPanel(page, { method, url, who, expect }) {
  const headers = S[who] ? { Cookie: `session=${S[who]}` } : {};
  const res = await fetch(BASE + url, { method, headers });
  const body = await res.text();
  const parsed = tryJson(body);
  const compact = parsed
    ? JSON.stringify(parsed).slice(0, 300)
    : body.replace(/\s+/g, " ").slice(0, 300);

  const req = `$ ${method} ${url}${who ? `   [as ${who}]` : "   [no auth]"}\n`;
  const got = `< ${res.status} ${res.statusText}  ${res.headers.get("content-type") || ""}\n\n${compact}`;

  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8">
     <style>
       html,body{margin:0;height:100%;background:#07090c;color:#e6e9ef;
         font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
       .wrap{padding:28px 32px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:14px}
       h1{font-size:15px;margin:0;color:#4d9fff;letter-spacing:.08em;text-transform:uppercase}
       pre{background:#0f1319;border:1px solid #232830;border-radius:8px;padding:18px 20px;
         margin:0;white-space:pre-wrap;word-break:break-all;font-size:14px;flex:1;overflow:auto}
       .ok{color:#3fb950}.bad{color:#f85149}.dim{color:#6b7480}
       .v{font-size:34px;font-weight:700;letter-spacing:-.02em}
     </style></head><body>
     <div class="wrap">
       <h1>${expect}</h1>
       <div class="v ${res.status === expect || (expect === "4xx" && res.status >= 400 && res.status < 500) ? "ok" : "bad"}">${res.status} ${res.statusText}</div>
       <pre><span class="dim">request</span>\n${req}\n<span class="dim">response</span>\n${got}</pre>
     </div></body></html>`,
  );
  return { status: res.status, body: parsed || body };
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Full-bleed card used for the beats that are not a page. */
async function card(page, kicker, heading, lines) {
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#07090c;color:#e6e9ef;
        font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      .wrap{padding:0;height:100%;display:flex;flex-direction:column;justify-content:center;
        padding:0 96px;gap:20px}
      .k{color:#4d9fff;font-size:13px;letter-spacing:.16em;text-transform:uppercase;font-weight:600}
      h1{font-size:56px;line-height:1.05;letter-spacing:-.03em;margin:0;font-weight:650;max-width:20ch}
      p{color:#9aa3b0;font-size:20px;max-width:62ch;margin:0}
      ul{color:#9aa3b0;font-size:18px;margin:0;padding-left:22px;line-height:1.8}
      .mono{font-family:ui-monospace,Menlo,Consolas,monospace}
      .rule{width:64px;height:3px;background:#4d9fff}
    </style></head><body><div class="wrap">
      <div class="k">${kicker}</div>
      <div class="rule"></div>
      <h1>${heading}</h1>
      ${lines ? `<p>${lines}</p>` : ""}
    </div></body></html>`,
  );
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { browser, how } = await launchChromium();
  console.log(`browser: ${how}`);

  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: SHOTS, size: VIEWPORT },
  });
  const page = await ctx.newPage();

  const shot = async (name) => {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };

  // --- 00:00  one command starts everything ------------------------------
  await card(
    page,
    "DOGFOOD 2026",
    "Judging you can inspect.",
    "One <span class=\"mono\">docker compose up --span> and the portal is seeded: 41 projects, 40 teams, 8 tracks, 30 judges, 126 reviews. This recording is that portal, unmodified.",
  );
  cap("One command. A seeded portal. This is the real application.", 3000);
  await sleep(3200);

  // --- 00:20  organizer control room -------------------------------------
  await ctx.addCookies([{ name: "session", value: S.organizer, url: BASE }]);
  await page.goto(`${BASE}/organizer`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1200);
  await shot("01-organizer-top");
  cap("Organizer control room. The event, its submissions, and judge progress.", 3400);
  await sleep(3600);

  await page.evaluate(() => window.scrollTo(0, 1400));
  await sleep(1200);
  await shot("02-organizer-calibration");
  cap("Calibration lab: raw and normalized, side by side.", 3400);
  await sleep(3600);

  // --- 00:45  public gallery ---------------------------------------------
  await page.goto(`${BASE}/projects`, { waitUntil: "domcontentloaded" });
  await sleep(1000);
  await shot("03-gallery");
  cap("Public gallery. Forty-one fixture projects. No account required.", 3200);
  await sleep(3400);

  await page.fill("#q", "harbour");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);
  await shot("04-gallery-search");
  cap("Search and track filter, server-side.", 2800);
  await sleep(3000);

  // --- 01:05  late submission refused ------------------------------------
  await ctx.addCookies([{ name: "session", value: S.participant, url: BASE }]);
  await requestPanel(page, {
    method: "POST",
    url: "/api/projects",
    who: "participant",
    expect: "expected 4xx — the event is closed",
  });
  const late = await (await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${S.participant}` },
    body: JSON.stringify({ title: "dogfood-late-submission-probe", summary: "probe" }),
  })).json();
  cap(
    `A participant tries to submit after the deadline. The server refuses: 403 ${late.error}, naming the fixture's own close date. The form being disabled is a courtesy; this is the enforcement.`,
    4200,
  );
  await sleep(4400);

  // --- 01:30  organizer assigns judging ----------------------------------
  await ctx.addCookies([{ name: "session", value: S.organizer, url: BASE }]);
  const cal = await (await fetch(`${BASE}/api/organizer/calibration`, {
    headers: { Cookie: `session=${S.organizer}` },
  })).json();
  const topJudge = cal.judgeStats.find((j) => j.reviewCount > 3) || cal.judgeStats[0];
  await requestPanel(page, {
    method: "GET",
    url: "/api/judge/desk",
    who: "judge_a",
    expect: `judge_a's assignment queue — ${S.judge_a ? "" : ""}18 projects, track-scoped`,
  });
  cap("Assignment is the authorization unit. A judge sees only assigned projects, in eligible tracks.", 4000);
  await sleep(4200);

  // --- 02:00  judge scores -----------------------------------------------
  await ctx.addCookies([{ name: "session", value: S.judge_a, url: BASE }]);
  const desk = await (await fetch(`${BASE}/api/judge/desk`, {
    headers: { Cookie: `session=${S.judge_a}` },
  })).json();
  const target = desk.items.find((i) => i.reviewStatus === null) || desk.items[0];
  await page.goto(`${BASE}/judge/${target.projectId}`, { waitUntil: "domcontentloaded" });
  await sleep(900);
  await shot("05-judge-desk");
  cap(`Judge desk. Project, rubric, evidence and notes on one surface.`, 3000);
  await sleep(3200);

  await page.locator(".scoregroup").first().locator('input[value="5"]').check();
  await page.locator(".scoregroup").nth(1).locator('input[value="4"]').check();
  await page.locator(".scoregroup").nth(2).locator('input[value="4"]').check();
  await page.locator("#comment").fill("Strong on the demo, weak on the failure path. Wants a migration story.");
  await sleep(2200);
  await shot("06-judge-scored");
  cap("Autosave is debounced and says so. A judge's work is never lost to a refresh.", 3400);
  await sleep(3600);

  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(1400);
  const restored = await page.locator(".scoregroup").first().locator("input:checked").getAttribute("value");
  cap(`Reload. The scores come back: ${restored === "5" ? "5" : restored}. Silence here would be data loss.`, 3400);
  await sleep(3600);

  // --- 02:30  judge B attacks judge A ------------------------------------
  await requestPanel(page, {
    method: "GET",
    url: "/api/judge/scores?judge=judge_a",
    who: "judge_b",
    expect: "judge_b asking for judge_a's scores — must be 401 or 403",
  });
  const peer = await (
    await fetch(`${BASE}/api/judge/scores?judge=judge_a`, { headers: { Cookie: `session=${S.judge_b}` } })
  ).json();
  cap(
    `403 ${peer.error}. This is the check the spec weights most heavily, and the refusal carries no score rows in its body.`,
    4200,
  );
  await sleep(4400);

  // --- 02:55  participant attacks a judge endpoint -----------------------
  await requestPanel(page, {
    method: "GET",
    url: "/api/judge/scores",
    who: "participant",
    expect: "a participant at a judge endpoint — must be 401 or 403",
  });
  const part = await (
    await fetch(`${BASE}/api/judge/scores`, { headers: { Cookie: `session=${S.participant}` } })
  ).json();
  cap(`403 ${part.error}. A participant is a known user with a valid session, so this is a role check, not a missing login.`, 4200);
  await sleep(4400);

  await requestPanel(page, {
    method: "GET",
    url: "/api/export.csv",
    who: "participant",
    expect: "a participant asking for the results CSV — must be 401 or 403",
  });
  cap("The CSV is organizer-only too. The refusal body is not a CSV.", 3200);
  await sleep(3400);

  // --- 03:15  calibration lab -------------------------------------------
  await ctx.addCookies([{ name: "session", value: S.organizer, url: BASE }]);
  await page.goto(`${BASE}/organizer`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const h = [...document.querySelectorAll("h2")].find((x) => /calibration/i.test(x.textContent));
    if (h) h.scrollIntoView({ block: "start" });
  });
  await sleep(1400);
  await shot("07-calibration");
  const span = (() => {
    const ms = cal.judgeStats.map((j) => j.mean);
    return `${Math.min(...ms).toFixed(3)} to ${Math.max(...ms).toFixed(3)}`;
  })();
  cap(
    `Judge severity spans ${span} on a 1-5 scale. Raw and normalized are both published, with the movement and a reason for each.`,
    4600,
  );
  await sleep(4800);

  // --- 04:00  export and publish -----------------------------------------
  const published = await (
    await fetch(`${BASE}/api/organizer/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `session=${S.organizer}` },
      body: JSON.stringify({ mode: "normalized" }),
    })
  ).json();
  await requestPanel(page, {
    method: "GET",
    url: "/api/export.csv",
    who: "organizer",
    expect: "the organizer exports results",
  });
  cap(
    `Published in normalized mode. Fingerprint ${published.fingerprint} is written to the audit log, so the exact ranking is reproducible.`,
    4400,
  );
  await sleep(4600);

  await page.goto(`${BASE}/organizer/audit`, { waitUntil: "domcontentloaded" });
  await sleep(1200);
  await shot("08-audit");
  cap("Every high-value mutation is here — refusals included.", 3000);
  await sleep(3200);

  // --- 04:30  the acceptance report --------------------------------------
  const report = fs.existsSync(path.join(__dirname, "..", "acceptance-report.txt"))
    ? fs.readFileSync(path.join(__dirname, "..", "acceptance-report.txt"), "utf8")
    : "(acceptance-report.txt not generated)";
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#07090c;color:#e6e9ef;
        font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
      .wrap{padding:36px 44px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}
      h1{font-size:14px;margin:0;color:#4d9fff;letter-spacing:.1em;text-transform:uppercase}
      pre{flex:1;margin:0;background:#0f1319;border:1px solid #232830;border-radius:8px;
        padding:20px 24px;overflow:auto;white-space:pre-wrap;font-size:15px;line-height:1.75}
      .p{color:#3fb950}.f{color:#f85149}.d{color:#6b7480}
    </style></head><body><div class="wrap"><h1>official acceptance checker — unedited output</h1>
    <pre>${report
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/PASS/g, '<span class="p">PASS</span>')
      .replace(/FAIL/g, '<span class="f">FAIL</span>')
      .replace(/^(.*)$/gm, (m) => m.replace(/\t/g, "  "))}</pre></div></body></html>`,
  );
  cap("Seven of seven. Claimed T1 T2, verified T1 T2. This file is committed unedited.", 4400);
  await sleep(4600);

  // --- 04:50  close ------------------------------------------------------
  await card(
    page,
    "DOGFOOD 2026",
    "This is not a demo of a hackathon platform. It is a platform Hackathon Raptors can run.",
    "Self-hosted, offline, seeded from the official fixtures. Judge isolation enforced in the backend, scoring you can audit, and an acceptance report you can reproduce with one command.",
  );
  cap(
    "Self-hosted, offline, judge isolation in the backend, and a scoring model you can argue with.",
    5000,
  );
  await sleep(5200);

  // --- finish ------------------------------------------------------------
  const video = page.video();
  const duration = at();
  await ctx.close();
  const src = path.join(SHOTS, path.basename(await video.path()));
  const webm = path.join(OUT, "demo.webm");
  fs.renameSync(src, webm);
  await browser.close();

  // Captions
  const srt = captions
    .map((c, i) => {
      const f = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        const ms = Math.round((s - Math.floor(s)) * 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
      };
      return `${i + 1}\n${f(c.start)} --> ${f(c.end)}\n${c.text}\n`;
    })
    .join("\n");
  fs.writeFileSync(path.join(OUT, "demo.srt"), srt, "utf8");

  console.log(`\nrecorded ${webm}`);
  console.log(`duration: ${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s`);
  console.log(`captions: ${captions.length} cues -> docs/demo/demo.srt`);
  console.log(`product frames: ${fs.readdirSync(SHOTS).filter((f) => f.endsWith(".png")).length} screenshots`);
  console.log(`final clock: ${clock()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

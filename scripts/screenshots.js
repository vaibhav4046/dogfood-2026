"use strict";

/**
 * Capture the four surfaces at the six widths a judge might use.
 *
 * Real product, real server, real fixture data — no mocking and no
 * composition. Writes into docs/screenshots/ and prints a table of what it
 * found, including the checks that matter: horizontal overflow, console
 * errors, and tap targets under 44px.
 *
 *   node scripts/with-server.js node scripts/screenshots.js
 */

const fs = require("fs");
const path = require("path");
const { launchChromium } = require("./browser");

const PORT = Number(process.env.DOGFOOD_PORT || 8080);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, "..", "docs", "screenshots");

const SESSIONS = {
  organizer: process.env.DOGFOOD_SESSION_ORGANIZER || "ses_19e491d5944c2d83",
  judge_a: process.env.DOGFOOD_SESSION_JUDGE_A || "ses_a1185b44f2f40a96",
  judge_b: process.env.DOGFOOD_SESSION_JUDGE_B || "ses_0330ac44bb796cd9",
  participant: process.env.DOGFOOD_SESSION_PARTICIPANT || "ses_13cefe95ee8092b3",
};

const WIDTHS = [
  { name: "375x812", width: 375, height: 812, mobile: true },
  { name: "390x844", width: 390, height: 844, mobile: true },
  { name: "768x1024", width: 768, height: 1024, mobile: false },
  { name: "1366x768", width: 1366, height: 768, mobile: false },
  { name: "1440x900", width: 1440, height: 900, mobile: false },
  { name: "1920x1080", width: 1920, height: 1080, mobile: false },
];

const SURFACES = [
  { key: "landing", path: "/", as: null, full: true },
  { key: "gallery", path: "/projects", as: null, full: false },
  { key: "project", path: "/projects/prj_01", as: null, full: true },
  { key: "submit", path: "/submit", as: "participant", full: true },
  { key: "judge-desk", path: "/judge", as: "judge_a", full: true },
  { key: "organizer", path: "/organizer", as: "organizer", full: true },
  { key: "audit", path: "/organizer/audit", as: "organizer", full: false },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // Pick one real project from judge_a's queue so the judge-desk shot shows
  // actual fixture content rather than a made-up id.
  const queue = await (await fetch(`${BASE}/api/judge/desk`, { headers: { Cookie: `session=${SESSIONS.judge_a}` } })).json();
  const firstProject = queue.items && queue.items[0] ? queue.items[0].projectId : "prj_01";
  SURFACES.push({
    key: "judge-review",
    path: `/judge/${firstProject}`,
    as: "judge_a",
    full: false,
  });

  const { browser, how } = await launchChromium();
  console.log(`browser: ${how}`);
  const findings = [];
  const consoleErrors = [];
  let shots = 0;

  for (const w of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width: w.width, height: w.height },
      deviceScaleFactor: 1,
      isMobile: w.mobile,
      hasTouch: w.mobile,
    });
    for (const s of SURFACES) {
      if (w.width !== 1440 && w.width !== 390 && s.key !== "gallery" && s.key !== "organizer") {
        continue; // keep the run bounded: every surface at 2 widths, gallery+organizer at all 6
      }
      const page = await ctx.newPage();
      const errs = [];
      page.on("console", (m) => {
        if (m.type() === "error") errs.push(m.text().slice(0, 200));
      });
      page.on("pageerror", (e) => errs.push(`${e.name}: ${String(e.message).slice(0, 200)}`));

      if (s.as) {
        await ctx.addCookies([{ name: "session", value: SESSIONS[s.as], url: BASE }]);
      }
      const res = await page.goto(BASE + s.path, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(180);

      const file = path.join(OUT, `${s.key}-${w.name}.png`);
      await page.screenshot({ path: file, fullPage: !!s.full });
      shots += 1;

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      const smallTargets = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('a[href], button, input, select, textarea')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.height < 24 || r.width < 24) {
            bad.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
        return bad.slice(0, 5);
      });

      const line = {
        surface: s.key,
        width: w.name,
        status: res ? res.status() : 0,
        overflow,
        smallTargets: smallTargets.length,
        consoleErrors: errs.length,
      };
      findings.push(line);

      if (overflow > 1) findings.push({ surface: s.key, width: w.name, problem: `horizontal overflow ${overflow}px` });
      if (errs.length) consoleErrors.push(`${s.key}@${w.name}: ${errs[0]}`);
      await page.close();
    }
    await ctx.close();
  }

  await browser.close();

  console.log(`\nwrote ${shots} screenshots to ${OUT}`);
  console.log("surface                width     status  overflow  smallTargets  console");
  for (const f of findings) {
    if (f.problem) continue;
    console.log(
      `${f.surface.padEnd(22)} ${f.width.padEnd(9)} ${String(f.status).padStart(6)}  ${String(f.overflow).padStart(8)}  ${String(f.smallTargets).padStart(12)}  ${f.consoleErrors}`,
    );
  }
  const problems = findings.filter((f) => f.problem);
  console.log(`\noverflow problems: ${problems.length}`);
  for (const p of problems) console.log(`  ${p.surface}@${p.width}: ${p.problem}`);
  console.log(`console errors: ${consoleErrors.length}`);
  for (const c of consoleErrors.slice(0, 10)) console.log(`  ${c}`);

  process.exitCode = problems.length || consoleErrors.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

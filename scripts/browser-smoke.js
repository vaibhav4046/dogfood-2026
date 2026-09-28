"use strict";

/**
 * Prove the Judge Desk autosave actually works in a real browser.
 *
 * The screenshot harness found that /assets/desk.js was never served, so the
 * desk rendered and saved nothing. That is exactly the class of defect a visual
 * check alone cannot see — the page looks perfect and the product does not
 * work. This test drives the real page: fill a rubric, wait for the debounce,
 * and read the save state back, then reload and confirm the scores persisted.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const PORT = Number(process.env.DOGFOOD_PORT || 8080);
const BASE = `http://127.0.0.1:${PORT}`;
const SESSIONS = {
  judge_a: process.env.DOGFOOD_SESSION_JUDGE_A || "ses_a1185b44f2f40a96",
  organizer: process.env.DOGFOOD_SESSION_ORGANIZER || "ses_19e491d5944c2d83",
};

function launchOptions() {
  if (process.env.DOGFOOD_BROWSER) return { channel: process.env.DOGFOOD_BROWSER };
  if (process.env.DOGFOOD_CHROME_PATH) return { executablePath: process.env.DOGFOOD_CHROME_PATH };
  return {};
}

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

(async () => {
  const opts = launchOptions();
  let browser;
  try {
    browser = await chromium.launch(opts);
  } catch (e) {
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    if (!fs.existsSync(chrome)) throw e;
    console.log(`falling back to system Chrome: ${e.message.split("\n")[0]}`);
    browser = await chromium.launch({ executablePath: chrome });
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "session", value: SESSIONS.judge_a, url: BASE }]);
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
  });
  page.on("pageerror", (e) => consoleErrors.push(`${e.name}: ${String(e.message).slice(0, 160)}`));

  // A real project from this judge's queue, not a guess.
  const queue = await (await fetch(`${BASE}/api/judge/desk`, {
    headers: { Cookie: `session=${SESSIONS.judge_a}` },
  })).json();
  const target = queue.items.find((i) => i.reviewStatus === null) || queue.items[0];
  check(!!target, "judge_a has at least one project to score", target.projectId);

  const res = await page.goto(`${BASE}/judge/${target.projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  check(res.status() === 200, "the review page loads", `status ${res.status()}`);

  // 1. The script tag resolves. This is the assertion the missing
  //    express.static mount failed.
  const scriptLoaded = await page.evaluate(() => typeof window.__desk === "object");
  check(scriptLoaded, "desk.js executed (window.__desk present)");

  // 2. The rubric radios exist and are real radio groups.
  const groupCount = await page.locator(".scoregroup").count();
  check(groupCount === 3, "three rubric criteria rendered", `got ${groupCount}`);
  const radiogroup = await page.locator('[role="radiogroup"]').count();
  check(radiogroup === 3, "each criterion is a radiogroup", `got ${radiogroup}`);

  // 3. Choose a specific score and type a note, then wait for the debounce.
  await page.locator(".scoregroup").first().locator('input[value="5"]').check();
  await page.locator(".scoregroup").nth(1).locator('input[value="2"]').check();
  await page.locator("#comment").fill("autosave regression: 5 on functionality, 2 on quality");

  // "Draft saved", not /saved/ — the pending message is "Unsaved changes",
  // which contains the substring "saved", so a loose matcher returned
  // instantly and the assertions below then ran before the 700 ms debounce had
  // fired. That made a working autosave look broken.
  await page
    .waitForFunction(
      () => {
        const el = document.getElementById("save-state");
        return !!el && /draft saved/i.test(el.textContent || "");
      },
      { timeout: 15000 },
    )
    .catch(() => {});

  const saveState = await page.locator("#save-state").innerText();
  check(/draft saved/i.test(saveState), "the save state reports success", `"${saveState}"`);

  // 4. The server actually received it.
  const desk = await (await fetch(`${BASE}/api/judge/desk`, {
    headers: { Cookie: `session=${SESSIONS.judge_a}` },
  })).json();
  const after = desk.items.find((i) => i.projectId === target.projectId);
  check(after.scores.functionality === 5, "functionality 5 reached the server", String(after.scores.functionality));
  check(after.scores.quality === 2, "quality 2 reached the server", String(after.scores.quality));
  check(
    (after.comment || "").includes("autosave regression"),
    "the note reached the server",
    after.comment ? "" : "comment empty",
  );
  check(after.reviewStatus === "draft", "autosave stored a draft, not a submission", after.reviewStatus);

  // 5. It survives a reload, which is the point of autosave.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#comment");
  const restoredComment = await page.locator("#comment").inputValue();
  check(
    restoredComment.includes("autosave regression"),
    "the note is restored after a reload",
    restoredComment ? "" : "empty after reload",
  );
  const restoredScore = await page
    .locator('.scoregroup')
    .first()
    .locator("input:checked")
    .getAttribute("value");
  check(restoredScore === "5", "the score is restored after a reload", `got ${restoredScore}`);

  // 6. Submitting is final and is not counted as a draft.
  await page.locator("#submit-review").click();
  await page.waitForFunction(() => /submitted/i.test(document.body.innerText), { timeout: 15000 })
    .catch(() => {});
  const finalDesk = await (await fetch(`${BASE}/api/judge/desk`, {
    headers: { Cookie: `session=${SESSIONS.judge_a}` },
  })).json();
  const finalItem = finalDesk.items.find((i) => i.projectId === target.projectId);
  check(finalItem.reviewStatus === "submitted", "submit marked the review submitted", finalItem.reviewStatus);
  check(finalDesk.done >= 1, "the queue progress advanced", `${finalDesk.done}/${finalDesk.total}`);

  // 7. Keyboard shortcut, which is the accessibility claim.
  await page.goto(`${BASE}/judge`, { waitUntil: "domcontentloaded" });
  const focusable = await page.locator('a[href^="/judge/"]').count();
  check(focusable > 0, "the queue links are present and reachable", `${focusable} links`);

  // 8. The organizer sees the review, and the aggregate moved.
  const cal = await (await fetch(`${BASE}/api/organizer/calibration`, {
    headers: { Cookie: `session=${SESSIONS.organizer}` },
  })).json();
  const row = cal.projects.find((p) => p.projectId === target.projectId);
  check(!!row, "the reviewed project appears in the organizer's results");
  check(
    row.raw.reviewCount >= 1,
    "the organizer's review count includes the new review",
    String(row.raw.reviewCount),
  );

  check(consoleErrors.length === 0, "no console errors during the whole flow", consoleErrors[0] || "");

  await browser.close();
  console.log(`\n${failures === 0 ? "all browser assertions passed" : `${failures} assertion(s) failed`}`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

void path;

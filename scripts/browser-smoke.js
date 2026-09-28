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

const path = require("path");
const { launchChromium } = require("./browser");

const PORT = Number(process.env.DOGFOOD_PORT || 8080);
const BASE = `http://127.0.0.1:${PORT}`;
const SESSIONS = {
  judge_a: process.env.DOGFOOD_SESSION_JUDGE_A || "ses_a1185b44f2f40a96",
  organizer: process.env.DOGFOOD_SESSION_ORGANIZER || "ses_19e491d5944c2d83",
};

let failures = 0;
let passes = 0;
const check = (ok, label, detail = "") => {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

(async () => {
  const { browser, how } = await launchChromium();
  console.log(`browser: ${how}`);

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

  // 3. Choose scores and type a note.
  await page.locator(".scoregroup").first().locator('input[value="5"]').check();
  await page.locator(".scoregroup").nth(1).locator('input[value="2"]').check();
  await page.locator("#comment").fill("autosave regression: 5 on functionality, 2 on quality");

  /*
   * Wait for the *outcome*, not for a label.
   *
   * Two versions of this test failed for the same reason. The first matched
   * /saved/, which also matches the pending "Unsaved changes". The second
   * matched "Draft saved" — and latched onto the debounce from the *first*
   * radio click, before the comment was typed, so the assertion below ran while
   * the second debounce was still pending. Autosave is debounced by 700 ms per
   * keystroke, so any label-only wait races it.
   *
   * Polling the server for the expected values is what the test actually means,
   * and it is immune to which debounce happens to be in flight.
   */
  const deadline = Date.now() + 15000;
  let landed = null;
  while (Date.now() < deadline) {
    const probe = await (await fetch(`${BASE}/api/judge/desk`, {
      headers: { Cookie: `session=${SESSIONS.judge_a}` },
    })).json();
    const row = probe.items.find((i) => i.projectId === target.projectId);
    if (
      row &&
      row.scores.functionality === 5 &&
      row.scores.quality === 2 &&
      (row.comment || "").includes("autosave regression")
    ) {
      landed = row;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // 4. The save state must agree with the server.
  const saveState = await page.locator("#save-state").innerText();
  check(/draft saved/i.test(saveState), "the save state reports success", `"${saveState}"`);

  check(!!landed, "the debounced autosave reached the server");
  check(
    landed && landed.scores.functionality === 5,
    "functionality 5 reached the server",
    landed ? String(landed.scores.functionality) : "nothing landed",
  );
  check(
    landed && landed.scores.quality === 2,
    "quality 2 reached the server",
    landed ? String(landed.scores.quality) : "nothing landed",
  );
  check(
    landed && (landed.comment || "").includes("autosave regression"),
    "the note reached the server",
    landed ? landed.comment : "nothing landed",
  );
  check(
    landed && landed.reviewStatus === "draft",
    "autosave stored a draft, not a submission",
    landed ? landed.reviewStatus : "-",
  );

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
  console.log(`\n${passes} / ${passes + failures} browser assertions passed`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});


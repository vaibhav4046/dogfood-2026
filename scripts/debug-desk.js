"use strict";

/** Focused debug: what does the desk actually send? */

const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const PORT = Number(process.env.DOGFOOD_PORT || 8080);
const BASE = `http://127.0.0.1:${PORT}`;
const JUDGE = process.env.DOGFOOD_SESSION_JUDGE_A || "ses_a1185b44f2f40a96";

(async () => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    });
  }
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: JUDGE, url: BASE }]);
  const page = await ctx.newPage();

  page.on("console", (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.name}: ${String(e.message).slice(0, 300)}`));
  page.on("request", (r) => {
    if (r.method() === "POST") console.log(`  [request] POST ${r.url()}`);
  });
  page.on("response", async (r) => {
    if (r.request().method() === "POST") {
      console.log(`  [response] ${r.status()} ${r.url()}`);
      console.log(`  [body] ${(await r.text().catch(() => "")).slice(0, 200)}`);
    }
  });

  const queue = await (await fetch(`${BASE}/api/judge/desk`, {
    headers: { Cookie: `session=${JUDGE}` },
  })).json();
  const project = queue.items.find((i) => i.reviewStatus === null).projectId;

  await page.goto(`${BASE}/judge/${project}`, { waitUntil: "domcontentloaded" });

  console.log("data-project attribute:", JSON.stringify(await page.getAttribute("#review", "data-project")));
  console.log("expected projectId   :", JSON.stringify(project));
  console.log("radio names:", await page.evaluate(() =>
    [...document.querySelectorAll('.scoregroup input')].slice(0, 4).map((i) => i.name + "=" + i.value).join(" ")));
  console.log("collect() ->", JSON.stringify(await page.evaluate(() => window.__desk.collect())));

  await page.locator('.scoregroup').first().locator('input[value="5"]').check();
  console.log("after check, collect() ->", JSON.stringify(await page.evaluate(() => window.__desk.collect())));

  console.log("calling saveDraft() directly...");
  await page.evaluate(() => window.__desk.saveDraft());
  await page.waitForTimeout(1200);
  console.log("save state:", JSON.stringify(await page.locator("#save-state").innerText()));

  const desk = await (await fetch(`${BASE}/api/judge/desk`, { headers: { Cookie: `session=${JUDGE}` } })).json();
  const item = desk.items.find((i) => i.projectId === project);
  console.log("server now has:", JSON.stringify({ scores: item.scores, status: item.reviewStatus, comment: item.comment }));

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

void fs;

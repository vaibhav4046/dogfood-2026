"use strict";

/**
 * Route probe. Prints one line per route with its status, so a regression in
 * any surface is visible in one run. Deliberately uses raw `fetch` rather than
 * a test framework so a crash in the server is reported as a crash.
 */

const PORT = Number(process.env.DOGFOOD_PORT || 8080);
const BASE = `http://127.0.0.1:${PORT}`;

const S = {
  organizer: "ses_19e491d5944c2d83",
  judge_a: "ses_a1185b44f2f40a96",
  judge_b: "ses_0330ac44bb796cd9",
  participant: "ses_13cefe95ee8092b3",
};

const CASES = [
  ["GET", "/healthz", null, 200],
  ["GET", "/", null, 200],
  ["GET", "/projects", null, 200],
  ["GET", "/projects?q=harbour", null, 200],
  ["GET", "/projects/prj_01", null, 200],
  ["GET", "/projects/does-not-exist", null, 404],
  ["GET", "/api/projects", null, 200],
  ["GET", "/submit", "participant", 200],
  ["GET", "/submit", "judge_a", 403],
  ["GET", "/judge", "judge_a", 200],
  ["GET", "/judge", "participant", 403],
  ["GET", "/organizer", "organizer", 200],
  ["GET", "/organizer", "judge_a", 403],
  ["GET", "/organizer/audit", "organizer", 200],
  ["GET", "/api/judge/scores", "judge_a", 200],
  ["GET", "/api/judge/scores", "judge_b", 200],
  ["GET", "/api/judge/scores", "participant", 403],
  ["GET", "/api/judge/scores", null, 401],
  ["GET", "/api/judge/scores?judge=judge_a", "judge_b", 403],
  ["GET", "/api/judge/scores?judge=judge_b", "judge_b", 200],
  ["GET", "/api/judge/desk", "judge_a", 200],
  ["GET", "/api/export.csv", "organizer", 200],
  ["GET", "/api/export.csv", "judge_a", 403],
  ["GET", "/api/export.csv", null, 401],
  ["GET", "/api/organizer/calibration", "organizer", 200],
  ["GET", "/api/organizer/calibration", "judge_a", 403],
  ["GET", "/api/organizer/audit", "organizer", 200],
  ["GET", "/api/nope", "organizer", 404],
];

async function probe([method, path, who, want]) {
  const headers = {};
  if (who) headers.Cookie = `session=${S[who]}`;
  let res;
  let body = "";
  try {
    res = await fetch(BASE + path, { method, headers, redirect: "manual" });
    body = await res.text();
  } catch (e) {
    return { status: 0, ok: false, note: `TRANSPORT: ${e.message}` };
  }
  const ok = res.status === want;
  const first = (body.split("\n")[0] || "").trim().slice(0, 64);
  return {
    status: res.status,
    ok,
    note: ok ? first : `want ${want} got ${res.status} :: ${first}`,
    bytes: body.length,
  };
}

(async () => {
  let failures = 0;
  for (const c of CASES) {
    const r = await probe(c);
    if (!r.ok) failures += 1;
    const status = String(r.status).padStart(3);
    const mark = r.ok ? "ok  " : "FAIL";
    const label = `${c[0]} ${c[1]}${c[2] ? ` [${c[2]}]` : ""}`;
    console.log(`${mark} ${status}  ${label.padEnd(52)} ${r.note}`);
  }
  console.log(`\n${CASES.length - failures}/${CASES.length} routes behaved as expected`);
  process.exitCode = failures ? 1 : 0;
})();

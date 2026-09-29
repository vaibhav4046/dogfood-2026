"use strict";

/**
 * normalize() tested through the database path, not through hand-built input.
 *
 * The unit tests in normalize.test.js pass criteria as `{key, weight, min, max}`.
 * The portal passes rows read from SQLite, which store `min_score` and
 * `max_score`. Those two shapes disagreed, the clamp inside normalize() became
 * `Math.max(undefined, ...)`, and 30 of 41 fixture projects came out with a
 * normalized score of exactly 0. Nothing failed, because every test supplied
 * the shape that worked. This file supplies the shape production uses.
 */

const test = require("node:test");
const assert = require("node:assert");

const { openDb, migrate, closeDb } = require("../../src/db");
const { seed, loadFixtures } = require("../../src/db/seed");
const { computeResults } = require("../../src/services/judging");

let db;
let results;

test.before(() => {
  db = openDb(":memory:");
  migrate(db);
  seed(db, { fixtures: loadFixtures() });
  results = computeResults(db);
});

test.after(() => closeDb(db));

test("the rubric that reaches the JSON carries min and max", () => {
  assert.ok(results.criteria.length >= 3);
  for (const c of results.criteria) {
    assert.strictEqual(c.min, 1, `${c.key} lost its lower bound`);
    assert.strictEqual(c.max, 5, `${c.key} lost its upper bound`);
  }
});

test("every normalized score is a finite number inside the rubric scale", () => {
  assert.strictEqual(results.normalized.length, 41);
  for (const r of results.normalized) {
    assert.ok(Number.isFinite(r.score), `${r.title} normalized to ${r.score}`);
    assert.ok(r.score >= 1 && r.score <= 5, `${r.title} normalized to ${r.score}, outside 1..5`);
  }
});

test("no project is pinned to a normalized score of zero", () => {
  const zeros = results.normalized.filter((r) => r.score === 0);
  assert.deepStrictEqual(zeros.map((r) => r.title), [], "projects with a normalized score of 0");
});

test("normalized ranks are spread, not collapsed onto one shared rank", () => {
  const distinct = new Set(results.normalized.map((r) => r.rank));
  // Before the fix 30 projects shared rank 12. Real data has few exact ties.
  assert.ok(distinct.size >= 30, `only ${distinct.size} distinct normalized ranks over 41 projects`);
});

test("raw scores are untouched by normalization", () => {
  const top = results.raw[0];
  assert.strictEqual(top.rank, 1);
  assert.ok(top.score > 4 && top.score <= 5, `top raw score ${top.score}`);
});

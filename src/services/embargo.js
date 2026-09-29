"use strict";

/**
 * Results embargo. Scores, rankings, calibration and per-project aggregates
 * are organizer-only until the event status is 'published'. Every non-organizer
 * read path asks this one function, so there is one place to get wrong.
 */

function isPublished(db) {
  const row = db.prepare(`SELECT status FROM events LIMIT 1`).get();
  return Boolean(row) && row.status === "published";
}

module.exports = { isPublished };

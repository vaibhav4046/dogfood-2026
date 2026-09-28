"use strict";

/**
 * Rubric definition.
 *
 * Weights are relative and are normalised to sum to 1 at aggregation time, so
 * an organizer editing them does not have to keep them summing to a magic
 * number. The score bounds are stored per criterion rather than global because
 * a rubric that allows 0-5 for craft and 0-10 for impact is legitimate, and a
 * single global bound would forbid it.
 */

const CRITERIA = [
  { key: "functionality", label: "Functionality", weight: 1, min: 1, max: 5, sort: 1 },
  { key: "quality", label: "Quality", weight: 1, min: 1, max: 5, sort: 2 },
  { key: "innovation", label: "Innovation", weight: 1, min: 1, max: 5, sort: 3 },
];

/**
 * Fixture scores are 1..5 across all three criteria, so the initial weights
 * are equal thirds. `DEFAULT_WEIGHTS` stays keyed by criterion so a future
 * rubric with non-unit weights does not need a second shape.
 */
const DEFAULT_WEIGHTS = Object.fromEntries(CRITERIA.map((c) => [c.key, c.weight]));

function normaliseWeights(criteria) {
  const total = criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  if (total <= 0) {
    // All-zero weights would make every score a division by zero. Fall back to
    // equal shares rather than NaN, and let the organizer see it in the
    // Control Room's rubric health panel.
    const n = criteria.length || 1;
    return criteria.map((c) => ({ ...c, normalisedWeight: 1 / n }));
  }
  return criteria.map((c) => ({ ...c, normalisedWeight: (Number(c.weight) || 0) / total }));
}

module.exports = { CRITERIA, DEFAULT_WEIGHTS, normaliseWeights };

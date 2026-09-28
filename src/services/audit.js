"use strict";

const crypto = require("crypto");

/**
 * Audit trail.
 *
 * Every high-value judging mutation writes one row. Actor, action, target,
 * previous state where there is one, new state, request id, timestamp.
 *
 * A refusal is audited too. The interesting security events are the ones that
 * did not succeed — "judge_b asked for judge_a's scores" is exactly what an
 * organizer needs to see, and a trail that only records successes hides it.
 */

const ACTIONS = new Set([
  "project.submitted",
  "project.submit_refused",
  "project.updated",
  "team.created",
  "team.joined",
  "judge.invited",
  "judge.invitation_accepted",
  "assignment.created",
  "assignment.deleted",
  "review.saved",
  "review.submitted",
  "review.scores_refused",
  "scores.read",
  "scores.read_refused",
  "rubric.updated",
  "event.status_changed",
  "results.published",
  "export.csv",
]);

function writeAudit(db, req, { action, targetType, targetId, previousState = null, newState = null }) {
  if (!ACTIONS.has(action)) {
    // An unknown action is a programming error, not a runtime condition.
    throw new Error(`audit: unknown action "${action}"`);
  }
  const id = `aud_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(
    `INSERT INTO audit_events
      (id,event_id,actor_id,actor_role,action,target_type,target_id,
       previous_state,new_state,request_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    req.eventId || null,
    req.user ? req.user.id : null,
    req.user ? req.user.role : "anonymous",
    action,
    targetType,
    targetId,
    previousState,
    newState,
    req.requestId || crypto.randomUUID(),
    new Date().toISOString(),
  );
  return id;
}

function listAudit(db, { eventId, limit = 200 } = {}) {
  const rows = eventId
    ? db
        .prepare(
          `SELECT a.*, u.name AS actor_name, u.email AS actor_email
             FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
            WHERE a.event_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        )
        .all(eventId, limit)
    : db
        .prepare(
          `SELECT a.*, u.name AS actor_name, u.email AS actor_email
             FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
            ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        )
        .all(limit);
  return rows;
}

module.exports = { writeAudit, listAudit, ACTIONS };

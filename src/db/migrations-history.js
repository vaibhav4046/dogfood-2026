"use strict";

/** Append-only review score history. No foreign key: history must outlive a deleted review. */

module.exports = [
  {
    id: "history_001_review_versions",
    sql: `
      CREATE TABLE review_versions (
        id          TEXT PRIMARY KEY,
        review_id   TEXT NOT NULL,
        judge_id    TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        version     INTEGER NOT NULL,
        status      TEXT NOT NULL,
        comment     TEXT NOT NULL DEFAULT '',
        scores_json TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE (review_id, version)
      );
      CREATE TRIGGER review_versions_no_update BEFORE UPDATE ON review_versions
        BEGIN SELECT RAISE(ABORT, 'review_versions is append-only'); END;
      CREATE TRIGGER review_versions_no_delete BEFORE DELETE ON review_versions
        BEGIN SELECT RAISE(ABORT, 'review_versions is append-only'); END;
    `,
  },
];

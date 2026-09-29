"use strict";

/**
 * SQLite schema and migrations.
 *
 * Migrations are a numbered, append-only list. `migrate()` applies every one
 * whose id is not yet recorded, inside a transaction each, so a fresh volume
 * and an existing volume converge on the same schema and a half-applied
 * migration cannot be silently skipped.
 *
 * Relational, not JSON blobs: judging integrity is the product. A score that
 * cannot be joined to its judge, project and criterion cannot be checked for
 * authorization, aggregated, or exported. That is the whole reason this is
 * tables and not a document store.
 */

const MIGRATIONS = [
  {
    id: "001_core",
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('visitor','participant','judge','organizer','admin')),
        -- The short handle a human uses for this account: "judge_a",
        -- "organizer". The spec's .dogfood.toml addresses judges by these
        -- handles, so the API has to resolve them, not just internal ids.
        -- Nullable: fixture judges are named people and have no handle.
        login_key     TEXT UNIQUE,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_users_role ON users(role);

      CREATE TABLE sessions (
        token         TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE events (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        tagline           TEXT,
        description       TEXT,
        starts_at         TEXT,
        submissions_open  TEXT,
        submissions_close TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('draft','open','closed','judging','published')),
        prize_pool_cents  INTEGER NOT NULL DEFAULT 0,
        custom_questions  TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE tracks (
        id        TEXT PRIMARY KEY,
        event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name      TEXT NOT NULL,
        slug      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_tracks_slug ON tracks(event_id, slug);

      /*
       * Team names are NOT unique, and the fixtures prove why: forty teams
       * include three called "StillTrail", two "AmberSwitch" and two
       * "OpenSignal". A UNIQUE(event_id, name) index rejects 4 of the 40 real
       * rows, which would empty the gallery and fail the acceptance check on
       * the first boot. Identity is the id; the name is a label two different
       * teams may share. The create-team route still refuses a duplicate name
       * as a UI affordance, but the schema must not assert it.
       */
      CREATE TABLE teams (
        id         TEXT PRIMARY KEY,
        event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        invite_code TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_teams_name ON teams(event_id, name);

      CREATE TABLE team_members (
        team_id  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        is_captain INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );

      /*
       * No database-level uniqueness on (team, track), and that is a decision
       * rather than an omission. The fixtures contain a real duplicate:
       * prj_07 and prj_41 are both tm_07 in trk_03, both titled "Dry Harbour",
       * both submitted before the 18:00 deadline. That is the "duplicate
       * submission" the spec says is in there on purpose, and an organizer
       * cannot retroactively un-submit a project that was accepted in time.
       * Rejecting it at seed time would delete real data and fail the gallery
       * check.
       *
       * So the invariant is enforced where it can actually be trusted — in the
       * POST /api/projects handler, which refuses a second live submission per
       * team per track with 409 duplicate_submission — and the historical
       * duplicate is surfaced to the organizer in the Control Room instead of
       * being hidden. See duplicateSubmissions() in src/services/judging.js.
       */
      CREATE TABLE projects (
        id             TEXT PRIMARY KEY,
        event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        track_id       TEXT NOT NULL REFERENCES tracks(id) ON DELETE RESTRICT,
        title          TEXT NOT NULL,
        tagline        TEXT,
        description    TEXT,
        repo_url       TEXT,
        demo_url       TEXT,
        live_url       TEXT,
        media_urls     TEXT NOT NULL DEFAULT '[]',
        tech_tags      TEXT NOT NULL DEFAULT '[]',
        custom_answers TEXT NOT NULL DEFAULT '{}',
        status         TEXT NOT NULL CHECK (status IN ('draft','submitted')),
        submitted_at   TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX idx_projects_team_track ON projects(team_id, track_id);
      CREATE INDEX idx_projects_event ON projects(event_id);
      CREATE INDEX idx_projects_track ON projects(track_id);

      CREATE TABLE judge_profiles (
        judge_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT,
        bio        TEXT,
        org        TEXT
      );

      CREATE TABLE judge_track_eligibility (
        judge_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        PRIMARY KEY (judge_id, track_id)
      );

      CREATE TABLE invitations (
        id         TEXT PRIMARY KEY,
        event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        email      TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('judge','organizer')),
        token      TEXT NOT NULL UNIQUE,
        accepted_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_invitations_event_email ON invitations(event_id, email);

      CREATE TABLE assignments (
        id          TEXT PRIMARY KEY,
        event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        judge_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','submitted','declined')),
        assigned_at TEXT NOT NULL,
        UNIQUE (judge_id, project_id)
      );
      CREATE INDEX idx_assignments_judge ON assignments(judge_id);
      CREATE INDEX idx_assignments_project ON assignments(project_id);

      CREATE TABLE criteria (
        id          TEXT PRIMARY KEY,
        event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        label       TEXT NOT NULL,
        weight      REAL NOT NULL,
        min_score   INTEGER NOT NULL DEFAULT 1,
        max_score   INTEGER NOT NULL DEFAULT 5,
        sort_order  INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_criteria_key ON criteria(event_id, key);

      CREATE TABLE reviews (
        id          TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
        judge_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status      TEXT NOT NULL CHECK (status IN ('draft','submitted')),
        comment     TEXT NOT NULL DEFAULT '',
        submitted_at TEXT,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_reviews_judge ON reviews(judge_id);
      CREATE INDEX idx_reviews_project ON reviews(project_id);

      CREATE TABLE review_scores (
        review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        criterion_id TEXT NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
        value       INTEGER NOT NULL,
        PRIMARY KEY (review_id, criterion_id),
        CHECK (value >= 0 AND value <= 10)
      );

      CREATE TABLE audit_events (
        id           TEXT PRIMARY KEY,
        event_id     TEXT,
        actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_role   TEXT,
        action       TEXT NOT NULL,
        target_type  TEXT NOT NULL,
        target_id    TEXT,
        previous_state TEXT,
        new_state    TEXT,
        request_id   TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_audit_event ON audit_events(event_id, created_at);
      CREATE INDEX idx_audit_actor ON audit_events(actor_id);

      CREATE TABLE results (
        id             TEXT PRIMARY KEY,
        event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        mode           TEXT NOT NULL CHECK (mode IN ('raw','normalized')),
        weighted_score REAL NOT NULL,
        review_count   INTEGER NOT NULL,
        rank           INTEGER NOT NULL,
        detail         TEXT NOT NULL DEFAULT '{}',
        computed_at    TEXT NOT NULL,
        UNIQUE (event_id, project_id, mode)
      );

      CREATE TABLE counters (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `,
  },
];

MIGRATIONS.push(...require("./migrations-auth"), ...require("./migrations-audit-chain"));
MIGRATIONS.push(...require("./migrations-history"));

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);

  const applied = new Set(
    db.prepare(`SELECT id FROM schema_migrations`).all().map((r) => r.id),
  );
  const record = db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      if (m.up) m.up(db);
      record.run(m.id, new Date().toISOString());
    });
    run();
  }
  return MIGRATIONS.filter((m) => !applied.has(m.id)).map((m) => m.id);
}

module.exports = { migrate, MIGRATIONS };

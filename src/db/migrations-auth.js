"use strict";

/**
 * Auth migrations. migrations.js appends these to MIGRATIONS so the schema owner
 * of 001_core and the auth stream never edit the same lines. Ids are prefixed so
 * they cannot collide with another stream's numbering.
 *
 * Existing rows are the seeded fixtures. Every existing session row therefore
 * becomes kind 'demo' through the column default, which is what keeps the four
 * deterministic tokens working in demo mode and lets production mode ignore them.
 */

module.exports = [
  {
    id: "auth_001_accounts_and_sessions",
    sql: `
      -- scrypt$N$r$p$salt$hash. NULL for fixture users, who cannot sign in with a password.
      ALTER TABLE users ADD COLUMN password_hash TEXT;

      -- kind 'real': sessions.token holds sha256(token), the token itself is never stored.
      -- kind 'demo': sessions.token holds the fixture token in plaintext; honoured in demo mode only.
      ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'demo' CHECK (kind IN ('demo','real'));
      ALTER TABLE sessions ADD COLUMN revoked_at TEXT;
      ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
      -- Absolute cap. expires_at slides forward on use but never past this.
      ALTER TABLE sessions ADD COLUMN max_expires_at TEXT;
      CREATE INDEX idx_sessions_user_kind ON sessions(user_id, kind);
    `,
  },
  {
    id: "auth_002_judge_invitations",
    sql: `
      -- invitations.token holds sha256(token). The link token is shown once and not stored.
      ALTER TABLE invitations ADD COLUMN expires_at TEXT;
      ALTER TABLE invitations ADD COLUMN revoked_at TEXT;
      ALTER TABLE invitations ADD COLUMN tracks TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE invitations ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE invitations ADD COLUMN accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL;

      -- One open invitation per email. A new invitation revokes the previous open one,
      -- and accepted or revoked rows stay as history.
      DROP INDEX idx_invitations_event_email;
      CREATE UNIQUE INDEX idx_invitations_open_email ON invitations(event_id, email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;
    `,
  },
  {
    id: "auth_003_team_invites",
    sql: `
      CREATE TABLE team_invites (
        id          TEXT PRIMARY KEY,
        team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT,
        used_by     TEXT REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_team_invites_team ON team_invites(team_id);
    `,
  },
];

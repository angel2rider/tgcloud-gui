-- TeleDrive D1 Schema
-- ─────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,                        -- NULL for OAuth-only users
  google_id     TEXT UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  storage_used  INTEGER NOT NULL DEFAULT 0,  -- bytes
  storage_quota INTEGER NOT NULL DEFAULT 1099511627776, -- 1 TB
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google   ON users(google_id);

-- ─────────────────────────────────────────
-- FOLDERS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(owner_id, parent_id, name)
);

CREATE INDEX IF NOT EXISTS idx_folders_owner  ON folders(owner_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- ─────────────────────────────────────────
-- FILES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL DEFAULT 0,   -- bytes
  checksum    TEXT,                         -- SHA-256 of full file
  is_deleted  INTEGER NOT NULL DEFAULT 0,   -- soft delete
  upload_complete INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_files_owner    ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_folder   ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_deleted  ON files(is_deleted);

-- ─────────────────────────────────────────
-- CHUNKS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  file_id             TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  chunk_index         INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  telegram_file_id    TEXT NOT NULL,
  chunk_size          INTEGER NOT NULL,
  checksum            TEXT NOT NULL,        -- SHA-256 of chunk
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(file_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id, chunk_index);

-- ─────────────────────────────────────────
-- TRASH
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trash (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  file_id     TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  deleted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  purge_at    INTEGER NOT NULL DEFAULT (unixepoch() + 2592000) -- +30 days
);

CREATE INDEX IF NOT EXISTS idx_trash_purge ON trash(purge_at);

-- ─────────────────────────────────────────
-- UPLOAD SESSIONS  (resume support)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS upload_sessions (
  id           TEXT PRIMARY KEY,
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_id     TEXT NOT NULL,
  total_chunks INTEGER NOT NULL,
  uploaded     TEXT NOT NULL DEFAULT '[]',  -- JSON array of completed chunk indices
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER NOT NULL DEFAULT (unixepoch() + 86400) -- 24h
);

-- ─────────────────────────────────────────
-- RATE LIMITS  (simple sliding window)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT NOT NULL,
  window     INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window)
);

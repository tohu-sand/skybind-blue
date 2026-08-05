-- Idempotent schema for manga_links.
-- Safe to run against either the local or the remote (production) D1 database:
-- it only creates the table/index when missing and never drops existing data.
-- For a destructive LOCAL reset, use reset.sql (npm run db:reset:local) instead.
CREATE TABLE IF NOT EXISTS manga_links (
  id TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  title TEXT,
  pages_json TEXT NOT NULL,
  start_side TEXT DEFAULT 'right',
  original_post_uri TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  -- CID of the verified blue.skybind.comic record in the author's repo
  -- (NULL = no record: legacy links, or record creation failed/was skipped).
  record_cid TEXT,
  -- 'pending' while a reserved link awaits its thread; 'active' once linked.
  state TEXT NOT NULL DEFAULT 'active'
);
-- Adding columns to an EXISTING table cannot be expressed idempotently in
-- SQLite DDL; use `npm run db:migrate` / `db:migrate:remote` (scripts/db-migrate.mjs)
-- to bring an existing database up to this shape safely.
CREATE INDEX IF NOT EXISTS idx_manga_id ON manga_links(id);

-- Consumed service-auth JWT nonces (replay prevention). Rows are disposable:
-- anything past its expiry can no longer be replayed and is purged.
CREATE TABLE IF NOT EXISTS service_auth_jti (
  jti TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_auth_jti_expires ON service_auth_jti(expires_at);

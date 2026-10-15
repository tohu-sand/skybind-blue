-- Creates missing tables and indexes without changing existing data.
-- For existing tables, add columns with npm run db:migrate (or db:migrate:remote).
CREATE TABLE IF NOT EXISTS manga_links (
  id TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  title TEXT,
  pages_json TEXT NOT NULL,
  start_side TEXT DEFAULT 'right',
  original_post_uri TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  -- NULL means no verified blue.skybind.comic record is attached.
  record_cid TEXT,
  -- 'pending' while a reserved link awaits its thread; 'active' once linked.
  state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_manga_id ON manga_links(id);
CREATE INDEX IF NOT EXISTS idx_manga_author_created ON manga_links(author_did, created_at);

-- Consumed JWT nonces prevent replay; expired entries can be purged.
CREATE TABLE IF NOT EXISTS service_auth_jti (
  jti TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_auth_jti_expires ON service_auth_jti(expires_at);

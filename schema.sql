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
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_manga_id ON manga_links(id);

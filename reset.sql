-- DESTRUCTIVE: drops and recreates manga_links, deleting every row.
-- Intended for resetting a LOCAL development database only (npm run db:reset:local).
-- Never run this against the remote/production database: it permanently destroys
-- every id -> original_post_uri mapping and breaks all previously shared links.
DROP TABLE IF EXISTS manga_links;
CREATE TABLE manga_links (
  id TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  title TEXT,
  pages_json TEXT NOT NULL,
  start_side TEXT DEFAULT 'right',
  original_post_uri TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  record_cid TEXT,
  state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_manga_id ON manga_links(id);
DROP TABLE IF EXISTS service_auth_jti;
CREATE TABLE service_auth_jti (
  jti TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_auth_jti_expires ON service_auth_jti(expires_at);

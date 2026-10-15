-- Local reset only (npm run db:reset:local): deletes all links and consumed JWT nonces.
-- Never run against production; deleting link mappings breaks shared URLs.
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
CREATE INDEX IF NOT EXISTS idx_manga_author_created ON manga_links(author_did, created_at);
DROP TABLE IF EXISTS service_auth_jti;
CREATE TABLE service_auth_jti (
  jti TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_auth_jti_expires ON service_auth_jti(expires_at);

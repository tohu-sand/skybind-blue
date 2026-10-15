import { execFileSync } from 'node:child_process'

const DB_NAME = 'skybind-db'
const remote = process.argv.includes('--remote')
const target = remote ? '--remote' : '--local'

// Added columns must be nullable or have a default for existing rows.
const WANTED_COLUMNS = new Map([
  ['record_cid', 'record_cid TEXT'],
  ['state', "state TEXT NOT NULL DEFAULT 'active'"],
])

const d1 = (command) => {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, target, '--command', command, '--json'],
    { encoding: 'utf8' },
  )
  // Wrangler may print a banner before the JSON result array.
  const start = out.indexOf('[')
  if (start === -1) {
    throw new Error(`Unexpected wrangler output:\n${out}`)
  }
  return JSON.parse(out.slice(start))
}

console.log(`Target: ${remote ? 'REMOTE (production)' : 'local'} ${DB_NAME}`)
if (remote) {
  console.log('Reminder: take a backup first:')
  console.log(
    '  npx wrangler d1 export skybind-db --remote --output=backups/skybind-db-$(date +%Y%m%d-%H%M%S).sql',
  )
}

d1(`CREATE TABLE IF NOT EXISTS service_auth_jti (
  jti TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`)
d1(
  'CREATE INDEX IF NOT EXISTS idx_service_auth_jti_expires ON service_auth_jti(expires_at)',
)
console.log('- service_auth_jti: ensured')

// SQLite has no ADD COLUMN IF NOT EXISTS; inspect columns before adding them.
const info = d1('PRAGMA table_info(manga_links)')
const existing = new Set(
  (info[0]?.results ?? []).map((column) => column.name),
)
if (!existing.size) {
  throw new Error(
    'manga_links table not found. Run `npm run db:apply` (or db:apply:remote) first.',
  )
}

for (const [name, clause] of WANTED_COLUMNS) {
  if (existing.has(name)) {
    console.log(`- ${name}: already present, skipping`)
    continue
  }
  d1(`ALTER TABLE manga_links ADD COLUMN ${clause}`)
  console.log(`- ${name}: added`)
}

d1(
  'CREATE INDEX IF NOT EXISTS idx_manga_author_created ON manga_links(author_did, created_at)',
)
console.log('- idx_manga_author_created: ensured')

// Reservations must stay pending even when the column default is 'active'.
const fixed = d1(
  "UPDATE manga_links SET state = 'pending' WHERE original_post_uri = 'pending' AND state != 'pending'",
)
console.log(
  `- state backfill: ${fixed[0]?.meta?.changes ?? 0} pending row(s) corrected`,
)
console.log('Migration complete.')

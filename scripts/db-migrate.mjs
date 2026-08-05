// Idempotent D1 migration: brings an existing manga_links table up to the
// current schema. SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
// so this script inspects the table first and only adds what is missing.
// Safe to run any number of times, locally or remotely.
//
//   node scripts/db-migrate.mjs           # local D1
//   node scripts/db-migrate.mjs --remote  # production D1 (take a backup first!)

import { execFileSync } from 'node:child_process'

const DB_NAME = 'skybind-db'
const remote = process.argv.includes('--remote')
const target = remote ? '--remote' : '--local'

// column name -> ALTER clause. New columns must be nullable or have a default
// so the ALTER applies instantly without rewriting existing rows.
const WANTED_COLUMNS = new Map([
  ['record_cid', 'record_cid TEXT'],
  ["state", "state TEXT NOT NULL DEFAULT 'active'"],
])

const d1 = (command) => {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, target, '--command', command, '--json'],
    { encoding: 'utf8' },
  )
  // wrangler prints a JSON array of result sets after any banner noise.
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

// Tables that are safe to create outright when missing (idempotent DDL).
d1(`CREATE TABLE IF NOT EXISTS service_auth_jti (
  jti TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`)
d1(
  'CREATE INDEX IF NOT EXISTS idx_service_auth_jti_expires ON service_auth_jti(expires_at)',
)
console.log('- service_auth_jti: ensured')

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

// The 'active' default is wrong for reserved-but-never-completed rows; fix them.
// Idempotent: matching rows are already exactly this value after the first run.
const fixed = d1(
  "UPDATE manga_links SET state = 'pending' WHERE original_post_uri = 'pending' AND state != 'pending'",
)
console.log(
  `- state backfill: ${fixed[0]?.meta?.changes ?? 0} pending row(s) corrected`,
)
console.log('Migration complete.')

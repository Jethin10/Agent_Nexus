import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { executeRows } from './client'
import * as schema from './schema/index'

/**
 * The offline path (§16.3 insurance item 2). PGlite is a real Postgres compiled to
 * WASM, running in-process — the same engine, not an emulation, so every query in
 * `queries/` executes here exactly as it does on Neon.
 *
 * PLAN.md called for local Postgres via Docker. This replaces that: it needs no
 * daemon, no container and no port, which matters because the demo has to survive a
 * Neon suspension (§13.1) on a machine that may not have Docker at all.
 *
 * pgvector is loaded as an extension so `vector(768)`, the `<=>` cosine operator and
 * the HNSW indexes all behave as the retrieval queries expect. Verified against all
 * four sources in `queries/retrieval.test.ts`.
 *
 * Deliberately NOT a fallback inside `db()`: production stays on neon-http (D9), and
 * a silent switch between the two would hide a missing DATABASE_URL in deployment.
 * The caller opts in explicitly.
 */

/** Relative imports here stay extensionless, matching the rest of packages/db (D1, D16). */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve pgvector's archive as a real file URL instead of allowing Next/Webpack to
 * turn `new URL('./vector.tar.gz', import.meta.url)` into `/_next/static/media/...`.
 * PGlite runs on the server and reads this bundle from disk; an HTTP asset URL can
 * never work there. The candidates cover direct package execution, workspace tests,
 * and the filtered `apps/web` dev process.
 */
function vectorBundleUrl(): URL {
  let root = process.cwd()
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const parent = dirname(root)
    if (parent === root) throw new Error('Unable to locate the pnpm workspace root')
    root = parent
  }

  const store = join(root, 'node_modules', '.pnpm')
  const packageDir = readdirSync(store).find((name) =>
    name.startsWith('@electric-sql+pglite-pgvector@'),
  )
  if (!packageDir) throw new Error('Unable to resolve the local pgvector extension bundle')

  const bundle = join(
    store,
    packageDir,
    'node_modules',
    '@electric-sql',
    'pglite-pgvector',
    'dist',
    'vector.tar.gz',
  )
  if (!existsSync(bundle)) throw new Error(`Local pgvector bundle is missing: ${bundle}`)
  return pathToFileURL(bundle)
}

const localVector = {
  name: 'vector',
  setup: async (_pg: unknown, emscriptenOpts: unknown) => ({
    emscriptenOpts,
    bundlePath: vectorBundleUrl(),
  }),
}

/** `packages/db/migrations` — resolved from this file so cwd never matters. */
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations')

export type LocalDb = ReturnType<typeof drizzle<typeof schema>>

export interface LocalDbHandle {
  db: LocalDb
  client: PGlite
  close: () => Promise<void>
}

/**
 * `dataDir` omitted gives an in-memory database, which is what the tests use: each
 * one gets a clean Postgres in ~1s with no file to clean up. The seed script passes
 * a directory so a seeded corpus survives between `pnpm seed:demo` and `pnpm dev`.
 */
export async function makeLocalDb(dataDir?: string): Promise<LocalDbHandle> {
  const client = await PGlite.create({
    ...(dataDir ? { dataDir } : {}),
    extensions: { vector: localVector },
  })

  // Mirrors makeDb() in client.ts exactly: same schema, same casing. Anything that
  // works against one instance works against the other.
  const db = drizzle(client, { schema, casing: 'snake_case' })

  return {
    db,
    client,
    close: () => client.close(),
  }
}

/**
 * Applies every `migrations/*.sql` in filename order, statement by statement.
 *
 * drizzle-kit's own migrator is not used because it expects a journal table and a
 * node-postgres connection; this is a fresh database each time. `0000` hand-prepends
 * `CREATE EXTENSION IF NOT EXISTS vector` (D2) and that must remain the first statement
 * executed — the vector columns and HNSW indexes fail without it. Lexicographic order
 * over the zero-padded drizzle-kit prefixes gives that for free.
 *
 * Reading the directory rather than naming one file is deliberate: a hardcoded filename
 * means a second migration is silently ignored locally while passing in CI, and the
 * schema drift only surfaces as a missing column at runtime.
 */
export async function applyMigrations(db: LocalDb, dir = MIGRATIONS_DIR): Promise<number> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  if (files.length === 0) throw new Error(`applyMigrations: no .sql files in ${dir}`)

  let applied = 0
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8')
    const statements = raw
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const statement of statements) {
      await db.execute(sql.raw(statement))
    }
    applied += statements.length
  }
  return applied
}

/** True when a `vector` column can be created — proves the extension actually loaded. */
export async function hasVector(db: LocalDb): Promise<boolean> {
  const rows = await executeRows<{ n: number }>(
    db,
    sql`select count(*)::int as n from pg_extension where extname = 'vector'`,
  )
  return Number(rows[0]?.n ?? 0) > 0
}

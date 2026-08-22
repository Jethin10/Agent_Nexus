import { neon } from '@neondatabase/serverless'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http'
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { SQL } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema/index'

/**
 * The database as the rest of the codebase uses it.
 *
 * Deliberately drizzle's driver-agnostic `PgDatabase` rather than
 * `ReturnType<typeof makeDb>`: production runs on neon-http (D9) and the offline path
 * (local.ts, §16.3) runs on PGlite, and both must satisfy this type so every query in
 * `queries/` is written once and executed against both. The driver's result type is
 * what differs, and it is exactly what the `PgQueryResultHKT` parameter abstracts.
 *
 * Pinning this to one driver's concrete return type would make the offline demo a
 * second implementation of all ten tables' queries, which is precisely the
 * duplication that would let the two paths silently diverge.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

/**
 * Rows from a raw `db.execute()`.
 *
 * Every driver returns `{ rows }`, but the element type is expressed through the
 * driver's own result HKT, which stays unresolved while `Db` is driver-agnostic. The
 * two raw queries in this package (`repeatedObjections`, and the migration checks in
 * local.ts) go through here so the widening happens once, with the row shape named,
 * rather than as an `as` at each call site.
 */
export async function executeRows<TRow>(db: Db, query: SQL): Promise<TRow[]> {
  const res = (await db.execute(query)) as unknown as { rows: TRow[] }
  return [...res.rows]
}

/**
 * neon-http, not the WebSocket pool driver. Vercel Hobby functions are capped at 60s
 * and Neon Free scales compute to zero, so a per-request HTTP call that needs no
 * connection teardown is a better fit than a pool that has to be drained before the
 * function freezes. The cost is no interactive transactions — every write in this
 * codebase is a single statement or a batch, deliberately.
 */
export type DatabaseTransport = 'neon-http' | 'postgres'

export function databaseTransport(url: string): DatabaseTransport {
  const hostname = new URL(url).hostname.toLowerCase()
  return hostname.endsWith('.neon.tech') ? 'neon-http' : 'postgres'
}

export function makeDb(url: string): Db {
  if (databaseTransport(url) === 'neon-http') {
    return drizzleNeon(neon(url), { schema, casing: 'snake_case' }) as unknown as Db
  }

  // Render and ordinary hosted Postgres expose the wire protocol rather than Neon's
  // HTTP endpoint. Keep a small process-level pool; `db()` caches this Drizzle client
  // across warm requests and Render's free instance has intentionally modest limits.
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 })
  return drizzlePostgres(pool, { schema, casing: 'snake_case' }) as unknown as Db
}

let cached: Db | undefined

/**
 * Reused across warm invocations; throws loudly rather than connecting to nothing.
 *
 * `setDb()` exists for the offline path: scripts and tests build a PGlite instance
 * (see local.ts) and install it here, so every consumer of `db()` — including the
 * dashboard's server components — reaches the local database without knowing it is
 * not Neon. Production is untouched and still reads DATABASE_URL.
 */
export function db(): Db {
  if (cached) return cached
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. For the offline path, run through `pnpm seed:demo` / `pnpm demo`, ' +
        'or set ASCENDANT_LOCAL_DB=1 so the dashboard opens the local PGlite database.',
    )
  }
  cached = makeDb(url)
  return cached
}

/**
 * Installs an already-constructed instance as the process-wide `db()`.
 *
 * This is the seam that lets the local PGlite database serve the real queries without
 * a second code path through the ten tables: `Db` is structural, so drizzle-over-PGlite
 * satisfies it and every query in `queries/` runs unmodified.
 */
export function setDb(instance: Db): void {
  cached = instance
}

/** For tests that need a fresh instance in the same process. */
export function resetDb(): void {
  cached = undefined
}

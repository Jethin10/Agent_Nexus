import { setDb, type Db } from '@ascendant/db'

/**
 * Opens the local PGlite database for the dashboard when `ASCENDANT_LOCAL_DB=1`.
 *
 * `db()` is synchronous (it wraps a Neon HTTP handle, which needs no connect step) but
 * PGlite has to boot WASM, so the offline path needs an async initializer. Every server
 * component calls `ensureDb()` before `db()`; the promise is memoised so concurrent
 * requests during one render share a single instance rather than each booting Postgres.
 *
 * Production is unaffected: with DATABASE_URL set this returns immediately and `db()`
 * builds the Neon client exactly as before (D9).
 */

let opening: Promise<void> | undefined

export function isLocalDb(): boolean {
  return !process.env.DATABASE_URL && process.env.ASCENDANT_LOCAL_DB === '1'
}

export async function ensureDb(): Promise<void> {
  if (!isLocalDb()) return
  if (!opening) {
    opening = (async () => {
      // Imported lazily and by subpath so PGlite's WASM never enters a bundle that
      // does not need it — the package barrel deliberately does not export ./local.
      const { makeLocalDb } = await import('@ascendant/db/local')
      const { join } = await import('node:path')
      const dataDir = process.env.ASCENDANT_LOCAL_DB_DIR ?? join(process.cwd(), '..', '..', '.ascendant', 'pgdata')
      const handle = await makeLocalDb(dataDir)
      setDb(handle.db as unknown as Db)
    })()
  }
  return opening
}

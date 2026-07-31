import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema/index'

export type Db = ReturnType<typeof makeDb>

/**
 * neon-http, not the WebSocket pool driver. Vercel Hobby functions are capped at 60s
 * and Neon Free scales compute to zero, so a per-request HTTP call that needs no
 * connection teardown is a better fit than a pool that has to be drained before the
 * function freezes. The cost is no interactive transactions — every write in this
 * codebase is a single statement or a batch, deliberately.
 */
export function makeDb(url: string) {
  return drizzle(neon(url), { schema, casing: 'snake_case' })
}

let cached: Db | undefined

/** Reused across warm invocations; throws loudly rather than connecting to nothing. */
export function db(): Db {
  if (cached) return cached
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  cached = makeDb(url)
  return cached
}

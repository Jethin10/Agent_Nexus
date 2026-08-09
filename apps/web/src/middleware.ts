import { NextResponse, type NextRequest } from 'next/server'

/**
 * Dashboard auth (B8).
 *
 * The Policy view writes the autonomy threshold to the `config` table, and `band()`
 * reads it on every decision. Anyone who could reach `/policy` could therefore lower
 * the bar for autonomous action across the whole pipeline — a privilege escalation, not
 * just an information leak. That gap was documented in `policy/actions.ts` and
 * `lib/org.ts`; this closes it.
 *
 * HTTP Basic over a shared secret, deliberately: the dashboard has no user model, no
 * sessions table and no email flow, and inventing one to guard a single-operator demo
 * would be more code than the thing it protects. It is a gate, not an identity system —
 * `currentOrgId()` still resolves to one configured org.
 *
 * Two routes are exempt, and both already authenticate more strongly than a password:
 *
 *   /api/webhooks/github   HMAC-SHA256 over the raw body against the shared secret,
 *                          compared with timingSafeEqual (§15.2). GitHub cannot send
 *                          an Authorization header, so requiring one here would break
 *                          ingestion entirely.
 *   /api/inngest           Inngest's own request signing key.
 *
 * Adding Basic auth in front of either would not add security — it would replace a
 * cryptographic signature over the payload with a static password.
 */

const REALM = 'Ascendant'

/** Authenticated by signature instead; see the note above. */
const EXEMPT = ['/api/webhooks/', '/api/inngest']

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      // A 401 that gets cached is a 401 that survives a correct password.
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Length-independent comparison.
 *
 * `node:crypto`'s timingSafeEqual is not available in the Edge runtime that middleware
 * runs on, and it throws on length mismatch anyway — which leaks the secret's length.
 * Comparing fixed-width SHA-256 digests sidesteps both: every comparison is 32 bytes
 * regardless of input, and the loop has no early exit.
 */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const va = new Uint8Array(da)
  const vb = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < va.length; i += 1) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0)
  return diff === 0
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl
  if (EXEMPT.some((p) => pathname.startsWith(p))) return NextResponse.next()

  const expected = process.env.ASCENDANT_DASHBOARD_PASSWORD
  /**
   * Unset means local development, which is the common case for this repo: `pnpm dev`
   * against an in-process PGlite on localhost. Failing closed here would put a password
   * prompt in front of every local run and get the variable committed to a .env to make
   * it stop.
   *
   * The deployment guard is in `next.config.ts` instead, which refuses a production
   * build when the variable is missing — the right place for it, because that is the
   * moment the dashboard becomes reachable by someone other than the person who
   * started it.
   */
  if (!expected) return NextResponse.next()

  const header = req.headers.get('authorization')
  if (!header?.startsWith('Basic ')) return unauthorized()

  let decoded: string
  try {
    decoded = atob(header.slice('Basic '.length).trim())
  } catch {
    return unauthorized()
  }

  // "user:password" — the username is ignored, so any non-empty one works.
  const password = decoded.slice(decoded.indexOf(':') + 1)
  if (!password) return unauthorized()
  if (!(await secretsMatch(password, expected))) return unauthorized()

  return NextResponse.next()
}

export const config = {
  /**
   * Everything except Next's own static output. `_next/static` and `_next/image` carry
   * no data from the database, and gating them would mean the browser re-authenticating
   * for every chunk.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '../middleware.js'

/**
 * The dashboard gate (B8).
 *
 * Auth is the kind of thing that breaks silently — a matcher typo or an early return in
 * the wrong branch fails open, and every page still renders, so nothing looks wrong.
 * These tests assert the closed cases as hard as the open ones.
 */

const PASSWORD = 'demo-secret'

function req(path: string, auth?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    ...(auth ? { headers: { authorization: auth } } : {}),
  })
}

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`

let saved: string | undefined
let savedDemo: string | undefined

beforeEach(() => {
  saved = process.env.ASCENDANT_DASHBOARD_PASSWORD
  savedDemo = process.env.ASCENDANT_DEMO_MODE
  delete process.env.ASCENDANT_DEMO_MODE
  process.env.ASCENDANT_DASHBOARD_PASSWORD = PASSWORD
})

afterEach(() => {
  if (saved === undefined) delete process.env.ASCENDANT_DASHBOARD_PASSWORD
  else process.env.ASCENDANT_DASHBOARD_PASSWORD = saved
  if (savedDemo === undefined) delete process.env.ASCENDANT_DEMO_MODE
  else process.env.ASCENDANT_DEMO_MODE = savedDemo
})

describe('dashboard auth', () => {
  it('rejects cross-site dashboard mutations even with valid Basic auth', async () => {
    const request = new NextRequest('http://localhost:3000/policy', {
      method: 'POST',
      headers: {
        authorization: basic('operator', PASSWORD),
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    })
    expect((await middleware(request)).status).toBe(403)
  })

  it('allows same-origin dashboard mutations with valid Basic auth', async () => {
    const request = new NextRequest('http://localhost:3000/policy', {
      method: 'POST',
      headers: {
        authorization: basic('operator', PASSWORD),
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'same-origin',
      },
    })
    expect((await middleware(request)).status).toBe(200)
  })

  it('challenges an unauthenticated request', async () => {
    const res = await middleware(req('/policy'))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Basic realm="Ascendant"')
  })

  it('does not let a 401 be cached, which would outlive a correct password', async () => {
    const res = await middleware(req('/policy'))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects a wrong password', async () => {
    const res = await middleware(req('/policy', basic('x', 'wrong')))
    expect(res.status).toBe(401)
  })

  it('admits the right password regardless of username', async () => {
    for (const user of ['admin', 'x', '']) {
      const res = await middleware(req('/policy', basic(user, PASSWORD)))
      expect(res.status).toBe(200)
    }
  })

  it('gates the Inbox and Metrics too, not just Policy', async () => {
    for (const path of ['/', '/metrics', '/events/abc']) {
      expect((await middleware(req(path))).status).toBe(401)
    }
  })

  it('rejects a password that merely shares a prefix with the secret', async () => {
    // Guards against a comparison that stops at the shorter length.
    for (const attempt of ['demo', 'demo-secretx', '']) {
      expect((await middleware(req('/policy', basic('x', attempt)))).status).toBe(401)
    }
  })

  it('rejects malformed credentials rather than throwing', async () => {
    for (const header of ['Basic !!!not-base64!!!', 'Basic ', 'Bearer token', 'Basic']) {
      const res = await middleware(req('/policy', header))
      expect(res.status).toBe(401)
    }
  })

  /**
   * Both exempt routes authenticate by signature over the raw body, which is strictly
   * stronger than a shared password — and GitHub cannot send an Authorization header at
   * all, so gating the webhook would break ingestion rather than secure it.
   */
  it('exempts the signature-authenticated routes', async () => {
    for (const path of ['/api/webhooks/github', '/api/webhooks/slack', '/api/inngest']) {
      expect((await middleware(req(path))).status).toBe(200)
    }
  })

  it('exempts only GET OAuth callbacks and still protects connection mutations', async () => {
    for (const path of [
      '/api/connect/github/callback',
      '/api/connect/slack/callback',
      '/api/connect/google/callback',
    ]) {
      expect((await middleware(req(path))).status).toBe(200)
      expect((await middleware(new NextRequest(`http://localhost:3000${path}`, { method: 'POST' }))).status).toBe(401)
    }
    expect((await middleware(req('/api/connect/github'))).status).toBe(401)
  })

  it('falls open only when no password is configured', async () => {
    delete process.env.ASCENDANT_DASHBOARD_PASSWORD
    // Local `pnpm dev` on localhost. The production build guard in next.config.ts is
    // what stops this default from reaching a deployment.
    expect((await middleware(req('/policy'))).status).toBe(200)
  })

  it('still gates when the password is set to a whitespace string', async () => {
    process.env.ASCENDANT_DASHBOARD_PASSWORD = ' '
    expect((await middleware(req('/policy'))).status).toBe(401)
    expect((await middleware(req('/policy', basic('x', ' ')))).status).toBe(200)
  })

  it('makes an explicit public demo readable but rejects mutations', async () => {
    process.env.ASCENDANT_DEMO_MODE = '1'
    expect((await middleware(req('/'))).status).toBe(200)
    expect((await middleware(new NextRequest('http://localhost:3000/policy', { method: 'POST' }))).status).toBe(403)
  })
})

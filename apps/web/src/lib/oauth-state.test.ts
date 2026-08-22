import { describe, expect, it } from 'vitest'
import {
  createOAuthState,
  OAuthStateError,
  safeReturnTo,
  verifyOAuthState,
} from './oauth-state.js'

const SECRET = 'test-secret-that-is-at-least-thirty-two-characters'
const NOW = new Date('2026-08-22T06:30:00.000Z')

describe('OAuth state', () => {
  it('round trips provider, browser nonce, and a safe return path', () => {
    const issued = createOAuthState('google', '/integrations?from=settings', {
      secret: SECRET,
      now: NOW,
      nonce: 'fixed-nonce',
    })
    expect(verifyOAuthState(issued.state, issued.cookieValue, 'google', { secret: SECRET, now: NOW }))
      .toEqual({ returnTo: '/integrations?from=settings' })
    expect(issued.cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' })
    expect(issued.cookieName).toBe('ascendant_oauth_state_google')
  })

  it('rejects tampering, provider swapping, browser mismatch, and expiry', () => {
    const issued = createOAuthState('slack', '/integrations', { secret: SECRET, now: NOW })
    expect(() => verifyOAuthState(`${issued.state}x`, issued.cookieValue, 'slack', { secret: SECRET, now: NOW }))
      .toThrow(OAuthStateError)
    expect(() => verifyOAuthState(issued.state, issued.cookieValue, 'google', { secret: SECRET, now: NOW }))
      .toThrow('provider')
    expect(() => verifyOAuthState(issued.state, `${issued.cookieValue}x`, 'slack', { secret: SECRET, now: NOW }))
      .toThrow('browser')
    expect(() => verifyOAuthState(issued.state, issued.cookieValue, 'slack', {
      secret: SECRET,
      now: new Date(NOW.getTime() + 11 * 60_000),
    })).toThrow('expired')
  })

  it('uses provider-specific cookies so parallel connection tabs do not collide', () => {
    const github = createOAuthState('github', '/integrations', { secret: SECRET, now: NOW })
    const slack = createOAuthState('slack', '/integrations', { secret: SECRET, now: NOW })
    expect(github.cookieName).not.toBe(slack.cookieName)
  })
})

describe('safeReturnTo', () => {
  it.each(['https://evil.test', '//evil.test/path', '/\\evil.test', 'javascript:alert(1)'])('rejects %s', (value) => {
    expect(safeReturnTo(value)).toBe('/integrations')
  })
  it('allows a local path with query and hash', () => {
    expect(safeReturnTo('/integrations?connected=slack#connections')).toBe('/integrations?connected=slack#connections')
  })
})

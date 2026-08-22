import { describe, expect, it } from 'vitest'
import { beginOAuth, failOAuth, finishOAuth } from './connect-response.js'
import type { OAuthState } from './oauth-state.js'

const issued: OAuthState = {
  state: 'state-value',
  cookieName: 'ascendant_oauth_state_google',
  cookieValue: 'cookie-value',
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  },
}

describe('OAuth response caching', () => {
  it('prevents caching the provider redirect that sets browser-bound state', () => {
    const response = beginOAuth(new URL('https://accounts.example/authorize'), issued)

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toContain(issued.cookieName)
  })

  it('prevents caching successful callback redirects', () => {
    const response = finishOAuth(
      'https://agent.example/api/connect/google/callback',
      '/integrations',
      'google',
      'gmail',
    )

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('location')).toBe('https://agent.example/integrations?connected=gmail')
  })

  it('prevents caching failed callback redirects', () => {
    const response = failOAuth(
      'https://agent.example/api/connect/slack/callback',
      'slack',
      new Error('Slack authorization was declined'),
    )

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('location')).toContain('/integrations?connectError=slack')
  })
})

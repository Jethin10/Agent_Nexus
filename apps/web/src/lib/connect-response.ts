import { NextResponse } from 'next/server'
import { oauthStateCookieName, type ConnectProvider, type OAuthState } from './oauth-state'
import { publicOrigin } from './public-url'

export function beginOAuth(url: URL, issued: OAuthState): NextResponse {
  const response = NextResponse.redirect(url)
  response.headers.set('cache-control', 'no-store')
  response.cookies.set(issued.cookieName, issued.cookieValue, issued.cookie)
  return response
}

export function finishOAuth(requestUrl: string, returnTo: string, provider: ConnectProvider, resultProvider: string = provider): NextResponse {
  const url = new URL(returnTo, publicOrigin(requestUrl))
  url.searchParams.set('connected', resultProvider)
  const response = NextResponse.redirect(url)
  response.headers.set('cache-control', 'no-store')
  response.cookies.delete(oauthStateCookieName(provider))
  return response
}

export function failOAuth(requestUrl: string, provider: ConnectProvider, error: unknown): NextResponse {
  const url = new URL('/integrations', publicOrigin(requestUrl))
  url.searchParams.set('connectError', provider)
  url.searchParams.set('reason', safeProviderError(error))
  const response = NextResponse.redirect(url)
  response.headers.set('cache-control', 'no-store')
  response.cookies.delete(oauthStateCookieName(provider))
  return response
}

function safeProviderError(error: unknown): string {
  const value = error instanceof Error ? error.message : 'Connection failed'
  return value.replace(/[\r\n]/g, ' ').replace(/(token|secret|code)=[^\s&]+/gi, '$1=[redacted]').slice(0, 180)
}

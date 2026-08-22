import { cookies } from 'next/headers'
import { saveConnection } from '@ascendant/workflows'
import { db } from '@ascendant/db'
import { currentOrgId } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'
import { failOAuth, finishOAuth } from '@/lib/connect-response'
import { oauthStateCookieName, verifyOAuthState } from '@/lib/oauth-state'
import { publicUrl } from '@/lib/public-url'

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  scope?: string
  error?: string
  error_description?: string
}

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  try {
    const cookie = (await cookies()).get(oauthStateCookieName('google'))?.value
    const { returnTo } = verifyOAuthState(requestUrl.searchParams.get('state'), cookie, 'google')
    if (requestUrl.searchParams.get('error')) throw new Error('Google authorization was declined')
    const code = requestUrl.searchParams.get('code')
    if (!code) throw new Error('Google did not return an authorization code')
    const redirectUri = publicUrl(request.url, '/api/connect/google/callback')
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: requireEnv('GMAIL_CLIENT_ID'),
        client_secret: requireEnv('GMAIL_CLIENT_SECRET'),
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      cache: 'no-store',
    })
    const token = await tokenResponse.json() as GoogleTokenResponse
    if (!tokenResponse.ok || !token.access_token || !token.refresh_token) {
      throw new Error(`Google could not complete authorization${token.error_description ? `: ${token.error_description}` : ''}`)
    }
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
      cache: 'no-store',
    })
    const profile = await profileResponse.json() as { email?: string }
    if (!profileResponse.ok || !profile.email) throw new Error('Google did not return the account email')

    await ensureDb()
    await saveConnection(db(), currentOrgId(), {
      provider: 'gmail',
      refreshToken: token.refresh_token,
      email: profile.email,
      scope: token.scope?.split(' ').filter(Boolean),
    })
    return finishOAuth(request.url, returnTo, 'google', 'gmail')
  } catch (error) {
    return failOAuth(request.url, 'google', error)
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

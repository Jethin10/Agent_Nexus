import { createOAuthState } from '@/lib/oauth-state'
import { beginOAuth } from '@/lib/connect-response'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const clientId = process.env.GMAIL_CLIENT_ID
  if (!clientId) return new Response('Google OAuth is not configured.', { status: 503 })
  const requestUrl = new URL(request.url)
  const issued = createOAuthState('google', requestUrl.searchParams.get('returnTo'))
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', new URL('/api/connect/google/callback', request.url).toString())
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/gmail.readonly')
  authorize.searchParams.set('access_type', 'offline')
  authorize.searchParams.set('prompt', 'consent')
  authorize.searchParams.set('state', issued.state)
  return beginOAuth(authorize, issued)
}

import { createOAuthState } from '@/lib/oauth-state'
import { beginOAuth } from '@/lib/connect-response'
import { publicUrl } from '@/lib/public-url'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const clientId = process.env.SLACK_CLIENT_ID
  if (!clientId) return new Response('Slack OAuth is not configured.', { status: 503 })
  const requestUrl = new URL(request.url)
  const issued = createOAuthState('slack', requestUrl.searchParams.get('returnTo'))
  const authorize = new URL('https://slack.com/oauth/v2/authorize')
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('scope', 'chat:write,channels:history,groups:history,incoming-webhook')
  authorize.searchParams.set('redirect_uri', publicUrl(request.url, '/api/connect/slack/callback'))
  authorize.searchParams.set('state', issued.state)
  return beginOAuth(authorize, issued)
}

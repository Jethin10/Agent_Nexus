import { cookies } from 'next/headers'
import { saveConnection } from '@ascendant/workflows'
import { db } from '@ascendant/db'
import { currentOrgId } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'
import { failOAuth, finishOAuth } from '@/lib/connect-response'
import { oauthStateCookieName, verifyOAuthState } from '@/lib/oauth-state'
import { publicUrl } from '@/lib/public-url'

interface SlackOAuthResponse {
  ok?: boolean
  error?: string
  access_token?: string
  team?: { id?: string; name?: string }
  authed_user?: { id?: string }
  incoming_webhook?: { channel_id?: string }
}

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  try {
    const cookie = (await cookies()).get(oauthStateCookieName('slack'))?.value
    const { returnTo } = verifyOAuthState(requestUrl.searchParams.get('state'), cookie, 'slack')
    if (requestUrl.searchParams.get('error')) throw new Error('Slack authorization was declined')
    const code = requestUrl.searchParams.get('code')
    if (!code) throw new Error('Slack did not return an authorization code')

    const redirectUri = publicUrl(request.url, '/api/connect/slack/callback')
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: requireEnv('SLACK_CLIENT_ID'),
        client_secret: requireEnv('SLACK_CLIENT_SECRET'),
        code,
        redirect_uri: redirectUri,
      }),
      cache: 'no-store',
    })
    const body = await response.json() as SlackOAuthResponse
    const channelId = body.incoming_webhook?.channel_id
    if (!response.ok || !body.ok || !body.access_token || !body.team?.id || !channelId) {
      throw new Error(`Slack could not complete authorization${body.error ? `: ${body.error}` : ''}`)
    }
    await ensureDb()
    await saveConnection(db(), currentOrgId(), {
      provider: 'slack',
      botToken: body.access_token,
      channelId,
      teamId: body.team.id,
      ...(body.team.name ? { teamName: body.team.name } : {}),
      ...(body.authed_user?.id ? { reviewerIds: [body.authed_user.id] } : {}),
    })
    return finishOAuth(request.url, returnTo, 'slack')
  } catch (error) {
    return failOAuth(request.url, 'slack', error)
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

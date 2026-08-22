import { createOAuthState } from '@/lib/oauth-state'
import { beginOAuth } from '@/lib/connect-response'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const slug = process.env.GITHUB_APP_SLUG
  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) {
    return new Response('GitHub App installation is not configured.', { status: 503 })
  }
  const requestUrl = new URL(request.url)
  const issued = createOAuthState('github', requestUrl.searchParams.get('returnTo'))
  const authorize = new URL(`https://github.com/apps/${slug}/installations/new`)
  authorize.searchParams.set('state', issued.state)
  return beginOAuth(authorize, issued)
}

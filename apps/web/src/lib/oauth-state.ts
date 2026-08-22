import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60

export type ConnectProvider = 'github' | 'slack' | 'google'

interface StatePayload {
  provider: ConnectProvider
  nonce: string
  returnTo: string
  issuedAt: number
}

export interface OAuthState {
  state: string
  cookieName: string
  cookieValue: string
  cookie: {
    httpOnly: true
    secure: boolean
    sameSite: 'lax'
    path: '/'
    maxAge: number
  }
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthStateError'
  }
}

export function isConnectProvider(value: string): value is ConnectProvider {
  return value === 'github' || value === 'slack' || value === 'google'
}

/** Provider-specific names let independent OAuth flows coexist in separate tabs. */
export function oauthStateCookieName(provider: ConnectProvider): string {
  return `ascendant_oauth_state_${provider}`
}

/** Only same-origin paths are accepted; protocol-relative redirects are rejected. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/integrations'
  }
  try {
    const parsed = new URL(value, 'https://ascendant.invalid')
    return parsed.origin === 'https://ascendant.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : '/integrations'
  } catch {
    return '/integrations'
  }
}

export function createOAuthState(
  provider: ConnectProvider,
  returnTo?: string | null,
  options: { secret?: string; now?: Date; secure?: boolean; nonce?: string } = {},
): OAuthState {
  const secret = stateSecret(options.secret)
  const nonce = options.nonce ?? randomBytes(24).toString('base64url')
  const payload: StatePayload = {
    provider,
    nonce,
    returnTo: safeReturnTo(returnTo),
    issuedAt: Math.floor((options.now ?? new Date()).getTime() / 1000),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign(encoded, secret)
  return {
    state: `${encoded}.${signature}`,
    cookieName: oauthStateCookieName(provider),
    cookieValue: sign(`${provider}.${nonce}`, secret),
    cookie: {
      httpOnly: true,
      secure: options.secure ?? process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    },
  }
}

export function verifyOAuthState(
  state: string | null | undefined,
  cookieValue: string | null | undefined,
  expectedProvider: ConnectProvider,
  options: { secret?: string; now?: Date } = {},
): { returnTo: string } {
  if (!state || !cookieValue) throw new OAuthStateError('OAuth state cookie is missing')
  const [encoded, providedSignature, extra] = state.split('.')
  if (!encoded || !providedSignature || extra) throw new OAuthStateError('OAuth state is malformed')

  const secret = stateSecret(options.secret)
  if (!constantTimeEqual(providedSignature, sign(encoded, secret))) {
    throw new OAuthStateError('OAuth state signature is invalid')
  }

  let payload: StatePayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload
  } catch {
    throw new OAuthStateError('OAuth state payload is invalid')
  }
  if (!isConnectProvider(payload.provider) || payload.provider !== expectedProvider) {
    throw new OAuthStateError('OAuth provider does not match state')
  }
  if (!payload.nonce || !Number.isSafeInteger(payload.issuedAt)) {
    throw new OAuthStateError('OAuth state payload is incomplete')
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000)
  if (payload.issuedAt > now + 30 || now - payload.issuedAt > OAUTH_STATE_MAX_AGE_SECONDS) {
    throw new OAuthStateError('OAuth state has expired')
  }
  if (!constantTimeEqual(cookieValue, sign(`${payload.provider}.${payload.nonce}`, secret))) {
    throw new OAuthStateError('OAuth state does not match this browser')
  }
  return { returnTo: safeReturnTo(payload.returnTo) }
}

function stateSecret(explicit?: string): string {
  const secret = explicit ?? process.env.OAUTH_STATE_SECRET
  if (!secret || secret.length < 32) {
    throw new OAuthStateError('OAUTH_STATE_SECRET must contain at least 32 characters')
  }
  return secret
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

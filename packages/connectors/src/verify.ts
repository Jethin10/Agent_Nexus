import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison of two hex digests. `===` on a signature leaks the
 * length of the shared prefix through timing; timingSafeEqual does not (§15.2).
 * Length mismatch is rejected before the compare, since timingSafeEqual throws
 * rather than returning false when buffers differ in size.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/** HMAC of the raw body, hex-encoded. Never hash a re-serialized object. */
export function hmacHex(algo: 'sha256' | 'sha1', secret: string, body: string): string {
  return createHmac(algo, secret).update(body, 'utf8').digest('hex')
}

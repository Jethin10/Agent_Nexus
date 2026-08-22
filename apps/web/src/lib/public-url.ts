/** Canonical browser-facing origin used when the API is hosted behind a proxy. */
export function publicOrigin(
  requestUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env.ASCENDANT_PUBLIC_URL
  if (!configured) return new URL(requestUrl).origin

  const url = new URL(configured)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('ASCENDANT_PUBLIC_URL must use HTTPS outside local development')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('ASCENDANT_PUBLIC_URL must be an origin without credentials, query, or hash')
  }
  return url.origin
}

export function publicUrl(
  requestUrl: string,
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return new URL(path, publicOrigin(requestUrl, env)).toString()
}

import { isBlockedPath } from '@ascendant/core'
import { EGRESS_ALLOWLIST, SandboxError, type FileMap, type Handle } from './types.js'

/**
 * Driver-side enforcement, shared by all three drivers. These are the checks that
 * make §12.4's rules real rather than aspirational: a driver that forgot one would be
 * a hole in the security argument, so they live here and every driver calls them.
 */

/** Path traversal and absolute paths: a sandbox write must stay inside the workspace. */
export function assertSafeWritePath(path: string): void {
  const p = path.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    throw new SandboxError(`refusing an absolute write path: ${path}`, 'blocked_path')
  }
  if (p.split('/').includes('..')) {
    throw new SandboxError(`refusing a traversing write path: ${path}`, 'blocked_path')
  }
  if (isBlockedPath(p)) {
    throw new SandboxError(
      `refusing to write ${path}: CI config, lockfiles, .env and secrets paths are blocked deterministically`,
      'blocked_path',
    )
  }
}

/**
 * 512 MB written-file cap. Enforced before the write rather than after, because the
 * point is to stop a runaway generator from filling the disk, and a check that runs
 * afterwards has already lost.
 */
export function assertWithinWriteCap(files: FileMap, cap: number): number {
  let bytes = 0
  for (const content of Object.values(files)) bytes += Buffer.byteLength(content, 'utf8')
  if (bytes > cap) {
    throw new SandboxError(
      `refusing a ${bytes}-byte write against a ${cap}-byte cap`,
      'write_cap',
    )
  }
  return bytes
}

export function assertAlive(h: Handle, now = Date.now()): void {
  if (now > h.deadlineAt) {
    throw new SandboxError(
      `sandbox ${h.id} passed its ${new Date(h.deadlineAt).toISOString()} deadline`,
      'timeout',
    )
  }
}

/**
 * Hosts a command may reach. This is a second line rather than the primary one — the
 * real enforcement is the provider's network policy — but it catches the common case
 * of a generated test script curling somewhere, and it makes the intent auditable in
 * code rather than only in a provider console.
 */
const HOST_IN_CMD = /(?:https?:\/\/|@)([a-z0-9.-]+\.[a-z]{2,})/gi

export function assertEgressAllowed(cmd: readonly string[]): void {
  const joined = cmd.join(' ')
  for (const m of joined.matchAll(HOST_IN_CMD)) {
    const host = m[1]?.toLowerCase()
    if (!host) continue
    const allowed = EGRESS_ALLOWLIST.some((a) => host === a || host.endsWith(`.${a}`))
    if (!allowed) {
      throw new SandboxError(
        `refusing to reach ${host}: the sandbox egress allowlist is the package registry only`,
        'egress_denied',
      )
    }
  }
}

/**
 * The sandbox gets source code, never a token. Any env var that looks like a
 * credential is stripped before it can reach the microVM — enforced here so a caller
 * cannot leak one by carelessly forwarding `process.env`.
 */
const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|DSN|PRIVATE)/i

export function stripSecrets(env: Record<string, string> = {}): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV.test(k)) continue
    safe[k] = v
  }
  return safe
}

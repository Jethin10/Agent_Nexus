import type { FileMap } from '@ascendant/sandbox'
import { db as defaultDb, type Db } from '@ascendant/db'
import { connectionForOrg } from './connections.js'
import { githubAppInstallationToken, githubInstallationToken } from './github-auth.js'

/**
 * Repository access for the work pipeline. Lives in the workflow layer because R1
 * forbids an agent from doing I/O: the Research agent reasons about a file *listing*
 * and the Coder reasons about file *contents*, both handed in as data.
 *
 * Reads go through the GitHub Contents API rather than a clone. On Vercel Hobby a
 * function is capped at 60s and has no persistent disk, so cloning a repo to read
 * four files is the wrong shape — and the sandbox, which does get a checkout, is
 * deliberately unable to reach the GitHub API (§12.4).
 */
export interface RepoRef {
  owner: string
  repo: string
  ref?: string
}

export interface RepoClientOptions extends RepoRef {
  /** Installation token, minted per-run, 1-hour expiry — never a long-lived PAT. */
  token: string
  fetcher?: typeof fetch
}

const API = 'https://api.github.com'

/** Files worth reading. A generated fix does not need the lockfile or the images. */
const READABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sql|css|html|py|go|rs|java|rb)$/

const SKIP_DIR =
  /(?:^|\/)(?:node_modules|dist|build|\.next|\.turbo|coverage|\.git|vendor|__pycache__)(?:\/|$)/

export class RepoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

export interface RepoClient {
  /** Paths in the repo, filtered to source files. Feeds the Research agent. */
  listFiles(): Promise<string[]>
  /** Contents of specific files. Feeds the Planner and Coder. */
  readFiles(paths: readonly string[]): Promise<FileMap>
  /** Head SHA of the branch the diff will be based on. */
  headSha(): Promise<string>
}

export function repoClient(opts: RepoClientOptions): RepoClient {
  const fetcher = opts.fetcher ?? fetch
  const ref = opts.ref ?? 'main'
  const base = `${API}/repos/${opts.owner}/${opts.repo}`

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${opts.token}`,
    'x-github-api-version': '2022-11-28',
  }

  const get = async (url: string): Promise<Response> => {
    const res = await fetcher(url, { headers })
    /**
     * §14.3: a 403 secondary rate limit is honoured rather than hammered. The
     * workflow sleeps via `step.sleep`, so this surfaces the wait rather than
     * busy-waiting and burning a concurrency slot.
     */
    if (res.status === 403 || res.status === 429) {
      const retry = res.headers.get('retry-after')
      throw new RepoError(
        `github rate limited${retry ? `, retry after ${retry}s` : ''}`,
        res.status,
      )
    }
    if (!res.ok) {
      throw new RepoError(`github ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
    }
    return res
  }

  return {
    async headSha(): Promise<string> {
      const res = await get(`${base}/commits/${encodeURIComponent(ref)}`)
      const body = (await res.json()) as { sha?: string }
      if (!body.sha) throw new RepoError(`no sha for ref ${ref}`)
      return body.sha
    },

    /**
     * One recursive tree call rather than walking directories. The API caps a tree
     * response and sets `truncated`, which is reported rather than silently returning
     * a partial listing — a Research agent given half a repo would confidently name
     * files that are not the right ones.
     */
    async listFiles(): Promise<string[]> {
      const res = await get(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
      const body = (await res.json()) as {
        tree?: { path?: string; type?: string }[]
        truncated?: boolean
      }
      const paths = (body.tree ?? [])
        .filter((t) => t.type === 'blob' && t.path)
        .map((t) => t.path as string)
        .filter((p) => READABLE.test(p) && !SKIP_DIR.test(p))

      if (body.truncated) paths.push('(listing truncated by the GitHub API)')
      return paths
    },

    async readFiles(paths: readonly string[]): Promise<FileMap> {
      const out: FileMap = {}
      // Serial rather than parallel: GitHub's secondary rate limit triggers on
      // concurrent requests to the same repo, and a Planner reads a handful of files.
      for (const path of paths.slice(0, 20)) {
        try {
          const res = await get(
            `${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
          )
          const body = (await res.json()) as { content?: string; encoding?: string; size?: number }
          if (!body.content) continue
          if ((body.size ?? 0) > 200_000) continue
          out[path] =
            body.encoding === 'base64'
              ? Buffer.from(body.content, 'base64').toString('utf8')
              : body.content
        } catch (err) {
          // A missing file is information, not a failure: the Planner asked for a path
          // that does not exist, and the Coder should see that rather than crash.
          if (err instanceof RepoError && err.status === 404) continue
          throw err
        }
      }
      return out
    },
  }
}

export async function repoFromEnv(): Promise<
  (RepoClientOptions & { configured: boolean; auth: 'app' | 'token' }) | undefined
> {
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  if (!owner || !repo) return undefined

  const appId = process.env.GITHUB_APP_ID
  const appKey = process.env.GITHUB_APP_PRIVATE_KEY_BASE64
  if (Boolean(appId) !== Boolean(appKey)) {
    throw new RepoError(
      'GitHub App authentication is incomplete: set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_BASE64',
    )
  }

  let token: string
  let auth: 'app' | 'token'
  if (appId && appKey) {
    token = await githubAppInstallationToken({
      appId,
      privateKeyBase64: appKey,
      owner,
      repo,
    })
    auth = 'app'
  } else if (
    process.env.GITHUB_TOKEN &&
    process.env.ASCENDANT_ALLOW_GITHUB_TOKEN === '1'
  ) {
    // A fine-grained token remains useful for explicit local setup. It is never an
    // implicit fallback: deployed environments must use short-lived App credentials.
    token = process.env.GITHUB_TOKEN
    auth = 'token'
  } else if (process.env.GITHUB_TOKEN) {
    throw new RepoError(
      'GITHUB_TOKEN is disabled unless ASCENDANT_ALLOW_GITHUB_TOKEN=1; production must use GitHub App credentials',
    )
  } else {
    return undefined
  }

  return {
    token,
    owner,
    repo,
    ...(process.env.GITHUB_DEFAULT_BRANCH ? { ref: process.env.GITHUB_DEFAULT_BRANCH } : {}),
    configured: true,
    auth,
  }
}

/** Resolve the repository selected by this organization, with env fallback for local installs. */
export async function repoForOrg(
  orgId: string,
  database: Db = defaultDb(),
): Promise<(RepoClientOptions & { configured: boolean; auth: 'app' | 'token' }) | undefined> {
  const connection = await connectionForOrg(database, orgId, 'github')
  if (!connection) return repoFromEnv()
  // An installation with multiple repositories is connected but deliberately inert
  // until the operator chooses the active repository in the Connections view.
  if (!connection.owner || !connection.repo) return undefined

  const appId = process.env.GITHUB_APP_ID
  const appKey = process.env.GITHUB_APP_PRIVATE_KEY_BASE64
  if (!appId || !appKey) {
    throw new RepoError(
      'GitHub is connected, but server GitHub App credentials are incomplete: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_BASE64',
    )
  }
  const token = await githubInstallationToken({
    appId,
    privateKeyBase64: appKey,
    installationId: connection.installationId,
    repositories: [connection.repo],
  })
  return {
    token,
    owner: connection.owner,
    repo: connection.repo,
    ...(connection.defaultBranch ? { ref: connection.defaultBranch } : {}),
    configured: true,
    auth: 'app',
  }
}

/**
 * Applies a unified diff to an in-memory file map. Used to build the sandbox's
 * "after" tree without a git checkout.
 *
 * Deliberately strict: a hunk whose context does not match is a failure rather than a
 * best-effort patch. §14.3 says a diff that does not apply is a rebase-and-retry then
 * an ESCALATE, and a fuzzy apply would turn that into a silently wrong file.
 */
export function applyDiff(files: FileMap, diff: string): { files: FileMap; failed: string[] } {
  const out: FileMap = { ...files }
  const failed: string[] = []

  for (const chunk of splitByFile(diff)) {
    const { path, hunks, isDelete, isNew } = chunk
    if (!path) continue

    if (isDelete) {
      delete out[path]
      continue
    }

    const original = isNew ? '' : (out[path] ?? '')
    const applied = applyHunks(original, hunks)
    if (applied === undefined) {
      failed.push(path)
      continue
    }
    out[path] = applied
  }

  return { files: out, failed }
}

interface FileChunk {
  path: string | undefined
  hunks: string[][]
  isNew: boolean
  isDelete: boolean
}

function splitByFile(diff: string): FileChunk[] {
  const chunks: FileChunk[] = []
  let current: FileChunk | undefined
  let hunk: string[] | undefined

  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (hunk && current) current.hunks.push(hunk)
      if (current) chunks.push(current)
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      current = { path: m?.[2] ?? m?.[1], hunks: [], isNew: false, isDelete: false }
      hunk = undefined
      continue
    }
    if (!current) continue

    if (line.startsWith('new file mode')) current.isNew = true
    else if (line.startsWith('deleted file mode')) current.isDelete = true
    else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      if (line.endsWith('/dev/null')) {
        if (line.startsWith('+++ ')) current.isDelete = true
        else current.isNew = true
      }
    } else if (line.startsWith('@@')) {
      if (hunk) current.hunks.push(hunk)
      hunk = []
    } else if (hunk) {
      hunk.push(line)
    }
  }
  if (hunk && current) current.hunks.push(hunk)
  if (current) chunks.push(current)
  return chunks
}

/**
 * Applies hunks by matching their context lines. Line numbers in the @@ header are
 * ignored: a model's arithmetic there is unreliable, while the context lines it emits
 * are usually verbatim. Matching on content is the more robust of the two.
 */
function applyHunks(original: string, hunks: string[][]): string | undefined {
  // `''.split('\n')` is `['']`, not `[]` — so a new file would gain a leading blank
  // line, and every subsequent hunk's context would be offset by one.
  let lines = original === '' ? [] : original.split('\n')

  for (const hunk of hunks) {
    const before: string[] = []
    const after: string[] = []
    for (const l of hunk) {
      if (l.startsWith('+')) after.push(l.slice(1))
      else if (l.startsWith('-')) before.push(l.slice(1))
      else if (l.startsWith('\\')) continue
      else {
        const context = l.startsWith(' ') ? l.slice(1) : l
        before.push(context)
        after.push(context)
      }
    }

    if (before.length === 0) {
      lines = [...lines, ...after]
      continue
    }

    const at = findRun(lines, before)
    if (at === -1) return undefined
    lines = [...lines.slice(0, at), ...after, ...lines.slice(at + before.length)]
  }

  return lines.join('\n')
}

function findRun(haystack: readonly string[], needle: readonly string[]): number {
  const trim = (s: string) => s.replace(/\s+$/, '')
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (trim(haystack[i + j] ?? '') !== trim(needle[j] ?? '')) continue outer
    }
    return i
  }
  return -1
}

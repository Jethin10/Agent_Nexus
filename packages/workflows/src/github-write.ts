import { isBlockedPath } from '@ascendant/core'
import { RepoError, type RepoClientOptions } from './repo.js'

/**
 * The write side of GitHub: branch, commit, pull request, comment.
 *
 * This lives in the workflow layer and **never** inside the sandbox. That is §12.4's
 * third rule and the important one: the sandbox produces a diff, and it never has the
 * credentials to publish one. An agent prompt-injected inside the sandbox can at worst
 * write a bad diff, which then has to survive the Reviewer, QA, and a human review.
 *
 * The token is an installation token minted per-run, expiring in 1 hour — no
 * long-lived PAT anywhere in this codebase (§15.4).
 */
const API = 'https://api.github.com'

export interface CommitFile {
  path: string
  /** Undefined means delete. */
  content?: string | undefined
}

export interface OpenPrInput {
  branch: string
  baseSha: string
  base: string
  commitMessage: string
  files: readonly CommitFile[]
  title: string
  body: string
  draft: boolean
  labels?: readonly string[]
}

export interface OpenPrResult {
  number: number
  url: string
  isDraft: boolean
  branch: string
  commitSha: string
}

export interface GithubWriter {
  openPr(input: OpenPrInput): Promise<OpenPrResult>
  comment(issueRef: string, body: string): Promise<void>
  closeIssue(issueRef: string, reason?: 'completed' | 'not_planned'): Promise<void>
  label(issueRef: string, labels: readonly string[]): Promise<void>
}

/** `acme/api#412` or a bare `412` → the issue number. */
function issueNumber(ref: string): number {
  const m = /#(\d+)$/.exec(ref) ?? /^(\d+)$/.exec(ref)
  const n = Number(m?.[1])
  if (!Number.isFinite(n)) throw new RepoError(`cannot read an issue number from "${ref}"`)
  return n
}

export function githubWriter(opts: RepoClientOptions): GithubWriter {
  const fetcher = opts.fetcher ?? fetch
  const base = `${API}/repos/${opts.owner}/${opts.repo}`

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${opts.token}`,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  }

  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await fetcher(`${base}${path}`, { ...init, headers })
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
    return res.status === 204 ? null : res.json()
  }

  return {
    /**
     * Branch → blobs → tree → commit → ref → PR. Five calls rather than the Contents
     * API's one-per-file, because a multi-file change has to land as ONE commit: a
     * per-file sequence leaves the branch in a broken intermediate state that CI would
     * pick up and report against.
     */
    async openPr(input: OpenPrInput): Promise<OpenPrResult> {
      // Never main (§8.1). Enforced here as well as in branchName(), because this is
      // the function holding the credentials.
      if (!input.branch.startsWith('ascendant/')) {
        throw new RepoError(`refusing to push to "${input.branch}": branches must be ascendant/*`)
      }
      const blocked = input.files.map((f) => f.path).filter(isBlockedPath)
      if (blocked.length > 0) {
        // Layer 3 again, at the last possible moment. The diff scanner already refused
        // this, so reaching here means something upstream was bypassed.
        throw new RepoError(`refusing to commit protected paths: ${blocked.join(', ')}`)
      }

      const blobs = await Promise.all(
        input.files
          .filter((f) => f.content !== undefined)
          .map(async (f) => {
            const blob = (await call('/git/blobs', {
              method: 'POST',
              body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
            })) as { sha: string }
            return { path: f.path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha }
          }),
      )

      const deletions = input.files
        .filter((f) => f.content === undefined)
        .map((f) => ({ path: f.path, mode: '100644' as const, type: 'blob' as const, sha: null }))

      const tree = (await call('/git/trees', {
        method: 'POST',
        body: JSON.stringify({ base_tree: input.baseSha, tree: [...blobs, ...deletions] }),
      })) as { sha: string }

      const commit = (await call('/git/commits', {
        method: 'POST',
        body: JSON.stringify({
          message: input.commitMessage,
          tree: tree.sha,
          parents: [input.baseSha],
        }),
      })) as { sha: string }

      // Create the ref, or move it if a retry already created it. Inngest retries a
      // step, so this must be idempotent rather than failing on the second attempt.
      try {
        await call('/git/refs', {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: commit.sha }),
        })
      } catch (err) {
        if (!(err instanceof RepoError) || err.status !== 422) throw err
        await call(`/git/refs/heads/${encodeURIComponent(input.branch)}`, {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha, force: true }),
        })
      }

      let pr: { number: number; html_url: string; draft?: boolean }
      try {
        pr = (await call('/pulls', {
          method: 'POST',
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            head: input.branch,
            base: input.base,
            /** Draft below the autonomy threshold. Never auto-merged, at any confidence. */
            draft: input.draft,
          }),
        })) as typeof pr
      } catch (err) {
        if (!(err instanceof RepoError) || err.status !== 422) throw err
        // The previous attempt may have created the PR and died before Inngest stored
        // the step result. Recover that PR rather than failing or opening another one.
        const existing = (await call(
          `/pulls?state=open&head=${encodeURIComponent(`${opts.owner}:${input.branch}`)}&base=${encodeURIComponent(input.base)}`,
        )) as (typeof pr)[]
        const first = existing[0]
        if (!first) throw err
        pr = first
      }

      if (input.labels?.length) {
        await call(`/issues/${pr.number}/labels`, {
          method: 'POST',
          body: JSON.stringify({ labels: input.labels }),
        }).catch(() => {
          // A missing label is cosmetic; it must not fail a shipped PR.
        })
      }

      return {
        number: pr.number,
        url: pr.html_url,
        isDraft: pr.draft ?? input.draft,
        branch: input.branch,
        commitSha: commit.sha,
      }
    },

    async comment(issueRef: string, body: string): Promise<void> {
      const number = issueNumber(issueRef)
      const existing = (await call(`/issues/${number}/comments?per_page=100`)) as { body?: string }[]
      if (existing.some((comment) => comment.body === body)) return
      await call(`/issues/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
    },

    async closeIssue(issueRef: string, reason = 'not_planned'): Promise<void> {
      await call(`/issues/${issueNumber(issueRef)}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed', state_reason: reason }),
      })
    },

    async label(issueRef: string, labels: readonly string[]): Promise<void> {
      if (labels.length === 0) return
      await call(`/issues/${issueNumber(issueRef)}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels }),
      })
    },
  }
}

import { describe, expect, it, vi } from 'vitest'
import { applyDiff, repoClient, RepoError } from './repo.js'

/**
 * `applyDiff` builds the sandbox's "after" tree without a git checkout. If it
 * silently mis-patches, QA runs tests against a file nobody wrote — so a hunk that
 * does not match must fail loudly rather than fuzzily apply.
 */
describe('applyDiff', () => {
  const original = { 'src/a.ts': 'const a = 1\nconst b = 2\nconst c = 3' }

  it('applies a single-line change by matching context', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 22',
      ' const c = 3',
    ].join('\n')

    const res = applyDiff(original, diff)
    expect(res.failed).toEqual([])
    expect(res.files['src/a.ts']).toBe('const a = 1\nconst b = 22\nconst c = 3')
  })

  it('ignores wrong line numbers in the @@ header and matches on content', () => {
    // A model's arithmetic in the hunk header is unreliable; its context lines are
    // usually verbatim. Matching on content is the more robust of the two.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -99,3 +99,3 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 22',
      ' const c = 3',
    ].join('\n')

    expect(applyDiff(original, diff).files['src/a.ts']).toContain('const b = 22')
  })

  it('creates a new file', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1',
      '+export const y = 2',
    ].join('\n')

    const res = applyDiff(original, diff)
    expect(res.failed).toEqual([])
    expect(res.files['src/new.ts']).toBe('export const x = 1\nexport const y = 2')
    expect(res.files['src/a.ts']).toBe(original['src/a.ts'])
  })

  it('deletes a file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'deleted file mode 100644',
      '--- a/src/a.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-const a = 1',
      '-const b = 2',
      '-const c = 3',
    ].join('\n')

    expect(applyDiff(original, diff).files['src/a.ts']).toBeUndefined()
  })

  it('applies several hunks in one file', () => {
    const src = { 'src/a.ts': 'one\ntwo\nthree\nfour\nfive' }
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      '@@ -4,2 +4,2 @@',
      ' four',
      '-five',
      '+FIVE',
    ].join('\n')

    const res = applyDiff(src, diff)
    expect(res.failed).toEqual([])
    expect(res.files['src/a.ts']).toBe('ONE\ntwo\nthree\nfour\nFIVE')
  })

  it('applies across several files in one diff', () => {
    const src = { 'a.ts': 'a', 'b.ts': 'b' }
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-b',
      '+B',
    ].join('\n')

    const res = applyDiff(src, diff)
    expect(res.files).toEqual({ 'a.ts': 'A', 'b.ts': 'B' })
  })

  it('reports failure rather than fuzzily patching when context does not match', () => {
    // §14.3: a diff that does not apply is a rebase-and-retry, then an ESCALATE.
    // A best-effort apply would turn that into a silently wrong file.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 999',
      '-const nonexistent = 0',
      '+const nonexistent = 1',
    ].join('\n')

    const res = applyDiff(original, diff)
    expect(res.failed).toEqual(['src/a.ts'])
    // The original is left untouched, so a partial apply cannot reach the sandbox.
    expect(res.files['src/a.ts']).toBe(original['src/a.ts'])
  })

  it('tolerates trailing-whitespace drift in context lines', () => {
    const src = { 'a.ts': 'keep  \nchange' }
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-change',
      '+changed',
    ].join('\n')

    expect(applyDiff(src, diff).failed).toEqual([])
  })

  it('ignores a "\\ No newline at end of file" marker', () => {
    const src = { 'a.ts': 'x' }
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '\\ No newline at end of file',
      '+y',
      '\\ No newline at end of file',
    ].join('\n')

    expect(applyDiff(src, diff).files['a.ts']).toBe('y')
  })

  it('leaves everything alone for an empty diff', () => {
    expect(applyDiff(original, '')).toEqual({ files: original, failed: [] })
  })
})

describe('repoClient', () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  function client(responses: Response[]) {
    let i = 0
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return responses[Math.min(i++, responses.length - 1)] ?? ok({})
    })
    return {
      calls,
      repo: repoClient({
        token: 't',
        owner: 'acme',
        repo: 'api',
        fetcher: fetcher as unknown as typeof fetch,
      }),
    }
  }

  it('filters the tree to source files and skips build output', async () => {
    const { repo } = client([
      ok({
        tree: [
          { type: 'blob', path: 'src/a.ts' },
          { type: 'blob', path: 'node_modules/x/index.js' },
          { type: 'blob', path: 'dist/a.js' },
          { type: 'blob', path: 'logo.png' },
          { type: 'tree', path: 'src' },
        ],
      }),
    ])
    expect(await repo.listFiles()).toEqual(['src/a.ts'])
  })

  it('reports a truncated listing rather than returning a partial one silently', async () => {
    const { repo } = client([ok({ tree: [{ type: 'blob', path: 'src/a.ts' }], truncated: true })])
    expect(await repo.listFiles()).toContain('(listing truncated by the GitHub API)')
  })

  it('decodes base64 file contents', async () => {
    const { repo } = client([
      ok({ content: Buffer.from('hello', 'utf8').toString('base64'), encoding: 'base64', size: 5 }),
    ])
    expect(await repo.readFiles(['src/a.ts'])).toEqual({ 'src/a.ts': 'hello' })
  })

  it('treats a missing file as information, not a failure', async () => {
    const { repo } = client([new Response('not found', { status: 404 })])
    await expect(repo.readFiles(['src/gone.ts'])).resolves.toEqual({})
  })

  it('surfaces a secondary rate limit so the workflow can sleep on it', async () => {
    const { repo } = client([new Response('slow down', { status: 403, headers: { 'retry-after': '60' } })])
    await expect(repo.headSha()).rejects.toThrow(RepoError)
    await expect(repo.headSha()).rejects.toThrow(/retry after 60s/)
  })

  it('skips a file too large to be worth reading', async () => {
    const { repo } = client([ok({ content: 'x', encoding: 'base64', size: 500_000 })])
    expect(await repo.readFiles(['src/huge.ts'])).toEqual({})
  })
})

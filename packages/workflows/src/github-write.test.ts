import { describe, expect, it, vi } from 'vitest'
import { githubWriter } from './github-write.js'

function response(body: unknown, status = body === null ? 204 : 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('githubWriter', () => {
  it('publishes all changed files as one commit and opens a reviewable PR', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    const replies = [
      { sha: 'blob-a' },
      { sha: 'blob-b' },
      { sha: 'tree-1' },
      { sha: 'commit-1' },
      null,
      { number: 7, html_url: 'https://github.test/pr/7', draft: true },
      [],
    ]
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
      return response(replies.shift())
    }) as unknown as typeof fetch

    const result = await githubWriter({ owner: 'acme', repo: 'api', token: 'secret', fetcher }).openPr({
      branch: 'ascendant/fix-session',
      baseSha: 'base-1',
      base: 'main',
      commitMessage: 'fix session\n\nAscendant-Decision: dec_1',
      files: [
        { path: 'src/session.ts', content: 'fixed' },
        { path: 'src/session.test.ts', content: 'tested' },
      ],
      title: 'Fix session',
      body: 'Why and evidence',
      draft: true,
      labels: ['ascendant'],
    })

    expect(result).toMatchObject({ number: 7, commitSha: 'commit-1', isDraft: true })
    expect(calls.filter((call) => call.url.endsWith('/git/commits'))).toHaveLength(1)
    expect(calls.find((call) => call.url.endsWith('/pulls'))?.body).toMatchObject({
      head: 'ascendant/fix-session', base: 'main', draft: true,
    })
  })

  it('refuses protected paths at the credential-holding boundary', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(githubWriter({ owner: 'acme', repo: 'api', token: 'secret', fetcher }).openPr({
      branch: 'ascendant/bad', baseSha: 'base', base: 'main', commitMessage: 'x',
      files: [{ path: '.github/workflows/ci.yml', content: 'pwned' }],
      title: 'x', body: 'x', draft: true,
    })).rejects.toThrow('protected paths')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

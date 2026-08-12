import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { normalize, unitKey } from '@ascendant/core'
import { githubConnector, isGithubRepositoryRef } from './index.js'

const SECRET = 'shh-not-a-real-secret'
const gh = githubConnector({ secret: SECRET })
const ctx = { orgId: 'org_demo' }

function signed(body: string, secret = SECRET) {
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  return {
    headers: new Headers({ 'x-hub-signature-256': `sha256=${sig}` }),
    body,
  }
}

const repo = { full_name: 'acme/api', default_branch: 'main' }
const human = { id: 7, login: 'octocat', type: 'User' }

const issuePayload = {
  action: 'opened',
  repository: repo,
  issue: {
    number: 412,
    title: 'Crash on expired token',
    body: 'Throws in src/auth/session.ts',
    user: human,
    created_at: '2026-07-01T09:00:00Z',
  },
}

describe('repository authorization', () => {
  const expected = { owner: 'acme', repo: 'api' }

  it.each([
    'acme/api#412',
    'ACME/API!88',
    'acme/api#412:comment:9001',
  ])('accepts configured repository ref %s', (ref) => {
    expect(isGithubRepositoryRef(ref, expected)).toBe(true)
  })

  it.each([
    'other/api#412',
    'acme/other!88',
    '#412',
    'acme/api',
  ])('rejects non-configured repository ref %s', (ref) => {
    expect(isGithubRepositoryRef(ref, expected)).toBe(false)
  })
})

describe('verify', () => {
  it('accepts a correctly signed body', async () => {
    const body = JSON.stringify(issuePayload)
    expect(await gh.verify(signed(body))).toBe(true)
  })

  it('rejects a body signed with the wrong secret', async () => {
    const body = JSON.stringify(issuePayload)
    expect(await gh.verify(signed(body, 'wrong'))).toBe(false)
  })

  it('rejects when the body is altered after signing — the raw bytes matter', async () => {
    const req = signed(JSON.stringify(issuePayload))
    req.body = req.body.replace('412', '413')
    expect(await gh.verify(req)).toBe(false)
  })

  it('rejects a re-serialized body, which is why the route must use req.text()', async () => {
    const original = JSON.stringify(issuePayload)
    const req = signed(original)
    // A route that did req.json() then JSON.stringify() would produce this:
    req.body = JSON.stringify({ ...issuePayload, action: 'opened' }, null, 2)
    expect(await gh.verify(req)).toBe(false)
  })

  it('rejects a missing or malformed signature header', async () => {
    const body = JSON.stringify(issuePayload)
    expect(await gh.verify({ headers: new Headers(), body })).toBe(false)
    expect(
      await gh.verify({ headers: new Headers({ 'x-hub-signature-256': 'sha1=abc' }), body }),
    ).toBe(false)
    expect(
      await gh.verify({ headers: new Headers({ 'x-hub-signature-256': 'garbage' }), body }),
    ).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', async () => {
    const body = JSON.stringify(issuePayload)
    expect(
      await gh.verify({ headers: new Headers({ 'x-hub-signature-256': 'sha256=ab' }), body }),
    ).toBe(false)
  })

  it('throws 500 rather than accepting anything when no secret is configured', async () => {
    const bad = githubConnector({ secret: '' })
    await expect(bad.verify(signed('{}'))).rejects.toThrow(/not configured/)
  })
})

describe('parse: issues', () => {
  it('maps an opened issue', async () => {
    const [e] = await gh.parse(issuePayload, ctx)
    expect(e).toBeDefined()
    expect(e?.source).toBe('github')
    expect(e?.kind).toBe('issue')
    expect(e?.orgId).toBe('org_demo')
    expect(e?.sourceRef).toBe('acme/api#412')
    expect(e?.threadKey).toBe('acme/api#412')
    expect(e?.actor).toEqual({ id: '7', handle: 'octocat', isBot: false })
    expect(e?.title).toBe('Crash on expired token')
    expect(e?.createdAt.toISOString()).toBe('2026-07-01T09:00:00.000Z')
  })

  it('accepts reopened and edited, ignores labeled/assigned/closed', async () => {
    for (const action of ['reopened', 'edited']) {
      expect(await gh.parse({ ...issuePayload, action }, ctx)).toHaveLength(1)
    }
    for (const action of ['labeled', 'assigned', 'closed', 'milestoned']) {
      expect(await gh.parse({ ...issuePayload, action }, ctx)).toHaveLength(0)
    }
  })

  it('flags bots — both by type and by the [bot] login suffix', async () => {
    const byType = await gh.parse(
      { ...issuePayload, issue: { ...issuePayload.issue, user: { id: 1, login: 'x', type: 'Bot' } } },
      ctx,
    )
    expect(byType[0]?.actor.isBot).toBe(true)

    const bySuffix = await gh.parse(
      {
        ...issuePayload,
        issue: { ...issuePayload.issue, user: { id: 2, login: 'dependabot[bot]', type: 'User' } },
      },
      ctx,
    )
    expect(bySuffix[0]?.actor.isBot).toBe(true)
  })

  it('tolerates a null body — an empty issue is a DEFER, not a crash', async () => {
    const [e] = await gh.parse(
      { ...issuePayload, issue: { ...issuePayload.issue, body: null } },
      ctx,
    )
    expect(e?.body).toBe('')
  })

  it('skips an issues payload that is really a pull request', async () => {
    const events = await gh.parse(
      { ...issuePayload, issue: { ...issuePayload.issue, pull_request: { url: 'x' } } },
      ctx,
    )
    expect(events).toHaveLength(0)
  })
})

describe('parse: pull requests', () => {
  const prPayload = {
    action: 'opened',
    repository: repo,
    pull_request: {
      number: 88,
      title: 'Fix session id crash',
      body: 'Closes #412',
      user: human,
      created_at: '2026-07-02T09:00:00Z',
      draft: false,
    },
  }

  it('maps an opened PR with a ! ref so it cannot collide with issue #88', async () => {
    const [e] = await gh.parse(prPayload, ctx)
    expect(e?.kind).toBe('pr')
    expect(e?.sourceRef).toBe('acme/api!88')
    expect(e?.threadKey).toBe('acme/api!88')
  })

  it('accepts ready_for_review and merged closures, but ignores synchronize and unmerged closures', async () => {
    expect(await gh.parse({ ...prPayload, action: 'ready_for_review' }, ctx)).toHaveLength(1)
    expect(await gh.parse({ ...prPayload, action: 'synchronize' }, ctx)).toHaveLength(0)
    expect(await gh.parse({ ...prPayload, action: 'closed' }, ctx)).toHaveLength(0)
    const [merged] = await gh.parse({
      ...prPayload,
      action: 'closed',
      pull_request: { ...prPayload.pull_request, merged: true, merged_at: '2026-07-03T09:00:00Z' },
    }, ctx)
    expect(merged?.sourceRef).toBe('acme/api!88:merged')
    expect(merged?.threadKey).toBe('acme/api!88')
  })
})

describe('parse: comments', () => {
  const commentPayload = {
    action: 'created',
    repository: repo,
    issue: issuePayload.issue,
    comment: {
      id: 55501,
      body: 'Still happening on v2.3.1',
      user: human,
      created_at: '2026-07-01T10:00:00Z',
    },
  }

  it('collapses onto the parent thread while keeping a unique sourceRef', async () => {
    const [e] = await gh.parse(commentPayload, ctx)
    expect(e?.kind).toBe('comment')
    expect(e?.threadKey).toBe('acme/api#412')
    expect(e?.sourceRef).toBe('acme/api#412:comment:55501')
    expect(e?.title).toBe('Re: Crash on expired token')
  })

  it('gives an issue and its comments one unitKey — one unit of work, not n', async () => {
    const [parent] = await gh.parse(issuePayload, ctx)
    const [c1] = await gh.parse(commentPayload, ctx)
    const [c2] = await gh.parse(
      { ...commentPayload, comment: { ...commentPayload.comment, id: 55502 } },
      ctx,
    )
    expect(parent).toBeDefined()
    expect(c1).toBeDefined()
    expect(c2).toBeDefined()
    const keys = new Set([unitKey(parent!), unitKey(c1!), unitKey(c2!)])
    expect(keys).toEqual(new Set(['github:acme/api#412']))
  })

  it('routes a comment on a PR to the PR thread', async () => {
    const [e] = await gh.parse(
      {
        ...commentPayload,
        issue: { ...commentPayload.issue, pull_request: { url: 'x' } },
      },
      ctx,
    )
    expect(e?.threadKey).toBe('acme/api!412')
  })

  it('ignores edited and deleted comments', async () => {
    expect(await gh.parse({ ...commentPayload, action: 'edited' }, ctx)).toHaveLength(0)
    expect(await gh.parse({ ...commentPayload, action: 'deleted' }, ctx)).toHaveLength(0)
  })
})

describe('parse: everything else', () => {
  it('returns no events for ping, star, and installation payloads', async () => {
    expect(await gh.parse({ zen: 'Non-blocking is better.', hook_id: 1 }, ctx)).toHaveLength(0)
    expect(await gh.parse({ action: 'created', starred_at: 'x', repository: repo }, ctx)).toHaveLength(0)
  })

  it('throws on a non-object payload rather than guessing', async () => {
    await expect(gh.parse('nope', ctx)).rejects.toThrow(/not an object/)
    await expect(gh.parse(null, ctx)).rejects.toThrow(/not an object/)
  })

  it('preserves the untouched payload in raw so a parse fix can be replayed', async () => {
    const [e] = await gh.parse(issuePayload, ctx)
    expect((e?.raw as { repository: { full_name: string } }).repository.full_name).toBe('acme/api')
  })
})

describe('connector output feeds the Normalizer directly', () => {
  it('parse -> normalize produces a valid NormalizedEvent', async () => {
    const [e] = await gh.parse(issuePayload, ctx)
    const n = normalize(e!, { internalActors: ['octocat'] })
    expect(n.trust).toBe('internal')
    expect(n.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(n.extracted.symbols).toContain('src/auth/session.ts')
    expect(n.injectionSuspected).toBe(false)
  })
})

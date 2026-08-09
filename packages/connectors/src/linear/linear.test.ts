import { afterEach, describe, expect, it, vi } from 'vitest'
import { linearWriter } from './index.js'

const w = () => linearWriter({ token: 'lin_api_not_real', teamId: 'team_1' })

type FetchMock = ReturnType<typeof vi.fn>

/** Indexed access is checked here, so assert the call happened rather than using `!`. */
function callOf(mock: FetchMock, i = 0): [string, { body: string }] {
  const call = mock.mock.calls[i]
  if (!call) throw new Error(`expected a fetch call at index ${i}`)
  return call as [string, { body: string }]
}

function bodyOf(mock: FetchMock, i = 0) {
  return JSON.parse(callOf(mock, i)[1].body)
}

function graphql(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createIssue', () => {
  it('returns the identifier the ticket stores', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        graphql({ data: { issueCreate: { success: true, issue: { id: 'i1', identifier: 'ENG-412', url: 'https://linear.app/x/issue/ENG-412' } } } }),
      ),
    )

    const issue = await w().createIssue({
      title: 'Fix session crash',
      description: 'Throws on expired token',
      decisionId: 'dec_1',
    })
    expect(issue.identifier).toBe('ENG-412')
  })

  it('embeds the decision id in the description as a traceable fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphql({ data: { issueCreate: { success: true, issue: { id: 'i1', identifier: 'ENG-1', url: 'x' } } } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await w().createIssue({ title: 'T', description: 'D', decisionId: 'dec_abc123' })

    expect(bodyOf(fetchMock).variables.input.description).toContain('dec_abc123')
  })

  /**
   * The trap this writer exists to close: Linear signals a throttle as HTTP 400 with
   * RATELIMITED in the errors array, not a 429. A client that only checks the status
   * code reads this as a malformed query and can retry into a ban.
   */
  it('recognises a 400 RATELIMITED response as a rate limit, not a bad request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        graphql(
          { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
          400,
        ),
      ),
    )

    await expect(
      w().createIssue({ title: 'T', description: 'D', decisionId: 'dec_1' }),
    ).rejects.toMatchObject({ rateLimited: true })
  })

  it('still reports an ordinary 400 as a normal error, not a rate limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(graphql({ errors: [{ message: 'Argument "input" is required.' }] }, 400)),
    )

    await expect(
      w().createIssue({ title: 'T', description: 'D', decisionId: 'dec_1' }),
    ).rejects.toMatchObject({ rateLimited: false })
  })

  it('throws when the mutation reports success: false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(graphql({ data: { issueCreate: { success: false, issue: null } } })),
    )

    await expect(
      w().createIssue({ title: 'T', description: 'D', decisionId: 'dec_1' }),
    ).rejects.toThrow()
  })
})

describe('states', () => {
  it('requests an explicit first: rather than relying on the default page size', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphql({ data: { team: { states: { nodes: [{ id: 's1', name: 'Todo' }] } } } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await w().states()

    expect(bodyOf(fetchMock).query).toMatch(/states\(first:\s*\d+\)/)
  })

  it('caches across calls instead of refetching the whole workspace every time', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphql({ data: { team: { states: { nodes: [{ id: 's1', name: 'Todo' }] } } } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const writer = w()
    await writer.states()
    await writer.states()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('moveTo', () => {
  it('resolves the stage name to a state id before moving', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.query.includes('states(')) {
        return graphql({
          data: { team: { states: { nodes: [{ id: 'state_review', name: 'In Review' }] } } },
        })
      }
      return graphql({ data: { issueUpdate: { success: true } } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await w().moveTo('issue_1', 'In Review')

    expect(bodyOf(fetchMock, 1).variables.input.stateId).toBe('state_review')
  })

  it('names the missing state rather than failing silently on a renamed workflow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(graphql({ data: { team: { states: { nodes: [{ id: 's1', name: 'Backlog' }] } } } })),
    )

    await expect(w().moveTo('issue_1', 'In Review')).rejects.toThrow(/Backlog/)
  })
})

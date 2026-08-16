import { afterEach, describe, expect, it, vi } from 'vitest'
import { slackHistoryReader, slackMessageToRaw, slackWriter } from './index.js'

const w = () => slackWriter({ token: 'xoxb-not-real', channel: 'C123' })

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

/** Slack always answers 200; success lives in the body. */
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('post', () => {
  it('returns the channel and ts that identify the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: true, channel: 'C123', ts: '1699.01' })))

    const msg = await w().post('Shipped')
    expect(msg).toEqual({ channel: 'C123', ts: '1699.01' })
  })

  it('sends text alongside blocks so notifications and a11y have a fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ ok: true, channel: 'C123', ts: '1' }))
    vi.stubGlobal('fetch', fetchMock)

    await w().post('Gate decided: BUILD')

    const body = bodyOf(fetchMock)
    expect(body.text).toBe('Gate decided: BUILD')
    expect(body.channel).toBe('C123')
  })

  it('carries the decision id on each button so the handler can resume the wait', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ ok: true, channel: 'C123', ts: '1' }))
    vi.stubGlobal('fetch', fetchMock)

    await w().post('Needs review', [
      { text: 'Approve', actionId: 'ascendant_approve', value: 'dec_42', style: 'primary' },
    ])

    const body = bodyOf(fetchMock)
    const actions = body.blocks.find((b: { type: string }) => b.type === 'actions')
    expect(actions.elements[0]).toMatchObject({
      action_id: 'ascendant_approve',
      value: 'dec_42',
      style: 'primary',
    })
  })

  it('omits the actions block entirely when there are no buttons', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ ok: true, channel: 'C123', ts: '1' }))
    vi.stubGlobal('fetch', fetchMock)

    await w().post('Just an update')

    const body = bodyOf(fetchMock)
    expect(body.blocks.some((b: { type: string }) => b.type === 'actions')).toBe(false)
  })

  /**
   * The trap this writer exists to close: a Slack failure is a 200 with `ok: false`, so
   * `res.ok` is true and a naive client reports success on every error.
   */
  it('throws on ok:false even though the HTTP status is 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: false, error: 'channel_not_found' })))

    await expect(w().post('x')).rejects.toThrow(/channel_not_found/)
  })

  it('reports a 429 as rate limited and carries the retry hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('', { status: 429, headers: { 'retry-after': '12' } }),
      ),
    )

    // The caller needs to distinguish "wait and retry" from "this will never work",
    // so the code and the delay both have to survive the throw.
    await expect(w().post('x')).rejects.toMatchObject({
      code: 'ratelimited',
      retryAfterSeconds: 12,
    })
  })
})

describe('update', () => {
  it('edits in place by passing the original ts back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ ok: true, channel: 'C123', ts: '1699.01' }))
    vi.stubGlobal('fetch', fetchMock)

    await w().update('1699.01', 'Now in review')

    const [url] = callOf(fetchMock)
    expect(url).toContain('chat.update')
    expect(bodyOf(fetchMock).ts).toBe('1699.01')
  })

  it('keeps one message per ticket: update never hits chat.postMessage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ ok: true, channel: 'C123', ts: '1' }))
    vi.stubGlobal('fetch', fetchMock)

    await w().update('1', 'edited')

    expect(callOf(fetchMock)[0]).not.toContain('postMessage')
  })
})

describe('Slack inbound context', () => {
  it('collapses replies onto the parent conversation', () => {
    const event = slackMessageToRaw({
      channel: 'C123', ts: '1700000001.0002', threadTs: '1700000000.0001',
      user: 'U42', text: 'The getSessionId error also happens in production',
    }, 'org_demo')
    expect(event).toMatchObject({
      source: 'slack',
      sourceRef: 'slack:C123:1700000001.0002',
      threadKey: 'slack:C123:1700000000.0001',
      actor: { id: 'U42', handle: 'U42', isBot: false },
    })
  })

  it('never feeds bot delivery messages back into triage', () => {
    expect(slackMessageToRaw({ channel: 'C123', ts: '1.0', text: 'PR ready', botId: 'B1' }, 'org_demo')).toBeUndefined()
  })

  it('reads channel history and thread replies', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply({ ok: true, messages: [{ ts: '10.0', user: 'U1', text: 'Bug report', reply_count: 1 }] }))
      .mockResolvedValueOnce(reply({ ok: true, messages: [
        { ts: '10.0', user: 'U1', text: 'Bug report' },
        { ts: '11.0', thread_ts: '10.0', user: 'U2', text: 'Confirmed' },
      ] }))
    const events = await slackHistoryReader({ token: 'token', channel: 'C123', fetcher }).read('org_demo')
    expect(events.map((event) => event.sourceRef)).toEqual(['slack:C123:10.0', 'slack:C123:11.0'])
    expect(events[1]?.threadKey).toBe('slack:C123:10.0')
  })
})

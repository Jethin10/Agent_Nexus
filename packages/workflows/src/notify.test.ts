import { describe, expect, it, vi } from 'vitest'
import { createLinearWorkItem, notifyLinear, notifySlack } from './notify.js'
import type { LinearWriter, SlackWriter } from '@ascendant/connectors'

const decisionId = 'dec_1'

/** Indexed access is checked here, so assert the call happened rather than using `!`. */
function argsOf(fn: unknown, i = 0): unknown[] {
  const call = (fn as ReturnType<typeof vi.fn>).mock.calls[i]
  if (!call) throw new Error(`expected a call at index ${i}`)
  return call
}

function slackStub(over: Partial<SlackWriter> = {}): SlackWriter {
  return {
    post: vi.fn().mockResolvedValue({ channel: 'C1', ts: '100.1' }),
    update: vi.fn().mockResolvedValue({ channel: 'C1', ts: '100.1' }),
    ...over,
  } as SlackWriter
}

function linearStub(over: Partial<LinearWriter> = {}): LinearWriter {
  return {
    createIssue: vi.fn(),
    moveTo: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
    states: vi.fn(),
    ...over,
  } as unknown as LinearWriter
}

describe('notifySlack', () => {
  it('skips cleanly when Slack was never configured', async () => {
    const res = await notifySlack(undefined, { text: 'x', decisionId })
    expect(res).toEqual({ status: 'skipped', reason: 'slack not configured' })
  })

  it('posts a new message when the ticket has no ts yet', async () => {
    const w = slackStub()
    const res = await notifySlack(w, { text: 'Shipped', decisionId })

    expect(w.post).toHaveBeenCalled()
    expect(w.update).not.toHaveBeenCalled()
    expect(res).toMatchObject({ status: 'ok', detail: { ts: '100.1' } })
  })

  /** One message per ticket (§8.3) — the second stage edits rather than posts. */
  it('edits the existing message when the ticket already has a ts', async () => {
    const w = slackStub()
    await notifySlack(w, { text: 'Now in review', ts: '100.1', decisionId })

    expect(w.update).toHaveBeenCalledWith('100.1', expect.any(String), expect.anything())
    expect(w.post).not.toHaveBeenCalled()
  })

  it('appends the PR link so the message is actionable from the channel', async () => {
    const w = slackStub()
    await notifySlack(w, { text: 'Shipped', prUrl: 'https://github.com/acme/api/pull/9', decisionId })

    const [text] = argsOf(w.post)
    expect(text).toContain('https://github.com/acme/api/pull/9')
  })

  it('passes the decision id through every button', async () => {
    const w = slackStub()
    await notifySlack(w, { text: 'x', decisionId: 'dec_xyz' })

    const buttons = argsOf(w.post)[1] as { value: string }[]
    expect(buttons).toHaveLength(3)
    expect(buttons.every((b) => b.value === 'dec_xyz')).toBe(true)
  })

  /**
   * The contract the delivery step depends on: the PR is the deliverable, so a Slack
   * outage must degrade to a traced failure, never an exception that fails the run.
   */
  it('reports a transport failure instead of throwing', async () => {
    const w = slackStub({ post: vi.fn().mockRejectedValue(new Error('channel_not_found')) })
    const res = await notifySlack(w, { text: 'x', decisionId })

    expect(res).toEqual({ status: 'failed', reason: 'channel_not_found' })
  })
})

describe('createLinearWorkItem', () => {
  it('creates the issue at ACCEPT and returns the remote identity', async () => {
    const w = linearStub({
      createIssue: vi.fn().mockResolvedValue({ id: 'lin_1', identifier: 'ENG-42', url: 'https://linear.app/i/42' }),
    })
    const res = await createLinearWorkItem(w, {
      title: 'Fix sessions',
      description: 'Accepted by the gate.',
      decisionId,
    })
    expect(w.createIssue).toHaveBeenCalledWith(expect.objectContaining({ decisionId }))
    expect(res).toMatchObject({ status: 'ok', detail: { id: 'lin_1', identifier: 'ENG-42' } })
  })

  it('degrades when Linear is not configured', async () => {
    await expect(createLinearWorkItem(undefined, {
      title: 'x', description: 'y', decisionId,
    })).resolves.toEqual({ status: 'skipped', reason: 'linear not configured' })
  })
})

describe('notifyLinear', () => {
  it('skips when Linear is unconfigured', async () => {
    const res = await notifyLinear(undefined, { issueId: 'i1', stage: 'In Review' })
    expect(res).toMatchObject({ status: 'skipped' })
  })

  it('skips when the ticket was never mirrored to Linear', async () => {
    const res = await notifyLinear(linearStub(), { issueId: null, stage: 'In Review' })
    expect(res).toEqual({ status: 'skipped', reason: 'ticket has no linear issue' })
  })

  it('moves the issue and leaves the comment', async () => {
    const w = linearStub()
    const res = await notifyLinear(w, { issueId: 'i1', stage: 'In Review', comment: 'PR #9' })

    expect(w.moveTo).toHaveBeenCalledWith('i1', 'In Review')
    expect(w.comment).toHaveBeenCalledWith('i1', 'PR #9')
    expect(res).toMatchObject({ status: 'ok', detail: { commented: true } })
  })

  /**
   * The state transition is what the board shows, so a failed comment must not report
   * the move as failed — it only downgrades `commented`.
   */
  it('still reports ok when the move lands but the comment fails', async () => {
    const w = linearStub({ comment: vi.fn().mockRejectedValue(new Error('nope')) })
    const res = await notifyLinear(w, { issueId: 'i1', stage: 'Done', comment: 'x' })

    expect(res).toMatchObject({ status: 'ok', detail: { commented: false } })
  })

  it('reports a failed move without throwing', async () => {
    const w = linearStub({ moveTo: vi.fn().mockRejectedValue(new Error('no state named In Review')) })
    const res = await notifyLinear(w, { issueId: 'i1', stage: 'In Review' })

    expect(res).toEqual({ status: 'failed', reason: 'no state named In Review' })
  })
})

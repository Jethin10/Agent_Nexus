import { describe, expect, it } from 'vitest'
import { extract } from './extract.js'

const TITLE = 'Crash in getSessionId on expired token'

const BODY = [
  'The handler in src/auth/session.ts throws when the token is stale.',
  '',
  '```ts',
  'const id = auth.getSessionId(token)',
  'const row = await db.findSession(session_id)',
  '```',
  '',
  'Stack:',
  '    at getSessionId (src/auth/session.ts:12:3)',
  '    at handler (src/api/route.ts:44:9)',
  '  File "app/main.py", line 12, in handler',
  '',
  'Seen on v2.3.1, commit 9f3ab21. See #412 and ENG-88.',
  'Logs: https://example.com/logs/run-1',
].join('\n')

describe('extract', () => {
  const e = extract(TITLE, BODY)

  it('pulls file paths from anywhere in the text', () => {
    expect(e.symbols).toContain('src/auth/session.ts')
    expect(e.symbols).toContain('src/api/route.ts')
  })

  it('pulls dotted calls and identifiers only from code spans', () => {
    expect(e.symbols).toContain('auth.getSessionId')
    expect(e.symbols).toContain('db.findSession')
    expect(e.symbols).toContain('session_id')
    // `getSessionId` appears in the title too, but the title is not a code span —
    // it is only here because the fenced block contains it.
    expect(e.symbols).toContain('getSessionId')
  })

  it('ignores dotted calls outside code spans', () => {
    const only = extract('', 'call auth.getSessionId(token) in prose')
    expect(only.symbols).not.toContain('auth.getSessionId')
  })

  it('captures node and python stack frames, trimmed', () => {
    expect(e.stackFrames).toContain('at getSessionId (src/auth/session.ts:12:3)')
    expect(e.stackFrames).toContain('at handler (src/api/route.ts:44:9)')
    expect(e.stackFrames).toContain('File "app/main.py", line 12, in handler')
  })

  it('captures semver and sha-like versions', () => {
    expect(e.versions).toContain('v2.3.1')
    expect(e.versions).toContain('9f3ab21')
  })

  it('rejects sha candidates that are all digits or all letters', () => {
    const only = extract('', 'ids 1234567 and deadbee and 9f3ab21')
    expect(only.versions).not.toContain('1234567')
    expect(only.versions).not.toContain('deadbee')
    expect(only.versions).toContain('9f3ab21')
  })

  it('captures urls and issue refs in both notations', () => {
    expect(e.urls).toContain('https://example.com/logs/run-1')
    expect(e.issueRefs).toContain('#412')
    expect(e.issueRefs).toContain('ENG-88')
  })

  it('does not treat a url fragment as an issue ref', () => {
    const only = extract('', 'see https://example.com/page#123 for context')
    expect(only.issueRefs).not.toContain('#123')
  })

  /**
   * `owner/repo#N` is how a ref from another repo is normally written, and the
   * `already_closed_ref` regression guard only fires if it extracts.
   */
  it('extracts a cross-repo ref to its short form', () => {
    const only = extract('', 'this is acme/api#447 again')
    expect(only.issueRefs).toContain('#447')
  })

  it('still rejects a fragment on a path-shaped url', () => {
    const only = extract('', 'see https://example.com/acme/api#447 for context')
    expect(only.issueRefs).toEqual([])
  })

  it('does not read a bare hash after a word char as a ref', () => {
    expect(extract('', 'released as v2#3 internally').issueRefs).toEqual([])
  })

  it('dedupes and caps each field at 40', () => {
    const urls = Array.from({ length: 60 }, (_, i) => `https://example.com/${i}`)
    const only = extract('', urls.join('\n'))
    expect(only.urls).toHaveLength(40)

    const dupes = extract('', 'see #7 then #7 then #7')
    expect(dupes.issueRefs).toEqual(['#7'])
  })

  it('returns empty arrays for empty input rather than throwing', () => {
    expect(extract('', '')).toEqual({
      symbols: [],
      versions: [],
      stackFrames: [],
      urls: [],
      issueRefs: [],
    })
  })
})

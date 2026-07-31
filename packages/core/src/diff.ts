import { isBlockedPath } from './limits.js'

/**
 * §15.3 layer 4 — output validation, and the §14.3 hard rules.
 *
 * Everything here is a deterministic scan over the Coder's diff. That is the whole
 * point: a check that asks a model whether a diff is safe can be argued with, and
 * the attacker in the threat model gets to write the argument. These checks cannot
 * be persuaded.
 *
 * The Reviewer agent receives these results as *input*, so its verdict is informed
 * by them rather than duplicating them — a model is good at "is this code correct",
 * bad at "does this string contain a credential".
 */

export interface DiffFile {
  path: string
  /** Present when the diff renames: the old path. */
  oldPath?: string
  added: string[]
  removed: string[]
  isNew: boolean
  isDelete: boolean
}

export interface ParsedDiff {
  files: DiffFile[]
  addedLines: number
  removedLines: number
  totalLines: number
}

/**
 * Parses a unified diff. Hand-rolled rather than a dependency because the checks
 * below only need added/removed lines per path, and a diff from a model is often
 * *slightly* malformed — a parser that throws on an odd hunk header would turn a
 * fixable formatting slip into a failed run.
 */
export function parseDiff(diff: string): ParsedDiff {
  const files: DiffFile[] = []
  let current: DiffFile | undefined

  const push = () => {
    if (current) files.push(current)
  }

  for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw

    if (line.startsWith('diff --git ')) {
      push()
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      const path = m?.[2] ?? m?.[1] ?? 'unknown'
      current = { path, added: [], removed: [], isNew: false, isDelete: false }
      if (m?.[1] && m[1] !== m[2]) current.oldPath = m[1]
      continue
    }

    if (!current) {
      // Some models emit a bare `--- a/x` / `+++ b/x` pair with no `diff --git`.
      const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)
      if (plus?.[1] && plus[1] !== '/dev/null') {
        current = { path: plus[1], added: [], removed: [], isNew: false, isDelete: false }
      }
      continue
    }

    if (line.startsWith('new file mode')) current.isNew = true
    else if (line.startsWith('deleted file mode')) current.isDelete = true
    else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      if (line.endsWith('/dev/null')) {
        if (line.startsWith('+++ ')) current.isDelete = true
        else current.isNew = true
      }
      const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)
      if (plus?.[1] && plus[1] !== '/dev/null' && current.path === 'unknown') current.path = plus[1]
    } else if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
  }
  push()

  const addedLines = files.reduce((n, f) => n + f.added.length, 0)
  const removedLines = files.reduce((n, f) => n + f.removed.length, 0)
  return { files, addedLines, removedLines, totalLines: addedLines + removedLines }
}

/** Test files, by the conventions that actually appear in TS/JS repos. */
const TEST_FILE = /(?:^|\/)(?:__tests__\/|test\/|tests\/)|\.(?:test|spec)\.[cm]?[jt]sx?$/

/** Assertion shapes worth counting. Deliberately broad — an undercount is safe. */
const ASSERTION = /\b(?:expect|assert|should|toBe|toEqual|toThrow|t\.(?:is|deepEqual|throws))\b/g

/** `it(...)` / `test(...)` / `describe(...)` declarations. */
const TEST_DECL = /\b(?:it|test|describe)(?:\.\w+)?\s*\(/g

/**
 * Counts *occurrences*, not matching lines. Per-line counting looks equivalent and
 * is not: collapsing three `expect`s onto one line, or deleting two of three
 * assertions from a single-line test, would net to zero and pass. That is precisely
 * the evasion the §14.3 rule exists to catch, so the unit has to be the assertion
 * rather than the line.
 */
function countMatches(lines: readonly string[], re: RegExp): number {
  let n = 0
  for (const l of lines) {
    // Global regexes are stateful via lastIndex; matchAll takes its own copy.
    for (const _ of l.matchAll(re)) n += 1
  }
  return n
}

export interface TestErosion {
  /** True when the diff removes more tests or assertions than it adds. */
  eroded: boolean
  testsAdded: number
  testsRemoved: number
  assertionsAdded: number
  assertionsRemoved: number
  /** Test files this diff deletes outright. */
  deletedTestFiles: string[]
}

/**
 * §14.3's hard rule: **any diff reducing test count or assertions is an automatic
 * Reviewer reject** — a deterministic check, not just a prompt.
 *
 * This is the single most important scan in the file. "Delete the failing test" is
 * the shortest path to a green suite, it is a path a model will find, and a prompt
 * asking it not to is not a control. Net counts are used rather than absolute ones
 * so a legitimate refactor that rewrites a test file still passes.
 */
export function detectTestErosion(parsed: ParsedDiff): TestErosion {
  let testsAdded = 0
  let testsRemoved = 0
  let assertionsAdded = 0
  let assertionsRemoved = 0
  const deletedTestFiles: string[] = []

  for (const f of parsed.files) {
    const isTest = TEST_FILE.test(f.path) || (f.oldPath ? TEST_FILE.test(f.oldPath) : false)
    if (!isTest) continue
    if (f.isDelete) deletedTestFiles.push(f.path)
    testsAdded += countMatches(f.added, TEST_DECL)
    testsRemoved += countMatches(f.removed, TEST_DECL)
    assertionsAdded += countMatches(f.added, ASSERTION)
    assertionsRemoved += countMatches(f.removed, ASSERTION)
  }

  return {
    eroded:
      deletedTestFiles.length > 0 ||
      testsRemoved > testsAdded ||
      assertionsRemoved > assertionsAdded,
    testsAdded,
    testsRemoved,
    assertionsAdded,
    assertionsRemoved,
    deletedTestFiles,
  }
}

/**
 * Hosts a generated diff may legitimately reach. Everything else forces ESCALATE.
 * The list is short on purpose: the sandbox's egress allowlist is package-registry
 * only (§12.4), so a diff calling anything else is either wrong or hostile.
 */
export const ALLOWLISTED_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'localhost',
  '127.0.0.1',
  'api.github.com',
]

const URL_IN_CODE = /https?:\/\/([a-z0-9.-]+)/gi

/** Dangerous primitives. A generated diff has no business introducing any of these. */
const DANGEROUS = [
  { rule: 'eval', re: /\beval\s*\(/ },
  { rule: 'new-function', re: /\bnew\s+Function\s*\(/ },
  { rule: 'child-process', re: /\b(?:child_process|execSync|spawnSync|execFile)\b/ },
  { rule: 'dynamic-require', re: /\brequire\s*\(\s*[^'"`)]/ },
  { rule: 'process-env-write', re: /\bprocess\.env\.\w+\s*=/ },
] as const

/** Credential shapes. Broad by design: a false positive costs a human glance. */
const CREDENTIAL = [
  { rule: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { rule: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'generic-secret', re: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
] as const

/** A long base64 run in a diff is an exfiltration or a payload, not source code. */
const BASE64_BLOB = /['"`][A-Za-z0-9+/]{120,}={0,2}['"`]/

/** Dependency manifests. A new dependency is a human decision (§13.8). */
const MANIFEST = /(?:^|\/)(?:package\.json|requirements\.txt|Cargo\.toml|go\.mod|pyproject\.toml)$/

export interface DiffFinding {
  rule: string
  severity: 'blocker' | 'major'
  path: string
  /** The offending line, truncated. Never the whole file. */
  evidence: string
  why: string
}

export interface DiffScan {
  parsed: ParsedDiff
  erosion: TestErosion
  findings: DiffFinding[]
  /** True when anything here forces ESCALATE regardless of confidence. */
  mustEscalate: boolean
  blockedPaths: string[]
  overSize: boolean
}

const clip = (s: string) => s.trim().slice(0, 160)

/**
 * The full layer-4 scan. Returns findings rather than throwing: the Reviewer sees
 * them as input, the workflow decides to escalate, and the PR records them. A check
 * that throws loses the explanation, and the explanation is what a human needs.
 */
export function scanDiff(diff: string, opts: { maxLines?: number } = {}): DiffScan {
  const parsed = parseDiff(diff)
  const erosion = detectTestErosion(parsed)
  const findings: DiffFinding[] = []
  const blockedPaths: string[] = []

  for (const f of parsed.files) {
    for (const p of [f.path, f.oldPath].filter((x): x is string => Boolean(x))) {
      if (isBlockedPath(p)) blockedPaths.push(p)
    }

    // A new dependency is not a code review question, it is a supply-chain one.
    if (MANIFEST.test(f.path) && f.added.some((l) => /^\s*["']?[\w@/.-]+["']?\s*:/.test(l))) {
      findings.push({
        rule: 'new-dependency',
        severity: 'blocker',
        path: f.path,
        evidence: clip(f.added.find((l) => /:/.test(l)) ?? ''),
        why: 'The diff edits a dependency manifest. Adding a dependency is a human decision.',
      })
    }

    for (const line of f.added) {
      for (const { rule, re } of DANGEROUS) {
        if (re.test(line)) {
          findings.push({
            rule,
            severity: 'blocker',
            path: f.path,
            evidence: clip(line),
            why: `The diff introduces ${rule}, which a generated change has no legitimate need for.`,
          })
        }
      }
      for (const { rule, re } of CREDENTIAL) {
        if (re.test(line)) {
          findings.push({
            rule,
            severity: 'blocker',
            path: f.path,
            // Never echo a suspected secret back, even into an artifact row.
            evidence: `[redacted ${rule} match]`,
            why: 'The diff adds something shaped like a credential.',
          })
        }
      }
      if (BASE64_BLOB.test(line)) {
        findings.push({
          rule: 'base64-blob',
          severity: 'blocker',
          path: f.path,
          evidence: '[redacted base64 run]',
          why: 'A long base64 literal in generated code is a payload or an exfiltration, not source.',
        })
      }
      for (const m of line.matchAll(URL_IN_CODE)) {
        const host = m[1]?.toLowerCase()
        if (host && !ALLOWLISTED_HOSTS.includes(host)) {
          findings.push({
            rule: 'network-egress',
            severity: 'blocker',
            path: f.path,
            evidence: clip(line),
            why: `The diff adds a call to ${host}, which is not on the egress allowlist.`,
          })
        }
      }
    }
  }

  if (erosion.eroded) {
    findings.push({
      rule: 'test-erosion',
      severity: 'blocker',
      path: erosion.deletedTestFiles[0] ?? '(tests)',
      evidence: `tests ${erosion.testsRemoved}→${erosion.testsAdded}, assertions ${erosion.assertionsRemoved}→${erosion.assertionsAdded}`,
      why: 'The diff reduces test count or assertions. §14.3: automatic reject, deterministically.',
    })
  }

  const maxLines = opts.maxLines ?? 400
  const overSize = parsed.totalLines > maxLines
  if (overSize) {
    findings.push({
      rule: 'diff-too-large',
      severity: 'blocker',
      path: '(diff)',
      evidence: `${parsed.totalLines} changed lines against a ${maxLines}-line ceiling`,
      why: 'This is a bounded-work system. A change this large needs a human to own it.',
    })
  }

  for (const p of new Set(blockedPaths)) {
    findings.push({
      rule: 'blocked-path',
      severity: 'blocker',
      path: p,
      evidence: p,
      why: 'Writes to CI config, lockfiles, .env and secrets paths are blocked deterministically.',
    })
  }

  return {
    parsed,
    erosion,
    findings,
    mustEscalate: findings.some((f) => f.severity === 'blocker'),
    blockedPaths: [...new Set(blockedPaths)],
    overSize,
  }
}

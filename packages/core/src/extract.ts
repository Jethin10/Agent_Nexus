import type { Extracted } from './event.js'

const CAP = 40

function uniqCap(xs: string[]): string[] {
  return Array.from(new Set(xs.filter(Boolean))).slice(0, CAP)
}

/** ```lang ... ``` and `inline` — code spans are where symbols actually live. */
function codeSpans(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/```[\w+-]*\n([\s\S]*?)```/g)) out.push(m[1] ?? '')
  for (const m of body.matchAll(/`([^`\n]{2,120})`/g)) out.push(m[1] ?? '')
  return out
}

const FILE_PATH = /\b[\w.-]+(?:\/[\w.-]+)+\.[a-zA-Z]{1,8}\b/g
const DOTTED_CALL = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*\(/g
const IDENTIFIER = /\b(?:[a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[a-z_]+_[a-z_0-9]+)\b/g

const SEMVER = /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g
const SHA = /\b[0-9a-f]{7,40}\b/g

/** node:  at fn (file:12:3)   python:  File "x.py", line 12   java:  at a.b.C.m(C.java:9) */
const STACK_NODE = /^\s*at\s+.+$/gm
const STACK_PY = /^\s*File\s+"[^"]+",\s+line\s+\d+.*$/gm

const URL = /https?:\/\/[^\s<>()\[\]"']+/g
/**
 * `#412` and GitHub's cross-repo `owner/repo#412`, which is how people actually
 * cite an issue from another repo. Both yield the short `#412` form so matching
 * stays uniform; the qualified prefix is dropped because callers compare by
 * suffix against a fully-qualified `sourceRef`.
 *
 * URL fragments (`https://example.com/page#123`) must not match, and a bare
 * lookbehind is not enough once the `owner/repo` prefix is optional — the prefix
 * would simply match the URL's own last path segment. So URLs are stripped from
 * the text before this runs (see `extract`), and the lookbehind then only has to
 * reject `v2#3`-style word-char adjacency.
 */
const ISSUE_HASH = /(?<![\w/:])(?:[\w.-]+\/[\w.-]+)?#(\d{1,7})\b/g
const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g

/**
 * Deterministic extraction — no LLM, by design (§7.3). These fields are the join
 * keys for lexical retrieval and the git-activity overlap that powers
 * "already fixed on main", so they must be exact and free.
 */
export function extract(title: string, body: string): Extracted {
  const text = `${title}\n${body}`
  const spans = codeSpans(body).join('\n')

  const symbols = uniqCap([
    ...(text.match(FILE_PATH) ?? []),
    ...[...spans.matchAll(DOTTED_CALL)].map((m) => m[0].replace(/\s*\($/, '')),
    ...(spans.match(IDENTIFIER) ?? []),
  ])

  const versions = uniqCap([
    ...(text.match(SEMVER) ?? []),
    ...(text.match(SHA) ?? []).filter((s) => /[a-f]/.test(s) && /\d/.test(s)),
  ])

  const stackFrames = uniqCap([
    ...(text.match(STACK_NODE) ?? []),
    ...(text.match(STACK_PY) ?? []),
  ]).map((s) => s.trim())

  /**
   * Issue refs are matched against text with URLs removed, so a fragment like
   * `…/page#123` cannot be read as a ref. Replaced with a space rather than
   * deleted, so a ref immediately after a URL still has its boundary.
   */
  const deUrled = text.replace(URL, ' ')

  return {
    symbols,
    versions,
    stackFrames,
    urls: uniqCap(text.match(URL) ?? []),
    issueRefs: uniqCap([
      ...[...deUrled.matchAll(ISSUE_HASH)].map((m) => `#${m[1]}`),      ...[...text.matchAll(ISSUE_KEY)].map((m) => m[1] ?? ''),
    ]),
  }
}

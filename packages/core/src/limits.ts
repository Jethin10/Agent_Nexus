/**
 * Hard caps live in code, not prompts (§14).
 * Hitting any of these is an ESCALATE with the transcript attached — never a crash.
 * Values marked (config) are overridable live from the `config` table during the demo.
 */
export const LIMITS = {
  MAX_DEBATE_ROUNDS: 3,
  MAX_CODER_RETRIES: 2,
  MAX_FILES_TOUCHED: 12,
  MAX_DIFF_LINES: 400,
  /** (config) per-ticket ceiling — §10.4 */
  MAX_TICKET_TOKENS: 60_000,
  MAX_TICKET_LLM_CALLS: 25,
  /** (config) per-org daily ceiling */
  MAX_ORG_DAILY_TOKENS: 400_000,
  /** Retrieval budget — §9: union of 4 sources, deduped, capped. */
  RETRIEVAL_CANDIDATE_CAP: 20,
  RETRIEVAL_TOKEN_BUDGET: 6_000,
  GIT_ACTIVITY_WINDOW_DAYS: 21,
  /** Sandbox — §12.4, enforced by the driver. */
  SANDBOX_TIMEOUT_MS: 10 * 60 * 1000,
  SANDBOX_MAX_WRITTEN_BYTES: 512 * 1024 * 1024,
} as const

/**
 * (config) Autonomy bands — §5. Thresholds are in the DB so they can be
 * dragged during the demo without a redeploy.
 */
export const CONFIDENCE = {
  /** >= act autonomously */
  AUTONOMOUS: 0.8,
  /** >= act but mark needs_review; below this, ESCALATE */
  FLAGGED: 0.55,
  /** Ceiling applied when injection is suspected (§15.3 layer 1). */
  INJECTION_CEILING: 0.5,
} as const

/**
 * Layer 3 of §15.3 — capability, not persuasion. Writes to these paths are
 * blocked deterministically; a diff touching one ESCALATEs regardless of confidence.
 * A defence that depends on the model not being fooled is not a defence.
 */
export const BLOCKED_WRITE_PATTERNS: readonly RegExp[] = [
  /^\.github\//,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock)$/,
  /(^|\/)(id_rsa|id_ed25519|.*\.pem|.*\.p8|.*\.pfx|.*\.key)$/,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc)$/,
  /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/,
  /(^|\/)(vercel\.json|\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/)/,
]

export function isBlockedPath(path: string): boolean {
  const p = path.replace(/^\.\//, '').replace(/\\/g, '/')
  return BLOCKED_WRITE_PATTERNS.some((re) => re.test(p))
}

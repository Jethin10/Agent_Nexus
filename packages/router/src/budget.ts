import { LIMITS } from '@ascendant/core'

/**
 * §10.4 — budget. Checked before every call, decremented after.
 *
 * Exceeding a ceiling is an ESCALATE with the transcript attached, never a
 * half-finished PR. The per-day org ceiling exists for one specific reason: a
 * runaway loop at 2am must not be able to leave the demo without quota at 10am,
 * and Groq's 1,000 RPD on the 70b model is the real binding constraint on this
 * whole system (§13.4).
 */
export interface BudgetLimits {
  ticketTokens: number
  ticketLlmCalls: number
  orgDailyTokens: number
}

export const DEFAULT_BUDGET: BudgetLimits = {
  ticketTokens: LIMITS.MAX_TICKET_TOKENS,
  ticketLlmCalls: LIMITS.MAX_TICKET_LLM_CALLS,
  orgDailyTokens: LIMITS.MAX_ORG_DAILY_TOKENS,
}

export interface BudgetUsage {
  ticketTokens: number
  ticketLlmCalls: number
  orgDailyTokens: number
}

/** Thrown when a ceiling is hit. The caller turns this into an ESCALATE. */
export class BudgetExceededError extends Error {
  constructor(
    readonly which: 'ticket_tokens' | 'ticket_calls' | 'org_daily_tokens',
    readonly used: number,
    readonly limit: number,
  ) {
    super(`budget exceeded: ${which} at ${used} of ${limit}`)
    this.name = 'BudgetExceededError'
  }
}

/**
 * A per-ticket counter. Constructed once per pipeline run and passed down, so
 * every agent shares one ledger rather than each keeping its own optimistic count.
 */
export class Budget {
  private ticketTokens = 0
  private ticketCalls = 0

  constructor(
    readonly limits: BudgetLimits = DEFAULT_BUDGET,
    /** Tokens the org has already spent today, read from `agent_events`. */
    private orgTokensToday = 0,
  ) {}

  /**
   * Called before a request. Rejects on the *estimate*, not after the fact —
   * discovering a ceiling by exceeding it is how a free tier gets suspended.
   */
  check(estimatedTokens: number): void {
    if (this.ticketCalls + 1 > this.limits.ticketLlmCalls) {
      throw new BudgetExceededError('ticket_calls', this.ticketCalls + 1, this.limits.ticketLlmCalls)
    }
    if (this.ticketTokens + estimatedTokens > this.limits.ticketTokens) {
      throw new BudgetExceededError(
        'ticket_tokens',
        this.ticketTokens + estimatedTokens,
        this.limits.ticketTokens,
      )
    }
    if (this.orgTokensToday + estimatedTokens > this.limits.orgDailyTokens) {
      throw new BudgetExceededError(
        'org_daily_tokens',
        this.orgTokensToday + estimatedTokens,
        this.limits.orgDailyTokens,
      )
    }
  }

  spend(tokens: number): void {
    this.ticketCalls += 1
    this.ticketTokens += tokens
    this.orgTokensToday += tokens
  }

  /** A repair retry costs a call but must not be able to strand a run mid-debate. */
  get remainingCalls(): number {
    return Math.max(0, this.limits.ticketLlmCalls - this.ticketCalls)
  }

  get usage(): BudgetUsage {
    return {
      ticketTokens: this.ticketTokens,
      ticketLlmCalls: this.ticketCalls,
      orgDailyTokens: this.orgTokensToday,
    }
  }
}

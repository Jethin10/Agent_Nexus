import { serve } from 'inngest/next'
import { functions, inngest } from '@ascendant/workflows'

/**
 * Inngest discovers the six functions from this path (§12.2 step 3). The SDK verifies
 * Inngest's own signing key before any function body runs, which is why Inngest is the
 * one webhook source this codebase does not hand-verify (§15.2).
 *
 * `maxDuration` is 60 because that is Vercel Hobby's ceiling (§13.3). A step that needs
 * longer than that is a step in the wrong place — the sandbox run is the only long
 * operation and it lives inside a single `step.run` that Inngest drives, not inside one
 * HTTP request.
 */
export const maxDuration = 60

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...functions],
  ...(process.env.INNGEST_SIGNING_KEY ? { signingKey: process.env.INNGEST_SIGNING_KEY } : {}),
})

/**
 * The write side of Linear: create the ticket at ACCEPT, then move it through
 * `Triage → Todo → In Progress → In Review → Done` as the pipeline advances (§8.2).
 *
 * The ticket is created when the gate says ACCEPT rather than at delivery, so the work
 * is visible while it runs instead of appearing retroactively once a PR exists.
 *
 * Two Linear-specific traps, both handled here:
 *
 *  1. **Rate limits arrive as HTTP 400 with `RATELIMITED` in the errors array**, not
 *     429. Checking the status code alone reads a throttle as a malformed query and
 *     retries immediately, which is how naive Linear clients get themselves banned.
 *  2. Linear bills **query complexity** (10,000 points per query), so every connection
 *     carries an explicit `first:` — the implicit default of 50 on a nested field is
 *     what silently blows the budget.
 */
const API = 'https://api.linear.app/graphql'

export class LinearError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    /** True when Linear throttled us, however it chose to signal that. */
    readonly rateLimited = false,
  ) {
    super(message)
    this.name = 'LinearError'
  }
}

export interface LinearWriterOptions {
  /** Personal API key or OAuth token. Quotas attach to the authenticated user. */
  token: string
  /** Team the issues are filed under, resolved once and cached by the caller. */
  teamId: string
  fetcher?: typeof fetch
}

export interface LinearIssue {
  id: string
  /** `ENG-412` — the human-facing identifier, stored as `ticket.linearIdentifier`. */
  identifier: string
  url: string
}

/** The pipeline stages, in the order §8.2 defines them. */
export type LinearStage = 'Triage' | 'Todo' | 'In Progress' | 'In Review' | 'Done'

export interface CreateIssueInput {
  title: string
  description: string
  /** Ascendant's decision id, so a Linear ticket can be traced back to its gate. */
  decisionId: string
  /** Linear's 0–4 scale: 0 none, 1 urgent, 4 low. */
  priority?: number
  labelIds?: readonly string[]
}

export interface LinearWriter {
  createIssue(input: CreateIssueInput): Promise<LinearIssue>
  moveTo(issueId: string, stage: LinearStage): Promise<void>
  comment(issueId: string, body: string): Promise<void>
  /** Workflow state ids for the team, fetched once per day rather than per call. */
  states(): Promise<Record<string, string>>
}

interface GraphQLResponse<T> {
  data?: T
  errors?: { message: string; extensions?: { code?: string; type?: string } }[]
}

/**
 * Linear signals a throttle in three different shapes depending on the endpoint and
 * the era of the API, so all three are checked rather than the one that happened to
 * show up in testing.
 */
function isRateLimited(errors: GraphQLResponse<unknown>['errors']): boolean {
  return (errors ?? []).some(
    (e) =>
      e.extensions?.code === 'RATELIMITED' ||
      e.extensions?.type === 'ratelimited' ||
      /ratelimit/i.test(e.message),
  )
}

export function linearWriter(opts: LinearWriterOptions): LinearWriter {
  const fetcher = opts.fetcher ?? fetch
  let stateCache: { at: number; states: Record<string, string> } | undefined

  const query = async <T>(document: string, variables: Record<string, unknown>): Promise<T> => {
    const res = await fetcher(API, {
      method: 'POST',
      headers: {
        authorization: opts.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: document, variables }),
    })

    // Parse before branching on status: a 400 is where the throttle hides, so the body
    // has to be read even when the HTTP layer says the request was bad.
    const body = (await res.json().catch(() => ({}))) as GraphQLResponse<T>

    if (isRateLimited(body.errors)) {
      throw new LinearError('linear rate limited', 'RATELIMITED', true)
    }
    if (!res.ok) {
      throw new LinearError(`linear HTTP ${res.status}: ${body.errors?.[0]?.message ?? ''}`.trim())
    }
    if (body.errors?.length) {
      throw new LinearError(
        `linear: ${body.errors.map((e) => e.message).join('; ')}`,
        body.errors[0]?.extensions?.code,
      )
    }
    if (!body.data) throw new LinearError('linear returned no data')
    return body.data
  }

  const writer: LinearWriter = {
    async states() {
      // One workspace-metadata fetch per day (§8.2), not one per state transition.
      const DAY = 24 * 60 * 60 * 1000
      if (stateCache && Date.now() - stateCache.at < DAY) return stateCache.states

      // Explicit `first:` — the implicit default is the complexity trap.
      const data = await query<{
        team: { states: { nodes: { id: string; name: string }[] } }
      }>(
        `query States($teamId: String!) {
           team(id: $teamId) {
             states(first: 50) { nodes { id name } }
           }
         }`,
        { teamId: opts.teamId },
      )

      const states = Object.fromEntries(data.team.states.nodes.map((s) => [s.name, s.id]))
      stateCache = { at: Date.now(), states }
      return states
    },

    async createIssue(input) {
      const data = await query<{
        issueCreate: { success: boolean; issue: LinearIssue | null }
      }>(
        `mutation Create($input: IssueCreateInput!) {
           issueCreate(input: $input) {
             success
             issue { id identifier url }
           }
         }`,
        {
          input: {
            teamId: opts.teamId,
            title: input.title.slice(0, 255),
            // The decision id goes in the body as well as any custom field, because a
            // body survives a workspace that never configured the field.
            description: `${input.description}\n\n---\nAscendant decision: \`${input.decisionId}\``,
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.labelIds?.length ? { labelIds: [...input.labelIds] } : {}),
          },
        },
      )

      if (!data.issueCreate.success || !data.issueCreate.issue) {
        throw new LinearError('linear refused to create the issue')
      }
      return data.issueCreate.issue
    },

    async moveTo(issueId, stage) {
      const states = await writer.states()
      const stateId = states[stage]
      if (!stateId) {
        // A workspace with renamed states is a configuration problem, not a bug — say
        // which names exist so it is fixable without reading this source.
        throw new LinearError(
          `linear has no workflow state named "${stage}" (found: ${Object.keys(states).join(', ')})`,
          'no_such_state',
        )
      }

      const data = await query<{ issueUpdate: { success: boolean } }>(
        `mutation Move($id: String!, $input: IssueUpdateInput!) {
           issueUpdate(id: $id, input: $input) { success }
         }`,
        { id: issueId, input: { stateId } },
      )
      if (!data.issueUpdate.success) {
        throw new LinearError(`linear refused to move ${issueId} to ${stage}`)
      }
    },

    async comment(issueId, body) {
      const data = await query<{ commentCreate: { success: boolean } }>(
        `mutation Comment($input: CommentCreateInput!) {
           commentCreate(input: $input) { success }
         }`,
        { input: { issueId, body } },
      )
      if (!data.commentCreate.success) {
        throw new LinearError(`linear refused to comment on ${issueId}`)
      }
    },
  }

  return writer
}

/** Maps a pipeline phase to the Linear stage it should land in. */
export function stageForPhase(phase: string): LinearStage | undefined {
  switch (phase) {
    case 'triaged':
      return 'Todo'
    case 'planning':
    case 'coding':
      return 'In Progress'
    case 'review':
    case 'qa':
      return 'In Review'
    case 'shipped':
      return 'Done'
    default:
      return undefined
  }
}

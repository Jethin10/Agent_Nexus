import { normalize, type RawEvent } from '@ascendant/core'
import { db, insertEvent, readPolicy } from '@ascendant/db'
import { embedEvent, repoFromEnv } from '@ascendant/workflows'

const API = 'https://api.github.com'
const MAX_PAGES = 10

interface GhUser { id: number; login: string; type?: string }
interface GhIssue {
  number: number
  title: string
  body?: string | null
  user?: GhUser | null
  created_at: string
  pull_request?: unknown
}
interface GhPull extends GhIssue { merged_at?: string | null }

async function main() {
  const repository = await repoFromEnv()
  if (!repository) throw new Error('Configure GitHub App credentials and GITHUB_OWNER/GITHUB_REPO.')
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is required for production corpus synchronization.')

  const orgId = process.env.ASCENDANT_ORG_ID ?? 'org_demo'
  const database = db()
  const policy = await readPolicy(database, orgId)
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${repository.token}`,
    'x-github-api-version': '2022-11-28',
  }

  const [issues, pulls] = await Promise.all([
    paginate<GhIssue>(
      `${API}/repos/${repository.owner}/${repository.repo}/issues?state=all&sort=updated&direction=desc&per_page=100`,
      headers,
    ).then((rows) => rows.filter((row) => !row.pull_request)),
    paginate<GhPull>(
      `${API}/repos/${repository.owner}/${repository.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      headers,
    ).then((rows) => rows.filter((row) => row.merged_at)),
  ])

  const raws: RawEvent[] = [
    ...issues.map((item) => rawFor(item, repository, 'issue')),
    ...pulls.map((item) => rawFor(item, repository, 'pr')),
  ]

  let inserted = 0
  let embedded = 0
  let failed = 0
  for (const raw of raws) {
    try {
      const normalized = normalize(raw, {
        internalActors: policy.internalActors,
        knownExternalActors: policy.knownExternalActors,
        injectionSuspected: false,
      })
      const result = await insertEvent(database, normalized)
      if (result.inserted) inserted += 1
      await embedEvent(database, result.row, { apiKey })
      embedded += 1
    } catch (err) {
      failed += 1
      process.stderr.write(`Failed ${raw.sourceRef}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  process.stdout.write(
    `GitHub corpus sync: ${issues.length} issues, ${pulls.length} merged PRs; ` +
      `${inserted} inserted, ${embedded} embedded, ${failed} failed.\n`,
  )
  if (failed > 0) process.exitCode = 1
}

function rawFor(
  item: GhIssue,
  repo: { owner: string; repo: string },
  kind: 'issue' | 'pr',
): RawEvent {
  const repository = `${repo.owner}/${repo.repo}`
  const sourceRef = `${repository}${kind === 'pr' ? '!' : '#'}${item.number}${kind === 'pr' ? ':merged' : ''}`
  return {
    orgId: process.env.ASCENDANT_ORG_ID ?? 'org_demo',
    source: 'github',
    sourceRef,
    threadKey: sourceRef,
    kind,
    actor: {
      id: String(item.user?.id ?? 0),
      handle: item.user?.login ?? 'unknown',
      isBot: item.user?.type === 'Bot' || /\[bot\]$/.test(item.user?.login ?? ''),
    },
    title: item.title,
    body: item.body ?? '',
    createdAt: new Date(item.created_at),
    attachments: [],
    raw: { corpusSync: true, item },
  }
}

async function paginate<T>(url: string, headers: Record<string, string>): Promise<T[]> {
  const rows: T[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetch(`${url}&page=${page}`, { headers })
    if (!response.ok) {
      throw new Error(`GitHub corpus request failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
    }
    const batch = (await response.json()) as T[]
    rows.push(...batch)
    if (batch.length < 100) break
  }
  return rows
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})

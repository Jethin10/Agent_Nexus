/**
 * Every query in this app filters on org_id (§15.4). Multi-tenancy is not exercised in
 * the demo, but it means "how would this work for two companies?" has a one-sentence
 * answer rather than a rewrite.
 *
 * The dashboard sits behind a shared-secret gate (`src/middleware.ts`), which is a gate
 * rather than an identity system: there is still no user model, so this resolves to a
 * single configured org rather than to whoever is signed in. Multi-tenancy would need a
 * real session before this could read the org from a request.
 */
export function currentOrgId(): string {
  return process.env.ASCENDANT_ORG_ID ?? 'org_demo'
}

/** `DEMO_MODE=replay` serves stored agent_events at their original timing (§16.3). */
export function demoMode(): 'live' | 'replay' {
  return process.env.DEMO_MODE === 'replay' ? 'replay' : 'live'
}

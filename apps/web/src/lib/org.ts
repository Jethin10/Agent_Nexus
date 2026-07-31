/**
 * Every query in this app filters on org_id (§15.4). Multi-tenancy is not exercised in
 * the demo, but it means "how would this work for two companies?" has a one-sentence
 * answer rather than a rewrite.
 *
 * There is no auth in front of the dashboard yet, so this resolves to a single
 * configured org. That is a real gap, stated plainly rather than hidden: anyone who
 * can reach the deployed URL can read the Inbox and change the autonomy thresholds in
 * the Policy view. Before this is exposed to anything but a demo, the Policy mutations
 * need a session check.
 */
export function currentOrgId(): string {
  return process.env.ASCENDANT_ORG_ID ?? 'org_demo'
}

/** `DEMO_MODE=replay` serves stored agent_events at their original timing (§16.3). */
export function demoMode(): 'live' | 'replay' {
  return process.env.DEMO_MODE === 'replay' ? 'replay' : 'live'
}

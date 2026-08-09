import { describe, expect, it } from 'vitest'
import { DEPLOY_MARKERS, isDeployment, shouldBlockBuild } from './deploy-guard.js'

/**
 * A guard that blocks the documented verification command is worse than no guard: it
 * gets worked around, and a worked-around guard protects nothing.
 *
 * The first version of this keyed off `NODE_ENV === 'production'`, which `next build`
 * sets itself — so `pnpm build` failed in a fresh clone while a real deploy was still
 * unprotected if the platform set NODE_ENV differently. Both halves are pinned here.
 */
describe('deploy guard', () => {
  it('lets a local build through with nothing configured', () => {
    // `pnpm build` and `pnpm web:build` in a fresh clone. This is the regression case.
    expect(shouldBlockBuild({})).toBe(false)
    expect(shouldBlockBuild({ NODE_ENV: 'production' })).toBe(false)
    expect(shouldBlockBuild({ NODE_ENV: 'production', npm_lifecycle_event: 'build' })).toBe(
      false,
    )
  })

  it('blocks a deploy that would publish an unauthenticated dashboard', () => {
    for (const marker of DEPLOY_MARKERS) {
      expect(shouldBlockBuild({ [marker]: '1' })).toBe(true)
    }
  })

  it('allows a deploy once the secret is set', () => {
    expect(shouldBlockBuild({ VERCEL: '1', ASCENDANT_DASHBOARD_PASSWORD: 's3cret' })).toBe(false)
  })

  it('allows an intentionally open deploy', () => {
    expect(shouldBlockBuild({ VERCEL: '1', ASCENDANT_ALLOW_OPEN_DASHBOARD: '1' })).toBe(false)
  })

  it('treats any value other than exactly "1" as not opting out', () => {
    for (const v of ['0', 'true', 'yes', '']) {
      expect(shouldBlockBuild({ VERCEL: '1', ASCENDANT_ALLOW_OPEN_DASHBOARD: v })).toBe(true)
    }
  })

  it('does not treat an empty password as configured', () => {
    expect(shouldBlockBuild({ VERCEL: '1', ASCENDANT_DASHBOARD_PASSWORD: '' })).toBe(true)
  })

  /**
   * A pull-request build has no dashboard to expose. Treating CI as a deploy would force
   * the secret into repository settings just to make the test job green, sharing it with
   * everyone who can read a workflow log.
   */
  it('does not treat CI as a deployment', () => {
    expect(isDeployment({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe(false)
    expect(shouldBlockBuild({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe(false)
  })

  it('recognises each supported hosting platform', () => {
    expect(isDeployment({})).toBe(false)
    for (const marker of DEPLOY_MARKERS) {
      expect(isDeployment({ [marker]: '1' })).toBe(true)
    }
  })
})

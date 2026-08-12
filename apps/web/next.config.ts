import type { NextConfig } from 'next'
import {
  OPEN_DASHBOARD_ERROR,
  missingDeploymentRuntimeConfig,
  shouldBlockBuild,
} from './src/lib/deploy-guard'

/**
 * Deployment guard for the dashboard password (B8), paired with `src/middleware.ts`.
 *
 * The middleware lets an unset password through so local `pnpm dev` does not sit behind
 * a prompt. That default is only safe while "unset" means localhost, so this catches the
 * case where the dashboard becomes reachable by anyone else. The predicate lives in
 * `src/lib/deploy-guard.ts` so it can be tested — see the note there on why the trigger
 * is a deployment marker rather than NODE_ENV.
 */
if (shouldBlockBuild(process.env)) {
  throw new Error(OPEN_DASHBOARD_ERROR)
}
const missingRuntime = missingDeploymentRuntimeConfig(process.env)
if (missingRuntime.length > 0) {
  throw new Error(
    `Production runtime configuration is incomplete: ${missingRuntime.join(', ')}. ` +
      'Deployments require durable Postgres plus signed Inngest publishing and execution.',
  )
}

/**
 * The workspace packages are consumed as TypeScript source, not as built JS — see
 * `main: ./src/index.ts` in each package.json. `transpilePackages` is what lets Next
 * compile them in place, which keeps the monorepo free of a build step and means a
 * change to `@ascendant/core` is picked up by `next dev` immediately.
 */
const config: NextConfig = {
  // Keep `next build` from invalidating a running demo server. Next normally writes
  // both development and production artifacts to `.next`; running the production
  // build during QA can therefore leave an open review route pointing at chunks that
  // no longer exist. A separate dev directory makes demo-day verification safe.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  transpilePackages: [
    '@ascendant/core',
    '@ascendant/db',
    '@ascendant/router',
    '@ascendant/agents',
    '@ascendant/connectors',
    '@ascendant/sandbox',
    '@ascendant/workflows',
  ],
  /**
   * Left as real Node requires rather than bundled.
   *
   * PGlite ships Postgres as a WASM binary plus gzipped extension bundles (pgvector
   * among them) and locates them relative to its own module URL. Webpack rewrites
   * those into `/_next/static/media/...` asset URLs, which the loader then cannot
   * read — the failure is `Extension bundle not found: …/vector.tar.<hash>.gz` at
   * request time, not at build time. Marking it external keeps the file layout it
   * expects. It is only loaded on the offline path (see lib/local-db.ts).
   */
  serverExternalPackages: [
    '@neondatabase/serverless',
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    'e2b',
  ],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  /**
   * `@ascendant/core` and `@ascendant/connectors` write ESM-correct relative imports
   * with a `.js` extension (`./ids.js`), while `@ascendant/db` deliberately omits them
   * — drizzle-kit loads the schema through a CJS require and cannot map `./enums.js`
   * onto `enums.ts`, so adding them there breaks migration generation (HANDOFF D1).
   *
   * TypeScript resolves both under `moduleResolution: Bundler`. Webpack does not: it
   * looks for a literal `ids.js` that never gets emitted, because these packages are
   * consumed as source via `transpilePackages`. `extensionAlias` teaches it to try the
   * TypeScript file first, which makes both conventions work rather than forcing one.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    }
    return config
  },

  /** Turbopack resolves the same aliases, for `next dev --turbo`. On 15.1 this key
   *  lives under `experimental`; it moved to top-level `turbopack` in 15.3. */
  experimental: {
    turbo: {
      resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
    },
  },
}

export default config

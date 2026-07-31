import type { NextConfig } from 'next'

/**
 * The workspace packages are consumed as TypeScript source, not as built JS — see
 * `main: ./src/index.ts` in each package.json. `transpilePackages` is what lets Next
 * compile them in place, which keeps the monorepo free of a build step and means a
 * change to `@ascendant/core` is picked up by `next dev` immediately.
 */
const config: NextConfig = {
  transpilePackages: [
    '@ascendant/core',
    '@ascendant/db',
    '@ascendant/router',
    '@ascendant/agents',
    '@ascendant/connectors',
    '@ascendant/sandbox',
    '@ascendant/workflows',
  ],
  serverExternalPackages: ['@neondatabase/serverless'],
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

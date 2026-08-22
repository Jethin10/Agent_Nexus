import { spawn } from 'node:child_process'

/**
 * One production cutover gate for humans and CI.
 *
 * The integration probe is deliberately first: it is read-only and gives a useful
 * provider-by-provider diagnosis before a potentially expensive Next.js build.
 * Child processes inherit the caller's environment without ever printing secrets.
 */
async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`))
    })
  })
}

async function main(): Promise<void> {
  await run('pnpm', ['integrations:check', '--strict'])
  await run('pnpm', ['web:build'])
  process.stdout.write('\nProduction integration probes and the Vercel build passed.\n')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})

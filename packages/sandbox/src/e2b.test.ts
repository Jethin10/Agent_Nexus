import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  write: vi.fn(),
  read: vi.fn(),
  run: vi.fn(),
  kill: vi.fn(),
  create: vi.fn(),
}))

vi.mock('e2b', () => ({
  Sandbox: { create: sdk.create },
}))

import { e2bDriver } from './e2b.js'

beforeEach(() => {
  for (const mock of Object.values(sdk)) mock.mockReset()
  sdk.create.mockResolvedValue({
    sandboxId: 'sandbox-1',
    files: { write: sdk.write, read: sdk.read },
    commands: { run: sdk.run },
    kill: sdk.kill,
  })
  sdk.run.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' })
  sdk.read.mockResolvedValue('result')
})

describe('E2B production driver', () => {
  it('uses an isolated absolute workspace and never forwards secrets', async () => {
    const driver = e2bDriver({ apiKey: 'e2b-key', templateId: 'template-1' })
    const handle = await driver.create({
      image: 'base',
      timeoutMs: 60_000,
      env: { NODE_ENV: 'test', DATABASE_URL: 'must-not-leak', API_TOKEN: 'must-not-leak' },
    })
    await driver.writeFiles(handle, { 'src/index.ts': 'export {}' })
    await driver.exec(handle, ['pnpm', 'test'])
    await expect(driver.readFile(handle, 'test.log')).resolves.toBe('result')
    await driver.destroy(handle)

    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'e2b-key',
      template: 'template-1',
      envs: { NODE_ENV: 'test' },
    }))
    expect(sdk.write).toHaveBeenCalledWith(
      '/home/user/ascendant-workspace/src/index.ts',
      'export {}',
    )
    expect(sdk.run).toHaveBeenCalledWith('pnpm test', expect.objectContaining({
      cwd: '/home/user/ascendant-workspace',
      envs: {},
    }))
    expect(sdk.read).toHaveBeenCalledWith('/home/user/ascendant-workspace/test.log')
    expect(sdk.kill).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it } from 'vitest'
import { GET } from './route.js'

describe('GET /api/health', () => {
  it('fails closed without production configuration and exposes no secret values', async () => {
    const response = await GET()
    const body = await response.json() as {
      status: string
      database: string
      integrations: Record<string, string>
    }

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.status).toBe('unavailable')
    expect(body.database).toBe('unavailable')
    expect(body.integrations.database).not.toBe('ready')
  })
})

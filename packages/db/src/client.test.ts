import { describe, expect, it } from 'vitest'
import { databaseTransport } from './client.js'

describe('database transport selection', () => {
  it('uses HTTP for Neon connection strings', () => {
    expect(databaseTransport('postgresql://user:pass@ep-small-hill-123.us-east-2.aws.neon.tech/app'))
      .toBe('neon-http')
  })

  it('uses the Postgres protocol for Render and ordinary Postgres hosts', () => {
    expect(databaseTransport('postgresql://user:pass@dpg-example-a.singapore-postgres.render.com/app'))
      .toBe('postgres')
    expect(databaseTransport('postgresql://user:pass@127.0.0.1:5432/app')).toBe('postgres')
  })
})

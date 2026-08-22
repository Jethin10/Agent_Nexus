import { describe, expect, it } from 'vitest'
import { publicOrigin, publicUrl } from './public-url.js'

describe('public OAuth URL', () => {
  it('uses the incoming origin when no proxy origin is configured', () => {
    expect(publicOrigin('http://localhost:3000/api/connect/slack', {})).toBe('http://localhost:3000')
  })

  it('uses the canonical browser origin behind Render/Vercel proxying', () => {
    const env = { ASCENDANT_PUBLIC_URL: 'https://agent.example.com/' }
    expect(publicOrigin('https://internal.onrender.com/api/connect/slack', env)).toBe('https://agent.example.com')
  })

  it('builds callback URLs on the browser-facing origin', () => {
    const env = { ASCENDANT_PUBLIC_URL: 'https://agent.example.com' }
    expect(publicUrl('https://internal.onrender.com/api/connect/google', '/api/connect/google/callback', env))
      .toBe('https://agent.example.com/api/connect/google/callback')
  })

  it('rejects insecure hosted origins and embedded credentials', () => {
    expect(() => publicOrigin('https://internal.test', { ASCENDANT_PUBLIC_URL: 'http://agent.example.com' })).toThrow('HTTPS')
    expect(() => publicOrigin('https://internal.test', { ASCENDANT_PUBLIC_URL: 'https://user:pass@agent.example.com' })).toThrow('without credentials')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { securityHeaders } from '../server/security-headers.js'

function applyHeaders(path) {
  const headers = new Map()
  const res = {
    setHeader: vi.fn((name, value) => headers.set(name, value)),
    removeHeader: vi.fn(),
  }
  const next = vi.fn()
  securityHeaders({ path }, res, next)
  return { headers, next, res }
}

describe('security headers', () => {
  it('leaves CSP to the page-level policy', () => {
    for (const path of ['/', '/api/course-items', '/ai']) {
      const { headers } = applyHeaders(path)
      expect(headers.has('Content-Security-Policy')).toBe(false)
      expect(headers.has('X-Frame-Options')).toBe(false)
    }
  })

  it('retains the remaining security headers', () => {
    const { headers, res, next } = applyHeaders('/artist/course1.html')

    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(res.removeHeader).toHaveBeenCalledWith('X-Powered-By')
    expect(next).toHaveBeenCalledOnce()
  })
})

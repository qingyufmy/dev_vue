import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { securityHeaders } from '../server/security-headers.js'

const mainHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')

function applyHeaders(path, { secure = false, forwardedProto = '' } = {}) {
  const headers = new Map()
  const res = {
    setHeader: vi.fn((name, value) => headers.set(name, value)),
    removeHeader: vi.fn(),
  }
  const next = vi.fn()
  securityHeaders({ path, secure, get:vi.fn(() => forwardedProto) }, res, next)
  return { headers, next, res }
}

describe('security headers', () => {
  it('applies CSP and same-origin framing to every response', () => {
    for (const path of ['/', '/api/course-items', '/ai']) {
      const { headers } = applyHeaders(path)
      expect(headers.get('Content-Security-Policy')).toContain("object-src 'none'")
      expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'")
      expect(headers.get('Content-Security-Policy')).not.toContain("'unsafe-eval'")
      expect(headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    }
  })

  it('retains the remaining security headers', () => {
    const { headers, res, next } = applyHeaders('/artist/course1.html')

    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('Permissions-Policy')).toContain('camera=()')
    expect(headers.has('Strict-Transport-Security')).toBe(false)
    expect(res.removeHeader).toHaveBeenCalledWith('X-Powered-By')
    expect(next).toHaveBeenCalledOnce()
  })

  it('enables HSTS only for HTTPS requests', () => {
    expect(applyHeaders('/', { forwardedProto:'https' }).headers.get('Strict-Transport-Security'))
      .toBe('max-age=31536000; includeSubDomains')
  })

  it('removes unsafe eval and bounds HTTP connection lifetimes', () => {
    expect(mainHtml).not.toContain("'unsafe-eval'")
    expect(serverSource).toContain('server.headersTimeout = 15000')
    expect(serverSource).toContain('server.requestTimeout = 120000')
    expect(serverSource).not.toContain('server.requestTimeout = 0')
  })
})

import type { AuthService } from '../../application/auth-service.js'
import type { BrowserRequestAccess } from '../../application/browser-request-access.js'

function cookieValue(header: unknown, names: readonly string[]) {
  if (typeof header !== 'string') return undefined
  const cookies = new Map<string, string>()
  for (const item of header.split(';')) {
    const index = item.indexOf('=')
    if (index <= 0) continue
    const name = item.slice(0, index).trim()
    if (!name || cookies.has(name)) continue
    try {
      cookies.set(name, decodeURIComponent(item.slice(index + 1).trim()))
    } catch {
      // A malformed cookie is treated as an absent admin session.
    }
  }
  for (const name of names) {
    const value = cookies.get(name)
    if (value) return value
  }
  return undefined
}

/**
 * Authentication boundary for the admin observer registry.  Deliberately
 * accepts only the admin-web Host-only session cookie; a trade-web cookie
 * must never grant access to configuration writes.
 */
export class AuthObserverAdminAdapter implements BrowserRequestAccess {
  constructor(private readonly service: AuthService) {}

  async authenticate(request: { headers: Record<string, unknown> }) {
    const rawSession = cookieValue(request.headers.cookie, [
      this.service.cookieName('admin-web'),
    ])
    const { user } = await this.service.resolveSession(rawSession, 'admin-web')
    return { userId: user.id, role: user.role }
  }

  async assertWrite(request: { headers: Record<string, unknown> }) {
    const rawSession = cookieValue(request.headers.cookie, [
      this.service.cookieName('admin-web'),
    ])
    const { session, user } = await this.service.resolveSession(rawSession, 'admin-web')
    this.service.assertCsrf(
      rawSession!,
      session,
      headerValue(request.headers['x-csrf-token']),
      headerValue(request.headers.origin),
    )
    return { userId: user.id, role: user.role }
  }
}

function headerValue(value: unknown) {
  if (Array.isArray(value)) return undefined
  return typeof value === 'string' ? value : value === undefined ? undefined : String(value)
}

import type { AuthService } from '../../auth/application/auth-service.js'
import type { TradeRequestAuthenticator } from '../transport/http/trading-routes.js'

function cookieValue(header: unknown, names: string[]) {
  const cookies = new Map(String(header ?? '').split(';').map((item) => {
    const index = item.indexOf('='); return index > 0 ? [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())] : ['', '']
  }))
  for (const name of names) { const value = cookies.get(name); if (value) return value }
  return undefined
}

export class AuthTradeRequestAdapter implements TradeRequestAuthenticator {
  constructor(private readonly service: AuthService) {}

  async authenticate(request: { headers: Record<string, unknown> }) {
    const rawSession = cookieValue(request.headers.cookie, [this.service.cookieName('trade-web'), 'aurum_dev_trade-web_session'])
    const { user } = await this.service.resolveSession(rawSession, 'trade-web')
    return { userId: user.id }
  }

  async assertWrite(request: { headers: Record<string, unknown> }) {
    const rawSession = cookieValue(request.headers.cookie, [this.service.cookieName('trade-web'), 'aurum_dev_trade-web_session'])
    const { session, user } = await this.service.resolveSession(rawSession, 'trade-web')
    this.service.assertCsrf(rawSession!, session, String(request.headers['x-csrf-token'] ?? ''), String(request.headers.origin ?? ''))
    return { userId: user.id }
  }
}

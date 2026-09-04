import type { Redis } from 'ioredis'
import type {
  LoginTransaction,
  LoginTransactionStore,
  RealtimeTicketClaims,
  RealtimeTicketStore,
} from '../application/auth-ports.js'

const CONSUME_SCRIPT = `
local value = redis.call('get', KEYS[1])
if value then redis.call('del', KEYS[1]) end
return value
`

export class RedisAuthTransientStore implements LoginTransactionStore, RealtimeTicketStore {
  constructor(private readonly redis: Redis) {}

  async put(transaction: LoginTransaction, ttlSeconds: number) {
    const stored = await this.redis.set(`auth:v4:login:${transaction.state}`, JSON.stringify(transaction), 'EX', ttlSeconds, 'NX')
    if (stored !== 'OK') throw new Error('auth_login_transaction_collision')
  }

  async consumeLogin(state: string): Promise<LoginTransaction | null> {
    const raw = await this.redis.eval(CONSUME_SCRIPT, 1, `auth:v4:login:${state}`)
    return typeof raw === 'string' && raw ? JSON.parse(raw) as LoginTransaction : null
  }

  async peekLogin(state: string): Promise<LoginTransaction | null> {
    const raw = await this.redis.get(`auth:v4:login:${state}`)
    return raw ? JSON.parse(raw) as LoginTransaction : null
  }

  async consumeTicket(ticketHash: string): Promise<RealtimeTicketClaims | null> {
    const raw = await this.redis.eval(CONSUME_SCRIPT, 1, `auth:v4:realtime:${ticketHash}`)
    if (typeof raw !== 'string' || !raw) return null
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      if (!Number.isSafeInteger(value.userId) || Number(value.userId) <= 0
        || !Number.isSafeInteger(value.sessionId) || Number(value.sessionId) <= 0
        || value.clientId !== 'trade-web') return null
      return { userId: Number(value.userId), sessionId: Number(value.sessionId), clientId: 'trade-web' }
    } catch { return null }
  }

  async issue(ticketHash: string, claims: RealtimeTicketClaims, ttlSeconds: number) {
    const key = `auth:v4:realtime:${ticketHash}`
    const payload = JSON.stringify(claims)
    const stored = await this.redis.set(key, payload, 'EX', ttlSeconds, 'NX')
    if (stored !== 'OK') throw new Error('auth_realtime_ticket_collision')
    await this.redis.sadd(`auth:v4:realtime:session:${claims.sessionId}`, key)
    await this.redis.expire(`auth:v4:realtime:session:${claims.sessionId}`, ttlSeconds)
    await this.redis.sadd(`auth:v4:realtime:user:${claims.userId}`, key)
    await this.redis.expire(`auth:v4:realtime:user:${claims.userId}`, ttlSeconds)
  }

  async revokeSession(sessionId: number) {
    await this.revokeSet(`auth:v4:realtime:session:${sessionId}`)
  }

  async revokeUser(userId: number) {
    await this.revokeSet(`auth:v4:realtime:user:${userId}`)
  }

  private async revokeSet(indexKey: string) {
    const keys = await this.redis.smembers(indexKey)
    if (keys.length) await this.redis.del(...keys)
    await this.redis.del(indexKey)
  }
}

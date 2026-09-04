import { hashSecret } from '../domain/auth.js'
import type { AuthRepository, RealtimeTicketClaims, RealtimeTicketStore } from './auth-ports.js'

export class RealtimeTicketAuthenticator {
  private readonly now: () => Date

  constructor(
    private readonly repository: Pick<AuthRepository, 'findActiveSessionById' | 'findUserById'>,
    private readonly tickets: Pick<RealtimeTicketStore, 'consumeTicket'>,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date())
  }

  async consume(rawTicket: string): Promise<RealtimeTicketClaims | null> {
    const claims = await this.tickets.consumeTicket(hashSecret(rawTicket))
    if (!claims) return null
    const session = await this.repository.findActiveSessionById(claims.sessionId, this.now())
    if (!session || session.clientId !== 'trade-web' || session.userId !== claims.userId) return null
    const user = await this.repository.findUserById(claims.userId)
    if (!user?.active || user.sessionVersion !== session.sessionVersion) return null
    return claims
  }
}

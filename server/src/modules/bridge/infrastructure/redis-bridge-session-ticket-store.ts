import type { Redis } from 'ioredis'
import {
  assertSessionToken,
  BridgeCredentialError,
  createSessionToken,
  hashSecret,
} from '../domain/bridge-credential.js'
import type {
  BridgeSessionTicketClaims,
  BridgeSessionTicketStore,
  IssuedBridgeSessionTicket,
} from '../application/bridge-credential-ports.js'

const SESSION_TTL_SECONDS = 30
const CONSUME_TICKET_SCRIPT = `
local value = redis.call('get', KEYS[1])
if value then redis.call('del', KEYS[1]) end
return value
`

function keyFor(token: string): string {
  return `bridge:v4:session-ticket:${hashSecret(token)}`
}

export class RedisBridgeSessionTicketStore implements BridgeSessionTicketStore {
  constructor(private readonly redis: Redis) {}

  async issue(claims: BridgeSessionTicketClaims): Promise<IssuedBridgeSessionTicket> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = createSessionToken()
      const stored = await this.redis.set(keyFor(token), JSON.stringify({
        user_id: claims.userId,
        installation_id: claims.installationId,
        profile_id: claims.profileId,
        generation: claims.generation,
      }), 'EX', SESSION_TTL_SECONDS, 'NX')
      if (stored === 'OK') return { token, expiresInSeconds: SESSION_TTL_SECONDS }
    }
    throw new BridgeCredentialError('bridge_credential_storage_failed', 503, true)
  }

  async consume(rawToken: string): Promise<BridgeSessionTicketClaims> {
    const token = assertSessionToken(rawToken)
    const raw = await this.redis.eval(CONSUME_TICKET_SCRIPT, 1, keyFor(token))
    if (typeof raw !== 'string' || !raw) {
      throw new BridgeCredentialError('bridge_session_token_expired', 401)
    }
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      if (!Number.isInteger(value.user_id) || Number(value.user_id) <= 0
        || typeof value.installation_id !== 'string' || !value.installation_id
        || typeof value.profile_id !== 'string' || !value.profile_id
        || !Number.isInteger(value.generation) || Number(value.generation) <= 0) {
        throw new Error('invalid_claims')
      }
      return {
        userId: Number(value.user_id),
        installationId: value.installation_id,
        profileId: value.profile_id,
        generation: Number(value.generation),
      }
    } catch {
      throw new BridgeCredentialError('bridge_session_token_invalid', 401)
    }
  }
}

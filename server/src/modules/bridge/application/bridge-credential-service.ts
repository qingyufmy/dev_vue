import {
  assertDeviceId,
  assertRefreshToken,
  assertSourceFingerprint,
  BridgeCredentialError,
  createMigrationKey,
  createRefreshToken,
  hashSecret,
} from '../domain/bridge-credential.js'
import type {
  BridgeCredentialRepository,
  BridgeSessionTicketIssuer,
} from './bridge-credential-ports.js'

const SESSION_TOKEN_PATH = '/api/v4/bridge/session-tokens'
const WEBSOCKET_PATH = '/bridge/v4/ws'

export interface LegacyCredentialExchangeInput {
  schemaVersion: number
  legacyRefreshToken: string
  installationId: string
  profileId: string
  sourceFingerprint: string
  userAgent?: string
  ipAddress?: string
}

export interface DeviceSessionTokenInput {
  refreshToken: string
  installationId: string
  profileId: string
  userAgent?: string
  ipAddress?: string
}

export class BridgeCredentialService {
  constructor(
    private readonly repository: BridgeCredentialRepository,
    private readonly ticketIssuer: BridgeSessionTicketIssuer,
  ) {}

  async exchangeLegacyCredential(input: LegacyCredentialExchangeInput) {
    if (input.schemaVersion !== 1) {
      throw new BridgeCredentialError('bridge_credential_request_invalid', 400)
    }
    const legacyRefreshToken = assertRefreshToken(input.legacyRefreshToken)
    const installationId = assertDeviceId(input.installationId)
    const profileId = assertDeviceId(input.profileId)
    const sourceFingerprint = assertSourceFingerprint(input.sourceFingerprint)
    const legacyTokenHash = hashSecret(legacyRefreshToken)
    const refreshToken = createRefreshToken()
    const rotated = await this.repository.rotateFromLegacy({
      legacyTokenHash,
      migrationKey: createMigrationKey({ legacyTokenHash, installationId, profileId, sourceFingerprint }),
      installationId,
      profileId,
      sourceFingerprint,
      replacementTokenHash: hashSecret(refreshToken),
      userAgent: String(input.userAgent ?? '').slice(0, 255),
      ipAddress: String(input.ipAddress ?? '').slice(0, 64),
    })

    return {
      credential_type: 'bridge_refresh' as const,
      refresh_token: refreshToken,
      generation: rotated.generation,
      session_token_path: SESSION_TOKEN_PATH,
      websocket_path: WEBSOCKET_PATH,
    }
  }

  async createSessionToken(input: DeviceSessionTokenInput) {
    const refreshToken = assertRefreshToken(input.refreshToken)
    const installationId = assertDeviceId(input.installationId)
    const profileId = assertDeviceId(input.profileId)
    const session = await this.repository.useDeviceRefresh({
      tokenHash: hashSecret(refreshToken),
      installationId,
      profileId,
      userAgent: String(input.userAgent ?? '').slice(0, 255),
      ipAddress: String(input.ipAddress ?? '').slice(0, 64),
    })
    const ticket = await this.ticketIssuer.issue({
      userId: session.userId,
      installationId: session.installationId,
      profileId: session.profileId,
      generation: session.generation,
    })
    return {
      credential_type: 'bridge_session' as const,
      access_token: ticket.token,
      expires_in_seconds: ticket.expiresInSeconds,
      websocket_path: WEBSOCKET_PATH,
    }
  }

  async revokeDeviceCredential(input: DeviceSessionTokenInput) {
    const refreshToken = assertRefreshToken(input.refreshToken)
    const installationId = assertDeviceId(input.installationId)
    const profileId = assertDeviceId(input.profileId)
    if (installationId !== input.installationId || profileId !== input.profileId) {
      throw new BridgeCredentialError('bridge_credential_request_invalid', 400)
    }
    const session = await this.repository.revokeDeviceRefresh({ tokenHash: hashSecret(refreshToken), installationId, profileId })
    return {
      credential_type: 'bridge_revocation' as const,
      installation_id: session.installationId,
      profile_id: session.profileId,
      generation: session.generation,
      revoked: true as const,
    }
  }
}

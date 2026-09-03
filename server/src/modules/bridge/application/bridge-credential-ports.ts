export interface RotateLegacyCredentialInput {
  legacyTokenHash: string
  migrationKey: string
  installationId: string
  profileId: string
  sourceFingerprint: string
  replacementTokenHash: string
  userAgent: string
  ipAddress: string
}

export interface RotatedBridgeCredential {
  userId: number
  generation: number
}

export interface UseDeviceRefreshInput {
  tokenHash: string
  installationId: string
  profileId: string
  userAgent: string
  ipAddress: string
}

export interface DeviceRefreshSession {
  userId: number
  generation: number
  installationId: string
  profileId: string
}

export interface BridgeCredentialRepository {
  rotateFromLegacy(input: RotateLegacyCredentialInput): Promise<RotatedBridgeCredential>
  useDeviceRefresh(input: UseDeviceRefreshInput): Promise<DeviceRefreshSession>
}

export interface BridgeSessionTicketClaims {
  userId: number
  installationId: string
  profileId: string
  generation: number
}

export interface IssuedBridgeSessionTicket {
  token: string
  expiresInSeconds: number
}

export interface BridgeSessionTicketIssuer {
  issue(claims: BridgeSessionTicketClaims): Promise<IssuedBridgeSessionTicket>
}

export interface BridgeSessionTicketStore extends BridgeSessionTicketIssuer {
  consume(token: string): Promise<BridgeSessionTicketClaims>
}

import { createHash, randomBytes } from 'node:crypto'

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SOURCE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/

export type BridgeCredentialErrorCode =
  | 'bridge_credential_request_invalid'
  | 'bridge_legacy_credential_invalid'
  | 'bridge_credential_binding_invalid'
  | 'bridge_credential_migration_conflict'
  | 'bridge_credential_migration_revoked'
  | 'bridge_credential_storage_failed'
  | 'bridge_session_token_invalid'
  | 'bridge_session_token_expired'

export class BridgeCredentialError extends Error {
  readonly code: BridgeCredentialErrorCode
  readonly status: number
  readonly retryable: boolean

  constructor(code: BridgeCredentialErrorCode, status: number, retryable = false) {
    super(code)
    this.name = 'BridgeCredentialError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

export function assertDeviceId(value: string): string {
  const normalized = String(value ?? '').trim()
  if (!DEVICE_ID_PATTERN.test(normalized)) {
    throw new BridgeCredentialError('bridge_credential_request_invalid', 400)
  }
  return normalized
}

export function assertSourceFingerprint(value: string): string {
  const normalized = String(value ?? '').trim()
  if (!SOURCE_FINGERPRINT_PATTERN.test(normalized)) {
    throw new BridgeCredentialError('bridge_credential_request_invalid', 400)
  }
  return normalized
}

export function assertRefreshToken(value: string): string {
  const normalized = String(value ?? '')
  if (normalized.length < 40 || normalized.length > 512 || /\s/.test(normalized)) {
    throw new BridgeCredentialError('bridge_legacy_credential_invalid', 401)
  }
  return normalized
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function createRefreshToken(): string {
  return `br4_${randomBytes(48).toString('base64url')}`
}

export function createSessionToken(): string {
  return `bst_${randomBytes(32).toString('base64url')}`
}

export function assertSessionToken(value: string): string {
  const normalized = String(value ?? '')
  if (!/^bst_[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw new BridgeCredentialError('bridge_session_token_invalid', 401)
  }
  return normalized
}

export function createMigrationKey(input: {
  legacyTokenHash: string
  installationId: string
  profileId: string
  sourceFingerprint: string
}): string {
  const value = [
    'bridge-v3-v4-credential-exchange-v1',
    input.legacyTokenHash,
    input.installationId,
    input.profileId,
    input.sourceFingerprint,
  ].join('\0')
  return hashSecret(value)
}

import { assertDeviceId, hashSecret } from '../domain/bridge-credential.js'

export class BridgePairingError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

export interface PairingReceipt { pairingId: string; profileId: string; expiresAt: string }
export interface PairingCredential { profileId: string; installationId: string; generation: number }
export interface BridgePairingRepository {
  create(userId: number, requestKey: string, codeHash: string): Promise<PairingReceipt>
  redeem(codeHash: string, installationId: string, tokenHash: string): Promise<PairingCredential>
}

export class BridgePairingService {
  constructor(private readonly repository: BridgePairingRepository) {}

  create(userId: number, requestKey: string, codeHash: string) {
    if (!Number.isSafeInteger(userId) || userId <= 0
      || !/^[A-Za-z0-9._:-]{16,128}$/.test(requestKey) || /\s/.test(requestKey)
      || codeHash.length !== 64 || !/^[a-f0-9]{64}$/.test(codeHash)) {
      throw new BridgePairingError('bridge_pairing_request_invalid', 400)
    }
    return this.repository.create(userId, requestKey, codeHash)
  }

  redeem(code: string, installationId: string, refreshToken: string) {
    if (code.length !== 47 || refreshToken.length !== 68
      || !/^bpc_[A-Za-z0-9_-]{43}$/.test(code) || !/^br4_[A-Za-z0-9_-]{64}$/.test(refreshToken)) {
      throw new BridgePairingError('bridge_pairing_request_invalid', 400)
    }
    return this.repository.redeem(hashSecret(code), assertDeviceId(installationId), hashSecret(refreshToken))
  }
}

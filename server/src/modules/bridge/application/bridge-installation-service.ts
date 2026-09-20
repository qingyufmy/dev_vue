import { hashSecret } from '../domain/bridge-credential.js'
import { BridgeInstallationError, type InstallationConfirmation, type InstallationIdentity, type InstallationProof, type InstallationStart } from '../domain/bridge-installation.js'

export interface BridgeInstallationRepository {
  start(input: InstallationStart, ipHash: string): Promise<{ authorization_id: string; confirmation_path: string; expires_at: string; poll_interval_seconds: number }>
  confirmation(id: string, userId: number): Promise<InstallationConfirmation>
  decide(id: string, userId: number, key: string, decision: 'approved' | 'denied', revision: string): Promise<InstallationConfirmation>
  poll(id: string, pollHash: string, tokenHash: string): Promise<{ status: string; poll_interval_seconds: number; installation_id?: string; user?: InstallationIdentity['user']; generation?: number; authorized?: true }>
  authenticate(installationId: string, tokenHash: string): Promise<InstallationIdentity>
  registerProfile(installationId: string, tokenHash: string, requestKey: string, refreshHash: string): Promise<{ profile_id: string; generation: number }>
  revoke(installationId: string, tokenHash: string): Promise<void>
}
export interface InstallationCapacityReader { summary(userId: number): Promise<{ included: number; purchased: number; total: number; active: number; available: number }> }

export class BridgeInstallationService {
  constructor(private readonly repository: BridgeInstallationRepository, private readonly capacity: InstallationCapacityReader) {}
  start(input: InstallationStart, ip: string) { return this.repository.start(input, hashSecret(ip)) }
  confirmation(id: string, userId: number) { return this.repository.confirmation(id, userId) }
  decide(id: string, userId: number, key: string, input: { decision: 'approved' | 'denied'; expected_revision: string; current_user_id: string }) {
    if (input.current_user_id !== String(userId)) throw new BridgeInstallationError('bridge_installation_user_changed', 409)
    return this.repository.decide(id, userId, key, input.decision, input.expected_revision)
  }
  poll(id: string, input: { poll_secret: string; installation_token: string }) {
    return this.repository.poll(id, hashSecret(input.poll_secret), hashSecret(input.installation_token))
  }
  async status(input: InstallationProof) {
    const identity = await this.repository.authenticate(input.installation_id, hashSecret(input.installation_token))
    const capacity = await this.capacity.summary(Number(identity.user.id))
    return { installation_id: identity.installation_id, user: identity.user, generation: identity.generation, authorized: true as const, capacity }
  }
  async registerProfile(input: InstallationProof & { request_key: string; refresh_token: string }) {
    const profile = await this.repository.registerProfile(input.installation_id, hashSecret(input.installation_token), input.request_key, hashSecret(input.refresh_token))
    return { credential_type: 'bridge_refresh' as const, installation_id: input.installation_id, ...profile,
      session_token_path: '/api/v4/bridge/session-tokens', websocket_path: '/bridge/v4/ws' }
  }
  async revoke(input: InstallationProof) {
    await this.repository.revoke(input.installation_id, hashSecret(input.installation_token))
    return { installation_id: input.installation_id, revoked: true as const }
  }
}

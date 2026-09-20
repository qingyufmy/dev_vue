export class BridgeInstallationError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfterSeconds?: number) { super(code) }
}
export interface InstallationStart {
  installation_id: string; device_name: string; poll_secret_hash: string; installation_token_hash: string; request_key: string
}
export interface InstallationProof { installation_id: string; installation_token: string }
export interface InstallationUser { id: string; display_name: string }
export interface InstallationIdentity { id: string; installation_id: string; user: InstallationUser; generation: number; authorized: true }
export interface InstallationConfirmation {
  authorization_id: string; installation_id: string; device_name: string; status: string; revision: string
  created_at: string; expires_at: string; current_user: InstallationUser
}

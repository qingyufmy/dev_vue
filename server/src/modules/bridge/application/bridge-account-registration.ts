/** Consumer-owned capabilities; runtime assembly supplies the trading implementation. */
export interface BridgeAccountRegistration {
  createAccount(input: {
    platform: 'mt4' | 'mt5'; brokerServer: string; login: string; currency: string; registeredAt: string
  }): Promise<{ ok: true; accountId: string } | { ok: false; reason: 'storage_unavailable' | 'storage_invalid' }>
  grantFirstOwnership(input: { userId: number; accountId: string; registeredAt: string }):
    Promise<{ ok: true } | { ok: false; reason: 'storage_unavailable' | 'storage_invalid' }>
}

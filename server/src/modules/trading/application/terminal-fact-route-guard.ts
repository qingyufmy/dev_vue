import type { TrustedBridgeProjectionRoute } from './trading-ports.js'

export interface TerminalFactRoute extends TrustedBridgeProjectionRoute {
  connectionId: string
  platform: 'mt4' | 'mt5'
  brokerServer: string
  login: string
}
export interface TerminalFactRouteGuard {
  /** Retain account, ownership, credential, binding and session locks on the caller transaction. */
  assert(route: TerminalFactRoute): Promise<void>
}

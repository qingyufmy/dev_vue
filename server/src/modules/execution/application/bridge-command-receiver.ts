import type {
  BridgeCommand, BridgeCommandAcceptedEnvelope, BridgeCommandResultEnvelope,
  BridgeCommandResultAckEnvelope, BridgeRoute,
} from '../domain/bridge-command.js'
import type { BridgeCommandScope, BridgeCommandTransport } from './bridge-command-ports.js'

/** Gateway-facing execution capability. No command creation or ordinary dispatch. */
export interface BridgeCommandReceiver {
  accepted(envelope: BridgeCommandAcceptedEnvelope, now?: Date, scope?: BridgeCommandScope): Promise<BridgeCommand>
  result(envelope: BridgeCommandResultEnvelope, now?: Date, scope?: BridgeCommandScope): Promise<{
    command: BridgeCommand
    acknowledgement: BridgeCommandResultAckEnvelope
    disposition: 'persisted' | 'duplicate' | 'conflict'
  }>
  /** Only reconcile durable candidates; reconnect must never resend command.request. */
  recover(accountId: string, route: BridgeRoute, transport: BridgeCommandTransport, now?: Date, limit?: number): Promise<BridgeCommand[]>
}

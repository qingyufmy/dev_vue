import type {
  BridgeCommand, BridgeCommandAcceptedEnvelope, BridgeCommandResultEnvelope,
  BridgeCommandRequestEnvelope,
} from '../domain/bridge-command.js'

export interface BridgeResultPersistence {
  command: BridgeCommand
  disposition: 'persisted' | 'duplicate' | 'conflict'
}

/** Every method is one short database transaction and contains no network I/O. */
export interface BridgeCommandRepository {
  create(command: BridgeCommand): Promise<BridgeCommand>
  get(commandId: string): Promise<BridgeCommand | null>
  markDispatched(commandId: string, expectedRevision: number, now: string): Promise<BridgeCommand>
  markAccepted(envelope: BridgeCommandAcceptedEnvelope, now: string): Promise<BridgeCommand>
  markPreDispatchFailed(commandId: string, expectedRevision: number, errorCode: string, now: string): Promise<BridgeCommand>
  markUncertain(commandId: string, expectedRevision: number, errorCode: string, now: string): Promise<BridgeCommand>
  persistResult(envelope: BridgeCommandResultEnvelope, resultHash: string, now: string): Promise<BridgeResultPersistence>
  beginReconciliation(commandId: string, expectedRevision: number, now: string): Promise<BridgeCommand>
}

/** A transport call is deliberately outside every repository transaction. */
export interface BridgeCommandTransport {
  currentRoute(command: BridgeCommand): Promise<import('../domain/bridge-command.js').BridgeRoute | null>
  send(message: BridgeCommandRequestEnvelope | import('../domain/bridge-command.js').BridgeCommandReconcileEnvelope): Promise<void>
}

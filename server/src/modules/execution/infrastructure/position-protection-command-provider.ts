import type { PoolConnection } from 'mysql2/promise'
import type { BridgeCommand } from '../domain/bridge-command.js'
import type { PositionProtectionCommandReview } from '../domain/position-protection-command-review.js'

/** Route capture occurs before BEGIN; every operation below uses the command repository's connection. */
export interface PositionProtectionCommandProvider {
  authorize(connection: PoolConnection, command: BridgeCommand, workflowId: string): Promise<PositionProtectionCommandReview>
  bind(connection: PoolConnection, command: BridgeCommand, authority: PositionProtectionCommandReview): Promise<void>
  replay(connection: PoolConnection, command: BridgeCommand, workflowId: string): Promise<void>
}
export type CapturePositionProtectionCommandProvider = (command: BridgeCommand) => Promise<PositionProtectionCommandProvider>

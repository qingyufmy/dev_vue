import type { EffectiveRiskPolicy } from '../../risk/index.js'
import type { BridgeCommand } from '../domain/bridge-command.js'

export interface PendingCommandReviewer {
  /** Runs on the caller's locked account transaction before dispatch state changes. */
  review(command: BridgeCommand, policy: EffectiveRiskPolicy, now: Date): Promise<void>
}

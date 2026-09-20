import type { Pool } from 'mysql2/promise'
import type { PositionProtectionReceiverScopeReader } from '../application/position-protection-receivers.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import { readPositionProtectionPreparation } from './mysql-position-protection-preparation.js'
import { bridgeCommandTransaction } from './bridge-command-transaction.js'

export function createMysqlPositionProtectionReceiverScope(pool: Pool): PositionProtectionReceiverScopeReader {
  return { read: (scope, childId) => bridgeCommandTransaction(pool, async db => {
    const saved = await readPositionProtectionPreparation(db, scope)
    if (saved.childIntentId !== childId) throw new BridgeCommandError('position_protection_receiver_scope_mismatch', 409)
    if (saved.revision === 4 && (saved.status === 'succeeded' || saved.status === 'stopped')) return 'terminal'
    if (saved.revision !== 3 || saved.status !== 'protecting') throw new BridgeCommandError('position_protection_receiver_state_invalid', 409)
    return 'active'
  }) }
}

import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { PartialCloseWorkflowScope } from '../application/partial-close-workflow-progress.js'
import { BridgeCommandError, bridgeCommandId } from '../domain/bridge-command.js'
import { bridgeCommandTransaction } from './bridge-command-transaction.js'
import { readPositionProtectionPreparation } from './mysql-position-protection-preparation.js'

const fail = (code: string): never => { throw new BridgeCommandError(`position_protection_reconcile_${code}`, 409) }

/** The account/workflow locks serialize requests with completion and concurrent recovery workers. */
export function createMysqlPositionProtectionReconciliationRequest(pool: Pool) {
  return async (input: PartialCloseWorkflowScope, childId: string, commandId: string): Promise<void> => {
    const scope = structuredClone(input)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope.workflowId)
      || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || scope.userId > 2147483647
      || !/^[1-9][0-9]{0,19}$/.test(scope.accountId) || BigInt(scope.accountId) > 18446744073709551615n
      || commandId !== bridgeCommandId(childId, 1)) fail('scope_invalid')
    await bridgeCommandTransaction(pool, async db => {
      const saved = await readPositionProtectionPreparation(db, scope)
      if (saved.childIntentId !== childId) fail('scope_mismatch')
      if (saved.revision === 4 && ['succeeded', 'stopped'].includes(saved.status)) return
      if (saved.revision !== 3 || saved.status !== 'protecting') fail('state_invalid')
      const [commands] = await db.execute<RowDataPacket[]>(`SELECT id,execution_intent_id,user_id,trading_account_id,action,status
        FROM bridge_commands_v4 WHERE id=? FOR UPDATE`, [commandId])
      const command = commands[0]
      if (commands.length !== 1 || !command || command.execution_intent_id !== childId || command.user_id !== scope.userId
        || String(command.trading_account_id) !== scope.accountId || command.action !== 'position.protection.set') return fail('command_mismatch')
      if (['succeeded', 'failed', 'rejected'].includes(command.status)) return
      if (!['dispatched', 'accepted', 'uncertain', 'reconciling'].includes(command.status)) fail('command_status_invalid')
      const [requests] = await db.execute<RowDataPacket[]>(`SELECT status,
        created_at_utc>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 5 SECOND) AS recent
        FROM outbox_events WHERE aggregate_type='bridge_command' AND aggregate_id=?
          AND event_type='bridge.command.reconcile.requested' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [commandId])
      const previous = requests[0]
      // Preserve an outstanding delivery. A completed/dead delivery can be queried again after the cooldown.
      if (previous && (['pending', 'dispatching'].includes(previous.status) || Number(previous.recent) === 1)) return
      await db.execute(`INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
        VALUES (?,'bridge_command',?,'bridge.command.reconcile.requested',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
      [randomUUID(), commandId, JSON.stringify({ command_id: commandId })])
    })
  }
}

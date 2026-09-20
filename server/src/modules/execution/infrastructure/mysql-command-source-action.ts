import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { BridgeCommandError } from '../domain/bridge-command.js'
import type { ExecutionAction } from '../domain/execution-input.js'
import { sha256Canonical } from '../domain/execution.js'

interface PayloadRow extends RowDataPacket { action_json: string | ExecutionAction; action_sha256: string }
/** The caller owns the intent/account locks and transaction. */
export async function readCommandSourceAction(connection: PoolConnection, intentId: string): Promise<ExecutionAction> {
  const [rows] = await connection.execute<PayloadRow[]>('SELECT action_json,action_sha256 FROM execution_intent_payloads WHERE execution_intent_id=? LIMIT 1', [intentId])
  const row = rows[0]
  let action: ExecutionAction | null = null
  try { action = row ? typeof row.action_json === 'string' ? JSON.parse(row.action_json) as ExecutionAction : row.action_json : null }
  catch { throw new BridgeCommandError('bridge_command_intent_payload_invalid', 409) }
  if (!action || sha256Canonical(action) !== row!.action_sha256) throw new BridgeCommandError('bridge_command_intent_payload_invalid', 409)
  return action
}

import type { Pool, RowDataPacket } from 'mysql2/promise'
import { sha256Canonical } from '../domain/execution.js'

/** Persisted under the account transaction; never reconstructed from a later quote. */
export async function unchangedUserCommandTradeState(db: Pick<Pool, 'execute'>, intentId: string, state: unknown): Promise<boolean> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT c.request_json FROM execution_intents i
    INNER JOIN user_execution_commands c ON c.id=i.user_command_id AND c.operation_id=i.operation_id
      AND c.trading_account_id=i.trading_account_id AND c.user_id=i.user_id
    WHERE i.id=? AND i.source_type='user_command' LIMIT 1`, [intentId])
  if (!rows[0]) return false
  try {
    const request = typeof rows[0].request_json === 'string' ? JSON.parse(rows[0].request_json) : rows[0].request_json
    const frozen = request.bridgeExpectedState
    return !!frozen && typeof frozen === 'object' && !Array.isArray(frozen) && sha256Canonical(frozen) === sha256Canonical(state)
  } catch { return false }
}

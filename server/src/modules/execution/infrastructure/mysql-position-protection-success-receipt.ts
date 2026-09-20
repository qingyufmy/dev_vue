import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { BridgeCommandError, canonicalHash, type BridgeCommand } from '../domain/bridge-command.js'
import type { PositionProtectionSuccessReceipt } from '../domain/position-protection-outcome.js'

/** Caller retains the command and child intent locks while reading and merging the outcome. */
export async function readPositionProtectionSuccessReceipt(db: Pick<PoolConnection, 'execute'>,
  command: BridgeCommand): Promise<PositionProtectionSuccessReceipt | null> {
  if (command.status !== 'succeeded' || command.action !== 'position.protection.set') return null
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT r.result_json,r.result_sha256,r.error_code,r.terminal_code,
    CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',r.completed_at_utc) DIV 1000 AS CHAR) completed_msc
    FROM bridge_commands_v4 c JOIN execution_intents i ON i.id=c.execution_intent_id
      AND i.user_id=c.user_id AND i.trading_account_id=c.trading_account_id
    JOIN bridge_command_results_v4 r ON r.bridge_command_id=c.id AND r.message_id=c.result_message_id
      AND r.result_sha256=c.result_sha256
    WHERE c.id=? AND c.execution_intent_id=? AND c.user_id=? AND c.trading_account_id=?
      AND c.request_sha256=? AND c.result_sha256=? AND c.result_message_id=?
      AND c.action='position.protection.set' AND c.status='succeeded' AND c.error_code IS NULL
      AND i.action_kind='modify_position' AND i.source_type='position_workflow' AND i.status='succeeded'
      AND r.action='position.protection.set' AND r.status='succeeded' AND r.conflict=0 LIMIT 2 FOR SHARE`,
  [command.id, command.executionIntentId, command.userId, command.accountId, command.requestHash, command.resultHash, command.resultMessageId])
  if (!rows.length) return null
  const row = rows[0]!, completedAt = Number(row.completed_msc)
  const invalid = () => { throw new BridgeCommandError('position_protection_receipt_invalid', 409) }
  if (rows.length !== 1 || !Number.isSafeInteger(completedAt) || completedAt < Date.parse(command.issuedAt)
    || completedAt !== Date.parse(command.completedAt ?? '') || row.error_code !== null) invalid()
  let result: unknown
  try { result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json }
  catch { return invalid() }
  const payload = { command_id: command.id, action: command.action, status: 'succeeded', completed_at_utc_msc: completedAt, result, error_code: null }
  const candidates: unknown[] = row.terminal_code === null ? [payload, { ...payload, terminal_code: null }]
    : [{ ...payload, terminal_code: row.terminal_code }]
  if (typeof row.terminal_code === 'string' && Number.isFinite(Number(row.terminal_code)) && String(Number(row.terminal_code)) === row.terminal_code) {
    candidates.push({ ...payload, terminal_code: Number(row.terminal_code) })
  }
  if (!candidates.some(candidate => canonicalHash(candidate) === row.result_sha256)) invalid()
  return { commandId: command.id, childIntentId: command.executionIntentId, requestHash: command.requestHash,
    resultHash: row.result_sha256, completedAt }
}

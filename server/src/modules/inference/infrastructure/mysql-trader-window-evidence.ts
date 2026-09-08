import type { AccountClockReader } from '../../trading/index.js'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { contentHash, InferenceError, type TraderRun } from '../domain/inference.js'
import { readTraderWindowFingerprint } from './mysql-trader-window-guard.js'
import { assertTraderPreferencesCurrent } from './mysql-trader-preferences.js'

export async function traderWindowStaleReason(clock: AccountClockReader, connection: PoolConnection, run: TraderRun): Promise<string | null> {
  const [rows] = await connection.execute<(RowDataPacket & { payload_json: string | object; payload_sha256: string })[]>(`SELECT p.payload_json,s.payload_sha256
    FROM inference_snapshots s INNER JOIN inference_snapshot_payloads p ON p.snapshot_id=s.id AND p.encoding='json'
    WHERE s.id=? AND s.purpose='trader' AND s.user_id=? AND s.trading_account_id=? FOR SHARE`,
  [run.inputSnapshotId, run.userId, run.tradingAccountId])
  const row = rows[0]
  if (rows.length !== 1 || !row) return 'trader_schedule_unproven'
  let value: unknown
  try { value = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json } catch { return 'trader_schedule_unproven' }
  if (!value || typeof value !== 'object' || Array.isArray(value) || contentHash(value) !== row.payload_sha256) return 'trader_schedule_unproven'
  const frozen = (value as Record<string, unknown>).subscriptionWindowHash
  if (typeof frozen !== 'string' || !/^[a-f0-9]{64}$/.test(frozen)) return 'trader_schedule_unproven'
  try {
    if (await readTraderWindowFingerprint(clock, connection, run, new Date()) !== frozen) return 'trader_schedule_changed'
    await assertTraderPreferencesCurrent(connection, run, (value as Record<string, unknown>).executionPreferences)
    return null
  }
  catch (error) { if (error instanceof InferenceError) return error.code; throw error }
}

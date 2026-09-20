import type { AccountInventorySummaryReader } from '../../trading/index.js'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ModelTaskRecoveryRepository } from '../application/model-task-recovery.js'

interface CandidateRow extends RowDataPacket {
  id: string
  purpose: 'analysis' | 'trader'
  trading_account_id: string | null
}

interface TaskRow extends RowDataPacket {
  id: string
  status: string
  deadline_at_utc: Date
}

interface RunRow extends RowDataPacket {
  id: string
}

export class MysqlModelTaskRecoveryRepository implements ModelTaskRecoveryRepository {
  constructor(private readonly pool: Pool, private readonly accounts: (connection: PoolConnection) => Pick<AccountInventorySummaryReader, 'lockAccount'>) {}

  async expireOverdue(now: Date, limit: number) {
    const [candidates] = await this.pool.execute<CandidateRow[]>(`SELECT id,purpose,CAST(trading_account_id AS CHAR) trading_account_id
      FROM ai_model_tasks WHERE status='running' AND deadline_at_utc<=? ORDER BY deadline_at_utc,id LIMIT ${limit}`, [now])
    let expired = 0
    for (const candidate of candidates) {
      expired += await transaction(this.pool, connection => expireOne(connection, candidate, now, this.accounts(connection)))
    }
    return expired
  }
}

async function expireOne(connection: PoolConnection, candidate: CandidateRow, now: Date, accounts: Pick<AccountInventorySummaryReader, 'lockAccount'>) {
  if (candidate.purpose === 'trader' && candidate.trading_account_id) {
    await accounts.lockAccount(candidate.trading_account_id)
  }
  const table = candidate.purpose === 'analysis' ? 'ai_analysis_runs' : 'ai_trader_runs'
  const [runs] = await connection.execute<RunRow[]>(`SELECT id FROM ${table} WHERE model_task_id=? FOR UPDATE`, [candidate.id])
  const [tasks] = await connection.execute<TaskRow[]>('SELECT id,status,deadline_at_utc FROM ai_model_tasks WHERE id=? FOR UPDATE', [candidate.id])
  const task = tasks[0]
  if (!task || task.status !== 'running' || task.deadline_at_utc.getTime() > now.getTime()) return 0
  await connection.execute(`UPDATE ai_model_attempts SET status='timed_out',error_code='model_task_deadline_exceeded',completed_at_utc=?
    WHERE task_id=? AND status='running'`, [now, candidate.id])
  await connection.execute(`UPDATE ai_model_tasks SET status='expired',lease_owner=NULL,lease_expires_at_utc=NULL,
    updated_at_utc=?,completed_at_utc=? WHERE id=? AND status='running'`, [now, now, candidate.id])
  const run = runs[0]
  if (run) {
    await connection.execute(`UPDATE ${table} SET status='failed',error_code='model_task_deadline_exceeded',revision=revision+1,
      updated_at_utc=?,completed_at_utc=? WHERE id=? AND status='running'`, [now, now, run.id])
    const aggregate = candidate.purpose === 'analysis' ? 'analysis' : 'trader'
    const eventType = candidate.purpose === 'analysis' ? 'analysis.failed' : 'trader.failed'
    const idKey = candidate.purpose === 'analysis' ? 'analysis_id' : 'trader_run_id'
    await connection.execute(`INSERT INTO outbox_events
      (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
      VALUES (?,?,?,?,?,'pending',0,?,?)`, [
      randomUUID(), aggregate, run.id, eventType,
      JSON.stringify({ [idKey]: run.id, error_code: 'model_task_deadline_exceeded' }), now, now,
    ])
  }
  return 1
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

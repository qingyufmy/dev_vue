import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { PartialCloseWorkflowRecovery } from '../application/partial-close-workflow-recovery.js'
import { bridgeCommandTransaction } from './bridge-command-transaction.js'
import { BridgeCommandError } from '../domain/bridge-command.js'

export function createMysqlPartialCloseWorkflowRecovery(pool: Pool, options: { protecting?: boolean } = {}): PartialCloseWorkflowRecovery {
  const protecting = options.protecting === true
  return { async schedule(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new BridgeCommandError('partial_close_recovery_limit_invalid',422)
    return bridgeCommandTransaction(pool,async db => {
      const [zones] = await db.query<RowDataPacket[]>('SELECT @@session.time_zone zone')
      if (!['+00:00','UTC'].includes(String(zones[0]?.zone))) throw new BridgeCommandError('partial_close_utc_required',409)
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT w.id,w.user_id,CAST(w.trading_account_id AS CHAR) account_id FROM partial_close_workflows_v4 w
        WHERE (w.status IN ('awaiting_close','risk_review_required') OR (?=1 AND w.status='protecting')) AND w.updated_at_utc<=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND
          AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.aggregate_type='partial_close_workflow' AND o.aggregate_id=w.id
            AND o.event_type IN ('execution.partial-close.requested','execution.partial-close.progressed','execution.partial-close.reviewed') AND o.status IN ('pending','dispatching'))
        ORDER BY w.status,w.updated_at_utc,w.id LIMIT ? FOR UPDATE SKIP LOCKED`, [protecting ? 1 : 0, limit])
      for (const row of rows) {
        const [event] = await db.execute<ResultSetHeader>(`INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
          VALUES (?,'partial_close_workflow',?,'execution.partial-close.requested',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
        [randomUUID(),row.id,JSON.stringify({workflow_id:row.id,user_id:row.user_id,trading_account_id:row.account_id})])
        // Recovery changes delivery timing, not the workflow revision or its immutable audit sequence.
        const [updated] = await db.execute<ResultSetHeader>('UPDATE partial_close_workflows_v4 SET updated_at_utc=UTC_TIMESTAMP(3) WHERE id=?', [row.id])
        if (event.affectedRows !== 1 || updated.affectedRows !== 1) throw new BridgeCommandError('partial_close_recovery_unconfirmed',409)
      }
      return rows.length
    })
  } }
}

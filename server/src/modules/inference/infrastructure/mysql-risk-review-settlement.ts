import { randomUUID } from 'node:crypto'
import type { Pool, ResultSetHeader } from 'mysql2/promise'

/** Only unreviewed proposals can expire; never replay or overwrite accepted execution. */
export function createMysqlRiskReviewSettlement(pool: Pool) {
  return async (decisionId: string, reason: string): Promise<void> => {
    const db = await pool.getConnection()
    try {
      await db.beginTransaction()
      const [updated] = await db.execute<ResultSetHeader>(`UPDATE trade_decisions
        SET status='stale',stale_reason=?,revision=revision+1
        WHERE id=? AND status='proposed' AND risk_decision_id IS NULL`, [reason, decisionId])
      if (updated.affectedRows === 1) {
        await db.execute(`UPDATE inference_entry_event_claims_v4
          SET state='released',active_event_id=NULL,updated_at_utc=UTC_TIMESTAMP(3)
          WHERE decision_id=? AND state='reserved' AND risk_decision_id IS NULL`, [decisionId])
        await db.execute(`INSERT INTO outbox_events
          (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
          VALUES (?,'trade_decision',?,'trade_decision.created',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
        [randomUUID(), decisionId, JSON.stringify({ decision_id: decisionId, status: 'stale', stale_reason: reason })])
      }
      await db.commit()
    } catch (error) {
      await db.rollback()
      throw error
    } finally { db.release() }
  }
}

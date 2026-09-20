import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { InstrumentCollectionRecovery } from '../application/instrument-collection-recovery.js'

export function createMysqlInstrumentCollectionRecovery(pool: Pool): InstrumentCollectionRecovery {
  return {
    async schedule(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('instrument_recovery_limit_invalid')
      const connection = await pool.getConnection()
      let committing = false
      try {
        await connection.beginTransaction()
        const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT r.id FROM instrument_collection_requests_v4 r
          WHERE (r.status='pending' OR (r.status='running' AND r.lease_expires_at_utc<=UTC_TIMESTAMP(3)))
            AND r.updated_at_utc<=UTC_TIMESTAMP(3)-INTERVAL 3 MINUTE
            AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.aggregate_type='instrument_collection'
              AND o.aggregate_id=r.id AND o.event_type='instrument.collection.requested' AND o.status IN ('pending','dispatching'))
          ORDER BY r.status,r.lease_expires_at_utc,r.id LIMIT ? FOR UPDATE SKIP LOCKED`, [limit])
        for (const row of rows) {
          await connection.execute(`INSERT INTO outbox_events
            (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
            VALUES (?,'instrument_collection',?,'instrument.collection.requested',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
          [randomUUID(), row.id, JSON.stringify({ request_id: row.id })])
          // Same transaction as the event: a failed publication cannot silently consume the recovery cooldown.
          await connection.execute('UPDATE instrument_collection_requests_v4 SET updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1 WHERE id=?', [row.id])
        }
        committing = true
        await connection.commit()
        return rows.length
      } catch (error) {
        try { await connection.rollback() } catch { /* Keep the originating failure. */ }
        if (committing) throw new Error('instrument_recovery_commit_unknown')
        throw error
      } finally { connection.release() }
    },
  }
}

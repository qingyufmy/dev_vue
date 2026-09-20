import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { InstrumentCollectionTasks } from '../application/instrument-collection-tasks.js'

interface TaskRow extends RowDataPacket {
  user_id: number; account_id: string; symbol: string; status: string; lease_token: string | null; lease_expires_at_utc: Date | null
}
export function createMysqlInstrumentCollectionTasks(pool: Pool): InstrumentCollectionTasks {
  return {
    async claim(requestId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('instrument_request_id_invalid')
      const connection = await pool.getConnection(), token = randomUUID()
      let committing = false
      try {
        await connection.beginTransaction()
        // Durable attempt limit also covers worker crashes; active leases are never cancelled here.
        await connection.execute(`UPDATE instrument_collection_requests_v4
          SET status='failed',lease_token=NULL,lease_expires_at_utc=NULL,error_code='instrument_collection_attempts_exhausted',
            completed_at_utc=UTC_TIMESTAMP(3),updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
          WHERE id=? AND attempts>=5 AND (status='pending' OR (status='running' AND lease_expires_at_utc<=UTC_TIMESTAMP(3)))`, [requestId])
        await connection.execute(`UPDATE instrument_collection_requests_v4
          SET status='running',lease_token=?,lease_expires_at_utc=UTC_TIMESTAMP(3)+INTERVAL 90 SECOND,
            attempts=attempts+1,error_code=NULL,updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
          WHERE id=? AND (status='pending' OR (status='running' AND lease_expires_at_utc<=UTC_TIMESTAMP(3)))`, [token, requestId])
        const [rows] = await connection.execute<TaskRow[]>(`SELECT user_id,CAST(trading_account_id AS CHAR) account_id,symbol,status,lease_token,lease_expires_at_utc
          FROM instrument_collection_requests_v4 WHERE id=? FOR UPDATE`, [requestId])
        const row = rows[0]
        if (!row) throw new Error('instrument_request_not_found')
        const result = row.lease_token === token && row.status === 'running'
          ? { state: 'claimed' as const, claim: { requestId, userId: Number(row.user_id), accountId: row.account_id, symbol: row.symbol, leaseToken: token } }
          : row.status === 'succeeded' || row.status === 'failed' ? { state: 'terminal' as const }
            : row.status === 'running' && row.lease_expires_at_utc ? { state: 'busy' as const, retryAt: new Date(row.lease_expires_at_utc).toISOString() }
              : null
        if (!result) throw new Error('instrument_request_state_invalid')
        committing = true
        await connection.commit()
        return result
      } catch (error) {
        try { await connection.rollback() } catch { /* Preserve original failure. */ }
        if (committing) throw new Error('instrument_request_claim_unknown')
        throw error
      } finally { connection.release() }
    },
    async complete(claim, resultRevision) {
      if (!Number.isSafeInteger(resultRevision) || resultRevision < 1) throw new Error('instrument_result_revision_invalid')
      const [result] = await pool.execute<ResultSetHeader>(`UPDATE instrument_collection_requests_v4
        SET status='succeeded',result_revision=?,completed_at_utc=UTC_TIMESTAMP(3),updated_at_utc=UTC_TIMESTAMP(3),
          lease_token=NULL,lease_expires_at_utc=NULL,error_code=NULL,revision=revision+1
        WHERE id=? AND user_id=? AND trading_account_id=? AND BINARY symbol=BINARY ?
          AND status='running' AND lease_token=? AND lease_expires_at_utc>UTC_TIMESTAMP(3)`,
      [resultRevision, claim.requestId, claim.userId, claim.accountId, claim.symbol, claim.leaseToken])
      return result.affectedRows === 1
    },
    async release(claim, errorCode) {
      if (!/^[a-z][a-z0-9_]{2,127}$/.test(errorCode)) throw new Error('instrument_request_error_invalid')
      const [result] = await pool.execute<ResultSetHeader>(`UPDATE instrument_collection_requests_v4
        SET status='pending',lease_token=NULL,lease_expires_at_utc=NULL,error_code=?,updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
        WHERE id=? AND user_id=? AND trading_account_id=? AND BINARY symbol=BINARY ?
          AND status='running' AND lease_token=? AND lease_expires_at_utc>UTC_TIMESTAMP(3)`,
      [errorCode, claim.requestId, claim.userId, claim.accountId, claim.symbol, claim.leaseToken])
      return result.affectedRows === 1
    },
  }
}

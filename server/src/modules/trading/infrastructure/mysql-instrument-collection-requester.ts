import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { InstrumentCollectionRequester } from '../application/instrument-collection-requester.js'
import { TradingAccessError } from '../domain/trading.js'

export function createMysqlInstrumentCollectionRequester(pool: Pool): InstrumentCollectionRequester {
  return {
    async request(input) {
      const scope = { ...input }
      if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || !/^[1-9]\d{0,19}$/.test(scope.accountId)
        || BigInt(scope.accountId) > 18_446_744_073_709_551_615n
        || typeof scope.symbol !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(scope.symbol)
        || scope.symbol.trim() !== scope.symbol) throw new Error('instrument_request_invalid')
      const connection = await pool.getConnection()
      let committing = false
      try {
        await connection.beginTransaction()
        const [accounts] = await connection.execute<RowDataPacket[]>('SELECT id FROM trading_accounts WHERE id=? AND deleted_at_utc IS NULL FOR UPDATE', [scope.accountId])
        if (accounts.length !== 1) throw new TradingAccessError('trading_account_forbidden', 403)
        const [owners] = await connection.execute<RowDataPacket[]>(`SELECT o.user_id FROM trading_account_ownerships o
          INNER JOIN trading_accounts a ON a.id=o.trading_account_id AND a.ownership_revision=o.revision
          INNER JOIN users u ON u.id=o.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
          WHERE o.user_id=? AND o.trading_account_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL FOR UPDATE`, [scope.userId, scope.accountId])
        if (owners.length !== 1) throw new TradingAccessError('trading_account_forbidden', 403)
        const [[clock]] = await connection.execute<(RowDataPacket & { bucket: string; now: Date })[]>(
          'SELECT CAST(FLOOR(UNIX_TIMESTAMP(UTC_TIMESTAMP(3))/60) AS CHAR) bucket,UTC_TIMESTAMP(3) now')
        if (!clock) throw new Error('instrument_request_clock_unavailable')
        const [existing] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM instrument_collection_requests_v4
          WHERE user_id=? AND trading_account_id=? AND symbol=?
            AND (status IN ('pending','running') OR request_bucket=?)
          ORDER BY requested_at_utc DESC,id DESC LIMIT 1 FOR UPDATE`, [scope.userId, scope.accountId, scope.symbol, clock.bucket])
        const requestId = existing[0]?.id ?? randomUUID()
        if (existing.length === 0) {
          await connection.execute(`INSERT INTO instrument_collection_requests_v4
            (id,user_id,trading_account_id,symbol,request_bucket,status,requested_at_utc,updated_at_utc,revision)
            VALUES (?,?,?,?,?,'pending',?,?,1)`, [requestId, scope.userId, scope.accountId, scope.symbol, clock.bucket, clock.now, clock.now])
          await connection.execute(`INSERT INTO outbox_events
            (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
            VALUES (?,?,?,'instrument.collection.requested',?,'pending',0,?,?)`,
          [randomUUID(), 'instrument_collection', requestId, JSON.stringify({ request_id: requestId }), clock.now, clock.now])
        }
        committing = true
        await connection.commit()
        return { requestId, created: existing.length === 0 }
      } catch (error) {
        try { await connection.rollback() } catch { /* Keep the original write/commit failure. */ }
        if (committing) throw new Error('instrument_request_commit_unknown')
        throw error
      } finally { connection.release() }
    },
  }
}

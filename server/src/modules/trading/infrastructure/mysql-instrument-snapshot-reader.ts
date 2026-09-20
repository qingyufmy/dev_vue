import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { InstrumentSnapshot, InstrumentSnapshotReader, InstrumentRevisionReader } from '../application/instrument-snapshot-reader.js'

interface InstrumentRow extends RowDataPacket { payload_json: string | object; revision: number }
export function createMysqlInstrumentSnapshotReader(executor: Pick<Pool, 'execute'>): InstrumentSnapshotReader & InstrumentRevisionReader {
  return {
    async readRevision(accountId, symbol) {
      const [rows] = await executor.execute<InstrumentRow[]>(
        'SELECT revision FROM market_instrument_snapshots WHERE trading_account_id=? AND symbol=? LIMIT 1', [accountId, symbol])
      const revision = Number(rows[0]?.revision ?? 0)
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('instrument_snapshot_invalid')
      return revision
    },
    async read(accountId, symbol) {
      const [rows] = await executor.execute<InstrumentRow[]>(
        `SELECT i.payload_json,i.revision FROM market_instrument_snapshots i
        INNER JOIN trading_accounts a ON a.id=i.trading_account_id AND a.deleted_at_utc IS NULL
        INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.role='owner' AND o.revoked_at_utc IS NULL
          AND o.revision=a.ownership_revision
          AND CAST(o.user_id AS CHAR)=JSON_UNQUOTE(JSON_EXTRACT(i.payload_json,'$.sourceEvidence.userId'))
          AND CAST(a.ownership_revision AS CHAR)=JSON_UNQUOTE(JSON_EXTRACT(i.payload_json,'$.sourceEvidence.ownershipRevision'))
        INNER JOIN users u ON u.id=o.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
        INNER JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.unbound_at_utc IS NULL
          AND BINARY b.terminal_instance_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(i.payload_json,'$.sourceEvidence.terminalInstanceId'))
          AND BINARY b.terminal_profile_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(i.payload_json,'$.sourceEvidence.terminalProfileId'))
        INNER JOIN terminal_profiles p ON p.id=b.terminal_profile_id AND p.user_id=o.user_id AND p.deleted_at_utc IS NULL
        INNER JOIN bridge_connection_sessions s ON s.trading_account_id=a.id AND s.user_id=o.user_id
          AND s.terminal_profile_id=b.terminal_profile_id AND s.terminal_instance_id=b.terminal_instance_id
          AND CAST(s.connection_epoch_v4 AS CHAR)=JSON_UNQUOTE(JSON_EXTRACT(i.payload_json,'$.sourceEvidence.connectionEpoch'))
          AND s.disconnected_at_utc IS NULL AND s.last_seen_at_utc>=UTC_TIMESTAMP(3)-INTERVAL 45 SECOND
        CROSS JOIN (SELECT ? standard_symbol) requested
        WHERE i.trading_account_id=? AND LEFT(UPPER(i.symbol),CHAR_LENGTH(requested.standard_symbol))=UPPER(requested.standard_symbol)
          AND i.observed_at_utc>=UTC_TIMESTAMP(3)-INTERVAL 300 SECOND AND i.observed_at_utc<=UTC_TIMESTAMP(3)
        LIMIT 2`,
        [symbol, accountId],
      )
      if (rows.length > 1) throw new Error('instrument_snapshot_source_ambiguous')
      const row = rows[0]
      if (!row) return null
      const data = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
      const revision = Number(row.revision)
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isSafeInteger(revision) || revision < 1) {
        throw new Error('instrument_snapshot_invalid')
      }
      return { revision, data: data as InstrumentSnapshot['data'] }
    },
  }
}

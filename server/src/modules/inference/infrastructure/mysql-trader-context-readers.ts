import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { InstrumentSnapshotReader, RiskSummaryReader, VersionedTraderContext } from '../application/trader-context-builder.js'
import type { JsonObject } from '../domain/inference.js'

interface ProjectionRow extends RowDataPacket { payload_json: string | object; revision: number }

export class MysqlInstrumentSnapshotReader implements InstrumentSnapshotReader {
  constructor(private readonly pool: Pool) {}

  async read(accountId: string, symbol: string): Promise<VersionedTraderContext | null> {
    const [rows] = await this.pool.execute<ProjectionRow[]>(
      'SELECT payload_json,revision FROM market_instrument_snapshots WHERE trading_account_id=? AND symbol=? LIMIT 1',
      [accountId, symbol],
    )
    return projection(rows[0])
  }
}

export class MysqlRiskSummaryReader implements RiskSummaryReader {
  constructor(private readonly pool: Pool) {}

  async read(userId: number, accountId: string): Promise<VersionedTraderContext | null> {
    const [rows] = await this.pool.execute<ProjectionRow[]>(
      `SELECT s.payload_json,s.revision FROM account_risk_summaries s
       INNER JOIN trading_account_ownerships o ON o.trading_account_id=s.trading_account_id
         AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL
       WHERE s.trading_account_id=? LIMIT 1`,
      [userId, accountId],
    )
    return projection(rows[0])
  }
}

function projection(row: ProjectionRow | undefined): VersionedTraderContext | null {
  if (!row) return null
  const data = (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) as JsonObject
  return { revision: Number(row.revision), data }
}

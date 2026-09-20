import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AccountRiskSummaryReader } from '../application/account-risk-summary-reader.js'
import type { RiskJsonObject } from '../domain/risk-action.js'

interface SummaryRow extends RowDataPacket { payload_json: string | RiskJsonObject; revision: number }
interface RevisionRow extends RowDataPacket { revision: number }
export function createAccountRiskSummaryReader(connection: Pick<PoolConnection, 'execute'>): AccountRiskSummaryReader {
  return {
    async read(userId, accountId) {
      const [rows] = await connection.execute<SummaryRow[]>(`SELECT s.payload_json,s.revision FROM account_risk_summaries s
        INNER JOIN trading_account_ownerships o ON o.trading_account_id=s.trading_account_id
          AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL
        WHERE s.trading_account_id=?`, [userId, accountId])
      if (rows.length !== 1) return null
      const row = rows[0]!
      return { revision: Number(row.revision), data: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) as RiskJsonObject : row.payload_json }
    },
    async readRevision(userId, accountId) {
      const [rows] = await connection.execute<RevisionRow[]>(`SELECT s.revision FROM account_risk_summaries s
        INNER JOIN trading_account_ownerships o ON o.trading_account_id=s.trading_account_id
          AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL
        WHERE s.trading_account_id=? FOR SHARE`, [userId, accountId])
      return rows.length === 1 ? Number(rows[0]!.revision) : null
    },
  }
}

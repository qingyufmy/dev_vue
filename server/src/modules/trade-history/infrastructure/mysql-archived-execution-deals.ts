import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ArchivedExecutionDeal, ArchivedExecutionDealStore } from '../application/archived-execution-deals.js'

type Row = RowDataPacket & Omit<ArchivedExecutionDeal,'occurred_at_utc'> & { occurred_at_utc: string | Date | null }
function utc(value: string | Date | null) {
  if (value===null) return null
  return value instanceof Date ? value.toISOString() : new Date(value.includes('T') ? value : value.replace(' ','T')+'Z').toISOString()
}
export class MysqlArchivedExecutionDeals implements ArchivedExecutionDealStore {
  constructor(private readonly pool: Pool) {}
  async list(scope: Parameters<ArchivedExecutionDealStore['list']>[0]) {
    const [rows]=await this.pool.execute<Row[]>(`SELECT CAST(d.id AS CHAR) legacy_id,CAST(d.outcome_id AS CHAR) legacy_outcome_id,
      d.deal_ticket,d.position_id,d.order_ticket,d.entry_type,CAST(d.volume AS CHAR) volume,CAST(d.price AS CHAR) price,
      CAST(d.profit AS CHAR) profit,CAST(d.commission AS CHAR) commission,CAST(d.swap AS CHAR) swap,CAST(d.fee AS CHAR) fee,d.deal_time occurred_at_utc
      FROM signal_outcome_deals d INNER JOIN signal_outcomes o ON o.id=d.outcome_id
      WHERE o.order_intent_id=? AND o.user_id=? AND o.trading_account_id=? AND d.user_id=o.user_id AND d.trading_account_id=o.trading_account_id
      ${scope.beforeId ? 'AND d.id<?' : ''} ORDER BY d.id DESC LIMIT ?`,
    [scope.legacyIntentId,scope.userId,scope.legacyAccountId,...(scope.beforeId ? [scope.beforeId] : []),String(scope.limit+1)])
    const items=rows.slice(0,scope.limit).map(row=>({...row,occurred_at_utc:utc(row.occurred_at_utc)}))
    return {items,next_cursor:rows.length>scope.limit ? items.at(-1)!.legacy_id : null}
  }
}

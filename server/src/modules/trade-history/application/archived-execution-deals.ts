import type { ArchivedExecutionReader } from '../../execution/index.js'
import { TradeHistoryError } from '../domain/trade-history.js'

export interface ArchivedExecutionDeal {
  legacy_id: string
  legacy_outcome_id: string
  deal_ticket: string
  position_id: string | null
  order_ticket: string | null
  entry_type: number | null
  volume: string
  price: string | null
  profit: string
  commission: string
  swap: string
  fee: string
  occurred_at_utc: string | null
}
export interface ArchivedDealPage { items: ArchivedExecutionDeal[]; next_cursor: string | null }
export interface ArchivedExecutionDealStore {
  list(scope: { userId: number; legacyAccountId: string; legacyIntentId: string; limit: number; beforeId?: string }): Promise<ArchivedDealPage>
}
export class ArchivedExecutionDeals {
  constructor(private readonly executions: Pick<ArchivedExecutionReader,'get'>, private readonly deals: ArchivedExecutionDealStore) {}
  async list(userId: number, intentId: string, input: { limit: number; beforeId?: string }): Promise<ArchivedDealPage> {
    if (!Number.isSafeInteger(userId) || userId<=0) throw new TradeHistoryError('archive_not_found',404)
    const validId=(id:string)=>/^[1-9][0-9]{0,18}$/.test(id) && BigInt(id)<=9223372036854775807n
    if (!validId(intentId) || (input.beforeId!==undefined && !validId(input.beforeId)) || !Number.isSafeInteger(input.limit) || input.limit<1 || input.limit>100) throw new TradeHistoryError('archive_query_invalid',400)
    const execution=await this.executions.get(userId,intentId)
    if (!execution) throw new TradeHistoryError('archive_not_found',404)
    if (execution.legacy_account_id===null) return {items:[],next_cursor:null}
    return this.deals.list({userId,legacyAccountId:execution.legacy_account_id,legacyIntentId:intentId,...input})
  }
}

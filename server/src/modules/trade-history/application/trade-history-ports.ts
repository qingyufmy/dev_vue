import type { TradeHistoryDailyPoint, TradeHistoryFilter, TradeHistoryFreshness, TradeHistorySummary, TradeRecordDetail, TradeRecordSummary } from '../domain/trade-history.js'

export interface TradeHistoryRepositoryPage {
  items: TradeRecordSummary[]
  hasMore: boolean
  freshness: TradeHistoryFreshness
  summary: TradeHistorySummary
  daily: TradeHistoryDailyPoint[]
}

export interface TradeHistoryRepository {
  ownsAccount(userId: number, accountId: string): Promise<boolean>
  list(userId: number, filter: TradeHistoryFilter): Promise<TradeHistoryRepositoryPage>
  find(userId: number, recordId: string): Promise<TradeRecordDetail | null>
}

import type { TradeMoneyCurrency } from './trade-money-currency.js'

export type TradeHistorySide = 'buy' | 'sell'
export type TradeHistorySource = 'system' | 'manual' | 'other_ea' | 'mixed' | 'unknown'
export type TradeHistoryStatus = 'open' | 'closed' | 'partial' | 'unknown'
export type TradeEvidenceStatus = 'complete' | 'partial' | 'conflicted'
export type TradeAttributionStatus = 'exact' | 'partial' | 'conflicted' | 'unresolved'
export type TradeOutcomeFilter = 'profit' | 'loss' | 'breakeven'

export interface TradeHistoryFilter {
  accountId: string
  symbol?: string
  side?: TradeHistorySide
  source?: TradeHistorySource
  outcome?: TradeOutcomeFilter
  fromBusinessDate?: string
  toBusinessDate?: string
  query?: string
  limit: number
  capturedEnd: string
  cursor: TradeHistoryCursor | null
}

export interface TradeHistoryCursor {
  version: 1
  accountId: string
  filterKey: string
  capturedEnd: string
  closedAt: string
  id: string
}

export interface TradeRecordSummary extends TradeMoneyCurrency {
  id: string
  accountId: string
  platform: 'mt4' | 'mt5'
  primaryTicket: string
  positionId: string | null
  symbol: string
  side: TradeHistorySide
  status: TradeHistoryStatus
  source: TradeHistorySource
  attributionStatus: TradeAttributionStatus
  evidenceStatus: TradeEvidenceStatus
  volume: string
  entryPrice: string
  exitPrice: string | null
  stopLoss: string | null
  takeProfit: string | null
  grossProfit: string
  commission: string
  swap: string
  fee: string
  netProfit: string
  openedAt: string
  closedAt: string | null
  terminalTimezoneOffsetMinutes: number
  revision: number
}

export interface TradeRecordDeal extends TradeMoneyCurrency {
  id: string
  dealTicket: string
  orderTicket: string | null
  role: 'entry' | 'exit' | 'fee' | 'adjustment' | 'unknown'
  side: 'buy' | 'sell' | 'none' | 'unknown'
  entryKind: 'in' | 'out' | 'inout' | 'out_by' | 'none' | 'unknown'
  volume: string | null
  price: string | null
  grossProfit: string
  commission: string
  swap: string
  fee: string
  occurredAt: string
}

export interface TradeRecordAttribution {
  kind: 'market_analysis' | 'trade_decision' | 'risk_decision' | 'execution_intent' | 'execution_outcome' | 'bridge_command' | 'review_case'
  sourceId: string
  relation: 'opened' | 'modified' | 'closed' | 'cancelled' | 'reviewed' | 'related'
  proofKind: 'terminal_ticket' | 'terminal_order' | 'terminal_deal' | 'distribution_target' | 'legacy_mapping'
}

export interface TradeRecordDetail extends TradeRecordSummary {
  evidenceHash: string
  deals: TradeRecordDeal[]
  attributions: TradeRecordAttribution[]
}

export interface TradeHistorySummary {
  accountCurrency: string | null
  moneyStatus: 'comparable' | 'unknown' | 'mixed' | 'empty'
  tradeCount: number
  winningCount: number
  losingCount: number
  breakevenCount: number
  winRatePercent: string | null
  grossProfit: string | null
  commission: string | null
  swap: string | null
  fee: string | null
  netProfit: string | null
  profitFactor: string | null
}

export interface TradeHistoryDailyPoint {
  businessDate: string
  tradeCount: number
  netProfit: string | null
  cumulativeNetProfit: string | null
}

export interface TradeHistoryFreshness {
  status: 'empty' | 'syncing' | 'ready' | 'stale' | 'failed'
  historyRevision: number
  freshThrough: string | null
  lastSuccessAt: string | null
}

export interface TradeHistoryPage {
  capturedEnd: string
  freshness: TradeHistoryFreshness
  items: TradeRecordSummary[]
  nextCursor: string | null
  hasMore: boolean
  summary: TradeHistorySummary
  daily: TradeHistoryDailyPoint[]
}

export class TradeHistoryError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'TradeHistoryError'
  }
}

export function encodeTradeHistoryCursor(value: TradeHistoryCursor) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeTradeHistoryCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TradeHistoryCursor>
    if (parsed.version !== 1 || !text(parsed.accountId) || !text(parsed.filterKey) || !utc(parsed.capturedEnd)
      || !utc(parsed.closedAt) || !text(parsed.id)) throw new Error('invalid')
    return parsed as TradeHistoryCursor
  } catch {
    throw new TradeHistoryError('trade_history_cursor_invalid', 400)
  }
}

function text(value: unknown) { return typeof value === 'string' && value.length > 0 && value.length <= 512 }
function utc(value: unknown) { return text(value) && Number.isFinite(Date.parse(value as string)) }

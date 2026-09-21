export type TraderEntryCommandType = 'market_order' | 'pending_order'
export type TraderEntrySide = 'buy' | 'sell'
export type TraderPendingOrderType = 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop' | 'buy_stop_limit' | 'sell_stop_limit'

export interface TraderEntryCommandDraft {
  command_type: TraderEntryCommandType
  side?: TraderEntrySide
  order_type?: TraderPendingOrderType
  symbol: string
  volume: string
  stop_loss?: string
  reference_price: string
  price?: string
  stop_limit_price?: string
  take_profit?: string
  expiration_utc_msc?: number
  strategy_id?: string
}

export interface TraderResourceEditDraft {
  price?: string
  stop_limit_price?: string
  stop_loss?: string
  remove_stop_loss?: true
  take_profit?: string
  remove_take_profit?: true
  expiration_utc_msc?: number
  remove_expiration?: true
}

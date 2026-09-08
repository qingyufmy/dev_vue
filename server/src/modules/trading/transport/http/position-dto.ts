import type { OpenPosition } from '../../domain/trading.js'

export const positionDto = (value: OpenPosition) => ({ ticket: value.ticket, account_id: value.accountId, symbol: value.symbol, side: value.side, volume: value.volume, open_price: value.openPrice, current_price: value.currentPrice, stop_loss: value.stopLoss, take_profit: value.takeProfit, floating_profit: value.floatingProfit, opened_at: value.openedAt, source: value.source, signal_id: value.signalId, revision: String(value.revision) })

import type { TradingReadRepository } from '../../trading/index.js'

/** Analysis chooses an owned source and reads its market data. */
export type AnalysisTradingReader = Pick<TradingReadRepository,
  'findOwnedAccount' | 'listAccounts' | 'getQuote' | 'listCandles' | 'getAccountSnapshot'>

/** Trader snapshots require account facts and revisions, never context writes. */
export type TraderAccountReader = Pick<TradingReadRepository,
  'findOwnedAccount' | 'getAccountSnapshot' | 'listPositions' | 'listPendingOrders' | 'getQuote' | 'listCandles' | 'latestRevision'>

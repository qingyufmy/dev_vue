import type { AnalysisMarketSource, MacroSnapshotReader } from './application/analysis-context-builder.js'
import type { AnalysisTradingReader } from './application/trading-read-capabilities.js'
import { TradingAnalysisMarketSource } from './infrastructure/trading-analysis-market-source.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { AccountClockReader } from '../trading/index.js'
import type { SubscriptionPreferencesReader } from '../strategies/index.js'
import type { InferenceRepository } from './application/inference-ports.js'
import type { TraderAccountReader } from './application/trading-read-capabilities.js'
import type { TraderWindowGuard } from './application/trader-window-guard.js'
import { TraderContextBuilder } from './application/trader-context-builder.js'
import { MysqlInstrumentSnapshotReader, MysqlRiskSummaryReader } from './infrastructure/mysql-trader-context-readers.js'
import { MysqlTraderPreferencesReader } from './infrastructure/mysql-trader-preferences.js'
import { MysqlTraderWindowGuard } from './infrastructure/mysql-trader-window-guard.js'
import type { SubscriptionWindowClock } from '../strategies/index.js'
import type { AnalysisWindowGuard } from './application/analysis-window-guard.js'
import { MysqlAnalysisWindowGuard } from './infrastructure/mysql-analysis-window-guard.js'
import { MysqlMacroSnapshotReader } from './infrastructure/mysql-macro-snapshot-reader.js'

export function createMysqlAnalysisWindowGuard(pool: Pool,
  readClock: (accountId: string, userId: number) => Promise<SubscriptionWindowClock | null>): AnalysisWindowGuard {
  return new MysqlAnalysisWindowGuard(pool, readClock)
}

export function createMysqlMacroSnapshotReader(pool: Pool): MacroSnapshotReader {
  return new MysqlMacroSnapshotReader(pool)
}

export function createMysqlTraderContext(pool: Pool, inference: Pick<InferenceRepository, 'getAnalysisDetail'>,
  trading: TraderAccountReader, preferences: (connection: PoolConnection) => SubscriptionPreferencesReader): TraderContextBuilder {
  return new TraderContextBuilder(inference, trading, new MysqlInstrumentSnapshotReader(pool),
    new MysqlRiskSummaryReader(pool), new MysqlTraderPreferencesReader(pool, preferences))
}

export function createMysqlTraderWindowGuard(pool: Pool, clock: (connection: PoolConnection) => AccountClockReader): TraderWindowGuard {
  return new MysqlTraderWindowGuard(pool, clock)
}

export function createAnalysisMarketSource(trading: AnalysisTradingReader): AnalysisMarketSource {
  return new TradingAnalysisMarketSource(trading)
}

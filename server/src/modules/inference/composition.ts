import type { AnalysisMarketSource } from './application/analysis-context-builder.js'
import type { AnalysisTradingReader } from './application/trading-read-capabilities.js'
import { TradingAnalysisMarketSource } from './infrastructure/trading-analysis-market-source.js'

export function createAnalysisMarketSource(trading: AnalysisTradingReader): AnalysisMarketSource {
  return new TradingAnalysisMarketSource(trading)
}

import type { StrategyVersion } from '../../strategies/domain/strategy.js'
import type { AnalysisInputSnapshot, AnalysisRun, JsonObject } from '../domain/inference.js'

export interface AnalysisMarketPlan {
  timeframes: Array<'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1'>
  candleLimit: number
}

export interface AnalysisMarketSource {
  read(input: { userId: number; preferredAccountId: string | null; symbol: string; plan: AnalysisMarketPlan }): Promise<JsonObject>
}

export interface MacroSnapshotReader {
  latest(userId: number, now: string): Promise<JsonObject | null>
}

const allowedTimeframes = new Set<AnalysisMarketPlan['timeframes'][number]>(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])

export function marketPlan(config: Record<string, unknown>): AnalysisMarketPlan {
  const requested = Array.isArray(config.timeframes) ? config.timeframes.filter((value): value is AnalysisMarketPlan['timeframes'][number] => typeof value === 'string' && allowedTimeframes.has(value as AnalysisMarketPlan['timeframes'][number])) : []
  const candleLimit = Number(config.candle_limit)
  return {
    timeframes: requested.length > 0 ? [...new Set(requested)] : ['M5', 'M15', 'H1', 'H4'],
    candleLimit: Number.isSafeInteger(candleLimit) && candleLimit >= 50 && candleLimit <= 1000 ? candleLimit : 300,
  }
}

export class AnalysisContextBuilder {
  constructor(private readonly market: AnalysisMarketSource, private readonly macro: MacroSnapshotReader) {}

  async build(run: AnalysisRun, strategy: StrategyVersion, now = new Date()): Promise<AnalysisInputSnapshot> {
    const capturedAt = now.toISOString()
    return {
      kind: 'analysis',
      strategy: { id: strategy.strategyId, versionId: strategy.id, promptHash: strategy.promptHash, promptText: strategy.promptText },
      market: await this.market.read({ userId: run.userId, preferredAccountId: run.marketSourceAccountId, symbol: run.symbol, plan: marketPlan(strategy.config) }),
      macro: await this.macro.latest(run.userId, capturedAt),
      capturedAt,
    }
  }
}

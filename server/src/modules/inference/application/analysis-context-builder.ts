import { assertStrategySymbol } from '../../strategies/index.js'
import { parsePriceActionEvidencePlan, type PriceActionEvidencePlan } from '../../strategies/index.js'
import { parseChanEvidencePlan, type ChanEvidencePlan } from '../../strategies/index.js'
import type { StrategyVersion } from '../../strategies/index.js'
import { parseStrategyMarketDataPlan, parseEma34Plan, type Ema34Plan } from '../../strategies/index.js'
import type { AnalysisInputSnapshot, AnalysisRun, JsonObject } from '../domain/inference.js'
import type { RuntimeStrategyMemoryReader } from '../../reviews/index.js'
import { freezeStrategyMemory } from './freeze-strategy-memory.js'
import { isIndependentRoleConfig } from '../../strategies/index.js'

export interface AnalysisMarketPlan {
  timeframes: Array<'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1'>
  priceAction?: PriceActionEvidencePlan
  chan?: ChanEvidencePlan
  ema34?: Ema34Plan
  candleLimit: number
  candleLimits?: Record<string, number>
  primaryTimeframe?: string
}

export interface AnalysisMarketSource {
  read(input: { userId: number; preferredAccountId: string | null; symbol: string; strategyId?: string; strategyVersionId?: string; referenceTime?: string; plan: AnalysisMarketPlan }): Promise<JsonObject>
}

export interface MacroSnapshotReader {
  latest(input: { now: string; acceptedSchemaVersions: number[]; maxAgeSeconds: number }): Promise<JsonObject | null>
}

export type MacroEvidencePlan =
  | { mode: 'off' }
  | { mode: 'context'; acceptedSchemaVersions: number[]; maxAgeSeconds: number }

const allowedTimeframes = new Set<AnalysisMarketPlan['timeframes'][number]>(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])

export function marketPlan(config: Record<string, unknown>): AnalysisMarketPlan {
  const indicators = { ...(config.price_action_evidence === undefined ? {} : { priceAction: parsePriceActionEvidencePlan(config.price_action_evidence) }), ...(config.ema34_evidence === undefined ? {} : { ema34: parseEma34Plan(config.ema34_evidence) }),
    ...(config.chan_evidence === undefined ? {} : { chan: parseChanEvidencePlan(config.chan_evidence) }) }
  if (config.market_data_plan !== undefined) {
    if (config.timeframes !== undefined || config.candle_limit !== undefined) throw new Error('market_data_plan_conflict')
    const plan = parseStrategyMarketDataPlan(config.market_data_plan)
    return { ...indicators, timeframes: plan.timeframes.map(item => item.timeframe as AnalysisMarketPlan['timeframes'][number]),
      candleLimit: Math.max(...plan.timeframes.map(item => item.kline_count)),
      candleLimits: Object.fromEntries(plan.timeframes.map(item => [item.timeframe, item.kline_count])), primaryTimeframe: plan.primary_timeframe }
  }
  const requested = Array.isArray(config.timeframes) ? config.timeframes.filter((value): value is AnalysisMarketPlan['timeframes'][number] => typeof value === 'string' && allowedTimeframes.has(value as AnalysisMarketPlan['timeframes'][number])) : []
  const candleLimit = Number(config.candle_limit)
  return {
    ...indicators,
    timeframes: requested.length > 0 ? [...new Set(requested)] : ['M5', 'M15', 'H1', 'H4'],
    candleLimit: Number.isSafeInteger(candleLimit) && candleLimit >= 50 && candleLimit <= 1000 ? candleLimit : 300,
  }
}

export function macroEvidencePlan(config: Record<string, unknown>): MacroEvidencePlan {
  if (!config.macro_evidence || typeof config.macro_evidence !== 'object' || Array.isArray(config.macro_evidence)) return { mode: 'off' }
  const value = config.macro_evidence as Record<string, unknown>
  if (value.mode !== 'context') return { mode: 'off' }
  const versions = Array.isArray(value.accepted_schema_versions)
    ? value.accepted_schema_versions.filter((version): version is number => Number.isSafeInteger(version) && Number(version) > 0)
    : []
  const maxAgeSeconds = Number(value.max_age_seconds)
  if (versions.length < 1 || versions.length > 8 || new Set(versions).size !== versions.length
    || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 3_600 || maxAgeSeconds > 604_800) return { mode: 'off' }
  return { mode: 'context', acceptedSchemaVersions: versions, maxAgeSeconds }
}

export class AnalysisContextBuilder {
  constructor(private readonly market: AnalysisMarketSource, private readonly macro: MacroSnapshotReader,
    private readonly memory?: RuntimeStrategyMemoryReader) {}

  async build(run: AnalysisRun, strategy: StrategyVersion, now = new Date()): Promise<AnalysisInputSnapshot> {
    assertStrategySymbol(strategy.config, run.symbol)
    const capturedAt = now.toISOString()
    const macroPlan = macroEvidencePlan(strategy.config)
    const strategyMemory = await freezeStrategyMemory({ userId: run.userId, strategyId: strategy.strategyId, strategyKind: 'analysis' }, this.memory)
    return {
      kind: 'analysis',
      ...(isIndependentRoleConfig(strategy.config) ? { responsibilityMode: 'independent_roles_v2' as const } : {}),
      ...(strategyMemory === undefined ? {} : { strategyMemory }),
      strategy: { id: strategy.strategyId, versionId: strategy.id, promptHash: strategy.promptHash, promptText: strategy.promptText },
      market: await this.market.read({ userId: run.userId, preferredAccountId: run.marketSourceAccountId, symbol: run.symbol, strategyId: strategy.strategyId, strategyVersionId: strategy.id, referenceTime: capturedAt, plan: marketPlan(strategy.config) }),
      macro: macroPlan.mode === 'off'
        ? { status: 'disabled' }
        : await this.macro.latest({ now: capturedAt, acceptedSchemaVersions: macroPlan.acceptedSchemaVersions, maxAgeSeconds: macroPlan.maxAgeSeconds })
          ?? { status: 'unavailable', reason: 'no_compatible_snapshot' },
      capturedAt,
    }
  }
}

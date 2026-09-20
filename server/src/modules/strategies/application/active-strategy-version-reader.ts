import type { StrategyKind, StrategyVersion } from '../domain/strategy.js'

/** Reads the active version with the same user access and strategy-kind checks. */
export interface ActiveStrategyVersionReader {
  requireActiveVersion(userId: number, strategyId: string, kind: StrategyKind): Promise<StrategyVersion>
}

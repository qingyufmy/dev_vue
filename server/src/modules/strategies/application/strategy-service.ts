import type { StrategyKind, StrategySummary, StrategyVersion } from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'

export interface StrategyCatalog {
  listAvailable(userId: number, kind?: StrategyKind): Promise<StrategySummary[]>
  findActiveVersion(userId: number, strategyId: string): Promise<StrategyVersion | null>
}

export class StrategyService {
  constructor(private readonly catalog: StrategyCatalog) {}

  list(userId: number, kind?: StrategyKind) {
    return this.catalog.listAvailable(userId, kind)
  }

  async requireActiveVersion(userId: number, strategyId: string, kind: StrategyKind) {
    const version = await this.catalog.findActiveVersion(userId, strategyId)
    if (!version) throw new StrategyAccessError('strategy_not_found', 404)
    if (version.kind !== kind) throw new StrategyAccessError('strategy_kind_mismatch', 422)
    return version
  }
}

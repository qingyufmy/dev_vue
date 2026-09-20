import type { CreateStrategyVersionInput, PublishStrategyVersionInput, StrategyDetail } from '../domain/strategy.js'

export interface PlatformStrategyPublisher {
  createVersion(input: CreateStrategyVersionInput): Promise<StrategyDetail>
  publish(input: PublishStrategyVersionInput): Promise<StrategyDetail>
}

import type { CreateStrategyCombinationInput, CreateStrategyCombinationVersionInput, StrategyDetail } from '../domain/strategy.js'

export interface StrategyCombinationWriter {
  create(input: CreateStrategyCombinationInput): Promise<StrategyDetail>
  createVersion(input: CreateStrategyCombinationVersionInput): Promise<StrategyDetail>
}

import type { SubscriptionExecutionWindowScope } from './subscription-execution-window-reader.js'

export interface StrategyExecutionConfigScope extends SubscriptionExecutionWindowScope {
  promptHash: string
  configHash: string
}

export interface StrategyExecutionConfig {
  strategyId: string
  versionId: string
  promptHash: string
  configHash: string
  config: Record<string, unknown>
}

/** Uses the caller's transaction; hashes must come from verified frozen input,
 * never from model output. Null means the frozen configuration is not current
 * and authorized. Historical snapshots without a hash cannot use this port. */
export interface StrategyExecutionConfigReader {
  read(scope: StrategyExecutionConfigScope): Promise<StrategyExecutionConfig | null>
}

import { contentHash, type DecisionStrategyEvidenceReader } from '../../inference/index.js'
import { resolveStrategyRiskBudget, type StrategyExecutionConfigReader } from '../../strategies/index.js'
import { RiskError, type RiskEvaluationInput } from '../domain/risk.js'

import type { StrategyBudgetContext } from '../domain/strategy-budget-context.js'

export async function readStrategyBudgetContext(input: Pick<RiskEvaluationInput, 'decisionId' | 'decisionRevision' | 'policy' | 'currentRevisions'> & { decisionHash: string },
  evidenceReader: DecisionStrategyEvidenceReader, configReader: StrategyExecutionConfigReader): Promise<StrategyBudgetContext> {
  const scope = { decisionId: input.decisionId, decisionRevision: input.decisionRevision, userId: input.policy.userId, accountId: input.policy.accountId }
  const evidence = await evidenceReader.read(scope)
  if (!evidence || evidence.decisionId !== scope.decisionId || evidence.decisionRevision !== scope.decisionRevision
    || evidence.userId !== scope.userId || evidence.accountId !== scope.accountId || evidence.decisionHash !== input.decisionHash
    || evidence.strategyScope.userId !== scope.userId || evidence.strategyScope.accountId !== scope.accountId
    || evidence.strategyScope.subscriptionRevision !== input.currentRevisions.subscription) throw new RiskError('risk_strategy_evidence_stale', 409)
  const config = await configReader.read(evidence.strategyScope)
  if (!config || config.strategyId !== evidence.strategyScope.traderStrategyId || config.versionId !== evidence.strategyScope.traderStrategyVersionId
    || config.configHash !== evidence.strategyScope.configHash || config.promptHash !== evidence.strategyScope.promptHash
    || contentHash(config.config) !== config.configHash) throw new RiskError('risk_strategy_config_stale', 409)
  let budget: ReturnType<typeof resolveStrategyRiskBudget>
  try { budget = resolveStrategyRiskBudget(config.config.risk_budget, evidence.analysisMarketRegime) }
  catch { throw new RiskError('risk_strategy_budget_invalid', 409) }
  return { ...scope, subscriptionRevision: evidence.strategyScope.subscriptionRevision,
    decisionHash: evidence.decisionHash, snapshotId: evidence.snapshotId, snapshotHash: evidence.snapshotHash,
    strategyId: config.strategyId, versionId: config.versionId, promptHash: config.promptHash, configHash: config.configHash,
    ...(budget.ceiling === undefined ? {} : { strategyRiskCeilingPercent: budget.ceiling }),
    ...(budget.selection === undefined ? {} : { strategyRiskSelection: budget.selection }) }
}

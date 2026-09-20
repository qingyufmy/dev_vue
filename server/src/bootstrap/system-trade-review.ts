import type { PoolConnection } from 'mysql2/promise'
import { createMysqlSystemTradeCaseWriter, createMysqlSystemTradeCaseCompletion } from '../modules/reviews/composition.js'
import { createMysqlReviewDecisionContext } from '../modules/inference/composition.js'
import { createMysqlReviewRiskContext } from '../modules/risk/composition.js'
import { createTransactionSystemTradeAttribution } from './system-trade-attribution.js'

/** Collector transaction freezes one attributed trade; missing context remains visible as awaiting_evidence. */
export function createTransactionSystemTradeReviewCollector(connection: PoolConnection) {
  const attribution = createTransactionSystemTradeAttribution(connection)
  const cases = createMysqlSystemTradeCaseWriter(connection)
  const decisions = createMysqlReviewDecisionContext(connection), risks = createMysqlReviewRiskContext(connection)
  const completion = createMysqlSystemTradeCaseCompletion(connection)
  return { async collect(input: Parameters<typeof attribution.reconcile>[0]) {
    const result = await attribution.reconcile(input)
    if (result.status !== 'attributed') return result
    const review = await cases.create({ trade: result.trade, source: result.source })
    const contexts = [], seen = new Set<string>()
    for (const proof of result.source.proofs) {
      const key = JSON.stringify([proof.decisionId,proof.riskDecisionId])
      if (seen.has(key)) continue
      seen.add(key)
      const scope = { userId: input.userId, accountId: result.trade.evidence.accountId,
        decisionId: proof.decisionId, riskDecisionId: proof.riskDecisionId }
      const inference = await decisions.read(scope), risk = await risks.read(scope)
      if (!inference || !risk) return { status: 'unresolved' as const, reason: 'system_review_context_unavailable', caseId: review.caseId }
      contexts.push({ decisionId: proof.decisionId, riskDecisionId: proof.riskDecisionId, inference, risk })
    }
    return completion.complete(input.userId, review.caseId, contexts)
  } }
}

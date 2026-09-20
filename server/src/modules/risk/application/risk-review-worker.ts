import { evaluateTraderRisk } from './trader-risk-review.js'
import { randomUUID } from 'node:crypto'
import { invalidRiskEvaluation, RiskError } from '../domain/risk.js'
import type { RiskRepository } from './risk-ports.js'

export class RiskReviewWorker {
  constructor(private readonly repository: RiskRepository) {}

  async process(decisionId: string, now = new Date()) {
    const started = Date.now()
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.review(decisionId, new Date(now.getTime() + Date.now() - started))
      if (attempt >= 2 || result.status !== 'stale' || ![
        'risk_summary_revision_conflict', 'risk_review_context_revision_conflict',
      ].includes(result.code)) return result
      // The failed transaction rolled back. Read all facts and evaluate again, never replay an approval.
    }
  }

  private async review(decisionId: string, now: Date) {
    let candidate
    try { candidate = await this.repository.loadReviewCandidate(decisionId) }
    catch (error) {
      if (error instanceof RiskError && error.status === 409) return { status: 'stale' as const, code: error.code }
      throw error
    }
    if (!candidate || candidate.decisionStatus !== 'proposed') return { status: 'ignored' as const }
    let evaluation
    try { evaluation = evaluateTraderRisk(candidate, now) }
    catch (error) {
      if (!(error instanceof RiskError) || error.status !== 422) throw error
      evaluation = invalidRiskEvaluation(candidate.policy, error.code, now)
    }
    try {
      const decision = await this.repository.completeReview({
        riskDecisionId: randomUUID(), decisionId, decisionRevision: candidate.decisionRevision,
        accountRiskRevision: candidate.summary.revision,
        policySetRevision: candidate.policy.policySetRevision,
        expectedRevisions: candidate.currentRevisions,
        ...(candidate.strategyBudgetContext ? { strategyBudgetContext: candidate.strategyBudgetContext } : {}),
        evaluation,
      })
      return { status: evaluation.status, decision }
    } catch (error) {
      if (error instanceof RiskError && error.status === 409) return { status: 'stale' as const, code: error.code }
      throw error
    }
  }
}

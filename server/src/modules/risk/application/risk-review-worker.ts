import { randomUUID } from 'node:crypto'
import { evaluateRisk, invalidRiskEvaluation, RiskError } from '../domain/risk.js'
import type { RiskRepository } from './risk-ports.js'

export class RiskReviewWorker {
  constructor(private readonly repository: RiskRepository) {}

  async process(decisionId: string, now = new Date()) {
    let candidate
    try { candidate = await this.repository.loadReviewCandidate(decisionId) }
    catch (error) {
      if (error instanceof RiskError && error.status === 409) return { status: 'stale' as const, code: error.code }
      throw error
    }
    if (!candidate || candidate.decisionStatus !== 'proposed') return { status: 'ignored' as const }
    let evaluation
    try { evaluation = evaluateRisk(candidate, now) }
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
        evaluation,
      })
      return { status: evaluation.status, decision }
    } catch (error) {
      if (error instanceof RiskError && error.status === 409) return { status: 'stale' as const, code: error.code }
      throw error
    }
  }
}

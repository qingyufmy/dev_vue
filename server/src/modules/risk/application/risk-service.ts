import { assertAccountPolicyPatch, buildAccountRiskSummary, RiskError, type AccountRiskPolicyPatch, type AccountRiskSummary } from '../domain/risk.js'
import type { RiskRepository } from './risk-ports.js'

export class RiskService {
  constructor(private readonly repository: RiskRepository) {}

  async policy(userId: number, accountId: string) {
    const policy = await this.repository.getEffectivePolicy(userId, accountId)
    if (!policy) throw new RiskError('risk_policy_not_found', 404)
    return policy
  }

  async replacePolicy(userId: number, accountId: string, expectedRevision: number, patch: AccountRiskPolicyPatch, reason: string, now = new Date()) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new RiskError('risk_policy_revision_invalid', 422)
    if (reason.trim().length < 3 || reason.trim().length > 500) throw new RiskError('risk_policy_reason_invalid', 422)
    assertAccountPolicyPatch(patch)
    return this.repository.replaceAccountPolicy({ userId, accountId, expectedRevision, patch, actorUserId: userId, reason: reason.trim(), changedAt: now.toISOString() })
  }

  async summary(userId: number, accountId: string) {
    const summary = await this.repository.getAccountSummary(userId, accountId)
    if (!summary) throw new RiskError('risk_summary_not_found', 404)
    return summary
  }

  projectSummary(input: Omit<AccountRiskSummary, 'marginLevelPercent' | 'incompleteReasons'> & { incompleteReasons?: string[]; margin: string }, expectedRevision: number | null) {
    return this.repository.saveAccountSummary({ summary: buildAccountRiskSummary(input), expectedRevision })
  }

  decisions(userId: number, accountId: string, limit = 50) {
    return this.repository.listDecisions(userId, accountId, Math.min(Math.max(limit, 1), 100))
  }

  async decision(userId: number, decisionId: string) {
    const decision = await this.repository.getDecision(userId, decisionId)
    if (!decision) throw new RiskError('risk_decision_not_found', 404)
    return decision
  }
}

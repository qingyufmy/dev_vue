import { createHash, randomUUID } from 'node:crypto'
import { assessManualRelease, manualReleaseStillValid, type ManualReleaseState } from '../domain/manual-risk-release.js'
import { assertAccountPolicyPatch, buildAccountRiskSummary, riskPolicyHash, RiskError, type AccountRiskPolicyPatch, type AccountRiskSummary } from '../domain/risk.js'
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

  async manualRelease(userId: number, accountId: string) {
    await this.policy(userId, accountId)
    return this.repository.getManualRelease(userId, accountId)
  }

  /**
   * Return the latest release together with the server-owned assessment used
   * by the POST path.  Keeping this calculation here prevents the browser
   * from reimplementing clock, completeness, platform-ceiling or recoverable
   * rule checks when deciding whether to render the release action.
   */
  async manualReleaseState(userId: number, accountId: string, now = new Date()): Promise<ManualReleaseState> {
    const policy = await this.policy(userId, accountId)
    const [summary, release] = await Promise.all([
      this.repository.getAccountSummary(userId, accountId),
      this.repository.getManualRelease(userId, accountId),
    ])
    if (!summary) {
      return {
        release,
        availability: {
          available: false as const,
          code: 'risk_summary_not_found',
          rules: [],
          expiresAt: null,
          policySetRevision: policy.policySetRevision,
          riskStateRevision: null,
        },
      }
    }
    const assessment = assessManualRelease(policy, summary, now)
    if (release?.status === 'active' && manualReleaseStillValid(release, summary, now)) {
      return {
        release,
        availability: {
          available: false as const,
          code: 'risk_manual_release_already_active',
          rules: [],
          expiresAt: null,
          policySetRevision: policy.policySetRevision,
          riskStateRevision: summary.revision,
        },
      }
    }
    return {
      release,
      availability: assessment.available
        ? {
            available: true as const,
            code: null,
            rules: assessment.rules,
            expiresAt: assessment.expiresAt,
            policySetRevision: policy.policySetRevision,
            riskStateRevision: summary.revision,
          }
        : {
            available: false as const,
            code: assessment.code,
            rules: [],
            expiresAt: null,
            policySetRevision: policy.policySetRevision,
            riskStateRevision: summary.revision,
          },
    }
  }

  async createManualRelease(input: { userId: number; accountId: string; expectedSummaryRevision: number; idempotencyKey: string; acknowledgeRisk: boolean; reason: string }, now = new Date()) {
    if (!Number.isSafeInteger(input.expectedSummaryRevision) || input.expectedSummaryRevision < 1) throw new RiskError('risk_manual_release_revision_invalid', 422)
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new RiskError('idempotency_key_invalid', 422)
    if (input.acknowledgeRisk !== true) throw new RiskError('risk_manual_release_acknowledgement_required', 422)
    const reason = input.reason.trim()
    if (reason.length < 3 || reason.length > 500) throw new RiskError('risk_manual_release_reason_invalid', 422)
    const request = { accountId: input.accountId, expectedSummaryRevision: input.expectedSummaryRevision, acknowledgeRisk: true, reason }
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const existing = await this.repository.getManualReleaseByIdempotency(input.userId, input.accountId, input.idempotencyKey)
    if (existing) {
      if (existing.requestHash !== requestHash) throw new RiskError('idempotency_conflict', 409)
      return existing.release
    }
    const policy = await this.policy(input.userId, input.accountId)
    const summary = await this.summary(input.userId, input.accountId)
    if (summary.revision !== input.expectedSummaryRevision) throw new RiskError('risk_summary_revision_conflict', 412)
    const assessment = assessManualRelease(policy, summary, now)
    if (!assessment.available) throw new RiskError(assessment.code, 409)
    return this.repository.createManualRelease({
      release: {
        id: randomUUID(), userId: input.userId, accountId: input.accountId,
        platformPolicyVersionId: policy.platformPolicyVersionId, accountPolicyVersionId: policy.accountPolicyVersionId,
        policySetRevision: policy.policySetRevision, status: 'active',
        releasedRules: assessment.rules, baseline: assessment.baseline, riskStateRevision: summary.revision,
        breachFingerprint: assessment.breachFingerprint, reason, expiresAt: assessment.expiresAt,
        createdAt: now.toISOString(), invalidatedAt: null, invalidationReason: null, revision: 1,
      },
      expectedSummaryRevision: input.expectedSummaryRevision,
      expectedPolicyHash: riskPolicyHash(policy), idempotencyKey: input.idempotencyKey,
      requestHash,
    })
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

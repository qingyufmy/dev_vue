import { createHash } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { RiskEvaluationResult } from '../domain/risk.js'

const canonical = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`

export function createMysqlReviewRiskContext(connection: Pick<PoolConnection, 'execute'>) {
  return { async read(input: { userId: number; accountId: string; decisionId: string; riskDecisionId: string }) {
    input = structuredClone(input)
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT r.policy_sha256,p.payload_sha256,p.evaluation_json,
      CAST(r.platform_policy_version_id AS CHAR) platform_version,CAST(r.account_policy_version_id AS CHAR) account_version,
      CAST(r.policy_set_revision AS CHAR) policy_revision,CAST(r.account_risk_revision AS CHAR) risk_revision
      FROM risk_decisions_v4 r INNER JOIN risk_decision_payloads_v4 p ON p.risk_decision_id=r.id
      WHERE r.id=? AND r.trade_decision_id=? AND r.user_id=? AND r.trading_account_id=?
        AND r.decision_status='approved' AND r.reject_code IS NULL LIMIT 2 FOR SHARE`,
    [input.riskDecisionId,input.decisionId,input.userId,input.accountId])
    if (rows.length !== 1) return null
    const row = rows[0]!
    let evaluation: RiskEvaluationResult
    try { evaluation = typeof row.evaluation_json === 'string' ? JSON.parse(row.evaluation_json) : row.evaluation_json }
    catch { throw Error('review_risk_context_corrupt') }
    if (!evaluation || createHash('sha256').update(canonical(evaluation)).digest('hex') !== row.payload_sha256
      || evaluation.status !== 'approved' || evaluation.rejectCode !== null || evaluation.policyHash !== row.policy_sha256
      || !Array.isArray(evaluation.rules) || !Array.isArray(evaluation.approvedActions)) throw Error('review_risk_context_corrupt')
    return { ...input, payloadHash: String(row.payload_sha256), evaluation,
      platformPolicyVersionId: String(row.platform_version), accountPolicyVersionId: row.account_version === null ? null : String(row.account_version),
      policyRevision: String(row.policy_revision), riskRevision: String(row.risk_revision) }
  } }
}

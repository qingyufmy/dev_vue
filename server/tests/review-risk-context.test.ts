import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlReviewRiskContext } from '../src/modules/risk/infrastructure/mysql-review-risk-context.js'
const scope = { userId: 7, accountId: '5', decisionId: 'decision', riskDecisionId: 'risk' }
function fixture() {
  const evaluation = { approvedActions: [], policyHash: 'a'.repeat(64), rejectCode: null, rules: [], status: 'approved' }
  const row = { evaluation_json: evaluation, payload_sha256: createHash('sha256').update(JSON.stringify(evaluation)).digest('hex'),
    policy_sha256: evaluation.policyHash, platform_version: '1', account_version: null, policy_revision: '3', risk_revision: '4' }
  const rows = [row]
  const reader = createMysqlReviewRiskContext({ async execute() { return [rows] } } as unknown as PoolConnection)
  return { row, rows, reader }
}
it('captures the immutable evaluation and policy versions', async () => {
  expect(await fixture().reader.read(scope)).toMatchObject({ riskDecisionId: 'risk', platformPolicyVersionId: '1', accountPolicyVersionId: null, riskRevision: '4' })
})
it('rejects changed evaluation or mismatched policy digest', async () => {
  const f = fixture(); f.row.evaluation_json.status = 'rejected'
  await expect(f.reader.read(scope)).rejects.toThrow('review_risk_context_corrupt')
  const g = fixture(); g.row.policy_sha256 = 'b'.repeat(64)
  await expect(g.reader.read(scope)).rejects.toThrow('review_risk_context_corrupt')
})
it('does not fabricate absent historical decisions', async () => {
  const f = fixture(); f.rows.length = 0
  expect(await f.reader.read(scope)).toBeNull()
})

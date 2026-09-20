import { expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { contentHash } from '../src/modules/inference/domain/inference.js'
import { createMysqlReviewDecisionContext } from '../src/modules/inference/infrastructure/mysql-review-decision-context.js'

const scope = { userId: 7, accountId: '5', decisionId: 'decision', riskDecisionId: 'risk' }
function fixture() {
  const analysis = { summary: 'frozen analysis' }, decision = { action: 'close_position' }
  const snapshot = { kind: 'trader', strategy: { id: '9', versionId: '10' }, account: { id: '5' },
    analysis: { id: 'analysis', contentHash: contentHash(analysis), result: analysis }, subscriptionRevision: 3 }
  const row = { decision_hash: contentHash(decision), payload_sha256: contentHash(decision), payload_json: decision,
    snapshot_hash: contentHash(snapshot), snapshot_json: snapshot, subscription_id: '20', subscription_revision: '3',
    market_analysis_id: 'analysis', snapshot_id: 'snapshot', analysis_hash: contentHash(analysis) }
  const connection = { async execute(sql: string) { return [sql.includes('decision_hash') ? [row] :
    [{ decision_id: 'decision', user_id: 7, account_id: '5', strategy_id: '9', strategy_version_id: '10' }]] } } as unknown as PoolConnection
  return { row, snapshot, reader: createMysqlReviewDecisionContext(connection) }
}
it('retains historical snapshot and subscription revision', async () => {
  const f = fixture()
  expect(await f.reader.read(scope)).toMatchObject({ strategyVersionId: '10', subscriptionId: '20', subscriptionRevision: '3',
    snapshot: { analysis: { result: { summary: 'frozen analysis' } } } })
})
it('rejects changed payload and hash-consistent identity mismatch', async () => {
  const f = fixture(); f.row.payload_json.action = 'hold'
  await expect(f.reader.read(scope)).rejects.toThrow('review_decision_context_corrupt')
  for (const key of ['account', 'strategy', 'subscription', 'analysis'] as const) {
    const g = fixture()
    if (key === 'account') g.snapshot.account.id = '6'
    if (key === 'strategy') g.snapshot.strategy.versionId = '11'
    if (key === 'subscription') g.snapshot.subscriptionRevision = 4
    if (key === 'analysis') g.snapshot.analysis.result.summary = 'changed'
    g.row.snapshot_hash = contentHash(g.snapshot)
    await expect(g.reader.read(scope)).rejects.toThrow('review_decision_context_corrupt')
  }
})

import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { contentHash } from '../src/modules/inference/index.js'
import { createDecisionStrategyEvidenceReader } from '../src/modules/inference/composition.js'

const prompt = 'Structured trader', promptHash = createHash('sha256').update(prompt).digest('hex')
const decision = { actions: [], confidence: 80 }
const snapshot = { kind: 'trader', strategy: { id: '20', versionId: '21', promptText: prompt, promptHash },
  strategyConfigHash: contentHash({}), subscriptionRevision: 3, account: { id: '7' } }
const scope = { decisionId: 'decision', decisionRevision: 1, userId: 42, accountId: '7' }
function row(value: unknown = snapshot) {
  return { decision_id: 'decision', decision_revision: 1, user_id: 42, account_id: '7', decision_hash: contentHash(decision),
    decision_payload: decision, snapshot_id: 'snapshot', snapshot_hash: contentHash(value), snapshot_payload: value,
    subscription_id: '8', subscription_revision: 3, strategy_id: '20', version_id: '21' }
}
async function read(rows: unknown[]) {
  const connection = { execute: async () => [rows] } as unknown as PoolConnection
  return createDecisionStrategyEvidenceReader(connection).read(scope)
}
it('binds proposed decision and trader snapshot to a separate current-authorization scope', async () => {
  expect(await read([row()])).toMatchObject({ ...scope, decisionHash: contentHash(decision), snapshotHash: contentHash(snapshot),
    strategyScope: { subscriptionId: '8', subscriptionRevision: 3, userId: 42, accountId: '7',
      traderStrategyId: '20', traderStrategyVersionId: '21', promptHash, configHash: contentHash({}) } })
})
it.each([
  { ...snapshot, kind: 'analysis' }, { ...snapshot, account: { id: '8' } }, { ...snapshot, subscriptionRevision: 4 },
  { ...snapshot, strategy: { ...snapshot.strategy, versionId: '22' } },
  { ...snapshot, strategy: { ...snapshot.strategy, promptText: 'Changed' } },
  { ...snapshot, strategyConfigHash: null },
  { kind: 'trader', strategy: snapshot.strategy, account: snapshot.account, subscriptionRevision: 3 },
])('rejects inconsistent lineage even when its JSON hash is internally valid: %j', async value => {
  expect(await read([row(value)])).toBeNull()
})
it('rejects stale scope, tampered decision, snapshot hash and ambiguous records', async () => {
  for (const patch of [{ decision_revision: 2 }, { user_id: 43 }, { account_id: '8' },
    { decision_payload: { actions: ['changed'] } }, { snapshot_hash: '0'.repeat(64) }]) {
    expect(await read([{ ...row(), ...patch }])).toBeNull()
  }
  expect(await read([])).toBeNull()
  expect(await read([row(), row()])).toBeNull()
})

it('projects only the original frozen analysis regime with matching identity and content hash', async () => {
  const result = { marketRegime: 'reversal_watch' }
  const value = { ...snapshot, analysis: { id: 'analysis-1', result, contentHash: contentHash(result) } }
  const valid = { ...row(value), analysis_id: 'analysis-1' }
  expect(await read([valid])).toMatchObject({ analysisMarketRegime: 'reversal_watch' })
  expect(await read([{ ...valid, analysis_id: 'another-analysis' }])).toBeNull()
  const changed = structuredClone(value); changed.analysis.result.marketRegime = 'continuation'
  expect(await read([{ ...row(changed), analysis_id: 'analysis-1' }])).toBeNull()
  expect(await read([row()])).not.toHaveProperty('analysisMarketRegime')
})

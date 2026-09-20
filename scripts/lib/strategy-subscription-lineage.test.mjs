import test from 'node:test'
import assert from 'node:assert/strict'
import { planStrategySubscriptionLineage } from './strategy-subscription-lineage.mjs'
const sha = 'a'.repeat(64)
const inventory = () => ({ inspected: true, identity: { db: 'dev_vue' }, historyCount: 188, inputHash: sha, accountMappingHash: sha,
  strategyCandidates: [{ sourceId: '1', sourceHash: sha, promptHash: sha, sourceVersion: '44', lifecycle: 'active', problems: [] }],
  subscriptionCandidates: [{ sourceId: '5', sourceHash: sha, strategySourceId: '1', targetAccountId: '2', ownershipDisposition: 'historical_only',
    historicalOwnershipEvidenceHash: sha, legacyExecutionEnabled: true, legacyDeleted: false, symbols: { status: 'converted', symbols: ['XAUUSD','EURUSD'] }, schedule: { status: 'converted' }, problems: [] }] })
const mapping = () => ({ sourceId: '1', sourceHash: sha, promptHash: sha,
  analysis: { kind: 'analysis', strategyId: '11', versionId: '21', promptHash: sha, configHash: sha },
  trader: { kind: 'trader', strategyId: '12', versionId: '22', promptHash: sha, configHash: sha } })
test('preserves every symbol and historical ownership without granting runtime permission', () => {
  const result = planStrategySubscriptionLineage(inventory(), [mapping()])
  assert.equal(result.mappingComplete, true)
  assert.equal(result.executable, false)
  assert.equal(result.strategyRows[0].legacyIdentities.analysis.strategy.legacyId, '1:analysis')
  assert.equal(result.strategyRows[0].legacyIdentities.trader.strategy.legacyId, '1:trader')
  assert.deepEqual(result.subscriptionRows[0].symbolRows.map(row => [row.standardSymbol,row.historicalOnly,row.sourceExecutionEnabled]), [['XAUUSD',true,true],['EURUSD',true,true]])
})
test('reports missing role mappings without silently reusing one strategy for both roles', () => {
  const result = planStrategySubscriptionLineage(inventory())
  assert.equal(result.mappingComplete, false)
  assert.equal(result.subscriptionRows[0].symbolRows[0].analysisStrategyId,null)
  assert.ok(result.subscriptionRows[0].problems.includes('strategy_role_mapping_missing'))
})
test('rejects stale source, duplicate identities and cross-role target collisions', () => {
  const stale = mapping(); stale.sourceHash = 'b'.repeat(64)
  assert.throws(() => planStrategySubscriptionLineage(inventory(), [stale]), /source_changed/)
  const collision = mapping(); collision.trader.strategyId = collision.analysis.strategyId
  assert.throws(() => planStrategySubscriptionLineage(inventory(), [collision]), /target_collision/)
  assert.throws(() => planStrategySubscriptionLineage(inventory(), [mapping(),mapping()]), /duplicate_source/)
})
test('requires persisted account and ended ownership evidence', () => {
  const source=inventory();source.subscriptionCandidates[0].targetAccountId=null;source.subscriptionCandidates[0].historicalOwnershipEvidenceHash=null
  const result=planStrategySubscriptionLineage(source,[mapping()])
  assert.equal(result.mappingComplete,false)
  assert.ok(result.subscriptionRows[0].problems.includes('historical_ownership_evidence_missing'))
  assert.ok(result.subscriptionRows[0].problems.includes('persisted_account_mapping_missing'))
})

test('preserves an unreferenced retired template as exact legacy history without inventing executable roles', () => {
  const source=inventory()
  source.strategyCandidates.push({ ...source.strategyCandidates[0], sourceId:'2', lifecycle:'retired' })
  const archive={ sourceId:'2',sourceHash:sha,promptHash:sha,disposition:'archive_only',archive:{table:'auto_prompt_types',sourceId:'2',sourceHash:sha} }
  const plan=planStrategySubscriptionLineage(source,[mapping(),archive])
  assert.equal(plan.mappingComplete,true)
  assert.equal(plan.executable,false)
  assert.equal(plan.strategyRows[1].roles,null)
  assert.equal(plan.strategyRows[1].legacyIdentities,null)
  assert.equal(plan.strategyRows[1].archive.sourceId,'2')
  source.subscriptionCandidates.push({ ...source.subscriptionCandidates[0],sourceId:'6',strategySourceId:'2' })
  assert.throws(()=>planStrategySubscriptionLineage(source,[mapping(),archive]),/archive_invalid/)
})
test('never archives an active strategy or accepts a changed history locator', () => {
  const source=inventory();source.subscriptionCandidates=[]
  const archive={sourceId:'1',sourceHash:sha,promptHash:sha,disposition:'archive_only',archive:{table:'auto_prompt_types',sourceId:'1',sourceHash:sha}}
  assert.throws(()=>planStrategySubscriptionLineage(source,[archive]),/archive_invalid/)
  source.strategyCandidates[0].lifecycle='retired';archive.archive.sourceHash='b'.repeat(64)
  assert.throws(()=>planStrategySubscriptionLineage(source,[archive]),/archive_invalid/)
})

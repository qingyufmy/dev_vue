import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadRiskStructureSource, selectRiskStructureSource, inspectRiskStructurePrerequisites, riskStructureTables } from '../scripts/lib/risk-structure-source.mjs'
import { loadRiskStructureMigration } from '../scripts/lib/inplace-risk-structure.mjs'
import { loadTradingContextChanges } from '../scripts/lib/inplace-trading-context-changes.mjs'

const root = new URL('../', import.meta.url)
test('appends risk steps without replacing any historical migration identity or checksum', async () => {
  const prior = await loadTradingContextChanges(root)
  const next = await loadRiskStructureMigration(root)
  assert.equal(next.additions.length, 8)
  assert.deepEqual(next.steps.slice(0, prior.steps.length), prior.steps)
  assert.equal(next.prior.steps.length, 166)
  assert.equal(next.prior.steps.at(-1).id, 'inplace_042_01_observer_management_registry_seed')
  assert.equal(next.steps.length, 174)
  assert.equal(new Set(next.steps.map(row => row.id)).size, next.steps.length)
  assert.ok(next.additions.every(row => row.priorRegistryHash === next.priorRegistryHash && row.checksum.length === 64))
})
test('extracts only seven risk CREATEs and the active-version FK, without bootstrap writes', async () => {
  const plan = await loadRiskStructureSource(root)
  assert.equal(plan.statements.length, 8)
  assert.deepEqual(plan.statements.filter(row => row.sql.startsWith('CREATE')).map(row => row.table), riskStructureTables)
  assert.ok(plan.statements.every(row => /^(CREATE TABLE|ALTER TABLE)/.test(row.sql)))
  assert.ok(plan.statements.every(row => !/IF NOT EXISTS|INSERT INTO|UPDATE |trade_decisions|global_risk_controls/.test(row.sql)))
  assert.equal(plan.statements[2].table, 'risk_policy_sets_v4')
})

test('rejects modified source rather than blessing new bootstrap behavior', async () => {
  const sources = {}
  for (const file of ['20260903_006_account_trader_worker.sql', '20260903_007_deterministic_risk_review.sql', '20260903_008_manual_risk_release.sql']) {
    sources[file] = await readFile(new URL(`server/db/migrations/${file}`, root))
  }
  sources['20260903_007_deterministic_risk_review.sql'] = Buffer.concat([sources['20260903_007_deterministic_risk_review.sql'], Buffer.from('\nDELETE FROM global_risk_controls;')])
  assert.throws(() => selectRiskStructureSource(sources), /risk_structure_source_changed/)
})

const evidence = () => ({ kind: 'risk-upgrade-readiness/v1', inspected: true, tables: [],
  columns: [{ tableName: 'users', name: 'id', type: 'int', nullable: 'NO' }, { tableName: 'trading_accounts', name: 'id', type: 'bigint unsigned', nullable: 'NO' }],
  keys: ['users', 'trading_accounts'].map(tableName => ({ tableName, constraintName: 'PRIMARY', columnName: 'id' })) })
test('metadata preparation never grants apply readiness', () => {
  assert.deepEqual(inspectRiskStructurePrerequisites(evidence()).issues, [])
  assert.equal(inspectRiskStructurePrerequisites(evidence()).applyReady, false)
})
test('rejects incompatible signed account IDs, missing parent keys and existing target tables', () => {
  const report = evidence()
  report.columns[1].type = 'bigint'
  report.keys = []
  report.tables.push({ name: 'risk_manual_releases' })
  const result = inspectRiskStructurePrerequisites(report)
  assert.equal(result.readyForStructurePreparation, false)
  assert.deepEqual(result.issues.map(row => row.code), ['referenced_id_not_primary', 'referenced_id_type_mismatch',
    'referenced_id_not_primary', 'target_already_exists_requires_reconciliation'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadBridgeInstallationSource } from './bridge-installation-upgrade-source.mjs'
import { loadMigrationPlan } from './v4-migration-plan.mjs'

test('registers matching append-only sources and refuses to claim an unperformed reference proof', async () => {
  const root = new URL('../../', import.meta.url)
  const source = await loadBridgeInstallationSource(root)
  assert.equal(source.promotionStatus, 'reference_database_proof_required')
  const plan = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
  const migration = plan.find(item => item.id === '20260914_028_bridge_installation_authorizations')
  assert.ok(migration)
  assert.deepEqual(migration.statements, source.statements)
})

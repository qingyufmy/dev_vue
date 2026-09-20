import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRiskReapprovalUpgrade } from './risk-reapproval-upgrade.mjs'
import { loadCorrectedBridgeInstallationUpgrade } from './bridge-installation-corrected-upgrade.mjs'

test('appends reapproval without changing registered historical checksums', async () => {
  const root = new URL('../../', import.meta.url)
  const before = await loadCorrectedBridgeInstallationUpgrade(root)
  const after = await loadRiskReapprovalUpgrade(root)
  assert.deepEqual(after.steps.slice(0, before.steps.length), before.steps)
  assert.equal(after.finalTableHashes.strategy_write_receipts_v4, '5cbd19e2157474ed07d3e464019a3bdca937e976ce97a1c400b04f747219ea02')
  assert.equal(after.steps.length, 278)
  assert.equal(new Set(after.steps.map(step => step.id)).size, 278)
  assert.equal(after.reapproval.beforeHash, before.finalTableHashes.risk_decisions_v4)
  assert.notEqual(after.reapproval.beforeHash, after.reapproval.afterHash)
  assert.ok(after.definitions.risk_decisions_v4.includes('KEY `idx_risk_decision_trade_decision`'))
  assert.ok(!after.definitions.risk_decisions_v4.includes('UNIQUE KEY `uk_risk_decision_trade_decision`'))
})

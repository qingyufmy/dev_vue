import { loadRecentSources } from './recent-upgrade-inspection.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadCorrectedBridgeInstallationUpgrade } from './bridge-installation-corrected-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'

export async function loadRiskReapprovalUpgrade(root) {
  const base = await loadCorrectedBridgeInstallationUpgrade(root)
  assert.equal(base.steps.length, 272)
  const table = 'risk_decisions_v4'
  let node = base, before
  while (node) { before = node.definitions?.[table]; if (before) break; node = node.prior }
  if (!before) {
    const reference = JSON.parse(await readFile(new URL('docs/architecture/strategy-write-reference-v154-20260910.json', root)))
    const baseline = JSON.parse(await readFile(new URL('docs/architecture/execution-workflow-restored-baseline-20260910.json', root)))
    before = reference.executionFoundationFullSchema.canonicalTables[table]?.ddl ?? baseline.tables.find(row => row.name === table)?.ddl
  }
  assert.equal(tableDefinitionHash(before), base.finalTableHashes[table])
  const unique = '  UNIQUE KEY `uk_risk_decision_trade_decision` (`trade_decision_id`),\n'
  assert.ok(before.includes(unique))
  const after = before.replace(unique, '').replace('  CONSTRAINT ', '  KEY `idx_risk_decision_trade_decision` (`trade_decision_id`),\n  CONSTRAINT ')
  const source = 'server/db/migrations/inplace/086_risk_reapproval.sql'
  const bytes = await readFile(new URL(source, root)), statements = splitSqlStatements(bytes.toString('utf8'))
  assert.equal(statements.length, 1)
  assert.match(statements[0], /^ALTER TABLE risk_decisions_v4\s+DROP INDEX uk_risk_decision_trade_decision,\s+ADD INDEX idx_risk_decision_trade_decision \(trade_decision_id\)$/)
  const body = { id: 'inplace_086_01_risk_reapproval', protocol: 'risk-reapproval/v1', source,
    sql: statements[0], sourceSha256: sha256(bytes), beforeHash: tableDefinitionHash(before), afterHash: tableDefinitionHash(after) }
  const reapproval = { ...body, checksum: hash(body) }
  const recent = (await loadRecentSources(root)).map(({ id, checksum }) => ({ id, checksum }))
  for (const [id, source] of [
    ['inplace_084_01_strategy_trader_receipt_action', 'server/db/migrations/inplace/084_strategy_trader_receipt_action.sql'],
    ['inplace_085_01_account_daily_risk_baselines', 'server/db/migrations/20260915_032_account_daily_risk_baselines.sql'],
  ]) {
    const sql = splitSqlStatements(await readFile(new URL(source, root), 'utf8'))
    assert.equal(sql.length, 1)
    recent.push({ id, checksum: sha256(sql[0]) })
  }
  let receiptNode = base
  while (receiptNode && !receiptNode.receiptDdl?.includes('strategy_write_receipts_v4')) receiptNode = receiptNode.prior
  const receiptBefore = receiptNode?.receiptDdl
  assert.equal(tableDefinitionHash(receiptBefore), base.finalTableHashes.strategy_write_receipts_v4)
  assert.ok(receiptBefore.includes("'update_subscription'"))
  const receiptAfter = receiptBefore.replace("'update_subscription'", "'update_subscription',_utf8mb4'set_account_trader'")
  // MySQL reserializes regex literals against the ASCII hash columns during ALTER.
  const receiptCanonical = receiptAfter.replaceAll("_utf8mb4'^[0-9a-f]{64}$'", () => "_ascii'^[0-9a-f]{64}$'")
    .replaceAll("_utf8mb4'[^0-9a-f]'", "_ascii'[^0-9a-f]'")
  return { ...base, steps: [...base.steps, ...recent, reapproval], reapproval,
    definitions: { ...base.definitions, [table]: after, strategy_write_receipts_v4: receiptCanonical }, finalTableHashes: { ...base.finalTableHashes, [table]: reapproval.afterHash, strategy_write_receipts_v4: tableDefinitionHash(receiptCanonical) } }
}

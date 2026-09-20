import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRiskStructureMigration } from '../scripts/lib/inplace-risk-structure.mjs'
import { prepareRiskStructureProof, riskStructureReferenceChecks } from '../scripts/lib/risk-structure-proof.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'
import { legacyCandlePromotionSnapshot } from '../scripts/lib/legacy-candle-promotion.mjs'

const plan = await loadRiskStructureMigration(new URL('../', import.meta.url))
function fixture() {
  const identity = { database: 'dev_vue', serverUuid: 'fixture-server' }
  const prior = { identity, priorSnapshot: [{ name: 'users' }, { name: 'database_upgrade_steps_v4' }] }
  const source = ['database_upgrade_steps_v4', 'trading_context_changes_v4', 'users'].map(name => ({
    name, rows: 1, rowsSha256: 'a'.repeat(64),
    ddl: `CREATE TABLE \`${name}\` (\n  \`label\` varchar(12) COLLATE utf8mb4_unicode_ci DEFAULT NULL\n)`,
    columns: [{ name: 'label', characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', dataType: 'varchar', columnType: 'varchar(12)' }],
  }))
  const snapshot = legacyCandlePromotionSnapshot(source)
  const tools = [{ path: 'fixture', sha256: 'a'.repeat(64) }]
  const registryHash = hash(plan.steps.map(({ id, checksum }) => ({ id, checksum })))
  const states = new Map()
  const definitions = plan.additions.map((step, index) => {
    const canonicalDdl = `CREATE TABLE \`${step.table}\` (\n id INT, phase_${index} INT\n)`
    const definition = { stepId: step.id, stepChecksum: step.checksum, beforeHash: states.get(step.table) ?? null,
      afterHash: tableDefinitionHash(canonicalDdl), canonicalDdl }
    states.set(step.table, definition.afterHash)
    return definition
  })
  const reference = { kind: 'risk-structure-reference/v1', identity, registryHash, definitions, tools,
    referenceDatabaseRemoved: true, existingDatabaseWrites: 0, checks: [...riskStructureReferenceChecks] }
  const restore = { kind: 'risk-structure-restore/v1', passed: true, sourceIdentity: identity, registryHash,
    sourceSnapshotHash: hash(snapshot), restoredSnapshotHash: hash(snapshot), sourceWrites: 0, stepsCompleted: 174, tools,
    snapshotEvidence: { source, restored: structuredClone(source) } }
  return { identity, prior, snapshot, tools, reference, restore,
    prepare() { return prepareRiskStructureProof(plan, this.identity, this.prior, this.snapshot, this.reference, this.restore, this.tools) } }
}
test('binds restoration, every DDL transition and historical proof into one deterministic proof', () => {
  const f = fixture(), proof = f.prepare()
  assert.equal(f.prepare().proofHash, proof.proofHash)
  assert.equal(proof.definitions.length, 8)
  f.prior.extra = 'changed historical proof'
  assert.notEqual(f.prepare().proofHash, proof.proofHash)
})
test('rejects an unverified or mismatched restoration instead of accepting an empty reference database', () => {
  for (const patch of [{ passed: false }, { sourceWrites: 1 }, { stepsCompleted: 165 }, { restoredSnapshotHash: 'wrong' }]) {
    const f = fixture(); Object.assign(f.restore, patch)
    assert.throws(() => f.prepare(), /restore/)
  }
})
test('rejects a changed step, DDL fingerprint, chain, reference identity or tool set', () => {
  for (const patch of [{ stepChecksum: 'wrong' }, { afterHash: 'wrong' }, { beforeHash: 'wrong' }]) {
    const f = fixture(); Object.assign(f.reference.definitions[2], patch)
    assert.throws(() => f.prepare(), /definition/)
  }
  const f = fixture(); f.reference = { ...f.reference, identity: { database: 'another' } }
  assert.throws(() => f.prepare(), /reference/)
  const g = fixture(); g.tools = [{ path: 'changed' }]
  assert.throws(() => g.prepare(), /tools/)
})
test('unknown or duplicate baseline tables cannot be legitimized by a matching restore hash', () => {
  for (const name of ['unexpected_table', 'users']) {
    const f = fixture(); f.snapshot.push({ name, rows: 0 })
    f.restore.sourceSnapshotHash = f.restore.restoredSnapshotHash = hash(f.snapshot)
    assert.throws(() => f.prepare(), /snapshot|prior_tables/)
  }
})
test('incomplete reference checks cannot produce an upgrade proof', () => {
  const f = fixture(); f.reference.checks = []
  assert.throws(() => f.prepare(), /reference_checks/)
})

test('accepts verified redundant charset rendering while preserving distinct raw snapshot hashes', () => {
  const f = fixture()
  f.restore.snapshotEvidence.restored[2].ddl = f.restore.snapshotEvidence.restored[2].ddl
    .replace('varchar(12) COLLATE', 'varchar(12) CHARACTER SET utf8mb4 COLLATE')
  f.restore.restoredSnapshotHash = hash(legacyCandlePromotionSnapshot(f.restore.snapshotEvidence.restored))
  assert.notEqual(f.restore.sourceSnapshotHash, f.restore.restoredSnapshotHash)
  assert.equal(f.prepare().restoreHash, hash(f.restore))
})

test('rejects changed rows, column metadata and constraints even when the restored hash is updated', () => {
  for (const change of [row => { row.rowsSha256 = 'b'.repeat(64) },
    row => { row.columns[0].columnType = 'varchar(11)' },
    row => { row.ddl += ' ENGINE=MyISAM' }]) {
    const f = fixture()
    change(f.restore.snapshotEvidence.restored[2])
    f.restore.restoredSnapshotHash = hash(legacyCandlePromotionSnapshot(f.restore.snapshotEvidence.restored))
    assert.throws(() => f.prepare(), /risk_backup_(rows|columns|ddl)_mismatch/)
  }
})

test('rejects omitted evidence and identical forged hashes over unrelated backup content', () => {
  const f = fixture(); delete f.restore.snapshotEvidence
  assert.throws(() => f.prepare(), /restore_evidence/)
  const g = fixture()
  for (const rows of Object.values(g.restore.snapshotEvidence)) rows[2].rows = 20
  assert.throws(() => g.prepare(), /restore_snapshot/)
})

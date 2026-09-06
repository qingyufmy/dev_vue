import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadMigrationPlan } from '../scripts/lib/v4-migration-plan.mjs'
import { matrixRows, plannedColumns, validateUpgradeReview } from '../scripts/lib/v4-upgrade-review.mjs'

const root = resolve(import.meta.dirname, '..')
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const inventory = json('docs/migration/m1-source-target-inventory-20260905.json')
const observation = json('docs/migration/m1-b2-identity-observation-20260905.json')
const baseline = json('docs/migration/public-upgrade-u1-review-20260906.json')
let catalog
beforeAll(async () => { catalog = plannedColumns(await loadMigrationPlan({ rootDirectory: root })) })
const validate = value => validateUpgradeReview(value, inventory, observation, catalog)
const rejects = (change, code) => {
  const value = structuredClone(baseline)
  change(value)
  expect(validate(value).errors.map(e => e.code)).toContain(code)
}

describe('offline upgrade review safety gates', () => {
  it('accepts complete source coverage without permitting backfill', () => {
    expect(validate(baseline)).toEqual({ ok: true, errors: [] })
    expect(baseline.coverage).toHaveLength(165)
    expect(baseline.identity.tables.flatMap(t => t.fields)).toHaveLength(148)
    expect(baseline.executable).toBe(false)
  })
  it('rejects missing or duplicate source tables and column drift', () => {
    rejects(b => b.coverage.pop(), 'upgrade_table_missing')
    rejects(b => b.coverage.push(b.coverage[0]), 'upgrade_table_duplicate')
    rejects(b => b.coverage[0].sourceColumns.pop(), 'upgrade_source_columns_drift')
    rejects(b => b.identity.tables[0].fields.pop(), 'field_manifest_column_missing')
    rejects(b => b.identity.tables[0].fields.push(b.identity.tables[0].fields[0]), 'field_manifest_column_duplicate')
  })
  it('rejects source null/default/collation and snapshot changes', () => {
    rejects(b => { b.identity.tables[0].fields[0].sourceNullable = true }, 'upgrade_source_field_drift')
    rejects(b => { b.identity.tables[0].fields[0].sourceDefault = { kind: 'literal', value: '0' } }, 'upgrade_source_field_drift')
    rejects(b => { b.identity.source.snapshotId = b.frozenSource.snapshotId = 'changed' }, 'upgrade_snapshot_observation_mismatch')
  })
  it('rejects invented targets, stale declarations and false readiness', () => {
    rejects(b => { b.identity.tables[0].fields[0].target = 'users.missing' }, 'upgrade_target_column_missing')
    rejects(b => { b.identity.tables[0].fields[0].review.targetDeclaration.declaration = 'INT NULL' }, 'upgrade_target_declaration_drift')
    rejects(b => { b.executable = true }, 'upgrade_executable_forbidden')
    rejects(b => { b.identity.executable = true }, 'field_manifest_executable_forbidden')
    rejects(b => { b.coverage[0].status = 'ready' }, 'upgrade_coverage_readiness_unproven')
  })
  it('rejects unknown transforms, changed specifications and fabricated UTC', () => {
    rejects(b => { b.identity.tables[0].fields[0].transformId = 'invented' }, 'field_manifest_transform_unknown')
    rejects(b => { b.identity.transforms[0].rule += ' changed' }, 'upgrade_transform_hash_mismatch')
    rejects(b => {
      const f = b.identity.tables.flatMap(t => t.fields).find(f => /^datetime/.test(f.sourceType))
      f.timeKind = 'utc_datetime'
      f.blockers = f.blockers.filter(code => code !== 'G-TIME')
    }, 'upgrade_time_evidence_required')
  })
  it('preserves ownership and observer source distinctions, and retired Telegram', () => {
    const field = (table, name) => baseline.identity.tables.find(t => t.sourceTable === table).fields.find(f => f.sourceColumn === name)
    expect(field('trading_accounts', 'user_id').target).toBe('user_trading_account_settings.user_id')
    expect(field('ai_observer_channels', 'source_id').target).toBe('observer_channels.source_id')
    expect(field('users', 'referred_by').target).toBe('user_referral_accounts.referred_by_code')
    for (const f of baseline.identity.tables[0].fields.filter(f => f.sourceColumn.startsWith('telegram_'))) {
      expect(f.disposition).toBe('history')
      expect(f.blockers).toContain('G-EVIDENCE')
    }
  })
})

describe('bounded source SQL catalog and coverage parser', () => {
  const plan = statements => [{ file: 'test.sql', checksum: 'test', statements }]
  it('applies add/modify/drop and preserves final source declaration', () => {
    const result = plannedColumns(plan([
      'CREATE TABLE IF NOT EXISTS sample (\n id INT NOT NULL,\n value VARCHAR(50) NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      'ALTER TABLE sample ADD COLUMN extra INT NULL',
      'ALTER TABLE sample MODIFY COLUMN value VARCHAR(20) NOT NULL',
      'ALTER TABLE sample DROP COLUMN extra',
    ]))
    expect(Object.keys(result.sample)).toEqual(['id', 'value'])
    expect(result.sample.value.declaration).toBe('VARCHAR(20) NOT NULL')
    expect(result.sample.value.tableDefaults.collation).toBe('utf8mb4_unicode_ci')
  })
  it('fails closed on unsupported rename and unknown changed types', () => {
    expect(() => plannedColumns(plan(['CREATE TABLE t (\n id INT\n)', 'ALTER TABLE t CHANGE COLUMN id other INT']))).toThrow('upgrade_unsupported_column_change')
    expect(() => plannedColumns(plan(['CREATE TABLE t (\n id INT\n)', 'ALTER TABLE t ADD COLUMN opaque GEOMETRY']))).toThrow('upgrade_unsupported_column_type')
  })
  it('does not count the documented risk cross-reference twice', () => {
    const matrix = '## 10. execution\n| `risk_reservations` | 0 | 重塑 | `risk_reservations_v4` | execution rule |\n## 11. risk\n| `risk_reservations` | 0 | 重塑 | `risk_reservations_v4` | risk reference |'
    expect(matrixRows(matrix).get('risk_reservations').domain).toBe('10. execution')
    expect(() => matrixRows(matrix.replaceAll('risk_reservations', 'unexpected_duplicate'))).toThrow('upgrade_matrix_duplicate')
  })
})

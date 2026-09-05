import { describe, expect, it } from 'vitest'
import { validateFieldManifest } from '../scripts/lib/v4-field-manifest.mjs'

const inventory = {
  source_tables: [
    {
      name: 'users',
      columns: ['id', 'email', 'created_at'],
      primary_key: [['id', 'int']],
      row_count: 2,
    },
    {
      name: 'orders',
      columns: ['id', 'user_id'],
      primary_key: [['id', 'bigint']],
      row_count: 1,
    },
  ],
}

function field(sourceColumn, overrides = {}) {
  return {
    sourceColumn,
    sourceType: sourceColumn === 'id' ? 'int' : 'varchar(191)',
    sourceCollation: null,
    sourceNullable: true,
    sourceDefault: { kind: 'null' },
    disposition: 'active',
    target: `target_${sourceColumn}`,
    transformId: 'copy-v1',
    timeKind: 'not_time',
    nullRule: 'preserve-null',
    relationRule: 'none',
    checks: ['structural-check'],
    blockers: [],
    evidence: ['offline-test-fixture'],
    reviewStatus: 'reviewed',
    ...overrides,
  }
}

function baseManifest() {
  return {
    schemaVersion: 1,
    stage: 'B2',
    executable: false,
    source: {
      logicalSourceId: 'mysql-dev-vue',
      snapshotId: 'sha256:test-snapshot',
      mirrorDatabase: 'dev_vue_m1_source_20260905_01',
      serverUuid: 'server-test-uuid',
    },
    scopeTables: ['users'],
    tables: [{
      sourceTable: 'users',
      sourcePrimaryKey: ['id'],
      rowCount: '2',
      fields: [field('id'), field('email'), field('created_at')],
    }],
    transforms: [{ id: 'copy-v1', version: 1, rule: 'copy source value' }],
    gaps: [],
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function codes(result) {
  return result.errors.map(error => error.code)
}

describe('offline B2 field manifest validator', () => {
  it('accepts a complete structural manifest and reports informational counts', () => {
    const result = validateFieldManifest(baseManifest(), inventory)
    expect(result).toEqual({
      ok: true,
      errors: [],
      counts: { tables: 1, columns: 3, blockedColumns: 0 },
    })
  })

  it('checks table and column coverage without echoing source names in errors', () => {
    const manifest = baseManifest()
    manifest.tables[0].fields = [field('id'), field('id'), field('email'), field('not_in_inventory')]
    manifest.tables.push({
      sourceTable: 'orders',
      sourcePrimaryKey: ['id'],
      rowCount: '1',
      fields: [field('id'), field('user_id')],
    })
    const result = validateFieldManifest(manifest, inventory)
    expect(result.ok).toBe(false)
    expect(codes(result)).toEqual(expect.arrayContaining([
      'field_manifest_column_duplicate',
      'field_manifest_column_missing',
      'field_manifest_column_out_of_inventory',
      'field_manifest_table_out_of_scope',
    ]))
    expect(JSON.stringify(result.errors)).not.toContain('not_in_inventory')
    expect(JSON.stringify(result.errors)).not.toContain('orders')
    expect(result.counts).toEqual({ tables: 2, columns: 6, blockedColumns: 0 })
  })

  it('requires each scoped table exactly once and detects primary-key and count drift', () => {
    const manifest = baseManifest()
    manifest.scopeTables = ['users', 'orders']
    manifest.tables[0].sourcePrimaryKey = ['email']
    manifest.tables[0].rowCount = '3'
    const result = validateFieldManifest(manifest, inventory)
    expect(result.ok).toBe(false)
    expect(codes(result)).toEqual(expect.arrayContaining([
      'field_manifest_primary_key_mismatch',
      'field_manifest_row_count_mismatch',
      'field_manifest_scope_table_missing',
    ]))
  })

  it('requires every field transform to exist and be uniquely declared', () => {
    const manifest = baseManifest()
    manifest.tables[0].fields[1].transformId = 'missing-transform'
    manifest.transforms.push({ id: 'copy-v1', version: 2, rule: 'another rule' })
    const result = validateFieldManifest(manifest, inventory)
    expect(result.ok).toBe(false)
    expect(codes(result)).toEqual(expect.arrayContaining([
      'field_manifest_transform_unknown',
      'field_manifest_transform_duplicate',
    ]))
  })

  it('blocks unknown time semantics and enforces blocker/gap and review status rules', () => {
    const manifest = baseManifest()
    manifest.tables[0].fields[0].timeKind = 'unknown'
    const unknownTime = validateFieldManifest(manifest, inventory)
    expect(codes(unknownTime)).toContain('field_manifest_unknown_time_unblocked')

    const blocked = baseManifest()
    blocked.gaps = [{ id: 'gap-time', summary: 'time semantics need review' }]
    blocked.tables[0].fields[0] = field('id', {
      disposition: 'active',
      target: 'users.id',
      timeKind: 'unknown',
      blockers: ['gap-time'],
      reviewStatus: 'blocked',
    })
    const blockedResult = validateFieldManifest(blocked, inventory)
    expect(blockedResult.ok).toBe(true)
    expect(blockedResult.counts.blockedColumns).toBe(1)

    const unknownGap = clone(blocked)
    unknownGap.tables[0].fields[0].blockers = ['gap-does-not-exist']
    const unknownGapResult = validateFieldManifest(unknownGap, inventory)
    expect(codes(unknownGapResult)).toContain('field_manifest_blocker_gap_unknown')

    const reviewedWithBlocker = clone(blocked)
    reviewedWithBlocker.tables[0].fields[0].reviewStatus = 'reviewed'
    const reviewedResult = validateFieldManifest(reviewedWithBlocker, inventory)
    expect(codes(reviewedResult)).toContain('field_manifest_reviewed_has_blockers')

    const blockedWithoutBlocker = clone(blocked)
    blockedWithoutBlocker.tables[0].fields[0].blockers = []
    const blockedResultWithoutBlocker = validateFieldManifest(blockedWithoutBlocker, inventory)
    expect(codes(blockedResultWithoutBlocker)).toContain('field_manifest_blocked_without_blockers')
  })

  it('keeps default, evidence, checks, and rule fields structurally explicit', () => {
    const literalEmpty = baseManifest()
    literalEmpty.tables[0].fields[0].sourceDefault = { kind: 'literal', value: '' }
    expect(validateFieldManifest(literalEmpty, inventory).ok).toBe(true)

    const invalid = baseManifest()
    invalid.tables[0].fields[0].sourceDefault = { kind: 'expression' }
    invalid.tables[0].fields[1].checks = []
    invalid.tables[0].fields[1].evidence = ['']
    invalid.tables[0].fields[1].nullRule = ''
    invalid.tables[0].fields[1].relationRule = ''
    const result = validateFieldManifest(invalid, inventory)
    expect(codes(result)).toEqual(expect.arrayContaining([
      'field_manifest_default_value_required',
      'field_manifest_checks_invalid',
      'field_manifest_evidence_invalid',
      'field_manifest_null_rule_invalid',
      'field_manifest_relation_rule_invalid',
    ]))

    const nullWithValue = baseManifest()
    nullWithValue.tables[0].fields[0].sourceDefault = { kind: 'null', value: '' }
    expect(codes(validateFieldManifest(nullWithValue, inventory))).toContain('field_manifest_default_value_forbidden')
  })

  it('rejects executable manifests, invalid field types, and malformed roots safely', () => {
    const manifest = baseManifest()
    manifest.executable = true
    manifest.tables[0].fields[0].sourceNullable = 'true'
    manifest.tables[0].fields[0].sourceDefault = { kind: 'literal', value: 1 }
    const result = validateFieldManifest(manifest, inventory)
    expect(result.ok).toBe(false)
    expect(codes(result)).toEqual(expect.arrayContaining([
      'field_manifest_executable_forbidden',
      'field_manifest_source_nullable_invalid',
      'field_manifest_default_value_invalid',
    ]))

    for (const root of [null, undefined, 1, 'manifest', []]) {
      expect(validateFieldManifest(root, inventory)).toEqual({
        ok: false,
        errors: [{ code: 'field_manifest_root_invalid', path: '' }],
        counts: { tables: 0, columns: 0, blockedColumns: 0 },
      })
    }
  })
})

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateFieldManifest } from '../scripts/lib/v4-field-manifest.mjs'

const root = resolve(import.meta.dirname, '..')
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const manifest = readJson('docs/migration/m1-b2-identity-field-manifest-20260905.json')
const observation = readJson('docs/migration/m1-b2-identity-observation-20260905.json')
const inventory = readJson('docs/migration/m1-source-target-inventory-20260905.json')
const fields = manifest.tables.flatMap(table => table.fields)

describe('frozen B2 first-wave artifacts (offline only)', () => {
  it('covers the explicit eleven-table scope, without claiming backfill readiness', () => {
    expect(validateFieldManifest(manifest, inventory)).toEqual({
      ok: true,
      errors: [],
      counts: { tables: 11, columns: 148, blockedColumns: 138 },
    })
    expect(manifest.executable).toBe(false)
    expect(manifest.scopeTables).toEqual(Object.keys(observation.source))
    expect(manifest.source.snapshotId).toBe(observation.provenance.sourceSnapshotId)
    expect(manifest.source.serverUuid).toBe(observation.serverUuid)
    expect(manifest.source.mirrorDatabase).toBe(observation.sourceDatabase)
  })

  it('matches every observed source type, null, default, collation and ordered primary key', () => {
    for (const table of manifest.tables) {
      const observed = observation.source[table.sourceTable]
      expect(table.rowCount).toBe(observed.rowCount)
      expect(table.sourcePrimaryKey).toEqual(observed.indexes.filter(index => index[0] === 'PRIMARY').map(index => index[3]))
      expect(table.fields.map(field => field.sourceColumn)).toEqual(observed.columns.map(column => column.name))
      for (const field of table.fields) {
        const column = observed.columns.find(item => item.name === field.sourceColumn)
        expect(field.sourceType).toBe(column.type)
        expect(field.sourceCollation).toBe(column.collation)
        expect(field.sourceNullable).toBe(column.nullable === 'YES')
        expect(field.sourceDefault).toEqual(column.default === null
          ? { kind: 'null' }
          : { kind: column.extra.includes('DEFAULT_GENERATED') ? 'expression' : 'literal', value: column.default })
      }
    }
  })

  it('never presents a nonexistent physical target as an existing table column', () => {
    for (const field of fields) {
      if (field.target === null || /^(proposal|history-proposal|encrypted-snapshot):/.test(field.target)) continue
      const [table, column, extra] = field.target.split('.')
      expect(extra).toBeUndefined()
      expect(observation.target[table]?.columns.some(item => item.name === column)).toBe(true)
    }
  })

  it('binds each textual transform specification to its exact hash', () => {
    for (const transform of manifest.transforms) {
      const canonical = JSON.stringify({ id: transform.id, version: transform.version, rule: transform.rule })
      expect(transform.specSha256).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'))
      expect(transform.hashKind).toContain('not executable')
    }
  })

  it('links evidence to existing files, not invented repository modules', () => {
    for (const field of fields) {
      for (const evidence of field.evidence) {
        expect(existsSync(resolve(root, evidence.split('#')[0]))).toBe(true)
      }
    }
  })

  it('keeps unknown times, ownership intervals, observer policy and old runtime explicitly blocked', () => {
    for (const field of fields.filter(item => /^datetime/.test(item.sourceType))) {
      expect(field.timeKind).toBe('unknown')
      expect(field.blockers).toContain('G-TIME')
      expect(field.reviewStatus).toBe('blocked')
    }
    for (const tableName of ['mt5_account_ownership_history', 'ai_observer_channels', 'bridge_v3_terminal_sessions']) {
      const table = manifest.tables.find(item => item.sourceTable === tableName)
      expect(table.fields.every(field => field.reviewStatus === 'blocked')).toBe(true)
    }
    const users = manifest.tables.find(table => table.sourceTable === 'users')
    expect(users.fields.find(field => field.sourceColumn === 'referral_credit').transformId).toBe('b2.decimal')
    expect(users.fields.find(field => field.sourceColumn === 'referred_by').relationRule).toContain('NOT users.id')
    expect(observation.checks.users_nonzero_referral_credit).toBe('1')
    expect(observation.checks.bridge_sessions_missing_installation).toBe('7')
  })
})

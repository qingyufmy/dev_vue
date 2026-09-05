import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrationPlan, sha256, splitSqlStatements, validateMigrationStatement } from '../scripts/lib/v4-migration-plan.mjs'

const root = join(import.meta.dirname, '..')
const migrationId = '20260905_022_observer_management_ledger'
const migrationPath = join(root, 'server/db/migrations', `${migrationId}.sql`)
const migration = readFileSync(migrationPath, 'utf8')
const statements = splitSqlStatements(migration)
const [createRegistry, seedRegistry, createOperations] = statements

describe('V4 observer management coordination and operation ledger migration', () => {
  it('is migration 022 after the fixed 021 boundary with the reviewed statement count', async () => {
    const plan = await loadMigrationPlan({ rootDirectory: root })

    expect(plan).toHaveLength(24)
    expect(plan[21].id).toBe('20260905_021_observer_sources_and_audiences')
    expect(plan[22]).toMatchObject({ id: migrationId, file: `${migrationId}.sql` })
    expect(plan[22].statements).toHaveLength(3)
    expect(plan[22].statements).toEqual(statements)
    expect(plan[23].id).toBe('20260906_023_bridge_profile_epoch_scope')
    expect(plan.reduce((total, item) => total + item.statements.length, 0)).toBe(158)
  })

  it('creates a single-row registry with an explicit zero revision', () => {
    expect(createRegistry).toMatch(/^CREATE TABLE observer_management_registry\s*\(/i)
    expect(createRegistry).not.toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
    expect(createRegistry).toMatch(/ENGINE\s*=\s*InnoDB\s+DEFAULT\s+CHARSET=utf8mb4\s+COLLATE=utf8mb4_unicode_ci$/i)
    expect(columnDefinition(createRegistry, 'id')).toMatch(/^TINYINT\s+UNSIGNED\s+NOT\s+NULL$/i)
    expect(columnDefinition(createRegistry, 'revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+DEFAULT\s+0$/i)
    expect(createRegistry).toMatch(/PRIMARY KEY\s*\(id\)/i)
    expect(createRegistry).toMatch(/CHECK\s*\(id\s*=\s*1\)/i)
    expect(createRegistry).not.toMatch(/\b(?:AUTO_INCREMENT|INSERT|UPDATE|DELETE|DROP|FOREIGN KEY)\b/i)
  })

  it('allows only the exact reviewed registry seed and rejects all other INSERT statements', () => {
    expect(seedRegistry).toBe('INSERT INTO observer_management_registry (id,revision) VALUES (1,0)')
    expect(sha256(seedRegistry)).toBe('d5f205b290811a4f861fe7b3e57aff74964c12bb9ce6d2dbc9bca039d8b793e3')
    expect(() => validateMigrationStatement(seedRegistry, migrationId)).not.toThrow()
    expect(() => validateMigrationStatement(seedRegistry.replace('(1,0)', '(1,1)'), migrationId))
      .toThrow('migration_statement_unapproved')
    expect(() => validateMigrationStatement(seedRegistry, '20260905_021_observer_sources_and_audiences'))
      .toThrow('migration_statement_unapproved')
    expect(() => validateMigrationStatement('INSERT INTO observer_management_operations (id) VALUES (\'x\')', migrationId))
      .toThrow('migration_statement_unapproved')
  })

  it('creates an actor-scoped idempotent operation ledger with only an actor foreign key', () => {
    expect(createOperations).toMatch(/^CREATE TABLE observer_management_operations\s*\(/i)
    expect(createOperations).not.toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
    expect(createOperations).toMatch(/ENGINE\s*=\s*InnoDB\s+DEFAULT\s+CHARSET=utf8mb4\s+COLLATE=utf8mb4_unicode_ci$/i)
    expect(columnDefinition(createOperations, 'id')).toMatch(/^CHAR\(36\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createOperations, 'actor_user_id')).toMatch(/^INT\s+NOT\s+NULL$/i)
    expect(columnDefinition(createOperations, 'idempotency_key')).toMatch(/^VARCHAR\(128\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createOperations, 'request_hash')).toMatch(/^CHAR\(64\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createOperations, 'action')).toMatch(/^VARCHAR\(40\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createOperations, 'target_id')).toMatch(/^VARCHAR\(191\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createOperations, 'result_json')).toMatch(/^JSON\s+NOT\s+NULL$/i)
    expect(columnDefinition(createOperations, 'audit_json')).toMatch(/^JSON\s+NOT\s+NULL$/i)
    expect(columnDefinition(createOperations, 'created_at_utc')).toMatch(/^DATETIME\(3\)\s+NOT\s+NULL$/i)
    expect(createOperations).toMatch(/PRIMARY KEY\s*\(id\)/i)
    expect(createOperations).toMatch(/UNIQUE KEY\s+uk_observer_management_operations_actor_key\s*\(actor_user_id,\s*idempotency_key\)/i)
    expect(createOperations).toMatch(/KEY\s+idx_observer_management_operations_created\s*\(created_at_utc,\s*id\)/i)
    expect(createOperations).toMatch(/CONSTRAINT\s+fk_observer_management_operations_actor\s+FOREIGN KEY\s*\(actor_user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(createOperations).not.toMatch(/FOREIGN KEY\s*\(target_id\)/i)
    const definitionBody = createOperations.slice(0, createOperations.lastIndexOf(') ENGINE'))
    expect(definitionBody).not.toMatch(/\b(?:AUTO_INCREMENT|DEFAULT|ON\s+(?:DELETE|UPDATE)|CASCADE)\b/i)
  })

  it('contains no source, channel, grant or public-data seed and validates all three statements', () => {
    for (const statement of statements) expect(() => validateMigrationStatement(statement, migrationId)).not.toThrow()
    const executable = migration.replace(/--[^\n]*/g, '')
    expect(executable).not.toMatch(/observer_(?:sources|channels|channel_accesses)|trading_accounts|market_|public/i)
    expect(executable).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|GRANT|REVOKE)\s+(?!INTO\s+observer_management_registry\b)/i)
  })
})

function columnDefinition(statement, column) {
  const pattern = new RegExp(`^${column}\\s+`, 'i')
  const line = statement.split('\n').map(value => value.trim()).find(value => pattern.test(value))
  expect(line, `missing column ${column}`).toBeTruthy()
  return line.replace(/,\s*$/, '').replace(pattern, '').trim()
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrationPlan, splitSqlStatements, validateMigrationStatement } from '../scripts/lib/v4-migration-plan.mjs'

const root = join(import.meta.dirname, '..')
const migrationId = '20260905_020_account_projection_and_history_provenance'
const migrationPath = join(root, 'server/db/migrations', `${migrationId}.sql`)
const migration = readFileSync(migrationPath, 'utf8')
const statements = splitSqlStatements(migration)
const [createProvenance, alterTradeRecords] = statements
const projectionMigration = readFileSync(join(root, 'server/db/migrations/20260903_003_trading_context_and_market_projection.sql'), 'utf8')
const historyMigration = readFileSync(join(root, 'server/db/migrations/20260904_013_authoritative_trade_history.sql'), 'utf8')

describe('V4 account projection provenance schema migration', () => {
  it('is the final migration after the fixed 019 ownership boundary', async () => {
    const plan = await loadMigrationPlan({ rootDirectory: root })

    expect(plan).toHaveLength(24)
    expect(plan[19].id).toBe('20260905_019_account_ownership_intervals')
    expect(plan[20]).toMatchObject({ id: migrationId, file: `${migrationId}.sql` })
    expect(plan[21].id).toBe('20260905_021_observer_sources_and_audiences')
    expect(plan[22].id).toBe('20260905_022_observer_management_ledger')
    expect(plan[23].id).toBe('20260906_023_bridge_profile_epoch_scope')
    expect(plan[20].statements).toHaveLength(2)
    expect(plan[20].statements).toEqual(statements)
  })

  it('creates strict provenance rows with explicit ownership, terminal and projection facts', () => {
    expect(createProvenance).toMatch(/^CREATE TABLE trading_projection_provenance_v4\s*\(/i)
    expect(createProvenance).not.toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
    expect(createProvenance).toMatch(/ENGINE\s*=\s*InnoDB\s+DEFAULT\s+CHARSET=utf8mb4\s+COLLATE=utf8mb4_unicode_ci$/i)

    expect(columnDefinition(createProvenance, 'trading_account_id')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'resource_kind')).toMatch(/^VARCHAR\(64\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'resource_id')).toMatch(/^VARCHAR\(191\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'user_id')).toMatch(/^INT\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'ownership_interval_id')).toMatch(/^CHAR\(36\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'ownership_revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'terminal_profile_id')).toMatch(/^VARCHAR\(128\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'terminal_instance_id')).toMatch(/^VARCHAR\(128\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'connection_epoch')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'projection_revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL$/i)
    expect(columnDefinition(createProvenance, 'observed_at_utc')).toMatch(/^DATETIME\(3\)\s+NOT\s+NULL$/i)

    expect(createProvenance).toMatch(/PRIMARY KEY\s*\(trading_account_id,\s*resource_kind,\s*resource_id\)/i)
    expect(createProvenance).toMatch(/FOREIGN KEY\s*\(trading_account_id,\s*resource_kind,\s*resource_id\)\s+REFERENCES\s+trading_projection_revisions\s*\(trading_account_id,\s*resource_kind,\s*resource_id\)/i)
    expect(createProvenance).toMatch(/FOREIGN KEY\s*\(user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(createProvenance).toMatch(/FOREIGN KEY\s*\(ownership_interval_id\)\s+REFERENCES\s+trading_account_ownership_intervals\s*\(id\)/i)
    expect(createProvenance).toMatch(/FOREIGN KEY\s*\(terminal_profile_id\)\s+REFERENCES\s+terminal_profiles\s*\(id\)/i)
    expect(createProvenance).toMatch(/CHECK\s*\(resource_kind\s+IN\s*\('account\.metrics','positions','pending_orders'\)\)/i)
    const definitionBody = createProvenance.slice(0, createProvenance.lastIndexOf(') ENGINE'))
    expect(definitionBody).not.toMatch(/\b(?:DEFAULT|AUTO_INCREMENT|ON\s+(?:DELETE|UPDATE)|CASCADE)\b/i)
  })

  it('keeps resource, profile and terminal identity widths compatible with their existing V4 tables', () => {
    const projectionRevisions = createTable(projectionMigration, 'trading_projection_revisions')
    const terminalProfiles = createTable(projectionMigration, 'terminal_profiles')
    const terminalBindings = createTable(projectionMigration, 'terminal_account_bindings')
    const tradeRecords = createTable(historyMigration, 'account_trade_records_v4')

    expect(typeWidth(columnDefinition(createProvenance, 'resource_kind'))).toEqual(typeWidth(columnDefinition(projectionRevisions, 'resource_kind')))
    expect(typeWidth(columnDefinition(createProvenance, 'resource_id'))).toEqual(typeWidth(columnDefinition(projectionRevisions, 'resource_id')))
    expect(typeWidth(columnDefinition(createProvenance, 'terminal_profile_id'))).toEqual(typeWidth(columnDefinition(terminalProfiles, 'id')))
    expect(typeWidth(columnDefinition(createProvenance, 'terminal_instance_id'))).toEqual(typeWidth(columnDefinition(terminalBindings, 'terminal_instance_id')))
    expect(typeWidth(columnDefinition(alterTradeRecords, 'ownership_interval_id'))).toEqual(['char', 36])
    expect(typeWidth(columnDefinition(alterTradeRecords, 'user_id'))).toEqual(typeWidth(columnDefinition(tradeRecords, 'user_id')))
  })

  it('adds only nullable ownership provenance to trade records without writing or deleting data', () => {
    expect(alterTradeRecords).toMatch(/^ALTER TABLE account_trade_records_v4\b/i)
    expect((alterTradeRecords.match(/\bALTER TABLE\b/gi) ?? [])).toHaveLength(1)
    expect(alterTradeRecords).toMatch(/MODIFY COLUMN user_id\s+INT\s+NULL/i)
    expect(alterTradeRecords).toMatch(/ADD COLUMN ownership_interval_id\s+CHAR\(36\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NULL/i)
    expect(alterTradeRecords).toMatch(/ADD KEY idx_trade_record_ownership_interval\s*\(ownership_interval_id\)/i)
    expect(alterTradeRecords).toMatch(/FOREIGN KEY\s*\(ownership_interval_id\)\s+REFERENCES\s+trading_account_ownership_intervals\s*\(id\)/i)
    expect(alterTradeRecords).not.toMatch(/\b(?:DEFAULT|AUTO_INCREMENT|DROP|DELETE|INSERT|REPLACE|UPDATE|TRUNCATE|SELECT|CALL|RENAME|CHANGE|ON\s+(?:DELETE|UPDATE)|CASCADE)\b/i)
  })

  it('contains exactly two approved DDL statements and validates under the migration gate', () => {
    expect(statements).toHaveLength(2)
    for (const statement of statements) expect(() => validateMigrationStatement(statement, migrationId)).not.toThrow()

    const executable = migration.replace(/--[^\n]*/g, '')
    expect(executable).not.toMatch(/\b(?:INSERT|REPLACE|UPDATE|DELETE|TRUNCATE|SELECT|CALL|GRANT|REVOKE|USE)\b/i)
    expect(executable).not.toMatch(/\bON\s+(?:DELETE|UPDATE)\b/i)
    expect(executable).not.toMatch(/\b(?:IF\s+NOT\s+EXISTS|DROP\s+TABLE|DROP\s+COLUMN)\b/i)
  })
})

function createTable(source, table) {
  const match = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${table}\\s*\\([\\s\\S]*?\\)\\s+ENGINE`, 'i').exec(source)
  expect(match, `missing source table ${table}`).toBeTruthy()
  return match[0]
}

function columnDefinition(statement, column) {
  const prefix = `(?:(?:ADD|MODIFY)\\s+COLUMN\\s+)?`
  const pattern = new RegExp(`^${prefix}${column}\\s+`, 'i')
  const line = statement.split('\n').map(value => value.trim()).find(value => pattern.test(value))
  expect(line, `missing column ${column}`).toBeTruthy()
  return line.replace(/,\s*$/, '').replace(pattern, '').trim()
}

function typeWidth(definition) {
  const match = /^(?<type>[a-z]+)(?:\((?<size>\d+)\))?/i.exec(definition)
  expect(match, `missing type in ${definition}`).toBeTruthy()
  return [match.groups.type.toLowerCase(), match.groups.size ? Number(match.groups.size) : null]
}

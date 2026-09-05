import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrationPlan, splitSqlStatements, validateMigrationStatement } from '../scripts/lib/v4-migration-plan.mjs'

const root = join(import.meta.dirname, '..')
const migrationId = '20260905_021_observer_sources_and_audiences'
const migrationPath = join(root, 'server/db/migrations', `${migrationId}.sql`)
const migration = readFileSync(migrationPath, 'utf8')
const statements = splitSqlStatements(migration)
const [createSources, alterChannels, alterAccesses] = statements
const existingProjection = readFileSync(join(root, 'server/db/migrations/20260903_003_trading_context_and_market_projection.sql'), 'utf8')

describe('V4 observer source and audience authorization migration', () => {
  it('is the final migration after the fixed 019 and 020 boundaries', async () => {
    const plan = await loadMigrationPlan({ rootDirectory: root })

    expect(plan).toHaveLength(23)
    expect(plan[19].id).toBe('20260905_019_account_ownership_intervals')
    expect(plan[20].id).toBe('20260905_020_account_projection_and_history_provenance')
    expect(plan[21]).toMatchObject({ id: migrationId, file: `${migrationId}.sql` })
    expect(plan[21].statements).toHaveLength(3)
    expect(plan[21].statements).toEqual(statements)
    expect(plan[22].id).toBe('20260905_022_observer_management_ledger')
  })

  it('creates observer sources with explicit ownership, safe disabled/pending defaults and required foreign keys', () => {
    expect(createSources).toMatch(/^CREATE TABLE observer_sources\s*\(/i)
    expect(createSources).not.toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
    expect(createSources).toMatch(/ENGINE\s*=\s*InnoDB\s+DEFAULT\s+CHARSET=utf8mb4\s+COLLATE=utf8mb4_unicode_ci$/i)

    expect(columnDefinition(createSources, 'id')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+AUTO_INCREMENT$/i)
    expect(columnDefinition(createSources, 'display_name')).toMatch(/^VARCHAR\(80\)\s+NOT\s+NULL$/i)
    expect(columnDefinition(createSources, 'notes')).toMatch(/^VARCHAR\(255\)\s+NULL$/i)
    expect(columnDefinition(createSources, 'operator_user_id')).toMatch(/^INT\s+NOT\s+NULL$/i)
    expect(columnDefinition(createSources, 'trading_account_id')).toMatch(/^BIGINT\s+UNSIGNED\s+NULL$/i)
    expect(columnDefinition(createSources, 'analysis_strategy_id')).toMatch(/^BIGINT\s+UNSIGNED\s+NULL$/i)
    expect(columnDefinition(createSources, 'status')).toMatch(/^ENUM\('active','disabled'\)\s+NOT\s+NULL\s+DEFAULT\s+'disabled'$/i)
    expect(columnDefinition(createSources, 'configuration_status')).toMatch(/^ENUM\('pending','ready'\)\s+NOT\s+NULL\s+DEFAULT\s+'pending'$/i)
    expect(columnDefinition(createSources, 'created_by_user_id')).toMatch(/^INT\s+NOT\s+NULL$/i)
    expect(columnDefinition(createSources, 'revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+DEFAULT\s+1$/i)

    expect(createSources).toMatch(/PRIMARY KEY\s*\(id\)/i)
    expect(createSources).toMatch(/KEY\s+idx_observer_source_operator\s*\(operator_user_id,id\)/i)
    expect(createSources).toMatch(/KEY\s+idx_observer_source_account\s*\(trading_account_id,id\)/i)
    expect(createSources).toMatch(/FOREIGN KEY\s*\(operator_user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(createSources).toMatch(/FOREIGN KEY\s*\(trading_account_id\)\s+REFERENCES\s+trading_accounts\s*\(id\)/i)
    expect(createSources).toMatch(/FOREIGN KEY\s*\(analysis_strategy_id\)\s+REFERENCES\s+strategies\s*\(id\)/i)
    expect(createSources).toMatch(/FOREIGN KEY\s*\(created_by_user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(createSources).toMatch(/CHECK\s*\(configuration_status\s*<>\s*'ready'\s+OR\s+trading_account_id\s+IS\s+NOT\s+NULL\)/i)
    expect(createSources).not.toMatch(/\bON\s+(?:DELETE|UPDATE)\b|\bCASCADE\b/i)
  })

  it('evolves channels with nullable legacy source, non-public defaults and unique slug/default slots', () => {
    const existingChannels = createTable(existingProjection, 'observer_channels')

    expect(alterChannels).toMatch(/^ALTER TABLE observer_channels\b/i)
    expect(columnDefinition(alterChannels, 'source_trading_account_id')).toMatch(/^BIGINT\s+UNSIGNED\s+NULL$/i)
    expect(columnDefinition(alterChannels, 'active')).toMatch(/^TINYINT\(1\)\s+NOT\s+NULL\s+DEFAULT\s+0$/i)
    expect(columnDefinition(alterChannels, 'source_id')).toMatch(/^BIGINT\s+UNSIGNED\s+NULL$/i)
    expect(columnDefinition(alterChannels, 'slug')).toMatch(/^VARCHAR\(64\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NULL$/i)
    expect(columnDefinition(alterChannels, 'description')).toMatch(/^VARCHAR\(255\)\s+NULL$/i)
    expect(columnDefinition(alterChannels, 'audience')).toMatch(/^ENUM\('all','plus','pro','assigned'\)\s+NOT\s+NULL\s+DEFAULT\s+'assigned'$/i)
    expect(columnDefinition(alterChannels, 'is_default')).toMatch(/^TINYINT\(1\)\s+NOT\s+NULL\s+DEFAULT\s+0$/i)
    expect(columnDefinition(alterChannels, 'default_slot')).toMatch(/^TINYINT\s+GENERATED ALWAYS AS\s*\(CASE\s+WHEN\s+is_default=1\s+THEN\s+1\s+ELSE\s+NULL\s+END\)\s+STORED$/i)
    expect(columnDefinition(alterChannels, 'sort_order')).toMatch(/^INT\s+NOT\s+NULL\s+DEFAULT\s+0$/i)
    expect(columnDefinition(alterChannels, 'updated_at_utc')).toMatch(/^DATETIME\(3\)\s+NULL$/i)
    expect(columnDefinition(alterChannels, 'revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+DEFAULT\s+1$/i)

    expect(existingChannels).toMatch(/FOREIGN KEY\s*\(source_trading_account_id\)\s+REFERENCES\s+trading_accounts\s*\(id\)/i)
    expect(existingChannels).toMatch(/FOREIGN KEY\s*\(created_by_user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(alterChannels).toMatch(/ADD UNIQUE KEY uk_observer_channel_slug\s*\(slug\)/i)
    expect(alterChannels).toMatch(/ADD UNIQUE KEY uk_observer_channel_default\s*\(default_slot\)/i)
    expect(alterChannels).toMatch(/ADD KEY idx_observer_channel_source\s*\(source_id,id\)/i)
    expect(alterChannels).toMatch(/FOREIGN KEY\s*\(source_id\)\s+REFERENCES\s+observer_sources\s*\(id\)/i)
    expect(alterChannels).toMatch(/CHECK\s*\(is_default\s+IN\s*\(0,1\)\)/i)
    expect(alterChannels).not.toMatch(/\b(?:INSERT|REPLACE|UPDATE|DELETE|TRUNCATE|SELECT|CALL|DROP|RENAME|CHANGE)\b/i)
    expect(columnDefinition(alterChannels, 'audience')).not.toMatch(/DEFAULT\s+'(?:all|plus|pro)'/i)
    expect(columnDefinition(alterChannels, 'is_default')).not.toMatch(/DEFAULT\s+1/i)
  })

  it('adds access grant provenance and revision while preserving the source/user composite authorization key', () => {
    const existingAccesses = createTable(existingProjection, 'observer_channel_accesses')

    expect(existingAccesses).toMatch(/PRIMARY KEY\s*\(observer_channel_id,\s*user_id\)/i)
    expect(existingAccesses).toMatch(/FOREIGN KEY\s*\(observer_channel_id\)\s+REFERENCES\s+observer_channels\s*\(id\)/i)
    expect(existingAccesses).toMatch(/FOREIGN KEY\s*\(user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(alterAccesses).toMatch(/^ALTER TABLE observer_channel_accesses\b/i)
    expect(columnDefinition(alterAccesses, 'granted_by_user_id')).toMatch(/^INT\s+NULL$/i)
    expect(columnDefinition(alterAccesses, 'revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+DEFAULT\s+1$/i)
    expect(alterAccesses).toMatch(/FOREIGN KEY\s*\(granted_by_user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(alterAccesses).not.toMatch(/\b(?:INSERT|REPLACE|UPDATE|DELETE|TRUNCATE|SELECT|CALL|DROP|RENAME|CHANGE)\b/i)
    expect(alterAccesses).not.toMatch(/\bON\s+(?:DELETE|UPDATE)\b|\bCASCADE\b/i)
  })

  it('contains exactly three approved DDL statements and no data movement or automatic audience publication', () => {
    expect(statements).toHaveLength(3)
    for (const statement of statements) expect(() => validateMigrationStatement(statement, migrationId)).not.toThrow()

    const executable = migration.replace(/--[^\n]*/g, '')
    expect(executable).not.toMatch(/\b(?:INSERT|REPLACE|UPDATE|DELETE|TRUNCATE|SELECT|CALL|GRANT|REVOKE|USE)\b/i)
    expect(executable).not.toMatch(/\bON\s+(?:DELETE|UPDATE)\b|\bCASCADE\b/i)
    expect(executable).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|RENAME|CHANGE)\b/i)
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

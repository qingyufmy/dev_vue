import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrationPlan, splitSqlStatements, validateMigrationStatement } from '../scripts/lib/v4-migration-plan.mjs'

const root = join(import.meta.dirname, '..')
const migrationId = '20260905_019_account_ownership_intervals'
const migrationPath = join(root, 'server/db/migrations', `${migrationId}.sql`)
const sourceObservation = JSON.parse(readFileSync(join(root, 'docs/migration/m1-b2-identity-observation-20260905.json'), 'utf8'))
const migration = readFileSync(migrationPath, 'utf8')
const statements = splitSqlStatements(migration)
const [alterAccounts, createIntervals, alterOwnerships, createSettings] = statements
const sourceAccounts = new Map(sourceObservation.source.trading_accounts.columns.map(column => [column.name, column]))

describe('V4 account ownership and per-user account settings migration', () => {
  it('is migration 019 at the fixed pre-provenance boundary and contains exactly the four approved DDL statements in order', async () => {
    const plan = (await loadMigrationPlan({ rootDirectory: root })).slice(0, 24)
    const migration = plan[19]

    expect(migration).toMatchObject({ id: migrationId, file: `${migrationId}.sql` })
    expect(plan.at(-1).id).toBe('20260906_023_bridge_profile_epoch_scope')
    expect(migration.statements).toHaveLength(4)
    expect(migration.statements).toEqual(statements)
    for (const statement of statements) expect(() => validateMigrationStatement(statement, migrationId)).not.toThrow()
    expect(statements.map(statement => statement.match(/^(ALTER TABLE|CREATE TABLE)\s+([a-z0-9_]+)/i)?.[2])).toEqual([
      'trading_accounts', 'trading_account_ownership_intervals', 'trading_account_ownerships', 'user_trading_account_settings',
    ])
  })

  it('extends trading_accounts without narrowing the observed margin mode and keeps ownership revision explicit', () => {
    expect(alterAccounts).toMatch(/^ALTER TABLE trading_accounts\b/i)
    expect((alterAccounts.match(/\bALTER TABLE\b/gi) ?? [])).toHaveLength(1)

    const additions = readAddedColumns(alterAccounts)
    expect([...additions.keys()]).toEqual(['margin_mode', 'ownership_revision'])
    expect(additions.get('margin_mode')).toMatch(/^VARCHAR\(20\).*\bNULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('ownership_revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+DEFAULT\s+1$/i)
    expectColumnCompatible(additions.get('margin_mode'), sourceAccounts.get('margin_mode'), { allowNullableExpansion: true })
    expect(alterAccounts).not.toMatch(/\b(?:DROP|MODIFY|CHANGE|RENAME)\b/i)
  })

  it('preserves source account field widths, collations and facts in the settings projection', () => {
    const settings = readTableColumns(createSettings)
    const mappings = [
      ['nickname', 'nickname'],
      ['review_status', 'review_status'],
      ['observe_status', 'observe_status'],
      ['anomaly_code', 'anomaly_code'],
      ['legacy_is_deleted', 'is_deleted'],
      ['observed_until_utc', 'observed_until'],
      ['identity_verified_at_utc', 'identity_verified_at'],
      ['first_verified_at_utc', 'first_verified_at'],
    ]

    for (const [target, source] of mappings) {
      expectColumnCompatible(settings.get(target), sourceAccounts.get(source), { allowNullableExpansion: true })
    }
    expect(settings.get('nickname')).toMatch(/CHARACTER\s+SET\s+utf8mb4\s+COLLATE\s+utf8mb4_0900_ai_ci/i)
    expect(settings.get('review_status')).toMatch(/CHARACTER\s+SET\s+utf8mb4\s+COLLATE\s+utf8mb4_0900_ai_ci/i)
    expect(settings.get('observe_status')).toMatch(/CHARACTER\s+SET\s+utf8mb4\s+COLLATE\s+utf8mb4_0900_ai_ci/i)
    expect(settings.get('anomaly_code')).toMatch(/CHARACTER\s+SET\s+utf8mb4\s+COLLATE\s+utf8mb4_0900_ai_ci/i)
    expect(settings.get('legacy_is_deleted')).toMatch(/^TINYINT\s+NULL\s+DEFAULT\s+NULL$/i)
    for (const column of ['observed_until_utc', 'identity_verified_at_utc', 'first_verified_at_utc']) {
      expect(settings.get(column)).toMatch(/^DATETIME\(3\)\s+NULL\s+DEFAULT\s+NULL$/i)
    }
  })

  it('creates strict ownership intervals with source relationships, stable origin idempotency and bounded period checks', () => {
    expect(createIntervals).toMatch(/^CREATE TABLE trading_account_ownership_intervals\s*\(/i)
    expect(createIntervals).not.toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
    expect(createIntervals).toMatch(/ENGINE\s*=\s*InnoDB\s+DEFAULT\s+CHARSET=utf8mb4\s+COLLATE=utf8mb4_unicode_ci$/i)

    const columns = readTableColumns(createIntervals)
    expect(columns.get('id')).toMatch(/^CHAR\(36\).*CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columns.get('user_id')).toMatch(/^INT\s+NOT\s+NULL$/i)
    expect(columns.get('trading_account_id')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL$/i)
    expect(columns.get('role')).toMatch(/^ENUM\('owner','observer_source'\)\s+NOT\s+NULL$/i)
    expect(columns.get('started_at_utc')).toMatch(/^DATETIME\(3\)\s+NOT\s+NULL$/i)
    expect(columns.get('ended_at_utc')).toMatch(/^DATETIME\(3\)\s+NULL$/i)
    expect(columns.get('end_reason')).toMatch(/^VARCHAR\(64\).*\bNULL$/i)
    expect(columns.get('origin_kind')).toMatch(/^ENUM\('legacy','runtime'\)\s+NOT\s+NULL$/i)
    expect(columns.get('origin_ref')).toMatch(/^VARCHAR\(191\).*CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL$/i)
    expect(columns.get('created_at_utc')).toMatch(/^DATETIME\(3\)\s+NOT\s+NULL$/i)
    expect(columns.get('updated_at_utc')).toMatch(/^DATETIME\(3\)\s+NOT\s+NULL$/i)

    expect(createIntervals).toMatch(/PRIMARY KEY\s*\(id\)/i)
    expect(createIntervals).toMatch(/UNIQUE KEY\s+\w+\s*\(origin_kind,\s*origin_ref\)/i)
    expect(createIntervals).toMatch(/UNIQUE KEY\s+\w+\s*\(id,\s*user_id,\s*trading_account_id,\s*role\)/i)
    expect(createIntervals).toMatch(/KEY\s+\w+\s*\(user_id,\s*trading_account_id,\s*started_at_utc,\s*id\)/i)
    expect(createIntervals).toMatch(/KEY\s+\w+\s*\(trading_account_id,\s*started_at_utc,\s*id\)/i)
    expect(createIntervals).toMatch(/CONSTRAINT\s+\w+\s+FOREIGN KEY\s*\(user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(createIntervals).toMatch(/CONSTRAINT\s+\w+\s+FOREIGN KEY\s*\(trading_account_id\)\s+REFERENCES\s+trading_accounts\s*\(id\)/i)
    expect(createIntervals).toMatch(/CHECK\s*\(ended_at_utc\s+IS\s+NULL\s+OR\s+ended_at_utc\s+>=\s+started_at_utc\)/i)
    for (const column of ['role', 'origin_kind', 'started_at_utc', 'created_at_utc', 'updated_at_utc']) {
      expect(columns.get(column)).not.toMatch(/\b(?:DEFAULT|NOW|CURRENT_TIMESTAMP)\b/i)
    }
  })

  it('uses an open-owner generated key that distinguishes ended intervals from revoked current grants', () => {
    const intervalExpression = generatedExpression(createIntervals, 'open_owner_account_id')
    const grantExpression = generatedExpression(alterOwnerships, 'open_owner_account_id')

    expect(intervalExpression).toMatch(/role\s*=\s*'owner'/i)
    expect(intervalExpression).toMatch(/ended_at_utc\s+IS\s+NULL/i)
    expect(intervalExpression).toMatch(/THEN\s+trading_account_id/i)
    expect(intervalExpression).toMatch(/ELSE\s+NULL/i)
    expect(intervalExpression).not.toMatch(/revoked_at_utc/i)

    expect(grantExpression).toMatch(/role\s*=\s*'owner'/i)
    expect(grantExpression).toMatch(/revoked_at_utc\s+IS\s+NULL/i)
    expect(grantExpression).toMatch(/THEN\s+trading_account_id/i)
    expect(grantExpression).toMatch(/ELSE\s+NULL/i)
    expect(grantExpression).not.toMatch(/ended_at_utc/i)

    expect(createIntervals).toMatch(/GENERATED ALWAYS AS\s*\([\s\S]*?\)\s+STORED/i)
    expect(createIntervals).toMatch(/UNIQUE KEY\s+\w+\s*\(open_owner_account_id\)/i)
    expect(createIntervals).not.toMatch(/UNIQUE KEY\s+\w+\s*\([^)]*(?:started_at_utc|ended_at_utc)[^)]*\)/i)
  })

  it('adds only a nullable interval projection and revision to current grants, preserving the old composite primary key', () => {
    expect(alterOwnerships).toMatch(/^ALTER TABLE trading_account_ownerships\b/i)
    const additions = readAddedColumns(alterOwnerships)
    expect([...additions.keys()]).toEqual(['interval_id', 'revision', 'open_owner_account_id'])
    expect(additions.get('interval_id')).toMatch(/^CHAR\(36\).*CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NULL$/i)
    expect(additions.get('interval_id')).not.toMatch(/DEFAULT/i)
    expect(additions.get('revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+DEFAULT\s+1$/i)
    expect(additions.get('open_owner_account_id')).toMatch(/GENERATED ALWAYS AS/i)
    expect(alterOwnerships).not.toMatch(/PRIMARY KEY|DROP|MODIFY|CHANGE|RENAME/i)
    expect(alterOwnerships).toMatch(/UNIQUE KEY\s+\w+\s*\(open_owner_account_id\)/i)
    expect(alterOwnerships).toMatch(/KEY\s+idx_account_owners_interval_fk\s*\(interval_id,\s*user_id,\s*trading_account_id,\s*role\)/i)
    expect(alterOwnerships).toMatch(/FOREIGN KEY\s*\(interval_id,\s*user_id,\s*trading_account_id,\s*role\)\s+REFERENCES\s+trading_account_ownership_intervals\s*\(id,\s*user_id,\s*trading_account_id,\s*role\)/i)
    expect(alterOwnerships).not.toMatch(/FOREIGN KEY\s*\(interval_id\)\s+REFERENCES/i)
    expect(alterOwnerships).not.toMatch(/ON\s+(?:DELETE|UPDATE)/i)
  })

  it('gives settings a user-account key, preserves nullable legacy facts and does not impose user-only uniqueness', () => {
    expect(createSettings).toMatch(/^CREATE TABLE user_trading_account_settings\s*\(/i)
    expect(createSettings).not.toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
    expect(createSettings).toMatch(/PRIMARY KEY\s*\(user_id,\s*trading_account_id\)/i)
    expect(createSettings).toMatch(/FOREIGN KEY\s*\(user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(createSettings).toMatch(/FOREIGN KEY\s*\(trading_account_id\)\s+REFERENCES\s+trading_accounts\s*\(id\)/i)
    expect(createSettings).toMatch(/KEY\s+idx_user_trading_account_settings_account\s*\(trading_account_id,\s*user_id\)/i)
    expect(createSettings).toMatch(/hidden\s+TINYINT\s+NOT\s+NULL\s+DEFAULT\s+0/i)
    expect(createSettings).toMatch(/connection_paused\s+TINYINT\s+NOT\s+NULL\s+DEFAULT\s+0/i)
    expect(createSettings).toMatch(/CHECK\s*\(hidden\s+IN\s*\(0,\s*1\)\)/i)
    expect(createSettings).toMatch(/CHECK\s*\(connection_paused\s+IN\s*\(0,\s*1\)\)/i)
    expect(createSettings).not.toMatch(/UNIQUE\s+KEY/i)
    expect(createSettings).not.toMatch(/ON\s+(?:DELETE|UPDATE)/i)
  })

  it('contains only the four DDL statements and no Telegram, data movement, cascade or field deletion', () => {
    const executable = migration.replace(/--[^\n]*/g, '')
    expect(executable).not.toMatch(/telegram/i)
    expect(executable).not.toMatch(/\b(?:INSERT|REPLACE|UPDATE|DELETE|DROP|TRUNCATE|SELECT|CALL|GRANT|REVOKE|MODIFY|CHANGE|RENAME)\b/i)
    expect(executable).not.toMatch(/\b(?:CURRENT_TIMESTAMP|NOW|HTTP|REDIS|BRIDGE|SEED|BACKFILL)\b/i)
    expect(executable).not.toMatch(/\bON\s+(?:DELETE|UPDATE)\b/i)
    expect(statements).toHaveLength(4)
  })
})

function readAddedColumns(statement) {
  return new Map([...statement.matchAll(/^\s*ADD COLUMN\s+([a-z][a-z0-9_]*)\s+(.+)$/gim)]
    .map(([, name, definition]) => [name, definition.replace(/,\s*$/, '').trim()]))
}

function readTableColumns(statement) {
  const body = statement.slice(statement.indexOf('(') + 1, statement.lastIndexOf(')'))
  return new Map(body.split('\n')
    .map(line => line.trim())
    .filter(line => /^[a-z][a-z0-9_]*\s+/i.test(line) && !/^(?:CASE|WHEN|THEN|ELSE|END)\b/i.test(line))
    .map(line => {
      const match = /^([a-z][a-z0-9_]*)\s+(.+)$/i.exec(line.replace(/,\s*$/, ''))
      return [match[1], match[2]]
    }))
}

function generatedExpression(statement, column) {
  const match = new RegExp(`${column}\\s+[^\\n]+?GENERATED ALWAYS AS\\s*\\(([\\s\\S]*?)\\)\\s+STORED`, 'i').exec(statement)
  expect(match, `missing generated column ${column}`).toBeTruthy()
  return match[1]
}

function expectColumnCompatible(definition, observed, { allowNullableExpansion = false } = {}) {
  expect(observed).toBeDefined()
  expect(definition).toBeDefined()
  expect(typeCapacity(definition).base).toBe(typeCapacity(observed.type).base)
  const sourceCapacity = typeCapacity(observed.type)
  const targetCapacity = typeCapacity(definition)
  if (sourceCapacity.size !== null) expect(targetCapacity.size).toBeGreaterThanOrEqual(sourceCapacity.size)
  if (observed.nullable === 'YES') expect(definition).not.toMatch(/\bNOT\s+NULL\b/i)
  else if (allowNullableExpansion) expect(definition).not.toMatch(/\bNOT\s+NULL\b/i)
  else expect(definition).toMatch(/\bNOT\s+NULL\b/i)
  if (observed.collation) expect(definition).toMatch(new RegExp(`COLLATE\\s+${observed.collation}`, 'i'))
}

function typeCapacity(type) {
  const match = /^(?<base>[a-z]+)(?:\((?<args>[^)]+)\))?/i.exec(type.trim())
  const args = match?.groups.args ?? null
  return { base: match?.groups.base.toLowerCase(), size: args && /^\d+$/.test(args) ? Number(args) : (args === null ? null : 0) }
}

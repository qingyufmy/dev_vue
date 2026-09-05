import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrationPlan, splitSqlStatements, validateMigrationStatement } from '../scripts/lib/v4-migration-plan.mjs'

const root = join(import.meta.dirname, '..')
const migrationId = '20260905_018_user_state_and_referral_accounts'
const migrationPath = join(root, 'server/db/migrations', `${migrationId}.sql`)
const sourceObservation = JSON.parse(readFileSync(join(root, 'docs/migration/m1-b2-identity-observation-20260905.json'), 'utf8'))
const foundation = readFileSync(join(root, 'server/db/migrations/bootstrap/v4-foundation-v1.sql'), 'utf8')
const migration = readFileSync(migrationPath, 'utf8')
const statements = splitSqlStatements(migration)
const [alterUsers, createReferralAccounts] = statements
const sourceUsers = new Map(sourceObservation.source.users.columns.map(column => [column.name, column]))

describe('V4 user state and referral-account migration', () => {
  it('is the final numbered migration and contains exactly the two planned statements', async () => {
    const plan = await loadMigrationPlan({ rootDirectory: root })
    const last = plan.at(-1)

    expect(last).toMatchObject({ id: migrationId, file: `${migrationId}.sql` })
    expect(last.statements).toHaveLength(2)
    expect(last.statements).toEqual(statements)
    expect(() => validateMigrationStatement(alterUsers, migrationId)).not.toThrow()
    expect(() => validateMigrationStatement(createReferralAccounts, migrationId)).not.toThrow()
  })

  it('adds only the eight explicit nullable/state columns without changing protected user fields', () => {
    expect(alterUsers).toMatch(/^ALTER TABLE users\b/i)
    expect((alterUsers.match(/\bALTER TABLE\b/gi) ?? [])).toHaveLength(1)

    const additions = readAddedColumns(alterUsers)
    expect([...additions.keys()]).toEqual([
      'email_verified', 'phone_verified', 'auth_method', 'plan_period', 'plan_source',
      'last_seen_at_utc', 'changelog_seen_version', 'profile_revision',
    ])
    expect(additions.get('email_verified')).toMatch(/^TINYINT\s+NULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('phone_verified')).toMatch(/^TINYINT\s+NULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('auth_method')).toMatch(/^VARCHAR\(20\).*\bNULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('plan_period')).toMatch(/^VARCHAR\(20\).*\bNULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('plan_source')).toMatch(/^VARCHAR\(20\).*\bNULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('last_seen_at_utc')).toMatch(/^DATETIME\(3\)\s+NULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('changelog_seen_version')).toMatch(/^INT\s+NULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('profile_revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+DEFAULT\s+1$/i)

    const protectedColumns = [
      'id', 'uid', 'email', 'phone', 'password', 'nickname', 'avatar', 'role', 'plan',
      'plan_expires_at', 'token_version', 'deletion_status', 'deleted_at', 'created_at', 'updated_at',
    ]
    expect(alterUsers).not.toMatch(new RegExp(`\\b(?:${protectedColumns.join('|')})\\b`, 'i'))
    expect(foundation).toContain('id INT NOT NULL AUTO_INCREMENT')
    expect(foundation).toContain('password VARCHAR(255) NOT NULL')
    expect(foundation).toContain("role VARCHAR(20) NOT NULL DEFAULT 'user'")
    expect(foundation).toContain("plan VARCHAR(20) NOT NULL DEFAULT 'free'")
    expect(foundation).toContain('token_version INT NOT NULL DEFAULT 0')
  })

  it('matches frozen source type, length, nullability and source collation for the ten mapped fields', () => {
    const additions = readAddedColumns(alterUsers)
    const tableColumns = new Map([
      ...[...additions.entries()],
      ...readTableColumns(createReferralAccounts),
    ])
    const mappings = [
      ['email_verified', 'email_verified'],
      ['phone_verified', 'phone_verified'],
      ['auth_method', 'auth_method'],
      ['plan_period', 'plan_period'],
      ['plan_source', 'plan_source'],
      ['last_seen_at_utc', 'last_seen_at'],
      ['changelog_seen_version', 'changelog_seen_version'],
      ['referral_code', 'referral_code'],
      ['referred_by_code', 'referred_by'],
      ['referral_credit', 'referral_credit'],
    ]

    for (const [target, source] of mappings) {
      const observed = sourceUsers.get(source)
      const definition = tableColumns.get(target)
      expect(observed).toBeDefined()
      expect(definition).toBeDefined()
      expect(typeShape(definition).base).toBe(typeShape(observed.type).base)
      if (typeShape(observed.type).args !== null) expect(typeShape(definition).args).toBe(typeShape(observed.type).args)
      expect(!/\bNOT\s+NULL\b/i.test(definition)).toBe(observed.nullable === 'YES')
      if (observed.collation) expect(definition).toContain(`COLLATE ${observed.collation}`)
    }
  })

  it('keeps verification unknown by default and uses explicit UTC/accounting precision', () => {
    const additions = readAddedColumns(alterUsers)
    expect(additions.get('email_verified')).toMatch(/\bNULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('phone_verified')).toMatch(/\bNULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('last_seen_at_utc')).toMatch(/^DATETIME\(3\)\s+NULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('changelog_seen_version')).toMatch(/^INT\s+NULL\s+DEFAULT\s+NULL$/i)
    expect(additions.get('profile_revision')).toMatch(/\bDEFAULT\s+1$/i)

    const referralColumns = readTableColumns(createReferralAccounts)
    expect(referralColumns.get('revision')).toMatch(/^BIGINT\s+UNSIGNED\s+NOT\s+NULL\s+DEFAULT\s+1$/i)
    expect(referralColumns.get('updated_at_utc')).toMatch(/^DATETIME\(3\)\s+NOT\s+NULL$/i)
    expect(referralColumns.get('updated_at_utc')).not.toMatch(/DEFAULT|CURRENT_TIMESTAMP|ON\s+UPDATE/i)
    expect(referralColumns.get('referral_credit')).toMatch(/^DECIMAL\(20,8\)\s+NOT\s+NULL$/i)
    expect(referralColumns.get('referral_credit')).not.toMatch(/DEFAULT|UNSIGNED|CHECK|>=|<=/i)
  })

  it('creates a non-cascading user-owned referral account with a non-unique code index', () => {
    expect(createReferralAccounts).toMatch(/^CREATE TABLE user_referral_accounts\s*\(/i)
    expect(createReferralAccounts).not.toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
    expect(createReferralAccounts).toMatch(/ENGINE\s*=\s*InnoDB\s+DEFAULT\s+CHARSET=utf8mb4\s+COLLATE=utf8mb4_unicode_ci$/i)
    expect(createReferralAccounts).toMatch(/\buser_id\s+INT\s+NOT\s+NULL/i)
    expect(createReferralAccounts).toMatch(/PRIMARY KEY\s*\(user_id\)/i)
    expect(createReferralAccounts).toMatch(/FOREIGN KEY\s*\(user_id\)\s+REFERENCES\s+users\s*\(id\)/i)
    expect(createReferralAccounts).not.toMatch(/FOREIGN KEY\s*\(referred_by_code\)/i)
    expect(createReferralAccounts).not.toMatch(/\bON\s+(?:DELETE|UPDATE)\b/i)
    expect(createReferralAccounts).toMatch(/\bKEY\s+idx_user_referral_accounts_referral_code\s*\(referral_code\)/i)
    expect(createReferralAccounts).not.toMatch(/\bUNIQUE\b/i)
  })

  it('does not contain Telegram structures, data seeds, backfills or external-service activation', () => {
    const executable = migration.replace(/--[^\n]*/g, '')
    expect(executable).not.toMatch(/telegram/i)
    expect(executable).not.toMatch(/\b(?:INSERT|REPLACE|UPDATE|DELETE|DROP|TRUNCATE|SELECT|CALL|GRANT|REVOKE|MODIFY|CHANGE|RENAME)\b/i)
    expect(executable).not.toMatch(/(?:CURRENT_TIMESTAMP|HTTP|REDIS|BRIDGE|SEED|BACKFILL)/i)
  })
})

function readAddedColumns(statement) {
  return new Map([...statement.matchAll(/^\s*ADD COLUMN\s+([a-z][a-z0-9_]*)\s+(.+)$/gim)]
    .map(([, name, definition]) => [name, definition.replace(/,\s*$/, '').trim()]))
}

function readTableColumns(statement) {
  return new Map(statement.split('\n')
    .map(line => line.trim())
    .filter(line => /^[a-z][a-z0-9_]*\s+/i.test(line))
    .map(line => {
      const match = /^([a-z][a-z0-9_]*)\s+(.+)$/i.exec(line.replace(/,$/, ''))
      return [match[1], match[2]]
    }))
}

function typeShape(type) {
  const match = /^(?<base>[a-z]+)(?:\((?<args>[^)]+)\))?/i.exec(type.trim())
  return { base: match?.groups.base.toLowerCase(), args: match?.groups.args ?? null }
}

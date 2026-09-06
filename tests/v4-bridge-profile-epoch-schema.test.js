import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrationPlan, splitSqlStatements, validateMigrationStatement } from '../scripts/lib/v4-migration-plan.mjs'

const root = join(import.meta.dirname, '..')
const id = '20260906_023_bridge_profile_epoch_scope'
const sql = readFileSync(join(root, 'server/db/migrations', `${id}.sql`), 'utf8')
const statements = splitSqlStatements(sql)

describe('P5A profile-scoped Bridge epoch index', () => {
  it('appends one correction without altering the frozen migration order', async () => {
    const plan = (await loadMigrationPlan({ rootDirectory: root })).slice(0, 24)
    expect(plan).toHaveLength(24)
    expect(plan[22].id).toBe('20260905_022_observer_management_ledger')
    expect(plan[23]).toMatchObject({ id, file: `${id}.sql`, statements })
    expect(plan.reduce((count, entry) => count + entry.statements.length, 0)).toBe(158)
    expect(statements).toHaveLength(1)
    expect(() => validateMigrationStatement(statements[0], id)).not.toThrow()
  })

  it('replaces only the numeric terminal-global constraint and preserves historical rows', () => {
    expect(statements[0]).toMatch(/^ALTER TABLE bridge_connection_sessions\s+DROP INDEX uk_bridge_connection_route_epoch_v4,\s+ADD KEY idx_bridge_connection_profile_epoch_v4\s*\(user_id,\s*terminal_profile_id,\s*connection_epoch_v4\)$/i)
    expect(statements[0]).not.toMatch(/\b(?:DELETE|UPDATE|INSERT|TRUNCATE|UNIQUE|DROP TABLE|DROP COLUMN)\b/i)
    // Do not replace the opaque connection-id uniqueness or modify the older migration.
    expect(statements[0]).not.toMatch(/DROP INDEX uk_bridge_connection_route_epoch\s*[,;]/i)
    const previous = readFileSync(join(root, 'server/db/migrations/20260903_010_bridge_v4_command_ledger.sql'), 'utf8')
    expect(previous).toContain('ADD UNIQUE KEY uk_bridge_connection_route_epoch_v4 (terminal_instance_id, connection_epoch_v4)')
  })
})

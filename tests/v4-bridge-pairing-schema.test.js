import { describe, expect, it } from 'vitest'
import { loadMigrationPlan, validateMigrationStatement } from '../scripts/lib/v4-migration-plan.mjs'

describe('V4 pairing migration 024', () => {
  it('appends one new table after 023 without rewriting source data', async () => {
    const plan = await loadMigrationPlan({ rootDirectory: process.cwd() })
    expect(plan.slice(0, 25)).toHaveLength(25)
    expect(plan[23].id).toBe('20260906_023_bridge_profile_epoch_scope')
    const migration = plan[24]
    expect(migration.id).toBe('20260906_024_bridge_pairing_requests')
    expect(migration.statements).toHaveLength(1)
    const sql = migration.statements[0]
    expect(() => validateMigrationStatement(sql, migration.id)).not.toThrow()
    expect(sql).toMatch(/^CREATE TABLE bridge_v4_pairing_requests/)
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i)
  })
  it('bounds identity, receipt and expiry fields without plaintext secrets', async () => {
    const sql = (await loadMigrationPlan({ rootDirectory: process.cwd() }))[24].statements[0]
    expect(sql).toContain('UNIQUE KEY uk_bridge_v4_pair_request (user_id, request_key)')
    expect(sql).toContain('UNIQUE KEY uk_bridge_v4_pair_code (code_hash)')
    expect(sql).toContain('UNIQUE KEY uk_bridge_v4_pair_profile (profile_id)')
    expect(sql).toContain('idx_bridge_v4_pair_user_time (user_id, created_at_utc)')
    expect(sql).toContain('revoked_at_utc DATETIME(3) NULL')
    expect(sql).toContain('refresh_session_id IS NOT NULL')
    expect(sql).not.toMatch(/\b(?:pairing_code|refresh_token|payload_json)\s/i)
  })
})

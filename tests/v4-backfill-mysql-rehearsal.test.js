import { describe, expect, it, vi } from 'vitest'
import { prepareBatch } from '../scripts/lib/v4-backfill-contract.mjs'
import { buildMysqlRehearsal, REHEARSAL_SCOPE, runMysqlBackfillRehearsal } from '../scripts/lib/v4-backfill-mysql-rehearsal.mjs'

describe('bounded MySQL rehearsal preparation (no real database)', () => {
  it('constructs four valid chained synthetic batches limited to ledger sentinel rows', () => {
    const fixture = buildMysqlRehearsal('a'.repeat(64))
    expect(fixture.batches).toHaveLength(4)
    expect(new Set([fixture.spec.runId, ...REHEARSAL_SCOPE.sentinelIds]).size).toBe(5)
    for (const [i, batch] of fixture.batches.entries()) {
      expect(() => prepareBatch(fixture.spec, batch)).not.toThrow()
      expect(batch.rows[0].targets[0]).toEqual({ table: 'data_migration_runs', pk: [{ type: 'text', value: REHEARSAL_SCOPE.sentinelIds[i] }] })
      expect(batch.rows[0].payload.amount).toBe('123456789012.12345678')
      expect(batch.startCursor).toEqual(i ? fixture.batches[i - 1].endCursor : null)
    }
  })
  it('requires the exact apply-and-cleanup scope before acquiring any connection', async () => {
    const pool = { getConnection: vi.fn() }
    for (const approval of [{ scope: 'other', apply: true, cleanup: true }, { scope: REHEARSAL_SCOPE.id, apply: false, cleanup: true }, { scope: REHEARSAL_SCOPE.id, apply: true, cleanup: false }, { scope: REHEARSAL_SCOPE.id, apply: true, cleanup: true, force: true }]) await expect(runMysqlBackfillRehearsal(pool, approval)).rejects.toThrow()
    expect(pool.getConnection).not.toHaveBeenCalled()
  })
  it('rejects a wrong database or instance before any metadata or mutation query', async () => {
    for (const actual of [{ db: 'dev_xin', uuid: REHEARSAL_SCOPE.serverUuid }, { db: REHEARSAL_SCOPE.database, uuid: 'wrong' }]) {
      const c = { query: vi.fn(async () => [[actual]]), release: vi.fn() }
      await expect(runMysqlBackfillRehearsal({ getConnection: async () => c }, { scope: REHEARSAL_SCOPE.id, apply: true, cleanup: true })).rejects.toThrow('rehearsal_target_mismatch')
      expect(c.query).toHaveBeenCalledOnce()
      expect(c.release).toHaveBeenCalledOnce()
    }
  })
})

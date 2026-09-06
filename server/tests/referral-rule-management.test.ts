import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { ReferralRuleManagementService, normalizeRuleChangeCommand } from '../src/modules/commerce/application/referral-rule-management.js'
import { MysqlReferralRuleManagement } from '../src/modules/commerce/infrastructure/mysql-referral-rule-management.js'
import { updateReferralRulesInTransaction } from '../src/modules/commerce/infrastructure/mysql-referral-rule-writer.js'
vi.mock('../src/modules/commerce/infrastructure/mysql-referral-rule-writer.js', () => ({ updateReferralRulesInTransaction: vi.fn() }))
const command = () => ({ actorUserId: 1, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', changes: [{ id: 2, expectedRevision: '1', rateBps: 0, enabled: false }] })
const receipt = { rule_id: '2', rule_revision: '2', actor_user_id: '1', rate_bps: '0', enabled: '0' }
function fixture(rows: object[] = [], admin = true) {
  vi.mocked(updateReferralRulesInTransaction).mockReset().mockResolvedValue([{ id: 2, revision: '2' }])
  const c = { query: vi.fn().mockResolvedValue([[], []]), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string) => [sql.includes('FROM users') ? (admin ? [{ id: 1 }] : []) : rows, []]) }
  const pool = { getConnection: vi.fn().mockResolvedValue(c) } as unknown as Pick<Pool, 'getConnection'>
  return { c, pool, repository: new MysqlReferralRuleManagement(pool) }
}
describe('referral rule management transaction ownership', () => {
  it('rechecks permission inside the transaction before applying or replaying', async () => {
    const f = fixture([receipt], false)
    await expect(f.repository.execute(command())).rejects.toThrow('referral_admin_required')
    expect(f.c.rollback).toHaveBeenCalledOnce()
    expect(updateReferralRulesInTransaction).not.toHaveBeenCalled()
    expect(f.c.commit).not.toHaveBeenCalled()
  })
  it('returns the persisted result on exact replay without calling the writer', async () => {
    const f = fixture([receipt])
    expect(await f.repository.execute(command())).toEqual({ rules: [{ id: 2, revision: '2' }], replayed: true })
    expect(updateReferralRulesInTransaction).not.toHaveBeenCalled()
    expect(f.c.commit).toHaveBeenCalledOnce()
    expect(f.c.execute.mock.calls[1]![0]).toContain('actor_user_id=?')
  })
  it('rejects changed content and incomplete audit sets as idempotency conflicts', async () => {
    for (const rows of [[{ ...receipt, rate_bps: '10' }], [{ ...receipt, rule_revision: '3' }], [receipt, receipt]]) {
      const f = fixture(rows)
      await expect(f.repository.execute(command())).rejects.toThrow('idempotency_conflict')
      expect(f.c.rollback).toHaveBeenCalledOnce()
      expect(updateReferralRulesInTransaction).not.toHaveBeenCalled()
    }
  })
  it('rolls back a writer or audit error and never commits a partial result', async () => {
    const f = fixture()
    vi.mocked(updateReferralRulesInTransaction).mockRejectedValueOnce(Error('audit_failure'))
    await expect(f.repository.execute(command())).rejects.toThrow('audit_failure')
    expect(f.c.rollback).toHaveBeenCalledOnce()
    expect(f.c.commit).not.toHaveBeenCalled()
    expect(f.c.release).toHaveBeenCalledOnce()
  })
  it('destroys an uncertain commit connection without replay or misleading rollback', async () => {
    const f = fixture(); f.c.commit.mockRejectedValueOnce(Error('lost_response'))
    await expect(f.repository.execute(command())).rejects.toThrow('commit_unknown')
    expect(updateReferralRulesInTransaction).toHaveBeenCalledOnce()
    expect(f.c.destroy).toHaveBeenCalledOnce()
    expect(f.c.rollback).not.toHaveBeenCalled()
    expect(f.c.release).not.toHaveBeenCalled()
  })
  it('discards a connection when rollback cannot be confirmed', async () => {
    const f = fixture()
    vi.mocked(updateReferralRulesInTransaction).mockRejectedValueOnce(Error('audit_failure'))
    f.c.rollback.mockRejectedValueOnce(Error('connection_lost'))
    await expect(f.repository.execute(command())).rejects.toThrow('rollback_unknown')
    expect(f.c.destroy).toHaveBeenCalledOnce()
    expect(f.c.release).not.toHaveBeenCalled()
    expect(f.c.commit).not.toHaveBeenCalled()
  })
  it('blocks malformed requests before acquiring a connection and freezes accepted input', async () => {
    const f = fixture(), input = command()
    await expect(f.repository.execute({ ...input, unexpected: true } as typeof input)).rejects.toThrow('update_invalid')
    expect(f.pool.getConnection).not.toHaveBeenCalled()
    const normalized = normalizeRuleChangeCommand(input); input.changes[0]!.rateBps = 10
    expect(normalized.changes[0]!.rateBps).toBe(0)
    const service = new ReferralRuleManagementService(f.repository)
    await expect(service.update({ userId: 1, role: 'user' }, input.requestId, input.changes)).rejects.toThrow('admin_required')
  })
})

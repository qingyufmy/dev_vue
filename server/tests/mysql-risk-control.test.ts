import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { readRiskControl } from '../src/modules/risk/infrastructure/mysql-risk-control.js'
import { MysqlRiskRepository } from '../src/modules/risk/infrastructure/mysql-risk-repository.js'

describe('persisted global risk control', () => {
  it('preserves both explicit control states and a canonical driver revision', () => {
    expect(readRiskControl({ kill_switch: 0, revision: 1 })).toEqual({ globalKillSwitch: false, revision: 1 })
    expect(readRiskControl({ kill_switch: 1, revision: '2' })).toEqual({ globalKillSwitch: true, revision: 2 })
  })

  it.each([undefined, { kill_switch: null, revision: 1 }, { kill_switch: 2, revision: 1 },
    { kill_switch: '0', revision: 1 }, { kill_switch: 0, revision: 0 }, { kill_switch: 0, revision: null },
    { kill_switch: 0, revision: '1.0' }, { kill_switch: 0, revision: '9007199254740993' }])(
    'refuses missing or corrupt control facts instead of enabling trading: %j', row => {
      expect(() => readRiskControl(row)).toThrow(expect.objectContaining({ code: 'risk_global_control_unavailable', status: 503 }))
    },
  )

  it('rejects policy reads when the control table has no singleton', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ id: 7 }]])
      .mockResolvedValueOnce([[{ version_id: '1', policy_json: {}, updated_at_utc: new Date() }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
    const repository = new MysqlRiskRepository({ execute } as unknown as Pool, () => { throw Error('unexpected decision write') })
    await expect(repository.getEffectivePolicy(42, '7')).rejects.toMatchObject({ code: 'risk_global_control_unavailable' })
  })

  it('rolls back policy replacement before any mutation if control initialization is missing', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ id: 7 }]])
      .mockResolvedValueOnce([[{ id: 7 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ version_id: '1', policy_json: {}, updated_at_utc: new Date() }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
    const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
    const repository = new MysqlRiskRepository({ getConnection: async () => connection } as unknown as Pool,
      () => { throw Error('unexpected decision write') })
    await expect(repository.replaceAccountPolicy({ userId: 42, actorUserId: 42, accountId: '7', expectedRevision: 0,
      patch: { accountKillSwitch: true }, idempotencyKey: 'original-policy-key', reason: 'Pause account', changedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'risk_global_control_unavailable' })
    expect(connection.commit).not.toHaveBeenCalled()
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(execute.mock.calls.every(([sql]) => sql.startsWith('SELECT '))).toBe(true)
  })
})

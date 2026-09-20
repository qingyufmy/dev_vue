import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlRiskRepository } from '../src/modules/risk/infrastructure/mysql-risk-repository.js'
import { DEFAULT_RISK_POLICY } from '../src/modules/risk/domain/risk.js'
import { policyReceiptHash, riskPolicyRequestHash } from '../src/modules/risk/domain/risk-policy-receipt.js'

const input = { userId: 42, accountId: '7', actorUserId: 42, expectedRevision: 3, idempotencyKey: 'original-policy-key',
  patch: { maxRiskPerTradePercent: 0.5 }, reason: '降低风险', changedAt: '2026-09-09T00:00:00.000Z' }

function fixture() {
  const execute = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT 1 FROM trading_account_ownerships')) return [[{}]]
    if (sql.includes('FROM risk_policy_write_receipts')) return [[]]
    if (sql.startsWith('INSERT INTO risk_policy_write_receipts')) return [{ affectedRows: 1 }]
    if (sql.startsWith('SELECT a.id FROM trading_accounts')) return [[{ id: '7' }]]
    if (sql.includes("p.scope='platform'")) return [[{ version_id: '101', policy_json: DEFAULT_RISK_POLICY }]]
    if (sql.includes("p.scope='account'")) return [[{ set_id: '10', set_revision: 3, version_id: '102', policy_json: {} }]]
    if (sql.startsWith('SELECT kill_switch')) return [[{ kill_switch: 0, revision: 2 }]]
    if (sql.startsWith('SELECT id FROM risk_policy_sets')) return [[{ id: '10' }]]
    if (sql.startsWith('SELECT COALESCE')) return [[{ version_number: 4 }]]
    if (sql.startsWith('INSERT INTO risk_policy_versions')) return [{ insertId: 103, affectedRows: 1 }]
    if (sql.startsWith('UPDATE risk_policy_sets')) return [{ affectedRows: 1 }]
    if (sql.startsWith('INSERT INTO risk_policy_change_items') || sql.startsWith('INSERT INTO outbox_events')) return [{ affectedRows: 1 }]
    if (sql.includes('FROM risk_manual_releases')) return [[]]
    throw Error('unexpected SQL')
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const pool = { getConnection: vi.fn(async () => connection), execute: vi.fn(async () => { throw Error('post-commit read unavailable') }) }
  const repository = new MysqlRiskRepository(pool as unknown as Pool, () => { throw Error('unused capability') })
  return { repository, pool, connection }
}

it('returns the exact committed policy version without a fallible post-commit pool read', async () => {
  const f = fixture()
  const result = await f.repository.replaceAccountPolicy(input)
  expect(result).toMatchObject({ accountId: '7', accountPolicyVersionId: '103', platformPolicyVersionId: '101',
    policySetRevision: 4, updatedAt: input.changedAt, values: { maxRiskPerTradePercent: 0.5 } })
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.pool.execute).not.toHaveBeenCalled()
  expect(f.connection.rollback).not.toHaveBeenCalled()
})

it('does not return the prepared snapshot when commit acknowledgement is lost', async () => {
  const f = fixture()
  f.connection.commit.mockRejectedValueOnce(Error('lost acknowledgement'))
  await expect(f.repository.replaceAccountPolicy(input)).rejects.toMatchObject({ code: 'risk_commit_unknown', status: 503 })
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.pool.execute).not.toHaveBeenCalled()
})

it('replays the stored result before current revision checks and performs no new writes', async () => {
  const f = fixture()
  const policy = await f.repository.replaceAccountPolicy(input)
  f.connection.execute.mockClear()
  f.connection.execute.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT a.id')) return [[{ id: '7' }]]
    if (sql.startsWith('SELECT 1')) return [[{}]]
    if (sql.includes('FROM risk_policy_write_receipts')) return [[{ request_sha256: riskPolicyRequestHash(input), result_json: policy, result_sha256: policyReceiptHash(policy) }]]
    throw Error('replay must not read current policy or mutate')
  })
  expect(await f.repository.replaceAccountPolicy(input)).toEqual(policy)
  expect(f.connection.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
  await expect(f.repository.replaceAccountPolicy({ ...input, reason: '新的请求原因' })).rejects.toMatchObject({ code: 'risk_policy_idempotency_conflict', status: 409 })
})

it('rolls back policy, audit and outbox if receipt insertion fails', async () => {
  const f = fixture()
  const original = f.connection.execute.getMockImplementation()!
  f.connection.execute.mockImplementation(async sql => {
    if (sql.startsWith('INSERT INTO risk_policy_write_receipts')) throw Error('receipt unavailable')
    return original(sql)
  })
  await expect(f.repository.replaceAccountPolicy(input)).rejects.toMatchObject({ code: 'risk_storage_unavailable' })
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})

it.each([{ lockedValue: 0.5, userEditable: true }, { lockedValue: null, userEditable: false }])('rejects new writes to controlled fields before version/audit/outbox writes', async control => {
  const f = fixture()
  const original = f.connection.execute.getMockImplementation()!
  f.connection.execute.mockImplementation(async sql => {
    if (sql.includes("p.scope='platform'")) return [[{ version_id: '101', policy_json: {
      values: DEFAULT_RISK_POLICY, controls: { maxRiskPerTradePercent: { allowedMin: 0.1, allowedMax: 1, ...control } },
    } }]]
    return original(sql)
  })
  await expect(f.repository.replaceAccountPolicy(input)).rejects.toMatchObject({ code: 'risk_policy_field_locked', status: 422 })
  expect(f.connection.execute.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false)
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
})

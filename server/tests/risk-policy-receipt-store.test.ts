import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy } from '../src/modules/risk/domain/risk.js'
import { policyReceiptHash, replayRiskPolicyReceipt, riskPolicyRequestHash } from '../src/modules/risk/domain/risk-policy-receipt.js'
import { insertRiskPolicyReceipt, readRiskPolicyReceipt } from '../src/modules/risk/infrastructure/mysql-risk-policy-receipts.js'

const scope = { userId: 42, accountId: '7', idempotencyKey: 'original-policy-key' }
const request = { ...scope, expectedRevision: 3, patch: { maxRiskPerTradePercent: 0.5, maxOpenPositions: 2 }, reason: '降低风险' }
const policy = resolveRiskPolicy({ userId: 42, accountId: '7', platformPolicyVersionId: '101', accountPolicyVersionId: '103',
  policySetRevision: 4, platform: { values: DEFAULT_RISK_POLICY, globalKillSwitch: false, revision: 1 },
  account: request.patch, updatedAt: '2026-09-09T00:00:00.000Z' })
const receipt = { requestHash: riskPolicyRequestHash(request), policy }

it('hashes semantic request fields and distinguishes revision, reason and scope changes', () => {
  expect(riskPolicyRequestHash({ ...request, patch: { maxOpenPositions: 2, maxRiskPerTradePercent: 0.5 }, reason: ' 降低风险 ' })).toBe(receipt.requestHash)
  for (const changed of [{ ...request, expectedRevision: 4 }, { ...request, reason: '新的原因' }, { ...request, accountId: '8' }]) {
    expect(() => replayRiskPolicyReceipt(receipt, riskPolicyRequestHash(changed))).toThrow('risk_policy_idempotency_conflict')
  }
  expect(replayRiskPolicyReceipt(receipt, receipt.requestHash)).toEqual(policy)
})

it('inserts the original snapshot on the supplied connection and reads by all three scope keys', async () => {
  let row: unknown
  const execute = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('INSERT')) { row = { request_sha256: params[3], result_json: params[4], result_sha256: params[5] }; return [{ affectedRows: 1 }] }
    if (sql.startsWith('SELECT 1')) return [[{}]]
    expect(params).toEqual([42, '7', 'original-policy-key'])
    expect(sql).toContain('o.revoked_at_utc IS NULL')
    return [[row]]
  })
  const connection = { execute } as unknown as PoolConnection
  await insertRiskPolicyReceipt(connection, scope, receipt, policy.updatedAt)
  expect(await readRiskPolicyReceipt(connection, scope)).toEqual(receipt)
  expect(execute).toHaveBeenCalledTimes(3)
})

it('rejects revoked ownership, corrupt snapshots and cross-account records', async () => {
  const execute = vi.fn().mockResolvedValueOnce([[]])
  const connection = { execute } as unknown as PoolConnection
  await expect(readRiskPolicyReceipt(connection, scope)).rejects.toMatchObject({ status: 403 })
  expect(execute).toHaveBeenCalledTimes(1)
  for (const result of [policy, { ...policy, accountId: '8' }]) {
    execute.mockResolvedValueOnce([[{}]]).mockResolvedValueOnce([[{ request_sha256: receipt.requestHash,
      result_json: result, result_sha256: result === policy ? '0'.repeat(64) : policyReceiptHash(result) }]])
    await expect(readRiskPolicyReceipt(connection, scope)).rejects.toMatchObject({ code: 'risk_policy_receipt_invalid', status: 503 })
  }
  execute.mockResolvedValueOnce([[{}]]).mockResolvedValueOnce([[]])
  expect(await readRiskPolicyReceipt(connection, scope)).toBeNull()
})

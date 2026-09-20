import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createTransactionRiskDecisionExecutionWriter } from '../src/modules/risk/composition.js'

it('links only the scoped unlinked revision using the supplied transaction', async () => {
  const execute = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([{ affectedRows: 0 }])
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const writer = createTransactionRiskDecisionExecutionWriter(connection as unknown as PoolConnection)
  const input = { riskDecisionId: '17', userId: 4, accountId: '23', expectedRevision: 7, operationId: 'operation-1' }
  expect(await writer.linkOperation(input)).toBe(true)
  expect(await writer.linkOperation(input)).toBe(false)
  const [sql, params] = execute.mock.calls[0]!
  expect(sql).toContain('SET operation_id=?,revision=revision+1')
  expect(sql).toContain('WHERE id=? AND user_id=? AND trading_account_id=? AND operation_id IS NULL AND revision=?')
  expect(params).toEqual(['operation-1', '17', 4, '23', 7])
  execute.mockRejectedValueOnce(Error('connection_lost'))
  await expect(writer.linkOperation(input)).rejects.toThrow('connection_lost')
  expect(execute).toHaveBeenCalledTimes(3)
  for (const method of [connection.beginTransaction, connection.commit, connection.rollback, connection.release]) {
    expect(method).not.toHaveBeenCalled()
  }
})

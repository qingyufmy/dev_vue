import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { readPendingDispatchOrigin } from '../src/modules/execution/infrastructure/mysql-pending-dispatch-origin.js'
import type { PendingDispatchCandidate } from '../src/modules/execution/infrastructure/mysql-pending-dispatch-candidates.js'

const candidate: PendingDispatchCandidate = { commandId: 'c1', intentId: 'i1', status: 'uncertain', sourceType: 'risk_decision',
  sourceId: 'r1', tradeDecisionId: 'd1', riskDecisionId: 'r1', instrumentId: 'XAUUSD.a', type: 'buy_limit', price: '2500', resultHash: null }
const origin = { userId: 7, accountId: '42', decisionId: 'd1', strategyId: '21', strategyVersionId: '31' }
function fixture() {
  const execute = vi.fn().mockResolvedValue([[{ strategy_id: '22' }], []])
  const read = vi.fn().mockResolvedValue(origin)
  return { execute, read, resolve: (value = candidate) => readPendingDispatchOrigin({ execute } as unknown as PoolConnection,
    { read }, { userId: 7, accountId: '42', candidate: value }) }
}
it('uses the verified historical AI decision through the public inference port', async () => {
  const { resolve, execute, read } = fixture()
  expect(await resolve()).toEqual({ userId: 7, accountId: '42', strategyId: '21' })
  expect(read).toHaveBeenCalledWith({ userId: 7, accountId: '42', decisionId: 'd1', riskDecisionId: 'r1' })
  expect(execute).not.toHaveBeenCalled()
})
it.each([null, { ...origin, accountId: '43' }, { ...origin, decisionId: 'd2' }, { ...origin, strategyId: '0' }])(
  'rejects missing or mismatched AI proof', async value => {
    const context = fixture(); context.read.mockResolvedValue(value)
    await expect(context.resolve()).rejects.toMatchObject({ code: 'execution_dedup_origin_invalid' })
  })
it('correlates the distribution child operation, target account and exact intent', async () => {
  const { resolve, execute, read } = fixture()
  expect(await resolve({ ...candidate, sourceType: 'strategy_distribution', sourceId: 'target1' })).toEqual({ userId: 7, accountId: '42', strategyId: '22' })
  expect(execute.mock.calls[0]![1]).toEqual(['i1', 'target1', 7, '42'])
  expect(execute.mock.calls[0]![0]).toContain('t.child_operation_id=i.operation_id')
  expect(read).not.toHaveBeenCalled()
})
it('rejects ambiguous distribution proof', async () => {
  const context = fixture(); context.execute.mockResolvedValue([[{ strategy_id: '21' }, { strategy_id: '22' }], []])
  await expect(context.resolve({ ...candidate, sourceType: 'strategy_distribution' })).rejects.toMatchObject({ code: 'execution_dedup_origin_invalid' })
})
it('distinguishes explicit manual scope from unsupported source types', async () => {
  expect(await fixture().resolve({ ...candidate, sourceType: 'user_command' })).toBeNull()
  await expect(fixture().resolve({ ...candidate, sourceType: 'unknown' })).rejects.toMatchObject({ code: 'execution_dedup_origin_invalid' })
})

import { expect, it } from 'vitest'
import type { AuditEventDetail } from '@aurum/contracts'
import { executionActionGroups } from '../model/execution-action-groups'
type Node = AuditEventDetail['trace'][number]
const node = (intentId: string | null, stage: Node['stage'], status: Node['status']): Node => ({ parameters: {}, intentId, actionKind: 'modify_position', stage, status, sourceKind: stage, sourceId: `${intentId}-${stage}`, title: 'test', detail: 'test', reasonCode: null, occurredAt: '2026-09-15T00:00:00Z' })
it('keeps same-kind actions separate by exact execution identity', () => {
  const result = executionActionGroups([node('a', 'intent', 'succeeded'), node('a', 'terminal', 'succeeded'), node('b', 'intent', 'failed'), node('b', 'terminal', 'failed')])
  expect(result.map(item => [item.id, item.label])).toEqual([['a', '已完成'], ['b', '执行失败']])
})
it('does not treat bridge acceptance as terminal completion or guess legacy linkage', () => {
  const result = executionActionGroups([node('a', 'intent', 'succeeded'), node('a', 'bridge', 'succeeded'), node(null, 'terminal', 'succeeded')])
  expect(result).toHaveLength(1)
  expect(result[0]?.label).toBe('等待终端回执')
  expect(result[0]?.status).not.toBe('succeeded')
})
it('retains uncertainty when terminal results are mixed', () => {
  expect(executionActionGroups([node('a', 'terminal', 'succeeded'), node('a', 'terminal', 'failed')])[0]?.status).toBe('uncertain')
})

it('keeps submitted parameters on their own action and preserves zero', () => {
  const a = { ...node('a', 'intent', 'running'), parameters: { symbol: 'XAUUSD.s', ticket: '123', stop_loss: '0', take_profit: '4330' } }
  const b = { ...node('b', 'intent', 'running'), parameters: { ticket: '456', take_profit: '4200' } }
  const result = executionActionGroups([a, b])
  expect(result[0]?.parameters.map(field => field.value)).toEqual(['XAUUSD.s', '123', '0', '4330'])
  expect(result[1]?.parameters.map(field => field.value)).toEqual(['456', '4200'])
})

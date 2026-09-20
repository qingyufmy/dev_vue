import { expect, it, vi } from 'vitest'
import { MysqlAuditRepository } from '../src/modules/audit/infrastructure/mysql-audit-repository.js'
import type { Pool } from 'mysql2/promise'

it('reads only the owned decision and keeps accepted advice distinct from execution', async () => {
  const execute = vi.fn().mockResolvedValueOnce([[{ source_kind: 'trade_decision', source_id: 'd1', account_id: '7', category: 'trading', actor: 'ai', action: 'hold', status: 'info', raw_summary: '瑙傛湜', reason_code: null, symbol: null, occurred_at_utc: new Date(), terminal_timezone_offset_minutes: null, correlation_id: 'd1' }]])
    .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
  const result = await new MysqlAuditRepository({ execute } as unknown as Pool).find(3, 'trade_decision', 'd1')
  expect(execute.mock.calls[0][0]).toContain('d.id=? AND d.user_id=?')
  expect(execute.mock.calls[0][1]).toEqual(['d1', 3])
  expect(result?.event.status).toBe('info')
  expect(result?.trace).toHaveLength(1)
  expect(result?.trace[0].stage).toBe('trader')
})
it('does not inspect downstream records for an inaccessible decision', async () => {
  const execute = vi.fn().mockResolvedValue([[]])
  expect(await new MysqlAuditRepository({ execute } as unknown as Pool).find(3, 'trade_decision', 'other')).toBeNull()
  expect(execute).toHaveBeenCalledTimes(1)
})

it('enriches the current page in one owned operation query', async () => {
  const base = { account_id: '7', category: 'execution', actor: 'user', action: 'command', status: 'succeeded', raw_summary: 'internal', reason_code: null, symbol: null, occurred_at_utc: new Date(), terminal_timezone_offset_minutes: null, correlation_id: null }
  const execute = vi.fn().mockResolvedValueOnce([[{ ...base, source_kind: 'operation', source_id: 'op1' }]])
    .mockResolvedValueOnce([[{ total_count: 1 }]])
    .mockResolvedValueOnce([[{ operation_id: 'op1', action_count: 1, kind_count: 1, action_kind: 'modify_position', symbols: null, tickets: '123' }]])
  const repository = new MysqlAuditRepository({ execute } as unknown as Pool)
  const result = await repository.list(3, { limit: 20, fromUtc: '2026-09-01', toUtc: '2026-09-16', capturedEnd: '2026-09-16' } as Parameters<typeof repository.list>[1])
  expect(result.items[0]?.title).toBe('修改持仓')
  expect(result.items[0]?.summary).toBe('订单 123')
  expect(execute.mock.calls[2][1]).toEqual([3, 'op1'])
  expect(execute.mock.calls[2][0]).toContain('o.user_id=?')
})

it('does not project partially completed operations as succeeded', async () => {
  const execute = vi.fn().mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
  const repository = new MysqlAuditRepository({ execute } as unknown as Pool)
  await repository.list(3, { limit: 20, fromUtc: '2026-09-01', toUtc: '2026-09-16', capturedEnd: '2026-09-16' } as Parameters<typeof repository.list>[1])
  expect(execute.mock.calls[0][0]).toContain("WHEN 'partially_succeeded' THEN 'partially_succeeded'")
  expect(execute.mock.calls[0][0]).not.toContain("WHEN 'partially_succeeded' THEN 'succeeded'")
})

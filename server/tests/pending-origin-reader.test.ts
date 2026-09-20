import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { readPendingOrigins } from '../src/modules/execution/infrastructure/mysql-pending-origin-reader.js'

const scope = { userId: 7, accountId: '11', terminalInstanceId: 'terminal-1', brokerServer: 'Broker-Demo', login: '123', connectionEpoch: '3', tickets: ['91'] }
const row = { user_id: 7, account_id: '11', source_type: 'risk_decision', source_id: 'risk-1', risk_decision_id: 'risk-1',
  trade_decision_id: 'decision-1', result_json: { position_ticket: '81', order_ticket: '91' }, distribution_strategy_id: null }
function fixture(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue([rows, []])
  const read = vi.fn().mockResolvedValue({ decisionId: 'decision-1', userId: 7, accountId: '11', strategyId: '21', strategyVersionId: '31' })
  return { execute, read, run: (tickets = scope.tickets) => readPendingOrigins({ execute } as unknown as PoolConnection, { read }, { ...scope, tickets }) }
}
it('recomputes pending tickets and resolves AI provenance through the owner port', async () => {
  const { run, read, execute } = fixture([row, row])
  expect([...(await run()).entries()]).toEqual([['91', { userId: 7, accountId: '11', strategyId: '21' }]])
  expect(read).toHaveBeenCalledOnce()
  expect(read).toHaveBeenCalledWith({ decisionId: 'decision-1', riskDecisionId: 'risk-1', userId: 7, accountId: '11' })
  expect(execute.mock.calls[0]![1]).toEqual([7, '11', 'terminal-1', '3', 'Broker-Demo', '123', '91', '91', '91', '91'])
})
it('accepts execution-owned distribution lineage without querying inference', async () => {
  const { run, read } = fixture([{ ...row, source_type: 'strategy_distribution', distribution_strategy_id: '22' }])
  expect((await run()).get('91')?.strategyId).toBe('22')
  expect(read).not.toHaveBeenCalled()
})
it('rejects conflicting strategies for a ticket', async () => {
  const { run } = fixture([row, { ...row, source_type: 'strategy_distribution', distribution_strategy_id: '22' }])
  await expect(run()).rejects.toThrow('execution_dedup_origin_ambiguous')
})
it('rejects mixed strategy and non-strategy creation evidence in either row order', async () => {
  const manual = { ...row, source_type: 'user_command' }
  for (const rows of [[row, manual], [manual, row]]) {
    await expect(fixture(rows).run()).rejects.toThrow('execution_dedup_origin_ambiguous')
  }
})
it.each([{ account_id: '12' }, { result_json: '{' }, { source_id: 'other-risk' },
  { source_type: 'strategy_distribution', distribution_strategy_id: null }])('rejects broken evidence %j', async patch => {
  await expect(fixture([{ ...row, ...patch }]).run()).rejects.toThrow('execution_dedup_origin_invalid')
})
it('does not silently truncate large histories', async () => {
  await expect(fixture(Array.from({ length: 1001 }, () => row)).run()).rejects.toThrow('execution_dedup_origin_capacity_exceeded')
})
it('does not treat missing inference lineage as a manual order', async () => {
  const { run, read } = fixture([row])
  read.mockResolvedValue(null)
  await expect(run()).rejects.toThrow('execution_dedup_origin_invalid')
})
it('ignores unrelated historical tickets before reading inference', async () => {
  const { run, read } = fixture([{ ...row, result_json: { order_ticket: '92' }, source_id: 'unrelated' }])
  expect((await run()).size).toBe(0)
  expect(read).not.toHaveBeenCalled()
})
it('uses raw aliases instead of the legacy stored ticket to select current evidence', async () => {
  const { run, execute } = fixture([row])
  await run(['91', '91'])
  const [sql, values] = execute.mock.calls[0]!
  for (const alias of ['pending_ticket', 'order_ticket', 'order', 'ticket']) {
    expect(sql).toContain(`JSON_UNQUOTE(JSON_EXTRACT(o.result_json,'$.${alias}')) IN (?)`)
  }
  expect(values).toHaveLength(10)
})
it('does not query for an empty current ticket set and rejects invalid tickets', async () => {
  const { run, execute } = fixture([])
  expect((await run([])).size).toBe(0)
  await expect(run(['91 OR 1=1'])).rejects.toThrow('execution_dedup_ticket_invalid')
  expect(execute).not.toHaveBeenCalled()
})

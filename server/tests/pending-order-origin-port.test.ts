import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { PendingOrderOriginScope } from '../src/modules/execution/index.js'
import { createMysqlPendingOrderOriginReader, createMysqlSnapshotPendingOrderOriginReader } from '../src/modules/execution/composition.js'

const scope = (): PendingOrderOriginScope => ({ userId: 7, accountId: '11', terminalInstanceId: 'terminal-1',
  brokerServer: 'Broker-Demo', login: '123', connectionEpoch: '3', tickets: ['91', '92'] })
const row = { user_id: 7, account_id: '11', source_type: 'risk_decision', source_id: 'risk-1', risk_decision_id: 'risk-1',
  trade_decision_id: 'decision-1', result_json: { order_ticket: '91' }, distribution_strategy_id: null }
function fixture(rows: unknown[] = [row], create = createMysqlPendingOrderOriginReader) {
  const execute = vi.fn().mockResolvedValue([rows, []])
  const read = vi.fn().mockResolvedValue({ decisionId: 'decision-1', userId: 7, accountId: '11', strategyId: '21', strategyVersionId: '31' })
  return { execute, reader: create({ execute } as unknown as PoolConnection, { read }) }
}

it('keeps all scope and ambiguity rules in snapshot reads without acquiring current-read locks', async () => {
  const locked = fixture(), snapshot = fixture([row], createMysqlSnapshotPendingOrderOriginReader)
  expect(await snapshot.reader.read(scope())).toEqual(await locked.reader.read(scope()))
  expect(locked.execute.mock.calls[0]![0]).toContain('FOR SHARE')
  expect(snapshot.execute.mock.calls[0]![0]).toBe(locked.execute.mock.calls[0]![0].replace(' FOR SHARE', ''))
  expect(snapshot.execute.mock.calls[0]![1]).toEqual(locked.execute.mock.calls[0]![1])
  const ambiguous = fixture([row, { ...row, source_type: 'user_command' }], createMysqlSnapshotPendingOrderOriginReader)
  await expect(ambiguous.reader.read(scope())).rejects.toMatchObject({ code: 'execution_dedup_origin_ambiguous' })
  await expect(snapshot.reader.read({ ...scope(), tickets: ['0'] })).rejects.toMatchObject({ code: 'pending_order_origin_scope_invalid' })
})

it('returns a result for every requested ticket without equating missing evidence with manual origin', async () => {
  expect(await fixture().reader.read(scope())).toEqual([
    { ticket: '91', status: 'strategy', userId: 7, accountId: '11', strategyId: '21' },
    { ticket: '92', status: 'unresolved' },
  ])
  expect(await fixture([{ ...row, source_type: 'user_command' }]).reader.read(scope())).toEqual([
    { ticket: '91', status: 'unresolved' }, { ticket: '92', status: 'unresolved' },
  ])
})

it('validates the complete terminal/account scope before even an empty read', async () => {
  const { reader, execute } = fixture()
  for (const patch of [{ accountId: '18446744073709551616' }, { connectionEpoch: '0' }, { connectionEpoch: '9007199254740992' }, { userId: 2147483648 },
    { brokerServer: 'b'.repeat(129) }, { login: '1'.repeat(65) },
    { terminalInstanceId: '' }, { brokerServer: 'bad\nserver' }, { login: '' }, { tickets: ['0'] }]) {
    await expect(reader.read({ ...scope(), ...patch })).rejects.toMatchObject({ code: 'pending_order_origin_scope_invalid' })
  }
  expect(await reader.read({ ...scope(), tickets: [] })).toEqual([])
  expect(execute).not.toHaveBeenCalled()
})

it('freezes scope and ticket inputs before asynchronous evidence lookup', async () => {
  const { reader, execute } = fixture(), request = scope()
  const pending = reader.read(request)
  request.accountId = '99'; request.tickets = ['999']
  expect((await pending)[0]).toMatchObject({ ticket: '91', accountId: '11' })
  expect(execute.mock.calls[0]![1].slice(0, 6)).toEqual([7, '11', 'terminal-1', '3', 'Broker-Demo', '123'])
})

it('does not convert position identifiers into pending order tickets', async () => {
  const { reader } = fixture([{ ...row, result_json: { position_ticket: '91', position_id: '92' } }])
  expect(await reader.read(scope())).toEqual([{ ticket: '91', status: 'unresolved' }, { ticket: '92', status: 'unresolved' }])
})

it('rejects conflicting strategy evidence rather than returning a partial result', async () => {
  const { reader } = fixture([row, { ...row, source_type: 'strategy_distribution', distribution_strategy_id: '22' }])
  await expect(reader.read(scope())).rejects.toMatchObject({ code: 'execution_dedup_origin_ambiguous' })
  await expect(fixture([row, { ...row, source_type: 'user_command' }]).reader.read(scope()))
    .rejects.toMatchObject({ code: 'execution_dedup_origin_ambiguous' })
})

it('keeps source failures visible instead of fabricating an empty portfolio', async () => {
  const { reader, execute } = fixture()
  execute.mockRejectedValue(Error('database_unavailable'))
  await expect(reader.read(scope())).rejects.toThrow('database_unavailable')
})

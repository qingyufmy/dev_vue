import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlTradeDecisionOriginReader, createMysqlSnapshotTradeDecisionOriginReader } from '../src/modules/inference/infrastructure/mysql-trade-decision-origin-reader.js'

const input = { decisionId: 'decision-1', riskDecisionId: 'risk-1', userId: 7, accountId: '11' }
const row = { decision_id: 'decision-1', user_id: 7, account_id: '11', strategy_id: '21', strategy_version_id: '31' }
it('offers snapshot lineage without changing the default locking reader', async () => {
  const execute = vi.fn().mockResolvedValue([[row], []])
  const connection = { execute } as unknown as PoolConnection
  const expected = await createMysqlTradeDecisionOriginReader(connection).read(input)
  expect(await createMysqlSnapshotTradeDecisionOriginReader(connection).read(input)).toEqual(expected)
  expect(execute.mock.calls[1]![0]).toBe(execute.mock.calls[0]![0].replace(' FOR SHARE', ''))
  expect(execute.mock.calls[1]![1]).toEqual(execute.mock.calls[0]![1])
})
function fixture(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue([rows, []])
  return { execute, reader: createMysqlTradeDecisionOriginReader({ execute } as unknown as PoolConnection) }
}
it('reads historical origin on the supplied transaction with full decision/run correlation', async () => {
  const { execute, reader } = fixture([row])
  expect(await reader.read(input)).toEqual({ decisionId: 'decision-1', userId: 7, accountId: '11', strategyId: '21', strategyVersionId: '31' })
  const [sql, values] = execute.mock.calls[0]!
  expect(values).toEqual(['decision-1', 'risk-1', 7, '11'])
  for (const predicate of ['r.user_id=d.user_id', 'r.trading_account_id=d.trading_account_id', 'r.strategy_id=d.strategy_id',
    'r.strategy_version_id=d.strategy_version_id', 'r.market_analysis_id=d.market_analysis_id',
    'r.input_snapshot_id=d.input_snapshot_id', "d.status='accepted'", "r.status='succeeded'", 'FOR SHARE']) expect(sql).toContain(predicate)
  expect(execute).toHaveBeenCalledTimes(1)
})
it.each([{ rows: [] }, { rows: [row, row] }])('rejects missing or ambiguous lineage (%j)', async ({ rows }) => {
  expect(await fixture(rows).reader.read(input)).toBeNull()
})
it.each([{ decision_id: 'other' }, { user_id: 8 }, { account_id: '12' }, { strategy_id: '0' }, { strategy_version_id: '01' }])(
  'rejects mismatched or invalid origin %j', async patch => {
    expect(await fixture([{ ...row, ...patch }]).reader.read(input)).toBeNull()
  },
)
it('does not convert storage failures into an absence of strategy origin', async () => {
  const { execute, reader } = fixture([])
  execute.mockRejectedValue(new Error('storage unavailable'))
  await expect(reader.read(input)).rejects.toThrow('storage unavailable')
})

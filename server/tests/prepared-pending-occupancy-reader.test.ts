import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlPreparedPendingOccupancyReader } from '../src/modules/execution/infrastructure/mysql-prepared-pending-occupancy-reader.js'
import { sha256Canonical } from '../src/modules/execution/domain/execution.js'
const action = { kind: 'pending_order', parameters: { symbol: 'XAUUSD', type: 'buy_limit', price: '100' } }
const row = { intent_id: 'intent', user_id: 1, account_id: '2', source_type: 'risk_decision', source_id: 'risk',
  trade_decision_id: 'decision', risk_decision_id: 'risk', action_json: action, action_sha256: sha256Canonical(action) }
const scope = { userId: 1, accountId: '2', strategyId: '3' }
const origin = { ...scope, decisionId: 'decision', strategyVersionId: '1' }
function reader(rows: unknown[], value: typeof origin | null = origin) {
  return createMysqlPreparedPendingOccupancyReader({ execute: vi.fn(async () => [rows, []]) } as unknown as Pick<PoolConnection, 'execute'>,
    { read: async () => value })
}
it('reads prepared orders without command IDs and preserves verified historical strategy', async () => {
  const result = await reader([row], { ...origin, strategyId: '4' }).read(scope)
  expect(result?.items[0]).toMatchObject({ intentId: 'intent', order: { price: '100', verifiedOrigin: { strategyId: '4' } } })
  expect((await reader([{ ...row, source_type: 'user_command' }]).read(scope))?.items).toEqual([])
})
it('fails closed for corrupted payloads, missing provenance, cross-account rows and unbounded reads', async () => {
  for (const rows of [[{ ...row, action_sha256: '0'.repeat(64) }], [{ ...row, account_id: '9' }], [row, row], [{ ...row, action_json: null }]])
    await expect(reader(rows).read(scope)).rejects.toThrow('execution_dedup_prepared_invalid')
  await expect(reader([row], null).read(scope)).rejects.toThrow('execution_dedup_origin_invalid')
  await expect(reader(Array(1001).fill(row)).read(scope)).rejects.toThrow('execution_dedup_prepared_capacity_exceeded')
})

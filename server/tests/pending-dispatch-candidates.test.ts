import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { readPendingDispatchCandidates } from '../src/modules/execution/infrastructure/mysql-pending-dispatch-candidates.js'
import { sha256Canonical } from '../src/modules/execution/domain/execution.js'

const input = { userId: 7, accountId: '42', route: { terminalInstanceId: 't1', brokerServer: 'Broker', login: '123', connectionEpoch: '9', ownershipRevision: '2' } }
const action = { kind: 'pending_order', parameters: { symbol: 'XAUUSD.a', type: 'buy_limit', price: '2500.000000000000000001' } }
const row = { command_id: 'c1', intent_id: 'i1', user_id: 7, account_id: '42', status: 'succeeded', source_type: 'risk_decision',
  source_id: 'r1', trade_decision_id: 'd1', risk_decision_id: 'r1', action_json: action, action_sha256: sha256Canonical(action), result_sha256: 'hash' }
function fixture(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue([rows, []])
  return { execute, read: () => readPendingDispatchCandidates({ execute } as unknown as PoolConnection, input) }
}
it('retains successful candidates and exact broker price/symbol without claiming strategy ownership', async () => {
  const { read, execute } = fixture([row])
  expect(await read()).toEqual([{ commandId: 'c1', intentId: 'i1', status: 'succeeded', sourceType: 'risk_decision', sourceId: 'r1',
    tradeDecisionId: 'd1', riskDecisionId: 'r1', instrumentId: 'XAUUSD.a', type: 'buy_limit', price: action.parameters.price, resultHash: 'hash' }])
  expect(execute.mock.calls[0]![1]).toEqual([7, '42', 't1', '9', 'Broker', '123'])
  const sql = execute.mock.calls[0]![0] as string
  expect(sql).toContain('FOR SHARE')
  expect(sql).not.toMatch(/deadline|expires|INTERVAL|SELECT \*/)
})
it.each(['dispatched', 'accepted', 'uncertain', 'reconciling'])('retains %s candidates', async status => {
  expect((await fixture([{ ...row, status }]).read())[0]?.status).toBe(status)
})
it.each([{ user_id: 8 }, { account_id: '43' }, { action_sha256: 'wrong' }, { action_json: '{' }, { action_json: null }, { status: 'queued' }])(
  'rejects wrong scope or corrupted candidates %j', async patch => {
    await expect(fixture([{ ...row, ...patch }]).read()).rejects.toMatchObject({ code: 'execution_dedup_candidate_invalid' })
  })
it('refuses truncation instead of reporting an incomplete set as complete', async () => {
  await expect(fixture(Array.from({ length: 1001 }, () => row)).read()).rejects.toMatchObject({ code: 'execution_dedup_candidate_capacity_exceeded' })
})
it('rejects duplicate command evidence', async () => {
  await expect(fixture([row, row]).read()).rejects.toMatchObject({ code: 'execution_dedup_candidate_invalid' })
})

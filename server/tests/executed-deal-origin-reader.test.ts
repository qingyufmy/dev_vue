import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { canonicalHash } from '../src/modules/execution/domain/bridge-command.js'
import { createMysqlExecutedDealOriginReader } from '../src/modules/execution/infrastructure/mysql-executed-deal-origin-reader.js'

const scope = { userId: 7, accountId: '5', terminalInstanceId: 'terminal', brokerServer: 'broker', login: '001', connectionEpoch: 3,
  deals: [{ ticket: '101', orderTicket: '201', positionId: '301', occurredAtUtcMsc: 1500 }] }
function fixture() {
  const result = { order: '201', deal: '101', position: '301' }
  const request = { v: 4, type: 'command.request', correlation_id: 'intent', route: { terminal_instance_id: 'terminal', account_ref: { broker_server: 'broker', login: '001' }, connection_epoch: 2 },
    payload: { command_id: 'command', action: 'position.close', issued_at_utc_msc: 1000, params: { ticket: '301' } } }
  const row = { command_id: 'command', intent_id: 'intent', action: 'position.close', decision_id: 'decision', risk_id: 'risk',
    issued_msc: '1000', completed_msc: '2000', terminal_code: '10009', result_json: result,
    result_sha256: canonicalHash({ command_id: 'command', action: 'position.close', status: 'succeeded', completed_at_utc_msc: 2000, result, error_code: null, terminal_code: 10009 }),
    request_json: request, request_sha256: canonicalHash(request.payload), connection_epoch: 2 }
  const rows = [row]
  const decision = { decisionId: 'decision', userId: 7, accountId: '5', strategyId: '9', strategyVersionId: '10' }
  const read = vi.fn(async () => decision)
  const execute = vi.fn(async () => [rows])
  const reader = createMysqlExecutedDealOriginReader({ execute } as unknown as PoolConnection, { read })
  return { row, rows, decision, read, execute, reader }
}
it('preserves exact receipt and immutable strategy version across an earlier command epoch', async () => {
  const f = fixture()
  expect(await f.reader.read(scope)).toEqual([expect.objectContaining({ dealTicket: '101', orderTicket: '201',
    intentId: 'intent', commandId: 'command', decisionId: 'decision', riskDecisionId: 'risk', strategyId: '9', strategyVersionId: '10' })])
})
it.each(['deal', 'order', 'position', 'time'] as const)('does not infer lineage from a mismatched %s', async kind => {
  const f = fixture(), input = structuredClone(scope)
  if (kind === 'deal') input.deals[0]!.ticket = '102'
  if (kind === 'order') input.deals[0]!.orderTicket = '202'
  if (kind === 'position') input.deals[0]!.positionId = '302'
  if (kind === 'time') input.deals[0]!.occurredAtUtcMsc = 2001
  expect(await f.reader.read(input)).toEqual([])
  expect(f.read).not.toHaveBeenCalled()
})
it('rejects receipt tampering, command tampering, ambiguous commands and foreign decision ownership', async () => {
  const result = fixture(); result.row.result_json.deal = '102'
  await expect(result.reader.read(scope)).rejects.toThrow('executed_deal_receipt_corrupt')
  const request = fixture(); request.row.request_json.payload.params.ticket = '302'
  await expect(request.reader.read(scope)).rejects.toThrow('executed_deal_request_corrupt')
  const duplicate = fixture(); duplicate.rows.push({ ...duplicate.row, command_id: 'command' })
  await expect(duplicate.reader.read(scope)).rejects.toThrow('executed_deal_origin_ambiguous')
  const owner = fixture(); owner.decision.userId = 8
  await expect(owner.reader.read(scope)).rejects.toThrow('executed_deal_decision_unavailable')
})
it('bounds the read and does not query for an empty request', async () => {
  const f = fixture()
  expect(await f.reader.read({ ...scope, deals: [] })).toEqual([])
  expect(f.execute).not.toHaveBeenCalled()
  await expect(f.reader.read({ ...scope, deals: [scope.deals[0]!, scope.deals[0]!] })).rejects.toThrow('executed_deal_origin_scope_invalid')
})

it('reports malformed stored route as a stable integrity error', async () => {
  const f = fixture()
  Reflect.deleteProperty(f.row.request_json.route, 'account_ref')
  await expect(f.reader.read(scope)).rejects.toThrow('executed_deal_request_corrupt')
})

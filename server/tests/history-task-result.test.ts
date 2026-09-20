import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { HistoryResourcePageChain } from '../src/modules/trade-history/application/trade-history-collector-ports.js'
import { historyTaskRoute } from '../src/modules/trade-history/application/history-collection-task.js'
import { historyTaskCompletion } from '../src/modules/trade-history/application/history-task-completion.js'
import { historyCollectionReceipt } from '../src/modules/trade-history/application/history-collection-receipt.js'
import { confirmCompletedHistoryTask, finishHistoryTask, failHistoryTask, renewHistoryTaskLease } from '../src/modules/trade-history/infrastructure/mysql-history-task-result.js'

const route: BridgeGatewayRoute = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', terminalProfileId: 'profile',
  brokerServer: 'Broker', login: '001', connectionEpoch: 3, connectionId: 'connection', sessionId: 'session', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const claim = { taskId: '00000000-0000-4000-8000-000000000001', accountId: '5', leaseToken: '00000000-0000-4000-8000-000000000002',
  rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, routeHash: historyTaskRoute(route).hash }
const chains: HistoryResourcePageChain[] = ['history.orders', 'history.deals'].map(resource => ({ resource: resource as HistoryResourcePageChain['resource'],
  rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, source: 'terminal', sourceRevision: 'r1', pageCount: 1, itemCount: 3, pageChainHash: 'a'.repeat(64) }))
const completion = historyTaskCompletion(claim, route, chains)
const receipt = historyCollectionReceipt(route, 2000, chains)

function fixture() {
  const task = { status: 'succeeded', completion_json: completion.json, completion_sha256: completion.hash, result_receipt_id: 'receipt-id' as string | null }
  const receipts = [{ evidence_json: receipt.json, evidence_sha256: receipt.hash }]
  const execute = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT status')) return [[task]]
    if (sql.startsWith('SELECT evidence_json')) return [receipts]
    throw Error('unexpected_write')
  })
  return { task, receipts, execute, connection: { execute } as unknown as PoolConnection }
}

it('confirms succeeded evidence after lease takeover without writing or requiring the old lease', async () => {
  const f = fixture()
  const takeover = { ...claim, leaseToken: '00000000-0000-4000-8000-000000000003' }
  expect(await confirmCompletedHistoryTask(f.connection, takeover, route, completion)).toBe(true)
  expect(f.execute).toHaveBeenCalledTimes(2)
})
it('does not treat a completing task as committed', async () => {
  const f = fixture(); f.task.status = 'completing'
  expect(await confirmCompletedHistoryTask(f.connection, claim, route, completion)).toBe(false)
  expect(f.execute).toHaveBeenCalledTimes(1)
})
it.each(['missing', 'duplicate', 'digest', 'body', 'json'])('rejects a corrupt linked receipt: %s', async kind => {
  const f = fixture()
  if (kind === 'missing') f.receipts.length = 0
  if (kind === 'duplicate') f.receipts.push({ ...f.receipts[0]! })
  if (kind === 'digest') f.receipts[0]!.evidence_sha256 = 'b'.repeat(64)
  if (kind === 'body') f.receipts[0]!.evidence_json = JSON.stringify({ ...receipt.evidence, accountId: '6' })
  if (kind === 'json') f.receipts[0]!.evidence_json = '{'
  await expect(confirmCompletedHistoryTask(f.connection, claim, route, completion)).rejects.toThrow('history_task_result_corrupt')
})
it('rejects a different completion instead of confirming an unrelated receipt', async () => {
  const f = fixture()
  const changed = historyTaskCompletion(claim, route, chains.map(c => ({ ...c, sourceRevision: 'changed' })))
  await expect(confirmCompletedHistoryTask(f.connection, claim, route, changed)).rejects.toThrow('history_task_completion_conflict')
  expect(f.execute).toHaveBeenCalledTimes(1)
})
it.each(['finish', 'fail', 'renew'])('rejects lease loss at the final %s write', async action => {
  const execute = vi.fn(async () => [{ affectedRows: 0 }])
  const connection = { execute } as unknown as PoolConnection
  const result = action === 'finish' ? finishHistoryTask(connection, claim, 'receipt-id')
    : action === 'fail' ? failHistoryTask(connection, claim, 'history_query_failed') : renewHistoryTaskLease(connection, claim)
  await expect(result).rejects.toThrow('history_task_lease_lost')
  expect(execute).toHaveBeenCalledTimes(1)
})
it('rejects unstructured failure text before writing', async () => {
  const f = fixture()
  await expect(failHistoryTask(f.connection, claim, 'SQL error: private details')).rejects.toThrow('history_task_error_invalid')
  expect(f.execute).not.toHaveBeenCalled()
})

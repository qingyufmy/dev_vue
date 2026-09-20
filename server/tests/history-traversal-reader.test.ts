import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import { historyCollectionReceipt } from '../src/modules/trade-history/application/history-collection-receipt.js'
import { createMysqlHistoryTraversalReader } from '../src/modules/trade-history/infrastructure/mysql-history-traversal-reader.js'
const route: BridgeGatewayRoute = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal',
  terminalProfileId: 'profile', brokerServer: 'Broker', login: '001', connectionEpoch: 3,
  connectionId: 'connection', sessionId: 'session', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const scope = { route, rangeStartUtcMsc: 1000, rangeEndUtcMsc: 4000 }
function row(start: number, end: number, suffix: string, source: 'terminal' | 'local_projection' = 'terminal', changed = route) {
  const receipt = historyCollectionReceipt(changed, end, ['history.orders', 'history.deals'].map(resource => ({
    resource: resource as 'history.orders' | 'history.deals', rangeStartUtcMsc: start, rangeEndUtcMsc: end,
    source, sourceRevision: 'r1', pageCount: 1, itemCount: 0, pageChainHash: 'a'.repeat(64) })))
  return { id: '00000000-0000-4000-8000-' + suffix.padStart(12, '0'), evidence_json: receipt.json,
    evidence_sha256: receipt.hash, start_msc: String(start), end_msc: String(end) }
}
function fixture(rows = [row(500,2500,'1'),row(2500,4500,'2')]) {
  const execute = vi.fn().mockResolvedValue([rows])
  return { rows, execute, reader: createMysqlHistoryTraversalReader({ execute } as unknown as PoolConnection) }
}
it('combines contiguous verified terminal traversals without claiming complete history', async () => {
  const f = fixture()
  expect(await f.reader.read(scope)).toEqual({ status: 'traversed', receiptIds: f.rows.map(r => r.id), completeHistoryProven: false })
  expect(f.execute.mock.calls[0]![1]).toEqual(['5',7,'mt5','terminal',3,'2',new Date(4000),new Date(1000)])
})
it('does not bridge a one-millisecond gap', async () => {
  const f = fixture([row(500,2500,'1'),row(2501,4500,'2')])
  expect(await f.reader.read(scope)).toEqual({ status: 'unresolved', reason: 'traversal_gap' })
})
it('does not upgrade local projection traversal to terminal traversal', async () => {
  expect(await fixture([row(500,4500,'1','local_projection')]).reader.read(scope)).toEqual({ status: 'unresolved', reason: 'traversal_gap' })
})
it('missing receipts stay unresolved', async () => {
  expect(await fixture([]).reader.read(scope)).toEqual({ status: 'unresolved', reason: 'traversal_gap' })
})
it.each(['hash','json','window','identity'])('rejects corrupted or mismatched receipts: %s', async kind => {
  const f = fixture()
  if (kind === 'hash') f.rows[0]!.evidence_sha256 = 'f'.repeat(64)
  if (kind === 'json') f.rows[0]!.evidence_json = '{'
  if (kind === 'window') f.rows[0]!.start_msc = '501'
  if (kind === 'identity') f.rows[0] = row(500,2500,'1','terminal',{ ...route, login: '002' })
  await expect(f.reader.read(scope)).rejects.toThrow('history_traversal_receipt_corrupt')
})
it('rejects unbounded receipt sets', async () => {
  await expect(fixture(Array.from({ length: 10001 }, () => row(500,4500,'1'))).reader.read(scope)).rejects.toThrow('history_traversal_limit_exceeded')
})
it('requires a valid owned route and increasing window before SQL', async () => {
  const f = fixture()
  await expect(f.reader.read({ ...scope, rangeEndUtcMsc: 1000 })).rejects.toThrow('history_traversal_scope_invalid')
  const unowned = { ...route }; delete unowned.ownershipRevision
  await expect(f.reader.read({ ...scope, route: unowned })).rejects.toThrow('history_traversal_scope_invalid')
  expect(f.execute).not.toHaveBeenCalled()
})

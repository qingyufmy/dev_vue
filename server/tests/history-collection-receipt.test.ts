import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { HistoryResourcePageChain } from '../src/modules/trade-history/application/trade-history-collector-ports.js'
import { historyCollectionReceipt } from '../src/modules/trade-history/application/history-collection-receipt.js'
import { MysqlTradeHistoryCollectorRepository } from '../src/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js'

const route: BridgeGatewayRoute = { userId: 7, accountId: '42', platform: 'mt5', timezoneOffsetMinutes: 180,
  terminalInstanceId: 'terminal_1', terminalProfileId: 'profile_1', brokerServer: 'Broker', login: '001',
  connectionEpoch: 3, connectionId: 'connection_1', sessionId: 'session_1', ownershipRevision: '2' }
const chains = (): HistoryResourcePageChain[] => ['history.orders', 'history.deals'].map(resource => ({ resource: resource as HistoryResourcePageChain['resource'],
  rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, source: 'local_projection', sourceRevision: 'revision_1', pageCount: 2, itemCount: 10, pageChainHash: 'a'.repeat(64) }))

it('canonicalizes resource order and freezes identity and window', () => {
  const input = chains(), receipt = historyCollectionReceipt(route, 2000, input)
  expect(historyCollectionReceipt(route, 2000, input.reverse()).hash).toBe(receipt.hash)
  input[0]!.pageCount = 99
  expect(receipt.evidence.resources[0]!.pageCount).toBe(2)
  expect(receipt.evidence).toMatchObject({ accountId: '42', login: '001', connectionEpoch: '3', ownershipRevision: '2', rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000 })
  const unknownOwner = { ...route }; delete unknownOwner.ownershipRevision
  expect(historyCollectionReceipt(unknownOwner, 2000, chains()).evidence.ownershipRevision).toBeNull()
})

it.each(['missing', 'duplicate', 'resource', 'window', 'end', 'count', 'hash'])('rejects invalid completed resource evidence: %s', kind => {
  const input = chains()
  if (kind === 'missing') input.pop()
  if (kind === 'duplicate') input[1]!.resource = 'history.orders'
  if (kind === 'resource') input[1]!.resource = 'history.trades'
  if (kind === 'window') input[1]!.rangeStartUtcMsc = 999
  if (kind === 'end') input[1]!.rangeEndUtcMsc = 2001
  if (kind === 'count') input[1]!.itemCount = 1001
  if (kind === 'hash') input[1]!.pageChainHash = 'bad'
  expect(() => historyCollectionReceipt(route, 2000, input)).toThrow('trade_history_collection_receipt_invalid')
})

function fixture(writeFails = false) {
  const trace: string[] = []
  let stored: string | null = null
  let status = 'syncing'
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT trading_account_id')) { trace.push('sync-lock'); return [[{ trading_account_id: '42', status }]] }
      if (sql.startsWith('SELECT id,evidence_json')) return [stored ? [{ id: 'existing', evidence_json: stored }] : []]
      if (sql.startsWith('INSERT INTO terminal_history_collection_receipts')) {
        trace.push('receipt')
        if (writeFails) throw Error('receipt_write_failed')
        stored = String(values[10]); return [{ affectedRows: 1 }]
      }
      if (sql.startsWith('UPDATE trade_history_sync_states')) { trace.push('ready'); status = 'ready' }
      if (sql.startsWith('INSERT INTO outbox_events')) trace.push('outbox')
      if (sql.startsWith('SELECT history_revision')) return [[{ history_revision: 2 }]]
      return [{ affectedRows: 1 }]
    }) }
  const repository = new MysqlTradeHistoryCollectorRepository({ getConnection: async () => connection } as unknown as Pool,
    () => ({ assert: async () => { trace.push('guard') } }))
  return { repository, trace, connection, corrupt: () => { stored = '{}' }, setStatus: (value: string) => { status = value } }
}

it('writes the receipt before ready/outbox in the existing completion transaction and reuses the same receipt', async () => {
  const f = fixture()
  await f.repository.complete(route, 2000, new Date(3000), chains())
  expect(f.trace).toEqual(['guard', 'sync-lock', 'receipt', 'ready', 'outbox'])
  expect(f.connection.commit).toHaveBeenCalledOnce()
  await f.repository.complete(route, 2000, new Date(4000), chains())
  expect(f.trace.filter(x => x === 'receipt')).toHaveLength(1)
  expect(f.trace.filter(x => x === 'ready')).toHaveLength(1)
  expect(f.trace.filter(x => x === 'outbox')).toHaveLength(1)
  f.corrupt()
  await expect(f.repository.complete(route, 2000, new Date(5000), chains())).rejects.toThrow('trade_history_collection_receipt_conflict')
})

it('confirms a committed receipt after lost COMMIT acknowledgement without repeating completion writes', async () => {
  const f = fixture()
  f.connection.commit.mockRejectedValueOnce(Error('socket_lost'))
  await expect(f.repository.complete(route, 2000, new Date(3000), chains())).rejects.toThrow('trade_history_commit_unknown')
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.connection.release).not.toHaveBeenCalled()
  await f.repository.complete(route, 2000, new Date(4000), chains())
  expect(f.trace.filter(x => x === 'ready')).toHaveLength(1)
  expect(f.trace.filter(x => x === 'outbox')).toHaveLength(1)
})

it('does not create a new receipt after syncing has ended', async () => {
  const f = fixture()
  f.setStatus('ready')
  await expect(f.repository.complete(route, 2000, new Date(3000), chains())).rejects.toThrow('trade_history_sync_not_active')
  expect(f.trace).toEqual(['guard', 'sync-lock'])
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})

it('rolls back completion when the receipt cannot be written', async () => {
  const f = fixture(true)
  await expect(f.repository.complete(route, 2000, new Date(3000), chains())).rejects.toThrow('receipt_write_failed')
  expect(f.trace).toEqual(['guard', 'sync-lock', 'receipt'])
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
})

import type { PoolConnection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryTaskCoverageReader } from '../src/modules/trade-history/application/history-task-coverage-reader.js'
import type { HistoryTaskDealSourceReader } from '../src/modules/trade-history/application/history-task-deal-source-reader.js'
import type { HistoryTaskDealInventoryReader } from '../src/modules/trade-history/application/history-task-deal-inventory-reader.js'
import { canonicalEvidence } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import { createMysqlHistoryTaskDealInventoryReader } from '../src/modules/trade-history/infrastructure/mysql-history-task-deal-inventory-reader.js'

function fixture() {
  const rows = ['10', '11'].map(ticket => {
    const raw = { deal_ticket: ticket, time_utc_msc: 1000 }
    return { id: 'deal-' + ticket, ticket, hash: canonicalEvidence(raw).hash, raw }
  })
  const receipt = { taskId: 'task', receiptId: 'receipt', completionHash: 'a'.repeat(64) }
  const coverage = { read: vi.fn(async () => ({ status: 'provider_asserted', ...receipt, rangeStartUtcMsc: 1, rangeEndUtcMsc: 2000,
    resources: [{ resource: 'history.deals', historyCoverage: {}, pageMembership: { pages: [{ factHashes: rows.map(row => row.hash) }] } }],
  })) } as unknown as HistoryTaskCoverageReader
  let stored = [...rows]
  const sources = { read: vi.fn(async () => ({ status: 'source_matched', ...receipt,
    deals: rows.map(row => ({ ticket: row.ticket, dealId: row.id, factHash: row.hash, provenanceHashes: ['b'.repeat(64)] })),
  })) } as unknown as HistoryTaskDealSourceReader
  const connection = { execute: vi.fn(async () => [stored]) } as unknown as Pick<PoolConnection, 'execute'>
  const reader = createMysqlHistoryTaskDealInventoryReader(connection, { coverage, sources })
  const scope = { taskId: 'task', route: { platform: 'mt5', accountId: '5' } } as Parameters<HistoryTaskDealInventoryReader['read']>[0]
  return { reader, scope, rows, sources, replace: (next: typeof rows) => { stored = next } }
}
describe('completed task full deal inventory', () => {
  it('requires every page-member fact and its exact source proof', async () => {
    const f = fixture()
    expect(await f.reader.read(f.scope)).toMatchObject({ status: 'inventory_matched', facts: [{ ticket: '10' }, { ticket: '11' }] })
    expect(f.sources.read).toHaveBeenCalledWith(expect.objectContaining({ dealTickets: ['10', '11'] }))
  })
  it('does not pass a subset when another page fact is absent', async () => {
    const f = fixture(); f.replace([f.rows[0]!])
    expect(await f.reader.read(f.scope)).toEqual({ status: 'unresolved', reason: 'inventory_missing' })
    expect(f.sources.read).not.toHaveBeenCalled()
  })
  it('rejects swapped raw identity and refuses receipt changes', async () => {
    const f = fixture(); f.rows[0]!.raw.deal_ticket = '99'
    await expect(f.reader.read(f.scope)).rejects.toThrow('history_inventory_corrupt')
    const changed = fixture()
    vi.mocked(changed.sources.read).mockResolvedValue({ status: 'source_matched', taskId: 'task', receiptId: 'other', completionHash: 'a'.repeat(64), deals: [] })
    expect(await changed.reader.read(changed.scope)).toEqual({ status: 'unresolved', reason: 'inventory_missing' })
  })
})

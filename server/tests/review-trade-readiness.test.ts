import { describe, expect, it, vi } from 'vitest'
import { createReviewTradeReadinessReader, type ReviewTradeReadinessReader } from '../src/modules/trade-history/application/review-trade-readiness.js'
import type { ReviewTradeEvidence } from '../src/modules/trade-history/application/review-trade-evidence-reader.js'
import type { HistoryTaskDealInventoryReader, HistoryTaskDealInventoryResult } from '../src/modules/trade-history/application/history-task-deal-inventory-reader.js'

function setup() {
  const fact = { id: 'deal-1', ticket: '10', hash: 'a'.repeat(64), raw: { deal_ticket: '10', position_id: '100', time_utc_msc: 1500 }, provenanceHashes: ['b'.repeat(64)] }
  const evidence = { recordId: 'record', userId: 7, accountId: '5', revision: 1, platform: 'mt5',
    openedAt: new Date(1000).toISOString(), closedAt: new Date(1500).toISOString(), projection: { positionId: '100' }, facts: [fact] } as unknown as ReviewTradeEvidence
  const result: HistoryTaskDealInventoryResult = { status: 'inventory_matched', taskId: 'task', receiptId: 'receipt', completionHash: 'c'.repeat(64),
    rangeStartUtcMsc: 500, rangeEndUtcMsc: 2000, facts: [fact] }
  const inventory: HistoryTaskDealInventoryReader = { read: vi.fn(async () => result) }
  const reader = createReviewTradeReadinessReader({ read: async () => ({ status: 'captured', evidence }) }, inventory, () => 3000)
  const scope = { userId: 7, recordId: 'record', expectedRevision: 1, taskId: 'task', asOfUtcMsc: 2000,
    route: { userId: 7, accountId: '5', platform: 'mt5' } } as Parameters<ReviewTradeReadinessReader['read']>[0]
  return { reader, scope, result, fact, inventory }
}
describe('review trade readiness at a frozen cutoff', () => {
  it('combines the exact trade set and a covering completed task', async () => {
    const f = setup()
    expect(await f.reader.read(f.scope)).toMatchObject({ status: 'ready_as_of', asOfUtcMsc: 2000, taskId: 'task', receiptId: 'receipt' })
  })
  it('refuses omitted position facts and insufficient coverage', async () => {
    const f = setup()
    f.result.facts.push({ ...f.fact, id: 'deal-2', ticket: '11', hash: 'd'.repeat(64), raw: { deal_ticket: '11', position_id: '100', time_utc_msc: 1800 } })
    expect(await f.reader.read(f.scope)).toEqual({ status: 'unresolved', reason: 'trade_inventory_mismatch' })
    f.result.rangeEndUtcMsc = 1900
    expect(await f.reader.read(f.scope)).toEqual({ status: 'unresolved', reason: 'collection_window_incomplete' })
  })
  it('rejects cross-user routes and future cutoffs before reading inventory', async () => {
    const f = setup()
    await expect(f.reader.read({ ...f.scope, asOfUtcMsc: 3001 })).rejects.toMatchObject({ code: 'review_trade_readiness_scope_invalid' })
    await expect(f.reader.read({ ...f.scope, route: { ...f.scope.route, userId: 8 } })).rejects.toMatchObject({ code: 'review_trade_readiness_scope_invalid' })
    expect(f.inventory.read).not.toHaveBeenCalled()
  })
})

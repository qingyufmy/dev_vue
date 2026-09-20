import { describe, expect, it, vi } from 'vitest'
import { ManualCandidateCollector, type ReadyReviewTrade } from '../src/modules/reviews/application/manual-candidate-collector.js'
import type { ReviewTradeReadinessReader } from '../src/modules/trade-history/index.js'

describe('manual candidate collection', () => {
  const scope = {} as Parameters<ReviewTradeReadinessReader['read']>[0]
  function setup(source: 'manual' | 'system' = 'manual') {
    const trade = { status: 'ready_as_of', evidence: { source } } as ReadyReviewTrade
    const verify = vi.fn(async (_trade: ReadyReviewTrade) => ({ status: 'verified' as const, evidence: { clock: 'historical-proof' } }))
    const write = vi.fn(async () => ({ status: 'created' as const, candidateId: 'candidate', revision: 1 }))
    const collector = new ManualCandidateCollector({ read: async () => trade }, { verify }, { write })
    return { collector, verify, write, trade }
  }
  it('requires manual source before asking for authority or writing', async () => {
    const f = setup('system')
    expect(await f.collector.collect(scope)).toEqual({ status: 'unresolved', reason: 'source_not_manual' })
    expect(f.verify).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
  it('propagates unavailable historical authority without writing', async () => {
    const f = setup()
    const collector = new ManualCandidateCollector({ read: async () => f.trade },
      { verify: async () => ({ status: 'unresolved', reason: 'historical_clock_unavailable' }) }, { write: f.write })
    expect(await collector.collect(scope)).toEqual({ status: 'unresolved', reason: 'historical_clock_unavailable' })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('writes the ready snapshot with frozen authority and preserves writer replay results', async () => {
    const f = setup()
    expect(await f.collector.collect(scope)).toEqual({ status: 'created', candidateId: 'candidate', revision: 1 })
    expect(f.write).toHaveBeenCalledWith({ trade: f.trade, authority: { clock: 'historical-proof' } })
    f.verify.mockImplementation(async value => { value.evidence.source = 'system'; return { status: 'verified', evidence: {} as { clock: string } } })
    await f.collector.collect(scope)
    expect(f.trade.evidence.source).toBe('manual')
  })
})

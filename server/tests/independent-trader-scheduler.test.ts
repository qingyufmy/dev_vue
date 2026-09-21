import { describe, expect, it } from 'vitest'
import { independentTraderSlot, IndependentTraderScheduler } from '../src/modules/inference/application/independent-trader-scheduler.js'

const candidate = { subscriptionId: '10', subscriptionRevision: 3, userId: 7, tradingAccountId: '8', marketAnalysisId: 'a1', strategyId: '20', strategyVersionId: '21', symbol: 'XAUUSD' }

describe('independent trader scheduler', () => {
  it('uses one stable idempotency key per M5 slot', async () => {
    const calls: unknown[][] = []
    const inference = { requestAccountEvaluation: async (...args: unknown[]) => { calls.push(args); return { id: 'run-1' } } }
    const scheduler = new IndependentTraderScheduler({ listCandidates: async () => [candidate] }, inference as never)
    const now = new Date('2026-09-21T08:07:13.000Z')
    const first = await scheduler.tick(now)
    await scheduler.tick(new Date('2026-09-21T08:09:59.000Z'))
    expect(independentTraderSlot(now)).toBe('2026-09-21T08:05:00.000Z')
    expect(calls.map(call => call[2])).toEqual(['independent-m5:10:r3:a1:2026-09-21T08:05:00.000Z'])
    expect(first.failures).toEqual([])
  })

  it('treats an expired background without inventory as idle', async () => {
    const scheduler = new IndependentTraderScheduler({ listCandidates: async () => [candidate] }, {
      requestAccountEvaluation: async () => { throw new Error('trader_analysis_expired') },
    } as never)
    await expect(scheduler.tick()).resolves.toMatchObject({ runs: [], failures: [] })
  })
})

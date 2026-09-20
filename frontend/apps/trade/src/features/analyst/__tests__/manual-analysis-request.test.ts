import { beforeEach, describe, expect, it } from 'vitest'
import { prepareManualAnalysis, clearManualAnalysis } from '../model/manual-analysis-request'
const body = { strategy_id: 'strategy-1', symbol: 'XAUUSD', mode: 'manual' as const }
beforeEach(() => sessionStorage.clear())
describe('manual analysis retries', () => {
  it('keeps the same request after an uncertain response or page remount', () => {
    const first = prepareManualAnalysis(sessionStorage, '1', body)
    expect(prepareManualAnalysis(sessionStorage, '1', body)).toEqual(first)
    expect(() => prepareManualAnalysis(sessionStorage, '1', { ...body, symbol: 'EURUSD' })).toThrow('尚未确认')
  })
  it('isolates users and creates a new key only after confirmation', () => {
    const first = prepareManualAnalysis(sessionStorage, '1', body)
    expect(prepareManualAnalysis(sessionStorage, '2', body).idempotencyKey).not.toBe(first.idempotencyKey)
    clearManualAnalysis(sessionStorage, '1')
    expect(prepareManualAnalysis(sessionStorage, '1', body).idempotencyKey).not.toBe(first.idempotencyKey)
  })
})

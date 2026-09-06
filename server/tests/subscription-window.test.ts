import { describe, expect, it } from 'vitest'
import { evaluateSubscriptionWindow } from '../src/modules/strategies/index.js'
import { AnalysisScheduler, type DueAnalysisSchedule, type InferenceService } from '../src/modules/inference/index.js'

const window = { version: 1, timezone: 'terminal_server', enabled: true, weekdays: [1], windows: [{ start: '22:00', end: '02:00' }], outsideBehavior: 'pause_all' }
const clock = { timezoneOffsetMinutes: 180, clockStatus: 'calibrated' }
const decide = (utc: string, overrides = {}) => evaluateSubscriptionWindow({ ...window, ...overrides }, 'terminal_server', new Date(utc), clock)

describe('subscription window runtime', () => {
  it('uses start-day ownership across midnight with exclusive ending', () => {
    for (const [utc, inside] of [['2026-09-07T18:59:00Z', false], ['2026-09-07T19:00:00Z', true],
      ['2026-09-07T22:59:59Z', true], ['2026-09-07T23:00:00Z', false], ['2026-09-08T19:00:00Z', false]] as const) {
      expect(decide(utc)).toMatchObject({ inferenceAllowed: inside, executionAllowed: inside })
    }
  })
  it('keeps equal endpoints as all selected day, and does not widen 23:59', () => {
    expect(decide('2026-09-07T03:00:00Z', { windows: [{ start: '10:00', end: '10:00' }] }).executionAllowed).toBe(true)
    expect(decide('2026-09-07T20:59:00Z', { windows: [{ start: '00:00', end: '23:59' }] }).executionAllowed).toBe(false)
  })
  it('allows analysis only outside a signals-only window, including unavailable clock', () => {
    expect(decide('2026-09-08T19:00:00Z', { outsideBehavior: 'signals_only' })).toMatchObject({ inferenceAllowed: true, executionAllowed: false })
    for (const status of ['stale', 'observer_bootstrap', 'unavailable', 'fallback']) {
      expect(evaluateSubscriptionWindow(window, 'terminal_server', new Date('2026-09-07T19:00:00Z'), { ...clock, clockStatus: status })).toMatchObject({ inferenceAllowed: false, executionAllowed: false, reason: 'clock_unverified' })
    }
    expect(evaluateSubscriptionWindow({ ...window, outsideBehavior: 'signals_only' }, 'terminal_server', new Date(), null)).toMatchObject({ inferenceAllowed: true, executionAllowed: false })
  })
  it('supports existing disabled V4 rows but rejects unknown or corrupted contracts', () => {
    expect(evaluateSubscriptionWindow('{"enabled":false}', 'UTC', new Date(), null).reason).toBe('disabled')
    for (const raw of [null, '{}', 'bad', { ...window, version: 2 }, { ...window, weekdays: [] },
      { ...window, windows: [{ start: '24:00', end: '02:00' }] }, { ...window, outsideBehavior: 'allow_all' }]) {
      expect(() => evaluateSubscriptionWindow(raw, 'terminal_server', new Date(), clock)).toThrow('subscription_window_invalid')
    }
    expect(() => evaluateSubscriptionWindow(window, 'UTC', new Date(), clock)).toThrow('subscription_window_invalid')
  })
  it('filters before grouping, advances closed rows, and isolates malformed rows', async () => {
    const now = new Date('2026-09-07T19:00:00Z'), advanced: string[] = [], selected: string[] = []
    const due: DueAnalysisSchedule[] = ['1', '2', '3'].map(id => ({ subscriptionId: id, userId: 42,
      marketSourceAccountId: id, strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD', cadenceSeconds: 300,
      nextDueAt: now.toISOString(), receiveTimezone: 'terminal_server', receiveWindow: id === '3' ? {} : window }))
    const inference = { async requestScheduledAnalysis(input: { marketSourceAccountId: string }) { selected.push(input.marketSourceAccountId); return { id: 'run' } } } as unknown as InferenceService
    const scheduler = new AnalysisScheduler({ async listDue() { return due }, async advance(id, _previous, next) {
      expect(next).toBe('2026-09-07T19:05:00.000Z'); advanced.push(id); return true
    } }, inference, async id => id === '1' ? { ...clock, timezoneOffsetMinutes: 0 } : clock)
    const result = await scheduler.tick(now)
    expect(selected).toEqual(['2'])
    expect(advanced).toEqual(['1', '2'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.key).toBe('3')
  })
  it('does not request terminal evidence for disabled schedules', async () => {
    const scheduler = new AnalysisScheduler({ async listDue() { return [{ subscriptionId: '1', userId: 42,
      marketSourceAccountId: '1', strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD', cadenceSeconds: 300,
      nextDueAt: '2026-09-07T00:00:00Z', receiveTimezone: 'UTC', receiveWindow: { enabled: false } }] }, async advance() { return true } },
    { async requestScheduledAnalysis() { return { id: 'run' } } } as unknown as InferenceService,
    async () => { throw new Error('clock_must_not_be_read') })
    expect((await scheduler.tick()).failures).toEqual([])
  })
})

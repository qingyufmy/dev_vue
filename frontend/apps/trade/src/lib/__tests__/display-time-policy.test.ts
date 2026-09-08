import { applyTradingContext } from '~/features/trading-context'
import { terminalInputTime, terminalInputUtc } from '../terminal-input-time'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountSnapshot, TradingContext } from '@aurum/contracts'
import { formatBeijingTime, formatDisplayTime } from '@aurum/ui/lib/time'
import { accountSnapshot } from '../trading-runtime'
import { activeTerminalDisplayTimezone, formatLaboratoryTime } from '../laboratory-display-time'
import { analysisTime } from '../../features/analyst/model/analysis-presentation'
import { formatReviewTime } from '../../features/reviewer/model/reviewer-presentation'

const instant = '2026-09-06T23:30:00.000Z'
afterEach(() => { accountSnapshot.value = null; applyTradingContext(null) })

describe('UTC storage and display policy', () => {
  it('uses Beijing outside the laboratory and UTC+3 for uncalibrated laboratory displays', () => {
    expect(formatBeijingTime(instant)).toBe('2026-09-07 07:30:00')
    expect(formatLaboratoryTime(instant)).toBe('2026-09-07 02:30:00')
    expect(formatLaboratoryTime(instant, 0)).toBe('2026-09-06 23:30:00')
    expect(formatLaboratoryTime(instant, -210)).toBe('2026-09-06 20:00:00')
    expect(formatDisplayTime('2026-09-07T07:30:00+08:00', 180)).toBe('2026-09-07 02:30:00')
  })
  it('never parses an ambiguous wall clock through the browser timezone', () => {
    for (const value of [null, '', 'invalid', '2026-09-06 23:30:00']) expect(formatBeijingTime(value)).toBe('--')
    expect(formatDisplayTime(instant, NaN)).toBe('--')
  })
  it('isolates account switches and gives frozen historical offsets priority', () => {
    applyTradingContext({ accountId: 'a' } as TradingContext)
    accountSnapshot.value = { id: 'a', timezoneOffsetMinutes: 0, clockStatus: 'calibrated' } as AccountSnapshot
    expect(analysisTime(instant)).toBe('2026-09-06 23:30:00')
    expect(formatReviewTime(instant, 480)).toBe('2026-09-07 07:30:00')
    applyTradingContext({ accountId: 'b' } as TradingContext)
    expect(analysisTime(instant)).toBe('2026-09-07 02:30:00')
    expect(activeTerminalDisplayTimezone().isDefault).toBe(true)
    expect(accountSnapshot.value.timezoneOffsetMinutes).toBe(0)
  })
})

it('round trips terminal input to UTC and rejects unknown offsets or impossible dates', () => {
  const display = terminalInputTime(instant, 180)
  expect(display).toBe('2026-09-07T02:30:00')
  expect(terminalInputUtc(display, 180)).toBe(Date.parse(instant))
  expect(terminalInputUtc('2026-09-06T23:30', 0)).toBe(Date.parse(instant))
  expect(terminalInputUtc(display, null)).toBeNaN()
  expect(terminalInputUtc('2026-02-30T12:00', 180)).toBeNaN()
  expect(terminalInputUtc('2026-09-06T24:00', 180)).toBeNaN()
})

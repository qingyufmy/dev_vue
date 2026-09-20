import { applyAccountSnapshot, applyRealtimeState } from '~/features/trading-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountSnapshot, SessionSummary } from '@aurum/contracts'
import { accountSnapshot, clearAccountRuntime, marketQuote, realtimeState, resourceRevisions, openPositions } from '../src/features/home/home-runtime'
import { applyTerminalMarketSnapshot } from '../src/features/home/terminal-market-state'

const mocks = vi.hoisted(() => ({
  createRealtimeTicket: vi.fn(),
  connectRealtime: vi.fn(),
}))

vi.mock('@aurum/api-client', () => ({ createApiClient: () => ({ createRealtimeTicket: mocks.createRealtimeTicket }) }))
vi.mock('@aurum/realtime', () => ({ connectRealtime: mocks.connectRealtime }))

import { startTradingRealtime, stopTradingRealtime } from '../src/features/home/trading-realtime'

const session = {
  user: { id: '99', display_name: '观摩者', avatar_url: null }, app: 'trade', permissions: [],
  authenticated_at: '2026-09-05T08:00:00.000Z', mfa_level: 'none', csrf_token: 'csrf-token',
} satisfies SessionSummary

function publication(overrides: Record<string, unknown> = {}) {
  return {
    v: 4, event_id: 'publication-event', type: 'observer.publication.changed',
    occurred_at: '2026-09-05T08:00:01.000Z', sequence: 1,
    scope: { user_id: '99', trading_account_id: '7', terminal_instance_id: null, observer_channel_id: 'observer-1' },
    resource: { kind: 'observer_publication', id: 'observer-1' }, revision: '12',
    data: { channel_id: 'observer-1', source_revision: 'source-7', resource: 'market.quote', resource_id: 'XAUUSD' },
    correlation_id: null, ...overrides,
  }
}

function sourceEvent(overrides: Record<string, unknown> = {}) {
  return {
    v: 4, event_id: 'source-event', type: 'market.quote.updated', occurred_at: '2026-09-05T08:00:01.000Z', sequence: 1,
    scope: { user_id: '99', trading_account_id: '7', terminal_instance_id: 'terminal-1', observer_channel_id: 'observer-1' },
    resource: { kind: 'market.quote', id: 'XAUUSD' }, revision: '12', data: { login: 'private-login' }, correlation_id: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('trade home observer realtime adapter', () => {
  let options: any
  let socket: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

  afterEach(() => { stopTradingRealtime(); vi.useRealTimers() })

  it('subscribes without a racing snapshot cursor and reads authority after subscription is ready', async () => {
    resourceRevisions.value.account = 123
    resourceRevisions.value.positions = 456
    const resync = vi.fn(async () => undefined)
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', null, resync)
    options.onOpen(socket)
    const targets = JSON.parse(socket.send.mock.calls[0]![0]).targets
    expect(targets.filter((target: any) => target.kind === 'account').every((target: any) => target.after_revision === null)).toBe(true)
    expect(resync).not.toHaveBeenCalled()
    await options.onMessage({ type: 'subscription.ready' })
    expect(resync).toHaveBeenCalledOnce()
    expect(realtimeState.value).toBe('live')
  })

  it('rejects cross-account rows and older position snapshots', async () => {
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', null, async () => undefined)
    const item = { ticket: '101', account_id: '7', symbol: 'XAUUSD', side: 'buy', volume: '0.01', open_price: '2300', current_price: '2301', stop_loss: null, take_profit: null, floating_profit: '1', opened_at: '2026-09-05T07:00:00.000Z', source: 'unknown', signal_id: null, revision: '12' }
    const event = (sequence: number, revision: string, row: typeof item) => sourceEvent({ type: 'positions.changed', sequence, revision,
      scope: { user_id: '99', trading_account_id: '7', terminal_instance_id: 'terminal-1', observer_channel_id: null },
      resource: { kind: 'positions', id: 'open' }, data: { items: [row] } })
    await options.onMessage(event(1, '12', item))
    expect(openPositions.value).toHaveLength(1)
    await options.onMessage(event(2, '11', { ...item, current_price: '1' }))
    expect(openPositions.value[0]?.currentPrice).toBe('2301')
    await options.onMessage(event(3, '13', { ...item, account_id: '8' }))
    expect(openPositions.value[0]?.accountId).toBe('7')
    expect(resourceRevisions.value.positions).toBe(12)
  })

  it('does not use a historical candle row revision as a live subscription cursor', async () => {
    resourceRevisions.value.candle = 1788000000000
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', null, async () => undefined)
    options.onOpen(socket as never)
    const { targets } = JSON.parse(socket.send.mock.calls[0]![0])
    expect(targets.find((target: any) => target.resource_id === 'public_candle').after_revision).toBeNull()
    expect(targets.filter((target: any) => target.kind === 'market').every((target: any) => target.trading_account_id === null)).toBe(true)
    await options.onMessage({ type: 'subscription.ready' })
    expect(realtimeState.value).toBe('live')
    expect(socket.close).not.toHaveBeenCalled()
  })

  it('subscribes an owned non-public symbol to terminal quote and candle resources', async () => {
    applyTerminalMarketSnapshot({ accountId: '7', symbol: 'BTCUST', timeframe: 'M5', candles: [], quote: null, structure: null })
    await startTradingRealtime(session, '7', 'BTCUST', 'M5', null, async () => undefined, undefined, 'terminal')
    options.onOpen(socket as never)
    const { targets } = JSON.parse(socket.send.mock.calls[0]![0])
    const market = targets.filter((target: any) => target.kind === 'market')
    expect(market).toEqual(expect.arrayContaining([
      expect.objectContaining({ trading_account_id: '7', symbol: 'BTCUST', resource_id: 'quote' }),
      expect.objectContaining({ trading_account_id: '7', symbol: 'BTCUST', timeframe: 'M5', resource_id: 'candle' }),
    ]))
    await options.onMessage(sourceEvent({
      scope: { user_id: '99', trading_account_id: '7', terminal_instance_id: 'terminal-1', observer_channel_id: null },
      resource: { kind: 'market.quote', id: 'BTCUST' },
      data: { symbol: 'BTCUST', bid: '80291.17', ask: '80305.17', last: '80295', spread: '14', observed_at: '2026-09-05T08:00:01.000Z' },
    }))
    expect(marketQuote.value).toMatchObject({ symbol: 'BTCUST', bid: '80291.17', ask: '80305.17' })
  })

  it('keeps analysis refresh notifications after ticket failure and reconnect', async () => {
    vi.useFakeTimers()
    mocks.createRealtimeTicket.mockRejectedValueOnce(new Error('temporary_ticket_failure'))
    const resync = vi.fn(async () => undefined)
    const analysisChanged = vi.fn()
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', null, resync, analysisChanged)
    expect(mocks.connectRealtime).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1300)
    expect(resync).toHaveBeenCalledOnce()
    expect(mocks.connectRealtime).toHaveBeenCalledOnce()
    await options.onMessage(sourceEvent({ type: 'market_analysis.created',
      scope: { user_id: '99', trading_account_id: null, terminal_instance_id: null, observer_channel_id: null },
      resource: { kind: 'market_analysis', id: 'analysis-1' }, data: {} }))
    expect(analysisChanged).toHaveBeenCalledOnce()
  })

  it('does not revive an old account while its reconnect snapshot is pending', async () => {
    vi.useFakeTimers()
    const oldSnapshot = deferred<void>()
    const oldAnalysis = vi.fn()
    const newAnalysis = vi.fn()
    mocks.createRealtimeTicket.mockRejectedValueOnce(new Error('temporary_ticket_failure'))
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', null, () => oldSnapshot.promise, oldAnalysis)
    await vi.advanceTimersByTimeAsync(1300)
    await startTradingRealtime(session, '8', 'XAUUSD', 'M5', null, async () => undefined, newAnalysis)
    oldSnapshot.resolve()
    await flush()
    expect(mocks.connectRealtime).toHaveBeenCalledOnce()
    options.onOpen(socket as never)
    const { targets } = JSON.parse(socket.send.mock.calls[0]![0] as string)
    expect(targets.filter((target: any) => target.trading_account_id !== null)
      .every((target: any) => target.trading_account_id === '8')).toBe(true)
    await options.onMessage(sourceEvent({ type: 'market_analysis.created',
      scope: { user_id: '99', trading_account_id: null, terminal_instance_id: null, observer_channel_id: null },
      resource: { kind: 'market_analysis', id: 'analysis-2' }, data: {} }))
    expect(oldAnalysis).not.toHaveBeenCalled()
    expect(newAnalysis).toHaveBeenCalledOnce()
  })

  beforeEach(() => {
    stopTradingRealtime()
    clearAccountRuntime()
    applyRealtimeState('idle')
    mocks.createRealtimeTicket.mockReset().mockResolvedValue(undefined)
    mocks.connectRealtime.mockReset().mockImplementation((next: any) => {
      options = next
      socket = { send: vi.fn(), close: vi.fn() }
      return { socket, close: vi.fn() }
    })
    applyAccountSnapshot({ id: '7' } as never)
  })

  it('updates the owner clock from metrics and rejects older or foreign-account events', async () => {
    applyAccountSnapshot({ id: '7', revision: 10, timezoneOffsetMinutes: 120, clockStatus: 'calibrated' } as AccountSnapshot)
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', null, async () => undefined)
    const metrics = { balance: '100', equity: '100', margin: '0', free_margin: '100', floating_profit: '0', currency: 'USD', observed_at: '2026-09-06T08:00:00.000Z', timezone_offset_minutes: 0, clock_status: 'stale' }
    const event = sourceEvent({ type: 'account.metrics.changed', scope: { user_id: '99', trading_account_id: '7', terminal_instance_id: 'terminal-1', observer_channel_id: null }, resource: { kind: 'account.metrics', id: 'current' }, revision: '11', data: metrics })
    await options.onMessage(event)
    expect(accountSnapshot.value).toMatchObject({ revision: 11, timezoneOffsetMinutes: 0, clockStatus: 'stale' })
    await options.onMessage({ ...event, sequence: 2, revision: '10', data: { ...metrics, timezone_offset_minutes: 180, clock_status: 'calibrated' } })
    expect(accountSnapshot.value?.timezoneOffsetMinutes).toBe(0)
    await options.onMessage({ ...event, sequence: 3, revision: '12', scope: { ...(event.scope as object), trading_account_id: '8' }, data: { ...metrics, timezone_offset_minutes: 180 } })
    expect(accountSnapshot.value?.revision).toBe(11)
    await options.onMessage({ ...event, sequence: 4, revision: '13', data: { ...metrics, timezone_offset_minutes: null, clock_status: 'unavailable' } })
    expect(accountSnapshot.value).toMatchObject({ revision: 13, timezoneOffsetMinutes: null, clockStatus: 'unavailable' })
  })

  it('omits runtime observer targets and sends null after revisions', async () => {
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', 'observer-1', async () => undefined)
    options.onOpen(socket as never)
    const subscribe = JSON.parse(socket.send.mock.calls[0]![0] as string) as { targets: Array<Record<string, unknown>> }
    const accountTargets = subscribe.targets.filter(target => target.trading_account_id === '7')
    expect(accountTargets.some(target => target.kind === 'runtime')).toBe(false)
    expect(accountTargets.every(target => target.observer_channel_id === 'observer-1' && target.after_revision === null)).toBe(true)
  })

  it('coalesces observer publication resyncs and never patches source data', async () => {
    const refresh = deferred<void>()
    const resync = vi.fn(() => refresh.promise)
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', 'observer-1', resync)
    options.onOpen(socket as never)
    const first = options.onMessage(publication())
    await flush()
    const second = options.onMessage(publication({ event_id: 'publication-event-2', sequence: 2 }))
    await second
    expect(resync).toHaveBeenCalledTimes(1)
    refresh.resolve()
    await first
    await flush()
    expect(resync).toHaveBeenCalledTimes(2)
    expect(accountSnapshot.value).toEqual({ id: '7' })
  })

  it('ignores a publication with the wrong account/channel scope and rejects raw observer account events', async () => {
    const resync = vi.fn(async () => undefined)
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', 'observer-1', resync)
    options.onOpen(socket as never)
    await options.onMessage(publication({ scope: { user_id: '99', trading_account_id: '8', terminal_instance_id: null, observer_channel_id: 'observer-1' } }))
    await options.onMessage(sourceEvent({ sequence: 2 }))
    await flush()
    expect(resync).not.toHaveBeenCalled()
    expect(accountSnapshot.value).toEqual({ id: '7' })
  })

  it('does not mark the connection live after an in-flight resync loses its connection', async () => {
    const refresh = deferred<void>()
    const resync = vi.fn(() => refresh.promise)
    await startTradingRealtime(session, '7', 'XAUUSD', 'M5', 'observer-1', resync)
    options.onOpen(socket as never)
    const pending = options.onMessage(publication())
    await flush()
    options.onClose({} as CloseEvent)
    refresh.resolve()
    await pending
    await flush()
    expect(realtimeState.value).toBe('offline')
    stopTradingRealtime()
  })
})

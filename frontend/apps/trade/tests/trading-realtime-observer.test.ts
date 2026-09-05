import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@aurum/contracts'
import { accountSnapshot, clearAccountRuntime, realtimeState } from '../src/features/home/home-runtime'

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

  beforeEach(() => {
    stopTradingRealtime()
    clearAccountRuntime()
    realtimeState.value = 'idle'
    mocks.createRealtimeTicket.mockReset().mockResolvedValue(undefined)
    mocks.connectRealtime.mockReset().mockImplementation((next: any) => {
      options = next
      socket = { send: vi.fn(), close: vi.fn() }
      return { socket, close: vi.fn() }
    })
    accountSnapshot.value = { id: '7' } as never
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

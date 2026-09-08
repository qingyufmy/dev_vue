import { afterEach, expect, it, vi } from 'vitest'
import type { RealtimeConnectionOptions } from '@aurum/realtime'
import { startMarketRealtime } from '../model/market-realtime'

afterEach(() => vi.useRealTimers())
it('subscribes only public market targets, resyncs on ready and filters user scope', async () => {
  vi.useFakeTimers()
  let callbacks!: RealtimeConnectionOptions
  const close = vi.fn(), invalidate = vi.fn(), onState = vi.fn()
  const listener = startMarketRealtime({ userId: '1', url: 'ws://localhost/realtime/v4', ticket: async () => {}, invalidate, onState,
    connect: options => { callbacks = options; return { close, socket: {} as WebSocket } } })
  await Promise.resolve()
  const send = vi.fn(); callbacks.onOpen({ send } as unknown as WebSocket)
  const subscription = JSON.parse(send.mock.calls[0]![0])
  expect(subscription.targets.map((target: { resource_id: string }) => target.resource_id)).toEqual(['macro', 'calendar'])
  callbacks.onMessage({ type: 'subscription.ready', request_id: 'wrong' })
  expect(invalidate).not.toHaveBeenCalled()
  callbacks.onMessage({ type: 'subscription.ready', request_id: subscription.request_id })
  expect(onState).toHaveBeenLastCalledWith('live')
  expect(invalidate).toHaveBeenCalledTimes(1)
  const event = { v: 4, event_id: 'event', occurred_at: '2026-09-09T00:00:00.000Z', sequence: 1,
    scope: { user_id: '2', trading_account_id: null, terminal_instance_id: null, observer_channel_id: null }, revision: '1', correlation_id: null,
    type: 'market.macro.changed', resource: { kind: 'macro_snapshot', id: 'snapshot' },
    data: { change: 'updated', published_at: '2026-09-09T00:00:00.000Z', status: 'fresh' } }
  callbacks.onMessage(event); expect(invalidate).toHaveBeenCalledTimes(1)
  callbacks.onMessage({ ...event, scope: { ...event.scope, user_id: '1' } }); expect(invalidate).toHaveBeenCalledTimes(2)
  listener.stop(); callbacks.onMessage({ ...event, scope: { ...event.scope, user_id: '1' } })
  expect(invalidate).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledTimes(1)
})

it('retries ticket failures and ready timeouts and cancels retries when stopped', async () => {
  vi.useFakeTimers()
  const ticket = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined)
  const close = vi.fn(), connect = vi.fn(() => ({ close, socket: {} as WebSocket }))
  const listener = startMarketRealtime({ userId: '1', url: 'ws://localhost', ticket, invalidate: vi.fn(), onState: vi.fn(), connect })
  await vi.advanceTimersByTimeAsync(1000)
  expect(ticket).toHaveBeenCalledTimes(2)
  expect(connect).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(10000)
  expect(close).toHaveBeenCalledTimes(1)
  listener.stop()
  await vi.advanceTimersByTimeAsync(30000)
  expect(ticket).toHaveBeenCalledTimes(2)
})

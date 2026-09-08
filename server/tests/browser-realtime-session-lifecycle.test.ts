import { expect, it, vi } from 'vitest'
import { createBrowserRealtimeSessions } from '../src/modules/trading/composition.js'
import type { BrowserRealtimeHub } from '../src/modules/trading/transport/realtime/browser-realtime-hub.js'

const subscribe = { v: 4, type: 'subscription.subscribe', request_id: 'sub', targets: [{
  kind: 'account', trading_account_id: '7', observer_channel_id: null, symbol: null,
  timeframe: null, resource_id: 'positions', after_revision: null,
}] }

it('releases a subscription that finishes after connection close and ignores queued messages', async () => {
  let finish!: (release: () => void) => void
  const pending = new Promise<() => void>(resolve => { finish = resolve })
  const subscribeTargets = vi.fn(async (input: Parameters<BrowserRealtimeHub['subscribeTargets']>[0]) => {
    const release = await pending
    input.sink.send({ type: 'subscription.subscribed' })
    return release
  })
  const sink = { send: vi.fn(), close: vi.fn() }, release = vi.fn()
  const session = createBrowserRealtimeSessions({ subscribeTargets } as unknown as BrowserRealtimeHub).open(42, sink)
  const receiving = session.receive(subscribe)
  session.close()
  finish(release)
  await receiving
  await session.receive(subscribe)
  await session.receive({ v: 4, type: 'system.ping', request_id: 'ping' })
  session.close()
  expect(release).toHaveBeenCalledOnce()
  expect(subscribeTargets).toHaveBeenCalledOnce()
  expect(sink.send).not.toHaveBeenCalled()
})

it('invalidates pending subscriptions on unsubscribe while allowing a later subscription', async () => {
  let finish!: (release: () => void) => void
  const pending = new Promise<() => void>(resolve => { finish = resolve })
  const oldRelease = vi.fn(), newRelease = vi.fn()
  const subscribeTargets = vi.fn().mockImplementationOnce(async (input: Parameters<BrowserRealtimeHub['subscribeTargets']>[0]) => {
    const release = await pending
    input.sink.send({ type: 'subscription.subscribed' })
    input.sink.close(4403, 'late_authorization_result')
    return release
  }).mockResolvedValueOnce(newRelease)
  const sink = { send: vi.fn(), close: vi.fn() }
  const session = createBrowserRealtimeSessions({ subscribeTargets } as unknown as BrowserRealtimeHub).open(42, sink)
  const receiving = session.receive(subscribe)
  await session.receive({ v: 4, type: 'subscription.unsubscribe', request_id: 'unsub' })
  finish(oldRelease)
  await receiving
  expect(oldRelease).toHaveBeenCalledOnce()
  await session.receive(subscribe)
  expect(newRelease).not.toHaveBeenCalled()
  session.close()
  expect(newRelease).toHaveBeenCalledOnce()
  expect(sink.close).not.toHaveBeenCalled()
  expect(sink.send).toHaveBeenCalledOnce()
  expect(sink.send).toHaveBeenCalledWith({ v: 4, type: 'subscription.unsubscribed', request_id: 'unsub' })
})

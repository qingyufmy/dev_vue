import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import { BrowserRealtimeHub } from '../src/modules/trading/transport/realtime/browser-realtime-hub.js'
import { RedisBrowserRealtimeSubscriber } from '../src/modules/trading/infrastructure/redis-browser-realtime-subscriber.js'
import { OBSERVER_CONTROL_CHANNEL, observerInvalidation } from '../src/modules/trading/application/observer-invalidation.js'
import { RedisOutboxRealtimePublisher } from '../src/outbox/infrastructure/redis-outbox-realtime-publisher.js'
import type { ObserverAuthorization } from '../src/modules/trading/application/observer-ports.js'
import type { TradingReadRepository } from '../src/modules/trading/application/trading-ports.js'
import type { ClaimedOutboxEvent } from '../src/outbox/application/outbox-ports.js'
import { MysqlOutboxRepository } from '../src/outbox/infrastructure/mysql-outbox-repository.js'

const control = { source_id: '3', channel_id: null, user_id: null, registry_revision: 2 }
const proof = (userId = 9, channelId = '12'): ObserverAuthorization => ({
  userId, channelId, sourceId: '3', accountId: '7', operatorUserId: 42, userTokenVersion: 1,
  sourceRevision: '1', channelRevision: '1', accessRevision: '1', ownershipRevision: '1', displayName: '测试',
  expiresAtUtc: new Date(Date.now() + 30_000).toISOString(),
})
const target = { accountId: '7', observerChannelId: '12', resources: ['positions:open'], afterRevision: { 'positions:open': null } }
const sink = () => ({ send: vi.fn(), close: vi.fn() })
function hubFixture() {
  const authorize = vi.fn(async (userId: number, channelId: string) => proof(userId, channelId))
  const repo = { findOwnedAccount: async () => ({ id: '7' }), latestRevision: async () => 0 } as unknown as TradingReadRepository
  return { hub: new BrowserRealtimeHub(repo, { list: async () => [], authorize }), authorize }
}

describe('observer authorization control propagation', () => {
  it('keeps the internal contract separate from public events and pins its required fields', () => {
    const schema = JSON.parse(readFileSync(new URL('../../contracts/observer-authorization-control-v4.schema.json', import.meta.url), 'utf8'))
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required.slice().sort()).toEqual(Object.keys(control).sort())
    expect(schema.properties.user_id.maximum).toBe(2_147_483_647)
    expect(schema.properties.registry_revision.maximum).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('includes control events in the production outbox claim and expired-lease recovery filters', async () => {
    const execute = vi.fn(async (_sql: string, _params?: unknown) => [[], []])
    const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
    const repository = new MysqlOutboxRepository({ getConnection: async () => connection } as unknown as Pool)
    expect(await repository.claim('test-worker', 10, 30, new Date())).toEqual([])
    expect(execute.mock.calls).toHaveLength(2)
    for (const call of execute.mock.calls) expect(String(call[0])).toContain("'observer.authorization.changed'")
    expect(connection.commit).toHaveBeenCalledOnce()
  })
  it('validates a tiny strict control payload with no private or unknown fields', () => {
    expect(observerInvalidation(control)).toEqual(control)
    expect(observerInvalidation({ ...control, notes: 'secret' })).toBeNull()
    expect(observerInvalidation({ ...control, user_id: '9' })).toBeNull()
    expect(observerInvalidation({ ...control, registry_revision: -1 })).toBeNull()
    expect(observerInvalidation({ ...control, source_id: '1 OR 1=1' })).toBeNull()
  })

  it('outbox uses the internal channel, no SQL, and propagates delivery failure for retry', async () => {
    const publish = vi.fn().mockResolvedValue(0)
    const execute = vi.fn()
    const writer = new RedisOutboxRealtimePublisher({ execute } as unknown as Pool, { publish } as unknown as Redis)
    const event: ClaimedOutboxEvent = { id: '1', eventId: 'control-1', eventType: 'observer.authorization.changed',
      occurredAt: new Date().toISOString(), payload: control, attempts: 0 }
    await writer.publish(event)
    expect(publish).toHaveBeenCalledWith(OBSERVER_CONTROL_CHANNEL, JSON.stringify(control))
    expect(execute).not.toHaveBeenCalled()
    publish.mockRejectedValueOnce(new Error('redis_down'))
    await expect(writer.publish(event)).rejects.toThrow('redis_down')
    await expect(writer.publish({ ...event, payload: { ...control, secret: 'x' } })).rejects.toThrow('observer_invalidation_invalid')
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('subscribes to both channels and never routes control messages as private data', async () => {
    const redis = Object.assign(new EventEmitter(), { subscribe: vi.fn(), unsubscribe: vi.fn() })
    const destination = { publish: vi.fn(), invalidateObserverAuthorization: vi.fn() }
    const invalid = vi.fn()
    const subscriber = new RedisBrowserRealtimeSubscriber(redis as unknown as Redis, destination, undefined, invalid)
    await subscriber.start()
    expect(redis.subscribe).toHaveBeenCalledWith('aurum:v4:browser-realtime:events', OBSERVER_CONTROL_CHANNEL)
    redis.emit('message', OBSERVER_CONTROL_CHANNEL, JSON.stringify(control))
    expect(destination.invalidateObserverAuthorization).toHaveBeenCalledWith(control)
    redis.emit('message', OBSERVER_CONTROL_CHANNEL, '{bad')
    redis.emit('message', OBSERVER_CONTROL_CHANNEL, ' '.repeat(1025))
    expect(invalid).toHaveBeenCalledTimes(2)
    expect(destination.publish).not.toHaveBeenCalled()
    await subscriber.close()
    expect(redis.listenerCount('message')).toBe(0)
  })

  it('invalidates only matching observer scopes, preserves owners, and tolerates duplicate delivery', async () => {
    const { hub } = hubFixture()
    const one = sink(), two = sink(), owner = sink()
    const closeOne = await hub.subscribe({ ...target, userId: 9, sink: one })
    const closeTwo = await hub.subscribe({ ...target, userId: 10, sink: two })
    const closeOwner = await hub.subscribe({ ...target, userId: 9, observerChannelId: null, sink: owner })
    hub.invalidateObserverAuthorization({ ...control, channel_id: '13' })
    expect(one.close).not.toHaveBeenCalled()
    hub.invalidateObserverAuthorization({ ...control, channel_id: '12', user_id: 9 })
    hub.invalidateObserverAuthorization({ ...control, channel_id: '12', user_id: 9 })
    expect(one.close).toHaveBeenCalledTimes(1)
    expect(one.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'subscription.resync_required', reason: 'authorization_changed' }))
    expect(two.close).not.toHaveBeenCalled()
    expect(owner.close).not.toHaveBeenCalled()
    hub.invalidateObserverAuthorization({ ...control, source_id: null, registry_revision: 1 })
    expect(two.close).toHaveBeenCalledTimes(1)
    expect(owner.close).not.toHaveBeenCalled()
    closeOne?.(); closeTwo?.(); closeOwner?.()
  })

  it('rejects proof that was in flight when a control message arrived', async () => {
    const { hub, authorize } = hubFixture()
    let resolve!: (value: ObserverAuthorization) => void
    authorize.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const destination = sink()
    const pending = hub.subscribe({ ...target, userId: 9, sink: destination })
    hub.invalidateObserverAuthorization(control)
    resolve(proof())
    expect(await pending).toBeNull()
    expect(destination.send).not.toHaveBeenCalled()
    expect(destination.close).toHaveBeenCalledWith(4403, 'authorization_changed')
  })

  it('drops a queued publication if revoked while reauthorization is in flight', async () => {
    const { hub, authorize } = hubFixture()
    const destination = sink()
    const close = await hub.subscribe({ ...target, userId: 9, sink: destination })
    let resolve!: (value: ObserverAuthorization) => void
    authorize.mockReturnValueOnce(new Promise(done => { resolve = done }))
    hub.publish({ eventId: 'private-event', occurredAt: new Date().toISOString(), type: 'positions.changed', userId: 42,
      accountId: '7', terminalInstanceId: 'secret', resource: 'positions', resourceId: 'open', revision: 2, data: { secret: true } })
    hub.invalidateObserverAuthorization(control)
    resolve(proof())
    await Promise.resolve(); await Promise.resolve()
    expect(destination.send.mock.calls.map(call => call[0].type)).not.toContain('observer.publication.changed')
    expect(JSON.stringify(destination.send.mock.calls)).not.toContain('private-event')
    close?.()
  })
})

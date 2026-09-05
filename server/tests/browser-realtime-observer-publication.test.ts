import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserRealtimeHub, OBSERVER_AUTHORIZATION_TTL_MS,
  type BrowserRealtimeEvent, type BrowserRealtimeSink, type ObserverAccessReader,
  type ObserverAuthorization, type TradingReadRepository,
} from '../src/modules/trading/index.js'

const NOW = Date.parse('2026-09-05T08:00:00.000Z')

function authorization(overrides: Partial<ObserverAuthorization> = {}): ObserverAuthorization {
  return {
    userId: 99,
    channelId: 'observer-1',
    sourceId: 'source-1',
    sourceRevision: 'source-7',
    ownershipRevision: 'ownership-3',
    channelRevision: 'channel-4',
    accessRevision: 'access-5',
    userTokenVersion: 2,
    accountId: '7',
    operatorUserId: 42,
    displayName: '黄金观摩',
    expiresAtUtc: new Date(NOW + OBSERVER_AUTHORIZATION_TTL_MS).toISOString(),
    ...overrides,
  }
}

function repository() {
  const account = {
    id: '7', platform: 'mt5' as const, login: '596520', server: 'DooTechnology-Demo', currency: 'USD',
    terminalProfileId: 'profile-1', terminalInstanceId: 'terminal-1', bridgeState: 'online' as const,
    tradePermission: true, lastSeenAt: '2026-09-05T08:00:00.000Z',
  }
  return {
    account,
    listObserverChannels: vi.fn(async () => [{ id: 'observer-1', displayName: '旧路径', sourceAccountId: '7', active: true }]),
    listAccounts: vi.fn(async () => []),
    findAccount: vi.fn(async (accountId: string) => accountId === account.id ? account : null),
    findOwnedAccount: vi.fn(async (userId: number, accountId: string) => userId === 42 && accountId === account.id ? account : null),
    latestRevision: vi.fn(async () => 0),
  } as unknown as TradingReadRepository & {
    listObserverChannels: ReturnType<typeof vi.fn>
    findOwnedAccount: ReturnType<typeof vi.fn>
    latestRevision: ReturnType<typeof vi.fn>
  }
}

function accessFixture(initial: ObserverAuthorization | null = authorization()) {
  let current = initial
  let failure: Error | null = null
  const authorize = vi.fn(async () => {
    if (failure) throw failure
    return current
  })
  const reader: ObserverAccessReader = {
    list: async () => [],
    authorize,
  }
  return {
    reader,
    authorize,
    setAuthorization(value: ObserverAuthorization | null) { current = value },
    setFailure(value: Error | null) { failure = value },
  }
}

function sink() {
  const messages: unknown[] = []
  const closes: Array<{ code: number; reason: string }> = []
  const value: BrowserRealtimeSink = {
    send(message) { messages.push(message) },
    close(code, reason) { closes.push({ code, reason }) },
  }
  return { sink: value, messages, closes }
}

function sourceEvent(overrides: Partial<BrowserRealtimeEvent> = {}): BrowserRealtimeEvent {
  return {
    eventId: 'source-event-1',
    type: 'market.quote.updated',
    occurredAt: '2026-09-05T08:00:01.000Z',
    userId: 42,
    accountId: '7',
    terminalInstanceId: 'terminal-1',
    resource: 'market.quote',
    resourceId: 'XAUUSD',
    revision: 12,
    data: { login: 'private-login', profile_id: 'private-profile', signal_id: 'private-signal' },
    ...overrides,
  }
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function observerTarget(afterRevision: number | null = null) {
  return {
    accountId: '7',
    observerChannelId: 'observer-1',
    resources: ['market.quote:XAUUSD'],
    afterRevision: { 'market.quote:XAUUSD': afterRevision },
    publicTarget: {
      kind: 'market', trading_account_id: '7', observer_channel_id: 'observer-1',
      symbol: 'XAUUSD', timeframe: null, resource_id: 'quote', after_revision: afterRevision === null ? null : String(afterRevision),
    },
  }
}

describe('BrowserRealtimeHub observer publication authorization', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects observer targets without an access reader and never falls back to legacy channel listing', async () => {
    const repositoryStore = repository()
    const messages = sink()
    const result = await new BrowserRealtimeHub(repositoryStore).subscribe({
      userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'],
      afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink,
    })
    expect(result).toBeNull()
    expect(messages.closes).toEqual([{ code: 4403, reason: 'realtime_scope_forbidden' }])
    expect(repositoryStore.listObserverChannels).not.toHaveBeenCalled()
  })

  it('requires null observer after_revision, allows the account whitelist, and supports mixed user targets', async () => {
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const result = await new BrowserRealtimeHub(repositoryStore, access.reader, () => NOW).subscribeTargets({
      userId: 99,
      requestId: 'observer-subscribe',
      sink: messages.sink,
      targets: [
        observerTarget(),
        {
          accountId: null, observerChannelId: null, resources: ['market_analysis'],
          afterRevision: { market_analysis: null },
          publicTarget: { kind: 'signals', trading_account_id: null, observer_channel_id: null, resource_id: 'market_analyses', after_revision: null },
        },
      ],
    })
    expect(result).toBeTypeOf('function')
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'subscription.ready', request_id: 'observer-subscribe', subscriptions: expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ observer_channel_id: 'observer-1', after_revision: null }) }),
      expect.objectContaining({ target: expect.objectContaining({ resource_id: 'market_analyses' }) }),
    ]) }))
    expect(repositoryStore.latestRevision).not.toHaveBeenCalled()
  })

  it('rejects a non-null observer after_revision without reading a source revision', async () => {
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const result = await new BrowserRealtimeHub(repositoryStore, access.reader, () => NOW).subscribe({
      userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'],
      afterRevision: { 'market.quote:XAUUSD': 7 }, sink: messages.sink,
    })
    expect(result).toBeNull()
    expect(repositoryStore.latestRevision).not.toHaveBeenCalled()
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'subscription.resync_required', reason: 'revision_unknown' }))
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ type: 'subscription.ready' }))
  })

  it('emits only a value-free publication event for the current owner source', async () => {
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader, () => NOW)
    await hub.subscribe({
      userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'],
      afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink,
    })
    hub.publish(sourceEvent())
    await flush()
    const publication = messages.messages.find(value => typeof value === 'object' && value !== null && 'type' in value && value.type === 'observer.publication.changed') as Record<string, any> | undefined
    expect(publication).toMatchObject({
      type: 'observer.publication.changed', revision: '12',
      scope: { user_id: '99', trading_account_id: '7', terminal_instance_id: null, observer_channel_id: 'observer-1' },
      resource: { kind: 'observer_publication', id: 'observer-1' },
      data: { channel_id: 'observer-1', source_revision: 'source-7', resource: 'market.quote', resource_id: 'XAUUSD' },
    })
    expect(publication?.data).toEqual({ channel_id: 'observer-1', source_revision: 'source-7', resource: 'market.quote', resource_id: 'XAUUSD' })
    expect(String(publication?.event_id)).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(messages.messages)).not.toMatch(/private-login|private-profile|private-signal/)
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ type: 'market.quote.updated' }))
  })

  it('keeps generated publication event ids bounded for maximum-length source ids', async () => {
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader, () => NOW)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    hub.publish(sourceEvent({ eventId: 'x'.repeat(191) }))
    await flush()
    const publication = messages.messages.find(value => typeof value === 'object' && value !== null && 'type' in value && value.type === 'observer.publication.changed') as Record<string, any> | undefined
    expect(publication?.event_id).toMatch(/^[a-f0-9]{64}$/)
  })

  it('does not publish non-owner or cross-account source events', async () => {
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader, () => NOW)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    hub.publish(sourceEvent({ eventId: 'wrong-operator', userId: 77 }))
    hub.publish(sourceEvent({ eventId: 'wrong-account', accountId: '8' }))
    await flush()
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ type: 'observer.publication.changed' }))
    expect(messages.closes).toEqual([])
  })

  it.each([
    ['source revision', { sourceRevision: 'source-8' }],
    ['ownership revision', { ownershipRevision: 'ownership-4' }],
    ['channel revision', { channelRevision: 'channel-5' }],
    ['membership grant revision', { accessRevision: 'access-6' }],
    ['viewer token version', { userTokenVersion: 3 }],
  ])('closes after %s changes before an async publication is delivered', async (_name, changed) => {
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader, () => NOW)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    access.setAuthorization(authorization(changed))
    hub.publish(sourceEvent())
    await flush()
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'subscription.resync_required', reason: 'authorization_changed' }))
    expect(messages.closes).toContainEqual({ code: 4403, reason: 'authorization_changed' })
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ type: 'observer.publication.changed' }))
  })

  it('closes when the authorization query fails instead of reusing a stale proof', async () => {
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader, () => NOW)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    access.setFailure(new Error('database unavailable'))
    hub.publish(sourceEvent())
    await flush()
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'subscription.resync_required', reason: 'authorization_changed' }))
    expect(messages.closes).toContainEqual({ code: 4403, reason: 'authorization_changed' })
  })

  it('rejects a proof that expires while the initial authorization query is in flight', async () => {
    let currentTime = NOW
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    let release!: (value: ObserverAuthorization | null) => void
    access.authorize.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const subscribePromise = new BrowserRealtimeHub(repositoryStore, access.reader, () => currentTime).subscribe({
      userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'],
      afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink,
    })
    await flush()
    currentTime = NOW + OBSERVER_AUTHORIZATION_TTL_MS
    release(authorization())
    expect(await subscribePromise).toBeNull()
    expect(messages.closes).toContainEqual({ code: 4403, reason: 'trading_account_forbidden' })
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ type: 'subscription.ready' }))
  })

  it('closes when the source account changes even if the operator remains the same', async () => {
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader, () => NOW)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    access.setAuthorization(authorization({ accountId: '8' }))
    hub.publish(sourceEvent())
    await flush()
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'subscription.resync_required', reason: 'authorization_changed' }))
    expect(messages.closes).toContainEqual({ code: 4403, reason: 'authorization_changed' })
  })

  it('renews the deadline for quiet same-channel targets after a successful quote recheck', async () => {
    vi.useFakeTimers({ now: NOW })
    const initial = authorization({ expiresAtUtc: new Date(NOW + 10_000).toISOString() })
    const repositoryStore = repository(); const access = accessFixture(initial); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader)
    await hub.subscribeTargets({
      userId: 99, sink: messages.sink, targets: [
        observerTarget(),
        {
          accountId: '7', observerChannelId: 'observer-1', resources: ['positions:open'],
          afterRevision: { 'positions:open': null },
          publicTarget: { kind: 'account', trading_account_id: '7', observer_channel_id: 'observer-1', resource_id: 'positions', after_revision: null },
        },
      ],
    })
    access.setAuthorization(authorization({ expiresAtUtc: new Date(NOW + 30_000).toISOString() }))
    hub.publish(sourceEvent())
    await flush()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(messages.closes).toEqual([])
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'observer.publication.changed' }))
  })

  it('closes at the one-shot authorization deadline without database polling', async () => {
    vi.useFakeTimers({ now: NOW })
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    await vi.advanceTimersByTimeAsync(OBSERVER_AUTHORIZATION_TTL_MS)
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'subscription.resync_required', reason: 'authorization_changed' }))
    expect(messages.closes).toContainEqual({ code: 4403, reason: 'authorization_changed' })
    expect(access.authorize).toHaveBeenCalledTimes(1)
  })

  it('never sends an in-flight publication after the deadline closes the subscription', async () => {
    vi.useFakeTimers({ now: NOW })
    const repositoryStore = repository(); const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore, access.reader)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    let release!: (value: ObserverAuthorization | null) => void
    access.authorize.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    hub.publish(sourceEvent())
    await flush()
    expect(release).toBeTypeOf('function')
    await vi.advanceTimersByTimeAsync(OBSERVER_AUTHORIZATION_TTL_MS)
    release(authorization())
    await flush()
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'subscription.resync_required', reason: 'authorization_changed' }))
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ type: 'observer.publication.changed' }))
  })

  it('keeps owner delivery synchronous and does not duplicate a repeated owner target', async () => {
    const repositoryStore = repository(); const messages = sink()
    const hub = new BrowserRealtimeHub(repositoryStore)
    const target = {
      accountId: '7', observerChannelId: null, resources: ['market.quote:XAUUSD'],
      afterRevision: { 'market.quote:XAUUSD': 0 }, publicTarget: { kind: 'market', trading_account_id: '7' },
    }
    await hub.subscribeTargets({ userId: 42, sink: messages.sink, targets: [target, { ...target, publicTarget: { ...target.publicTarget } }] })
    hub.publish(sourceEvent())
    expect(messages.messages.filter(value => typeof value === 'object' && value !== null && 'type' in value && value.type === 'market.quote.updated')).toHaveLength(1)
    expect(messages.messages).toContainEqual(expect.objectContaining({ type: 'market.quote.updated', data: expect.objectContaining({ login: 'private-login' }) }))
  })

  it('does not renew an expired initial proof when a slow recheck returns a newer expiry', async () => {
    let currentTime = NOW
    const access = accessFixture(); const messages = sink()
    const hub = new BrowserRealtimeHub(repository(), access.reader, () => currentTime)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    access.authorize.mockImplementationOnce(async () => {
      currentTime = NOW + OBSERVER_AUTHORIZATION_TTL_MS + 1
      return authorization({ expiresAtUtc: new Date(currentTime + OBSERVER_AUTHORIZATION_TTL_MS).toISOString() })
    })
    hub.publish(sourceEvent())
    await flush()
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ type: 'observer.publication.changed' }))
    expect(messages.closes).toContainEqual({ code: 4403, reason: 'authorization_changed' })
  })

  it('closes and cleans up if asynchronous publication delivery throws', async () => {
    const access = accessFixture(); const messages = sink()
    const send = messages.sink.send
    messages.sink.send = value => {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'observer.publication.changed') {
        throw new Error('socket_gone')
      }
      send(value)
    }
    const hub = new BrowserRealtimeHub(repository(), access.reader, () => NOW)
    await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: messages.sink })
    hub.publish(sourceEvent())
    await flush()
    expect(messages.closes).toContainEqual({ code: 4403, reason: 'authorization_changed' })
    const callsAfterClose = access.authorize.mock.calls.length
    hub.publish(sourceEvent({ eventId: 'after-close' }))
    await flush()
    expect(access.authorize).toHaveBeenCalledTimes(callsAfterClose)
  })
})

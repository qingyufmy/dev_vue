import { BrowserRealtimeHub } from '../src/modules/trading/transport/realtime/browser-realtime-hub.js'
import { describe, expect, it, vi } from 'vitest'
import { type BrowserRealtimeEvent, type BrowserRealtimeSink, type TradingAccountSummary, type TradingReadRepository } from '../src/modules/trading/index.js'

const ACCOUNT_ID = 'account-42'
const FORMER_OWNER_ID = 7

describe('BrowserRealtimeHub P3 history access', () => {
  it('allows a former owner with no current ownership to subscribe to trade history only', async () => {
    const repository = mockRepository({ historyUsers: [FORMER_OWNER_ID] })
    const output = sink()
    const hub = new BrowserRealtimeHub(repository.repository)

    const stop = await hub.subscribeTargets({
      userId: FORMER_OWNER_ID,
      targets: [target(['trade_history'])],
      sink: output.sink,
    })

    expect(stop).toBeTypeOf('function')
    expect(repository.listAccounts).toHaveBeenCalledWith(FORMER_OWNER_ID, 'history')
    expect(repository.findOwnedAccount).not.toHaveBeenCalled()
    expect(output.closes).toEqual([])
    expect(output.messages).toContainEqual(expect.objectContaining({ type: 'subscription.ready' }))
    stop?.()
  })

  it('rejects mixed history and private position resources for a former owner', async () => {
    const repository = mockRepository({ historyUsers: [FORMER_OWNER_ID] })
    const output = sink()
    const hub = new BrowserRealtimeHub(repository.repository)

    const result = await hub.subscribeTargets({
      userId: FORMER_OWNER_ID,
      targets: [target(['trade_history', 'positions:open'])],
      sink: output.sink,
    })

    expect(result).toBeNull()
    expect(repository.listAccounts).not.toHaveBeenCalled()
    expect(repository.findOwnedAccount).toHaveBeenCalledWith(FORMER_OWNER_ID, ACCOUNT_ID)
    expect(output.closes).toEqual([[4403, 'trading_account_forbidden']])
    expect(output.messages).toEqual([])
  })

  it('does not reuse a history authorization cache for a later private target in the same request', async () => {
    const repository = mockRepository({ historyUsers: [FORMER_OWNER_ID] })
    const output = sink()
    const hub = new BrowserRealtimeHub(repository.repository)

    const result = await hub.subscribeTargets({
      userId: FORMER_OWNER_ID,
      targets: [target(['trade_history']), target(['positions:open'])],
      sink: output.sink,
    })

    expect(result).toBeNull()
    expect(repository.listAccounts).toHaveBeenCalledTimes(1)
    expect(repository.listAccounts).toHaveBeenCalledWith(FORMER_OWNER_ID, 'history')
    expect(repository.findOwnedAccount).toHaveBeenCalledTimes(1)
    expect(repository.findOwnedAccount).toHaveBeenCalledWith(FORMER_OWNER_ID, ACCOUNT_ID)
    expect(output.closes).toEqual([[4403, 'trading_account_forbidden']])
    expect(output.messages).toEqual([])
  })

  it('does not let an observer channel borrow history authorization', async () => {
    const repository = mockRepository({ historyUsers: [FORMER_OWNER_ID] })
    const output = sink()
    const hub = new BrowserRealtimeHub(repository.repository)

    const result = await hub.subscribeTargets({
      userId: FORMER_OWNER_ID,
      targets: [target(['trade_history'], 'observer-1')],
      sink: output.sink,
    })

    expect(result).toBeNull()
    expect(repository.listAccounts).not.toHaveBeenCalled()
    expect(repository.listObserverChannels).not.toHaveBeenCalled()
    expect(output.closes).toEqual([[4403, 'realtime_scope_forbidden']])
    expect(output.messages).toEqual([])
  })

  it('delivers valid history events only to the subscriber user in the account scope', async () => {
    const repository = mockRepository({ historyUsers: [7, 8] })
    const first = sink()
    const second = sink()
    const hub = new BrowserRealtimeHub(repository.repository)

    const firstStop = await hub.subscribeTargets({ userId: 7, targets: [target(['trade_history'])], sink: first.sink })
    const secondStop = await hub.subscribeTargets({ userId: 8, targets: [target(['trade_history'])], sink: second.sink })
    expect(firstStop).toBeTypeOf('function')
    expect(secondStop).toBeTypeOf('function')

    hub.publish(historyEvent('history-for-user-7', 7))
    hub.publish(historyEvent('history-for-user-8', 8))

    expect(eventIds(first.messages)).toEqual(['history-for-user-7'])
    expect(eventIds(second.messages)).toEqual(['history-for-user-8'])
    firstStop?.()
    secondStop?.()
  })
})

function target(resources: string[], observerChannelId: string | null = null) {
  return {
    accountId: ACCOUNT_ID,
    observerChannelId,
    resources,
    afterRevision: Object.fromEntries(resources.map(resource => [resource, null])),
    publicTarget: { kind: 'account', trading_account_id: ACCOUNT_ID, observer_channel_id: observerChannelId },
  }
}

function historyEvent(eventId: string, userId: number): BrowserRealtimeEvent {
  return {
    eventId, type: 'trade.history.changed', occurredAt: '2026-09-05T08:00:00.000Z', userId,
    accountId: ACCOUNT_ID, terminalInstanceId: null, resource: 'trade_history', resourceId: 'history', revision: 1,
    data: { status: 'stale', history_revision: '1', fresh_through: null },
  }
}

function account(): TradingAccountSummary {
  return {
    id: ACCOUNT_ID, platform: 'mt5', login: '596520', server: 'Demo', currency: 'USD', terminalProfileId: null,
    terminalInstanceId: null, bridgeState: 'offline', tradePermission: false, lastSeenAt: null,
  }
}

function mockRepository(options: { historyUsers: number[] }) {
  const listAccounts = vi.fn(async (userId: number, access = 'current') => access === 'history' && options.historyUsers.includes(userId) ? [account()] : [])
  const findOwnedAccount = vi.fn(async () => null)
  const listObserverChannels = vi.fn(async () => [])
  return {
    repository: { listAccounts, findOwnedAccount, listObserverChannels } as unknown as TradingReadRepository,
    listAccounts,
    findOwnedAccount,
    listObserverChannels,
  }
}

function sink() {
  const messages: unknown[] = []
  const closes: Array<[number, string]> = []
  const value: BrowserRealtimeSink = {
    send(message) { messages.push(message) },
    close(code, reason) { closes.push([code, reason]) },
  }
  return { sink: value, messages, closes }
}

function eventIds(messages: unknown[]) {
  return messages
    .filter((message): message is { event_id: string } => typeof message === 'object' && message !== null && 'event_id' in message)
    .map(message => message.event_id)
}

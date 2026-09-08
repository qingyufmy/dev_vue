import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'
import type { AccountSnapshot, ObserverChannel, TradingAccount, TradingContext } from '@aurum/contracts'
import { applyObserverChannels, applyTradingAccounts, applyTradingContext, observerChannels, tradingAccounts, tradingContext,
  accountSnapshot, applyAccountSnapshot, currentAccount, realtimeState, applyRealtimeState } from '../src/features/trading-context'

afterEach(() => {
  applyTradingContext(null); applyTradingAccounts([]); applyObserverChannels([])
  vi.restoreAllMocks()
})

describe('trading context projection ownership', () => {
  it('copies account facts, rejects direct writes and never displays a foreign account snapshot', () => {
    applyTradingContext({ accountId: 'a', mode: 'full' } as TradingContext)
    applyTradingAccounts([{ id: 'a', login: 'directory' }] as TradingAccount[])
    const snapshot = { id: 'a', login: 'snapshot', revision: 7 } as AccountSnapshot
    applyAccountSnapshot(snapshot); applyRealtimeState('live')
    snapshot.login = 'mutated'
    expect(currentAccount.value?.login).toBe('snapshot')
    expect(isReadonly(accountSnapshot.value)).toBe(true)
    expect(isReadonly(realtimeState)).toBe(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Reflect.set(accountSnapshot.value!, 'login', 'forged')
    Reflect.set(realtimeState, 'value', 'offline')
    expect(accountSnapshot.value?.login).toBe('snapshot')
    expect(realtimeState.value).toBe('live')
    applyAccountSnapshot({ id: 'b', login: 'foreign' } as AccountSnapshot)
    expect(currentAccount.value?.login).toBe('directory')
  })

  it('clears snapshot and connection status on account, channel, mode changes and logout', () => {
    const base = { accountId: 'a', mode: 'full', observerChannelId: null } as TradingContext
    for (const next of [{ ...base, accountId: 'b' }, { ...base, observerChannelId: 'channel' }, { ...base, mode: 'observer' }, null]) {
      applyTradingContext(base)
      applyAccountSnapshot({ id: 'a', revision: 1 } as AccountSnapshot)
      applyRealtimeState('live')
      applyTradingContext({ ...base, revision: 2 })
      expect(accountSnapshot.value?.id).toBe('a')
      applyTradingContext(next as TradingContext | null)
      expect(accountSnapshot.value).toBeNull()
      expect(realtimeState.value).toBe('idle')
    }
  })
  it('owns independent copies of server facts and exposes readonly projections', () => {
    const context = { accountId: 'a', mode: 'full', revision: 1 } as TradingContext
    const account = { id: 'a', login: '123' } as TradingAccount
    const channel = { id: 'channel', sourceAccountId: 'a', displayName: 'demo', active: true } as ObserverChannel
    applyTradingContext(context); applyTradingAccounts([account]); applyObserverChannels([channel])
    context.accountId = 'different'; account.login = 'changed'; channel.sourceAccountId = 'different'
    expect(tradingContext.value?.accountId).toBe('a')
    expect(tradingAccounts.value[0]?.login).toBe('123')
    expect(observerChannels.value[0]?.sourceAccountId).toBe('a')
    expect(isReadonly(tradingContext)).toBe(true)
    expect(isReadonly(tradingAccounts.value)).toBe(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Reflect.set(tradingContext.value!, 'accountId', 'forged')
    Reflect.set(tradingAccounts.value[0]!, 'login', 'forged')
    expect(tradingContext.value?.accountId).toBe('a')
    expect(tradingAccounts.value[0]?.login).toBe('123')
  })
  it('applies server-selected context and preserves independent directory projections', () => {
    applyTradingAccounts([{ id: 'a' }, { id: 'b' }] as TradingAccount[])
    applyTradingContext({ accountId: 'a', mode: 'full', revision: 1 } as TradingContext)
    applyTradingContext({ accountId: 'b', mode: 'full', revision: 2 } as TradingContext)
    expect(tradingContext.value).toMatchObject({ accountId: 'b', revision: 2 })
    expect(tradingAccounts.value.map(account => account.id)).toEqual(['a', 'b'])
    applyTradingContext(null)
    expect(tradingContext.value).toBeNull()
  })
})

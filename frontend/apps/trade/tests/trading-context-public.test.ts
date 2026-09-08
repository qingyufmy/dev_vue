import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'
import type { ObserverChannel, TradingAccount, TradingContext } from '@aurum/contracts'
import { applyObserverChannels, applyTradingAccounts, applyTradingContext, observerChannels, tradingAccounts, tradingContext } from '../src/features/trading-context'

afterEach(() => {
  applyTradingContext(null); applyTradingAccounts([]); applyObserverChannels([])
  vi.restoreAllMocks()
})

describe('trading context projection ownership', () => {
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

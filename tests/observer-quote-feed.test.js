import { describe, expect, it, vi } from 'vitest'
import { createObserverQuoteFeedManager, observerQuoteFeedKey } from '../server/observer-quote-feed.js'

function descriptor(overrides = {}) {
  return {
    sourceUserId:42,
    tradingAccountId:9,
    terminalInstanceId:'terminal_source_01',
    accountRef:{ broker_server:'Broker-Demo', login:'860058' },
    symbol:'XAUUSD',
    ...overrides,
  }
}

function setup() {
  const timers = []
  const fetchQuote = vi.fn(async route => ({
    status:'success', symbol:`${route.symbol}.s`, bid:4090.1, ask:4090.3,
    observed_at_utc_msc:1_800_000_000_000, timezone_offset_minutes:180,
  }))
  const publish = vi.fn(() => true)
  const manager = createObserverQuoteFeedManager({
    fetchQuote,
    publish,
    now:() => 1_800_000_000_500,
    setIntervalFn:callback => {
      const timer = { callback, unref:vi.fn() }
      timers.push(timer)
      return timer
    },
    clearIntervalFn:vi.fn(),
  })
  return { manager, fetchQuote, publish, timers }
}

describe('observer quote feed manager', () => {
  it('coalesces viewers of one source route into one terminal quote request', async () => {
    const { manager, fetchQuote, publish, timers } = setup()
    const first = { readyState:1 }
    const second = { readyState:1 }

    const [firstQuote, secondQuote] = await Promise.all([
      manager.subscribe(first, descriptor()),
      manager.subscribe(second, descriptor()),
    ])

    expect(firstQuote).toMatchObject({ status:'success', symbol:'XAUUSD.s' })
    expect(secondQuote).toEqual(firstQuote)
    expect(fetchQuote).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(timers).toHaveLength(1)
    expect(manager.stats()).toEqual([expect.objectContaining({ subscribers:2, source_user_id:42, symbol:'XAUUSD' })])
  })

  it('isolates feeds by source account, terminal and symbol', async () => {
    const { manager, fetchQuote } = setup()
    await manager.subscribe({}, descriptor())
    await manager.subscribe({}, descriptor({ tradingAccountId:10, terminalInstanceId:'terminal_source_02' }))
    await manager.subscribe({}, descriptor({ symbol:'EURUSD' }))

    expect(fetchQuote).toHaveBeenCalledTimes(3)
    expect(manager.stats()).toHaveLength(3)
    expect(observerQuoteFeedKey(descriptor())).not.toBe(observerQuoteFeedKey(
      descriptor({ tradingAccountId:10, terminalInstanceId:'terminal_source_02' })))
  })

  it('removes a source poller after its final browser disconnects', async () => {
    const { manager, timers } = setup()
    const first = {}
    const second = {}
    await manager.subscribe(first, descriptor())
    await manager.subscribe(second, descriptor())

    expect(manager.unsubscribe(first)).toBe(true)
    expect(manager.stats()[0].subscribers).toBe(1)
    expect(manager.unsubscribe(second)).toBe(true)
    expect(manager.stats()).toEqual([])
    expect(timers).toHaveLength(1)
  })

  it('does not reuse a cached quote after the freshness boundary', async () => {
    let now = 1000
    const fetchQuote = vi.fn(async () => ({ status:'success', symbol:'XAUUSD', bid:1, ask:2 }))
    const manager = createObserverQuoteFeedManager({
      fetchQuote,
      publish:() => true,
      now:() => now,
      freshMs:2500,
      setIntervalFn:() => ({ unref() {} }),
      clearIntervalFn:() => {},
    })
    await manager.subscribe({}, descriptor())
    now = 4001
    await manager.subscribe({}, descriptor())
    expect(fetchQuote).toHaveBeenCalledTimes(2)
  })
})

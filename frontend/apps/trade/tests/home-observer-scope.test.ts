import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { ApiClientError } from '@aurum/api-client'
import { useHomeWorkspace } from '../src/features/home/use-home-workspace'
import { accountSnapshot, clearAccountRuntime, marketQuote } from '../src/features/home/home-runtime'
import { applyAccountSnapshot } from '../src/features/trading-context'

const mocks = vi.hoisted(() => ({
  session: null as any,
  api: {
    getTradingContext: vi.fn(), listTradingAccounts: vi.fn(), listObserverChannels: vi.fn(),
    listMarketAnalyses: vi.fn(), listStrategies: vi.fn(), selectTradingAccount: vi.fn(),
    getPublicMarketSymbols: vi.fn(), getPublicMarketSnapshot: vi.fn(), getTradingWorkspace: vi.fn(), quotePayload: vi.fn(), getMarketCandles: vi.fn(),
    enterObserverMode: vi.fn(), leaveObserverMode: vi.fn(),
  },
  start: vi.fn(), stop: vi.fn(),
}))
vi.mock('@aurum/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aurum/api-client')>(), createApiClient: () => mocks.api,
}))
vi.mock('~/features/auth', () => ({
  useTradeSession: () => ({ session: mocks.session }),
}))
vi.mock('../src/features/home/trading-realtime', () => ({
  startTradingRealtime: mocks.start, stopTradingRealtime: mocks.stop,
}))

function workspace(id: string) {
  return { data: { account: { id }, snapshot: { id, balance: id, revision: 1 }, symbols: ['XAUUSD', 'EURUSD', 'GBPUSD'],
    positions: { revision: 1, items: [] }, pendingOrders: { revision: 1, items: [] } } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function latestResync(): () => Promise<void> {
  return mocks.start.mock.calls.at(-1)![5]
}

beforeEach(() => {
  mocks.session = ref({ csrf_token: 'test-csrf', user: { id: '9' } })
  Object.values(mocks.api).forEach(mock => mock.mockReset())
  mocks.start.mockReset()
  mocks.stop.mockReset()
  clearAccountRuntime()
  mocks.api.getTradingContext.mockResolvedValue({ data: { mode: 'observer', accountId: null, observerChannelId: '12', revision: 1 } })
  mocks.api.listTradingAccounts.mockResolvedValue({ data: { items: [{ id: '2' }] } })
  mocks.api.listObserverChannels.mockResolvedValue({ data: { items: [{ id: '12', sourceAccountId: '1', active: true }] } })
  mocks.api.listMarketAnalyses.mockResolvedValue({ data: { items: [] } })
  mocks.api.listStrategies.mockResolvedValue({ data: { items: [] } })
  mocks.api.getTradingWorkspace.mockImplementation(async (id: string) => workspace(id))
  mocks.api.selectTradingAccount.mockResolvedValue({ data: { mode: 'full', accountId: '2', observerChannelId: null, revision: 2 } })
  mocks.api.quotePayload.mockImplementation(async (accountId: string, symbol: string) => ({ data: { accountId, symbol, revision: 1 } }))
  mocks.api.getPublicMarketSymbols.mockResolvedValue({ data: { items: ['XAUUSD', 'EURUSD', 'GBPUSD'] } })
  mocks.api.getPublicMarketSnapshot.mockImplementation(async (symbol: string, timeframe: string) => {
    const { data } = await mocks.api.quotePayload('public', symbol)
    return { data: { symbol: data.symbol, timeframe, source_key: 'a'.repeat(64), source_generation: '1', status: 'cached', candles: [],
      quote: { bid: '1', ask: '2', last: null, spread: '1', observed_at: '2026-09-14T00:00:00Z', revision: String(data.revision) } } }
  })
  mocks.api.getMarketCandles.mockResolvedValue({ data: { items: [] } })
  mocks.api.enterObserverMode.mockResolvedValue({ data: { mode: 'observer', accountId: null, observerChannelId: '12', revision: 2 } })
  mocks.api.leaveObserverMode.mockResolvedValue({ data: { mode: 'blocked', accountId: null, observerChannelId: null, revision: 2 } })
})

describe('observer HTTP resync scope protection', () => {
  it.each([
    { status: 401, expected: '登录状态已失效' },
    { status: 403, expected: '没有查看此分析的权限' },
    { status: 503, expected: '最新分析暂时无法读取' },
  ])('keeps analysis failure visible without exposing API internals ($status)', async ({ status, expected }) => {
    mocks.api.listMarketAnalyses.mockRejectedValueOnce(new ApiClientError(status, {
      type: 'about:blank', title: 'inference_unavailable', status, detail: 'private_storage_detail', code: 'inference_unavailable',
    } as never))
    const scope = effectScope()
    const home = scope.run(() => useHomeWorkspace())!
    try {
      await home.load()
      expect(home.analysisError.value).toContain(expected)
      expect(home.analysisError.value).not.toContain('inference_unavailable')
      expect(home.analysisError.value).not.toContain('private_storage_detail')
      expect(home.latestAnalysis.value).toBeNull()
      expect(home.hasAccount.value).toBe(true)
    } finally { home.stop(); scope.stop() }
  })

  it('clears identity-scoped data immediately on logout and refuses an in-flight resync', async () => {
    const scope = effectScope()
    const home = scope.run(() => useHomeWorkspace())!
    try {
      await home.load()
      const pending = deferred<unknown>()
      mocks.api.getTradingWorkspace.mockReturnValueOnce(pending.promise)
      const resync = latestResync()()
      mocks.session.value = null
      expect(home.snapshot.value).toBeNull()
      expect(home.accounts.value).toEqual([])
      expect(home.observers.value).toEqual([])
      expect(home.hasAccount.value).toBe(false)
      pending.resolve(workspace('1'))
      await resync
      expect(home.snapshot.value).toBeNull()
      expect(home.latestAnalysis.value).toBeNull()
    } finally { home.stop(); scope.stop() }
  })
  it('does not let a stopped context load failure erase data published by the next workspace', async () => {
    const pending = deferred<unknown>()
    mocks.api.getTradingContext.mockReturnValueOnce(pending.promise)
    const home = useHomeWorkspace()
    const loading = home.load()
    await vi.waitFor(() => expect(mocks.api.getTradingContext).toHaveBeenCalled())
    home.stop()
    applyAccountSnapshot({ id: 'new-account', revision: 9 } as never)
    pending.reject(new Error('old_context_failed'))
    await loading
    expect(accountSnapshot.value).toMatchObject({ id: 'new-account', revision: 9 })
    expect(home.error.value).toBe('')
    expect(home.loading.value).toBe(false)
  })

  it('ignores a stopped nested snapshot failure but still reports an active snapshot failure', async () => {
    const pending = deferred<unknown>()
    mocks.api.getTradingWorkspace.mockReturnValueOnce(pending.promise)
    const home = useHomeWorkspace()
    const loading = home.load()
    await vi.waitFor(() => expect(mocks.api.getTradingWorkspace).toHaveBeenCalled())
    home.stop()
    applyAccountSnapshot({ id: 'new-account', revision: 9 } as never)
    pending.reject(new Error('old_snapshot_failed'))
    await loading
    expect(accountSnapshot.value?.id).toBe('new-account')
    expect(home.error.value).toBe('')
    mocks.api.getTradingWorkspace.mockRejectedValueOnce(new Error('active_snapshot_failed'))
    await home.load()
    expect(home.error.value).toBe('交易工作区暂时无法读取，请刷新重试')
    expect(home.hasAccount.value).toBe(false)
    expect(accountSnapshot.value).toBeNull()
    expect(home.loading.value).toBe(false)
  })

  it('does not apply an old analysis after stopping the workspace', async () => {
    const pending = deferred<unknown>()
    mocks.api.listMarketAnalyses.mockReturnValueOnce(pending.promise)
    const home = useHomeWorkspace()
    const loading = home.load()
    await vi.waitFor(() => expect(mocks.api.getTradingContext).toHaveBeenCalled())
    home.stop()
    pending.resolve({ data: { items: [{ id: 'old-analysis' }] } })
    await loading
    expect(home.latestAnalysis.value).toBeNull()
    expect(home.analysisLoading.value).toBe(false)
  })
  it('leaves explicitly without a personal account and retains the independent latest analysis', async () => {
    mocks.api.listTradingAccounts.mockResolvedValue({ data: { items: [] } })
    mocks.api.listMarketAnalyses.mockResolvedValue({ data: { items: [{ id: 'personal-analysis' }] } })
    const home = useHomeWorkspace()
    await home.load()
    const analysisCalls = mocks.api.listMarketAnalyses.mock.calls.length
    await home.leaveObserver()
    expect(mocks.api.leaveObserverMode).toHaveBeenCalledWith('test-csrf', 1)
    expect(home.context.value?.mode).toBe('blocked')
    expect(home.hasAccount.value).toBe(false)
    expect(accountSnapshot.value).toBeNull()
    expect(mocks.api.listMarketAnalyses).toHaveBeenCalledTimes(analysisCalls)
    expect(mocks.api.enterObserverMode).not.toHaveBeenCalled()
    home.stop()
  })

  it('does not automatically enter observation when no personal account exists', async () => {
    mocks.api.getTradingContext.mockResolvedValue({ data: { mode: 'blocked', accountId: null, observerChannelId: null, revision: 1 } })
    mocks.api.listTradingAccounts.mockResolvedValue({ data: { items: [] } })
    const home = useHomeWorkspace()
    await home.load()
    expect(home.hasAccount.value).toBe(false)
    expect(mocks.api.enterObserverMode).not.toHaveBeenCalled()
    expect(mocks.api.getTradingWorkspace).not.toHaveBeenCalled()
    expect(mocks.api.listMarketAnalyses).toHaveBeenCalled()
    home.stop()
  })

  it('drops a late enter response after an explicit exit wins', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const pending = deferred<{ data: { mode: string; accountId: null; observerChannelId: string; revision: number } }>()
    mocks.api.enterObserverMode.mockReturnValueOnce(pending.promise)
    const entering = home.selectObserver('12')
    expect(accountSnapshot.value).toBeNull()
    await home.leaveObserver()
    pending.resolve({ data: { mode: 'observer', accountId: null, observerChannelId: '12', revision: 2 } })
    await entering
    expect(home.context.value?.mode).toBe('blocked')
    expect(accountSnapshot.value).toBeNull()
    expect(home.loading.value).toBe(false)
    home.stop()
  })

  it('does not apply an old observer snapshot after switching to a personal account', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const pending = deferred<ReturnType<typeof workspace>>()
    mocks.api.getTradingWorkspace.mockReturnValueOnce(pending.promise)
    const oldRefresh = latestResync()()
    await home.selectAccount('2')
    pending.resolve(workspace('1'))
    await oldRefresh
    expect(accountSnapshot.value?.id).toBe('2')
    expect(marketQuote.value).not.toHaveProperty('accountId')
    home.stop()
  })

  it('does not let an older symbol response overwrite the newest selected symbol', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const pending = deferred<{ data: { accountId: string; symbol: string; revision: number } }>()
    mocks.api.quotePayload.mockReturnValueOnce(pending.promise)
    const oldMarket = home.selectSymbol('GBPUSD')
    await vi.waitFor(() => expect(mocks.api.quotePayload).toHaveBeenCalledWith('public', 'GBPUSD'))
    await home.selectSymbol('EURUSD')
    pending.resolve({ data: { accountId: '1', symbol: 'GBPUSD', revision: 1 } })
    await oldMarket
    expect(marketQuote.value?.symbol).toBe('EURUSD')
    home.stop()
  })

  it('clears the previous symbol immediately and offers a recoverable error without API details', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const pending = deferred<unknown>()
    mocks.api.quotePayload.mockReturnValueOnce(pending.promise)
    const changing = home.selectSymbol('EURUSD')
    expect(home.marketLoading.value).toBe(true)
    expect(home.quote.value).toBeNull()
    expect(home.candles.value).toEqual([])
    pending.reject(new Error('private_provider_failure'))
    await changing
    expect(home.marketLoading.value).toBe(false)
    expect(home.marketError.value).toBe('行情暂时无法读取，请重试')
    expect(home.quote.value).toBeNull()
    await home.refreshMarket()
    expect(home.marketError.value).toBe('')
    expect(home.quote.value?.symbol).toBe('EURUSD')
    home.stop()
  })

  it('does not let an old market failure change the new market loading or error state', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const pending = deferred<unknown>()
    mocks.api.quotePayload.mockReturnValueOnce(pending.promise)
    const older = home.selectSymbol('GBPUSD')
    await vi.waitFor(() => expect(mocks.api.quotePayload).toHaveBeenCalledWith('public', 'GBPUSD'))
    await home.selectSymbol('EURUSD')
    pending.reject(new Error('old_market_failure'))
    await older
    expect(home.quote.value?.symbol).toBe('EURUSD')
    expect(home.marketLoading.value).toBe(false)
    expect(home.marketError.value).toBe('')
    home.stop()
  })

  it('drops an in-flight observer refresh after the workspace is stopped', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const pending = deferred<ReturnType<typeof workspace>>()
    mocks.api.getTradingWorkspace.mockReturnValueOnce(pending.promise)
    const oldRefresh = latestResync()()
    home.stop()
    clearAccountRuntime()
    pending.resolve(workspace('1'))
    await oldRefresh
    expect(accountSnapshot.value).toBeNull()
    expect(marketQuote.value).toBeNull()
  })

  it('clears published account data when a current refresh loses authorization', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const resync = latestResync()
    const stops = mocks.stop.mock.calls.length
    mocks.api.getTradingWorkspace.mockRejectedValueOnce(new ApiClientError(403, null))
    await expect(latestResync()()).rejects.toMatchObject({ status: 403 })
    expect(accountSnapshot.value).toBeNull()
    expect(marketQuote.value).toBeNull()
    expect(home.error.value).toContain('访问权限已失效')
    expect(mocks.stop).toHaveBeenCalledTimes(stops + 1)
    expect(home.hasAccount.value).toBe(false)
    expect(home.symbol.value).toBe('')
    expect(home.symbols.value).toEqual([])
    const reads = mocks.api.getTradingWorkspace.mock.calls.length
    await resync()
    expect(mocks.api.getTradingWorkspace).toHaveBeenCalledTimes(reads)
    home.stop()
  })

  it('discards a market response still in flight when snapshot access is revoked', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const pending = deferred<{ data: { accountId: string; symbol: string; revision: number } }>()
    mocks.api.quotePayload.mockReturnValueOnce(pending.promise)
    const market = home.selectSymbol('EURUSD')
    mocks.api.getTradingWorkspace.mockRejectedValueOnce(new ApiClientError(403, null))
    await expect(latestResync()()).rejects.toMatchObject({ status: 403 })
    pending.resolve({ data: { accountId: '1', symbol: 'EURUSD', revision: 2 } })
    await market
    expect(marketQuote.value).toBeNull()
    expect(home.hasAccount.value).toBe(false)
    await home.selectAccount('2')
    expect(home.hasAccount.value).toBe(true)
    expect(accountSnapshot.value?.id).toBe('2')
    expect(marketQuote.value).not.toHaveProperty('accountId')
    expect(home.error.value).toBe('')
    home.stop()
  })

  it('does not stop the new account when an old observer request returns forbidden', async () => {
    const home = useHomeWorkspace()
    await home.load()
    const pending = deferred<ReturnType<typeof workspace>>()
    mocks.api.getTradingWorkspace.mockReturnValueOnce(pending.promise)
    const oldRefresh = latestResync()()
    await home.selectAccount('2')
    const stops = mocks.stop.mock.calls.length
    pending.reject(new ApiClientError(403, null))
    await oldRefresh
    expect(mocks.stop).toHaveBeenCalledTimes(stops)
    expect(home.hasAccount.value).toBe(true)
    expect(accountSnapshot.value?.id).toBe('2')
    expect(home.error.value).toBe('')
    home.stop()
  })

  it('clears the snapshot if authorization is revoked before the market read completes', async () => {
    const home = useHomeWorkspace()
    await home.load()
    mocks.api.quotePayload.mockRejectedValueOnce(new ApiClientError(403, null))
    await expect(latestResync()()).rejects.toMatchObject({ status: 403 })
    expect(accountSnapshot.value).toBeNull()
    expect(marketQuote.value).toBeNull()
    home.stop()
  })
})

// Page-scope tests inject the public command capability; its real HTTP/recovery behavior is tested separately.
vi.mock('~/features/trading-context', async importOriginal => ({
  ...await importOriginal<typeof import('~/features/trading-context')>(),
  recoverContextCommand: async () => null,
  runContextCommand: async (session: any, action: string, target: string | null, revision: number) => action === 'leave_observer' ? mocks.api.leaveObserverMode(session.csrf_token, revision) : action === 'enter_observer' ? mocks.api.enterObserverMode(session.csrf_token, target, revision) : mocks.api.selectTradingAccount(session.csrf_token, target, revision),
}))

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useRiskWorkspace } from '../src/features/risk/composables/use-risk-workspace'
import { applyTradingContext, tradingContext } from '../src/features/trading-context'

const api = vi.hoisted(() => ({ getContext: vi.fn(), listAccounts: vi.fn(), selectAccount: vi.fn(),
  getPolicy: vi.fn(), getSummary: vi.fn(), getManualRelease: vi.fn(), listDecisions: vi.fn(), replacePolicy: vi.fn(), createManualRelease: vi.fn() }))
vi.mock('../src/features/risk/api/risk-api', () => ({ riskApi: api }))
vi.mock('../src/features/risk/realtime/risk-realtime', () => ({ createRiskRealtime: () => ({ stop() {} }) }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: { value: { user: { id: '7' }, csrf_token: 'csrf' } } }) }))

const context = (accountId: string | null, revision = 1) => ({ accountId, revision, mode: 'full' as const, readOnly: false })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let wrapper: VueWrapper | undefined
let workspace: ReturnType<typeof useRiskWorkspace>
function open() {
  wrapper = mount(defineComponent({ setup() { workspace = useRiskWorkspace(ref(''), vi.fn()); return () => null } }))
}
beforeEach(() => {
  vi.resetAllMocks()
  api.getContext.mockResolvedValue({ data: context('a') })
  api.listAccounts.mockResolvedValue({ data: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } })
  api.getPolicy.mockResolvedValue({ data: { revision: 1 } })
  api.getSummary.mockResolvedValue({ data: null })
  api.getManualRelease.mockResolvedValue({ data: null })
  api.listDecisions.mockResolvedValue({ data: { items: [] } })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; applyTradingContext(null) })

describe('risk account response scope', () => {
  it('does not let the older selection overwrite the newest accepted context', async () => {
    open(); await flushPromises()
    const older = deferred<{ data: ReturnType<typeof context> }>()
    api.selectAccount.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ data: context('c', 3) })
    const pending = workspace.selectAccount('b')
    await workspace.selectAccount('c')
    older.resolve({ data: context('b', 2) }); await pending
    expect(tradingContext.value?.accountId).toBe('c')
    expect(workspace.activeAccountId.value).toBe('c')
    expect(api.getPolicy).not.toHaveBeenCalledWith('b')
  })
  it('does not apply a selection response after the risk workspace unmounts', async () => {
    open(); await flushPromises()
    const pendingResponse = deferred<{ data: ReturnType<typeof context> }>()
    api.selectAccount.mockReturnValueOnce(pendingResponse.promise)
    const pending = workspace.selectAccount('b')
    wrapper!.unmount(); wrapper = undefined
    pendingResponse.resolve({ data: context('b', 2) }); await pending
    expect(tradingContext.value?.accountId).toBe('a')
  })
  it('does not apply a default-account selection from a superseded initial load', async () => {
    const pendingResponse = deferred<{ data: ReturnType<typeof context> }>()
    api.getContext.mockResolvedValueOnce({ data: context(null) })
    api.selectAccount.mockReturnValueOnce(pendingResponse.promise)
    open(); await flushPromises()
    api.getContext.mockResolvedValueOnce({ data: context('c', 3) })
    await workspace.load()
    pendingResponse.resolve({ data: context('a', 2) }); await flushPromises()
    expect(tradingContext.value?.accountId).toBe('c')
    expect(workspace.activeAccountId.value).toBe('c')
    expect(api.getPolicy).not.toHaveBeenCalledWith('a')
  })
  it('does not put the previous account policy into the newly selected account', async () => {
    open(); await flushPromises()
    const result = deferred<{ data: { revision: number } }>()
    api.replacePolicy.mockReturnValueOnce(result.promise)
    const pending = workspace.savePolicy({ patch: { maxDailyLossPercent: '2' }, reason: 'test' })
    api.selectAccount.mockResolvedValueOnce({ data: context('b', 2) })
    await workspace.selectAccount('b')
    const reads = api.getSummary.mock.calls.length
    result.resolve({ data: { revision: 99 } })
    expect(await pending).toBe(false)
    expect(workspace.policy.value?.revision).toBe(1)
    expect(api.getSummary.mock.calls.length).toBe(reads)
  })
  it('does not refresh a new account after an old manual release completes', async () => {
    api.getSummary.mockResolvedValue({ data: { revision: 1 } })
    open(); await flushPromises()
    const result = deferred<unknown>()
    api.createManualRelease.mockReturnValueOnce(result.promise)
    const pending = workspace.createManualRelease('test')
    api.selectAccount.mockResolvedValueOnce({ data: context('b', 2) })
    await workspace.selectAccount('b')
    const reads = api.getSummary.mock.calls.length
    result.resolve({ data: {} })
    expect(await pending).toBe(false)
    expect(api.getSummary.mock.calls.length).toBe(reads)
  })
  it('accepts a current policy save and prevents concurrent duplicate writes', async () => {
    open(); await flushPromises()
    const result = deferred<{ data: { revision: number } }>()
    api.replacePolicy.mockReturnValueOnce(result.promise)
    const input = { patch: { maxDailyLossPercent: '2' }, reason: 'test' }
    const pending = workspace.savePolicy(input)
    expect(await workspace.savePolicy(input)).toBe(false)
    expect(api.replacePolicy).toHaveBeenCalledTimes(1)
    expect(api.replacePolicy).toHaveBeenCalledWith('csrf', 'a', { reason: 'test', max_daily_loss_percent: '2' }, 1)
    result.resolve({ data: { revision: 2 } })
    expect(await pending).toBe(true)
    expect(workspace.policy.value?.revision).toBe(2)
    expect(workspace.savingPolicy.value).toBe(false)
  })
})

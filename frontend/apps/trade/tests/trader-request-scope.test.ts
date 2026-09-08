import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { accountSnapshot, tradingAccounts } from '../src/features/trading-context'
import { useTraderWorkspace } from '../src/features/trader/composables/use-trader-workspace'

const mocks = vi.hoisted(() => ({ session: null as any, api: {
  getContext: vi.fn(), listAccounts: vi.fn(), listObservers: vi.fn(), listStrategies: vi.fn(),
  getWorkspace: vi.fn(), listDecisions: vi.fn(), getDecision: vi.fn(), selectAccount: vi.fn(),
}, realtime: vi.fn(), stop: vi.fn() }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: mocks.session }) }))
vi.mock('../src/features/trader/api/trader-api', () => ({ traderApi: mocks.api }))
vi.mock('../src/features/trader/realtime/trader-realtime', () => ({ createTraderRealtime: mocks.realtime }))

const workspace = (revision: number) => ({ data: { snapshot: { id: 'a', revision }, symbols: [],
  positions: { revision, items: [{ ticket: String(revision) }] }, pendingOrders: { revision, items: [] } } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let wrapper: ReturnType<typeof mount> | undefined
let state: ReturnType<typeof useTraderWorkspace>
beforeEach(() => {
  Object.values(mocks.api).forEach(mock => mock.mockReset())
  mocks.session = ref({ user: { id: 'u' }, csrf_token: 'csrf', authenticated_at: 'session-1' })
  mocks.api.getContext.mockResolvedValue({ data: { accountId: 'a', mode: 'full', revision: 1 } })
  mocks.api.listAccounts.mockResolvedValue({ data: { items: [{ id: 'a' }] } })
  mocks.api.listObservers.mockResolvedValue({ data: { items: [] } })
  mocks.api.listStrategies.mockResolvedValue({ data: { items: [] } })
  mocks.api.listDecisions.mockResolvedValue({ data: { items: [] } })
  mocks.api.getWorkspace.mockResolvedValue(workspace(1))
  mocks.stop.mockReset()
  mocks.realtime.mockReset().mockReturnValue({ stop: mocks.stop })
  wrapper = mount(defineComponent({ setup() {
    const selection = ref('')
    state = useTraderWorkspace(selection, id => { selection.value = id })
    return () => null
  } }))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

it('keeps the newest refresh when same-account responses finish out of order', async () => {
  await flushPromises()
  const first = deferred<ReturnType<typeof workspace>>(), second = deferred<ReturnType<typeof workspace>>()
  mocks.api.getWorkspace.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const older = state.refresh(), newer = state.refresh()
  second.resolve(workspace(3)); await newer
  first.resolve(workspace(2)); await older
  expect(accountSnapshot.value?.revision).toBe(3)
  expect(state.positions.value[0]?.ticket).toBe('3')
})

it('clears logout state and rejects both late HTTP data and callbacks from the closed realtime session', async () => {
  await flushPromises()
  const callbacks = mocks.realtime.mock.calls.at(-1)![0]
  const pending = deferred<ReturnType<typeof workspace>>()
  mocks.api.getWorkspace.mockReturnValueOnce(pending.promise)
  const request = state.refresh()
  mocks.session.value = null
  expect(accountSnapshot.value).toBeNull()
  expect(tradingAccounts.value).toEqual([])
  expect(state.positions.value).toEqual([])
  callbacks.onPositions([{ ticket: 'late' }], 8)
  callbacks.onState('live')
  pending.resolve(workspace(9)); await request
  expect(accountSnapshot.value).toBeNull()
  expect(state.positions.value).toEqual([])
  expect(state.realtime.value).toBe('idle')
  expect(state.refreshing.value).toBe(false)
  expect(mocks.stop).toHaveBeenCalled()
})

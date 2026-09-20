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
const selection = ref('')
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
    selection.value = ''
    state = useTraderWorkspace(selection, id => { selection.value = id })
    return () => null
  } }))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

it('can explicitly activate the displayed fallback account when the authoritative context is blocked', async () => {
  await flushPromises()
  mocks.api.getContext.mockResolvedValueOnce({ data: { accountId: null, mode: 'blocked', readOnly: true, revision: 0 } })
  await state.load()
  expect(state.activeAccountId.value).toBe('a')
  mocks.api.selectAccount.mockResolvedValueOnce({ data: { accountId: 'a', mode: 'full', readOnly: false, revision: 1 } })
  await state.selectAccount('a')
  expect(mocks.api.selectAccount).toHaveBeenCalledWith('csrf', 'a', 0)
  expect(state.context.value).toMatchObject({ mode: 'full', accountId: 'a' })
})

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

// Page-scope tests inject the public command capability; its real HTTP/recovery behavior is tested separately.
vi.mock('~/features/trading-context', async importOriginal => ({
  ...await importOriginal<typeof import('~/features/trading-context')>(),
  recoverContextCommand: async () => null,
  runContextCommand: async (session: any, _action: string, target: string | null, revision: number) => mocks.api.selectAccount(session.csrf_token, target, revision),
}))


it('keeps the workspace and realtime session when navigation refreshes the same login', async () => {
  await flushPromises()
  const requests = mocks.api.getWorkspace.mock.calls.length
  const connections = mocks.realtime.mock.calls.length
  mocks.session.value = { ...mocks.session.value, user: { ...mocks.session.value.user }, csrf_token: 'refreshed' }
  await flushPromises()
  expect(state.activeAccountId.value).toBe('a')
  expect(state.positions.value[0]?.ticket).toBe('1')
  expect(mocks.api.getWorkspace).toHaveBeenCalledTimes(requests)
  expect(mocks.realtime).toHaveBeenCalledTimes(connections)
  expect(mocks.stop).not.toHaveBeenCalled()
})

it('follows new decisions at the head but preserves a historical selection during an in-flight refresh', async () => {
  await flushPromises()
  mocks.api.getDecision.mockResolvedValue({ data: {} })
  mocks.api.listDecisions.mockResolvedValue({ data: { items: [{ decisionId: 'd1' }, { decisionId: 'old' }] } })
  await state.refresh(); await flushPromises()
  expect(selection.value).toBe('d1')
  mocks.api.listDecisions.mockResolvedValue({ data: { items: [{ decisionId: 'd2' }, { decisionId: 'd1' }, { decisionId: 'old' }] } })
  await state.refresh(); await flushPromises()
  expect(selection.value).toBe('d2')
  const pending = deferred<any>()
  mocks.api.listDecisions.mockReturnValueOnce(pending.promise)
  const refreshing = state.refresh()
  selection.value = 'old'
  pending.resolve({ data: { items: [{ decisionId: 'd3' }, { decisionId: 'd2' }, { decisionId: 'old' }] } })
  await refreshing; await flushPromises()
  expect(selection.value).toBe('old')
})

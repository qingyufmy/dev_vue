import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
const mocks = vi.hoisted(() => ({ list: vi.fn(), strategies: vi.fn(), detail: vi.fn(), create: vi.fn(), realtime: vi.fn() }))
vi.mock('../api/analyst-api', () => ({ analystApi: { listStrategies: mocks.strategies, listAnalyses: mocks.list, getAnalysis: mocks.detail, createManualAnalysis: mocks.create } }))
vi.mock('../realtime/analyst-realtime', () => ({ createAnalystRealtime: mocks.realtime }))
vi.mock('~/features/auth', async () => {
  const { ref } = await import('vue')
  return { useTradeSession: () => ({ session: ref({ user: { id: 1 }, authenticated_at: 'today', csrf_token: 'test' }) }) }
})
import { useAnalystWorkspace } from '../composables/use-analyst-workspace'
let wrapper: ReturnType<typeof mount>
let client: QueryClient
let workspace: ReturnType<typeof useAnalystWorkspace>
const selected = ref('')
const select = vi.fn((id: string) => { selected.value = id })
beforeEach(() => {
  vi.clearAllMocks(); selected.value = ''; sessionStorage.clear()
  mocks.list.mockResolvedValue({ data: { items: [] } }); mocks.strategies.mockResolvedValue({ data: { items: [] } })
  mocks.realtime.mockReturnValue({ stop: vi.fn() })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  wrapper = mount(defineComponent({ setup() { workspace = useAnalystWorkspace(selected, select); return () => null } }), { global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } })
})
afterEach(() => { wrapper.unmount(); client.clear() })
it('does not leave the detail loading when no records exist', async () => {
  await flushPromises()
  expect(workspace.loadingDetail.value).toBe(false)
  expect(mocks.detail).not.toHaveBeenCalled()
})
it('retries an uncertain manual request with the same idempotency key', async () => {
  await flushPromises()
  mocks.create.mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce({ data: { analysisId: 'run-1', status: 'queued', createdAt: new Date().toISOString() } })
  await expect(workspace.runManual('strategy-1', 'xauusd')).rejects.toThrow('network lost')
  await workspace.runManual('strategy-1', 'XAUUSD')
  expect(mocks.create.mock.calls[0]?.[2]).toBe(mocks.create.mock.calls[1]?.[2])
  expect(workspace.currentJob.value?.status).toBe('queued')
  expect(workspace.manualCoolingDown.value).toBe(true)
})
it('refreshes results and selects the created analysis rather than the run id', async () => {
  await flushPromises()
  const onEvent = mocks.realtime.mock.calls[0]?.[0].onEvent
  onEvent({ type: 'market_analysis.created', resource: { id: 'result-1' } })
  await flushPromises()
  expect(select).toHaveBeenCalledWith('result-1')
  expect(mocks.list.mock.calls.length).toBeGreaterThan(1)
})

it('ignores older job events after a newer completion', async () => {
  await flushPromises()
  workspace.currentJob.value = { analysisId: 'run-1', status: 'succeeded', revision: 3 } as any
  const onEvent = mocks.realtime.mock.calls[0]?.[0].onEvent
  onEvent({ type: 'analysis.job.changed', resource: { id: 'run-1' }, revision: 2, data: { status: 'running' } })
  expect(workspace.currentJob.value?.status).toBe('succeeded')
})
it('keeps inactive strategy names for history without offering them for manual runs', async () => {
  mocks.strategies.mockResolvedValue({ data: { items: [{ id: 'old', name: '历史策略名称', status: 'retired', activeVersionId: 'v1' }] } })
  await workspace.refresh()
  expect(workspace.historyStrategies.value[0]?.name).toBe('历史策略名称')
  expect(workspace.strategies.value).toHaveLength(0)
})

it('follows the newest analysis only while the current head is selected', async () => {
  await flushPromises()
  mocks.list.mockResolvedValue({ data: { items: [{ analysisId: 'a1' }, { analysisId: 'old' }] } })
  await workspace.refresh(); await flushPromises()
  expect(selected.value).toBe('a1')
  mocks.list.mockResolvedValue({ data: { items: [{ analysisId: 'a2' }, { analysisId: 'a1' }, { analysisId: 'old' }] } })
  await workspace.refresh(); await flushPromises()
  expect(selected.value).toBe('a2')
  selected.value = 'old'
  mocks.list.mockResolvedValue({ data: { items: [{ analysisId: 'a3' }, { analysisId: 'a2' }, { analysisId: 'old' }] } })
  await workspace.refresh(); await flushPromises()
  expect(selected.value).toBe('old')
})

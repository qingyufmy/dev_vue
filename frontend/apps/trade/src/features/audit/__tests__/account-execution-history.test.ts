import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { Sheet } from '@aurum/ui/sheet'
const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }))
vi.mock('../api/audit-api', () => ({ auditApi: api }))
vi.mock('~/lib/laboratory-display-time', () => ({ formatLaboratoryTime: (value: string) => value }))
import History from '../components/AccountExecutionHistory.vue'

it('filters loaded records without extra requests and resets filters when account changes', async () => {
  api.list.mockResolvedValue({ data: { items: ['queued', 'uncertain', 'succeeded'].map((status, index) => ({ sourceKind: 'operation', sourceId: String(index), accountId: '1', status, occurredAt: '2026-09-15T00:00:00Z', reasonCode: null })), hasMore: false } })
  const wrapper = mount(History, { props: { accountId: '1' } })
  await flushPromises()
  expect(wrapper.findAll('li')).toHaveLength(3)
  await wrapper.findAll('button').find(button => button.text() === '需关注')!.trigger('click')
  expect(wrapper.findAll('li')).toHaveLength(1)
  expect(wrapper.find('li').text()).toContain('结果待核实')
  expect(api.list).toHaveBeenCalledTimes(1)
  await wrapper.setProps({ accountId: '2' })
  await flushPromises()
  expect(wrapper.findAll('li')).toHaveLength(0)
  expect(wrapper.text()).not.toContain('结果待核实')
  wrapper.unmount()
})

it('opens an exact decision trace without guessing from account history', async () => {
  api.list.mockResolvedValue({ data: { items: [], hasMore: false } })
  api.detail.mockResolvedValue({ data: { event: { accountId: '1', sourceKind: 'trade_decision', status: 'info', summary: '观望' }, trace: [] } })
  const wrapper = mount(History, { props: { accountId: '1', decisionId: 'decision-exact' } })
  await flushPromises()
  expect(api.detail).toHaveBeenLastCalledWith('trade_decision', 'decision-exact')
  wrapper.unmount()
})

it('coalesces execution notifications and cancels queued refresh when leaving', async () => {
  vi.useFakeTimers()
  api.list.mockClear()
  api.list.mockResolvedValue({ data: { items: [], hasMore: false } })
  const wrapper = mount(History, { props: { accountId: '1', refreshVersion: 0 } })
  try {
    await flushPromises()
    await wrapper.setProps({ refreshVersion: 1 })
    await wrapper.setProps({ refreshVersion: 2 })
    await vi.advanceTimersByTimeAsync(350)
    expect(api.list).toHaveBeenCalledTimes(2)
    await wrapper.setProps({ refreshVersion: 3 })
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(500)
    expect(api.list).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})
it('queues a follow-up refresh if a notification arrives during a request', async () => {
  vi.useFakeTimers()
  api.list.mockClear()
  let finish!: (value: unknown) => void
  api.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ data: { items: [], hasMore: false } })
  const wrapper = mount(History, { props: { accountId: '1', refreshVersion: 0 } })
  try {
    await wrapper.setProps({ refreshVersion: 1 })
    await vi.advanceTimersByTimeAsync(350)
    expect(api.list).toHaveBeenCalledTimes(1)
    finish({ data: { items: [], hasMore: false } })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(350)
    expect(api.list).toHaveBeenCalledTimes(2)
  } finally { wrapper.unmount(); vi.useRealTimers() }
})

it('shows partial completion in attention without calling it fully completed', async () => {
  api.list.mockResolvedValue({ data: { items: [{ sourceKind: 'operation', sourceId: 'partial', accountId: '1', status: 'partially_succeeded', title: '多项交易操作', occurredAt: '2026-09-15T00:00:00Z', reasonCode: null }], hasMore: false } })
  const wrapper = mount(History, { props: { accountId: '1' } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '需关注')!.trigger('click')
  expect(wrapper.findAll('li')).toHaveLength(1)
  expect(wrapper.find('li').text()).toContain('部分完成')
  expect(wrapper.find('li').text()).not.toContain('此步骤已完成')
  wrapper.unmount()
})

it('clears the originating decision link when the detail is closed', async () => {
  api.list.mockResolvedValue({ data: { items: [], hasMore: false } })
  api.detail.mockResolvedValue({ data: { event: { accountId: '1', sourceKind: 'trade_decision', status: 'info', summary: '观望' }, trace: [] } })
  const wrapper = mount(History, { props: { accountId: '1', decisionId: 'decision-exact' } })
  await flushPromises()
  wrapper.findComponent(Sheet).vm.$emit('update:open', false)
  await flushPromises()
  expect(wrapper.emitted('detail-close')).toHaveLength(1)
  wrapper.unmount()
})

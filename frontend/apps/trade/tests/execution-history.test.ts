import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi, afterEach } from 'vitest'
import AccountExecutionHistory from '../src/features/audit/components/AccountExecutionHistory.vue'
import { executionExplanation } from '../src/features/audit/model/execution-explanation'
const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }))
vi.mock('../src/features/audit/api/audit-api', () => ({ auditApi: api }))
vi.mock('~/lib/laboratory-display-time', () => ({ formatLaboratoryTime: () => '12:00' }))
const row = (accountId: string, sourceId: string) => ({ accountId, sourceId, sourceKind: 'operation', status: 'queued', symbol: sourceId, occurredAt: '', reasonCode: null })
const page = (items: unknown[], nextCursor: string | null = null) => ({ data: { items, hasMore: !!nextCursor, nextCursor } })
afterEach(() => vi.resetAllMocks())
it('discards a previous account response and paginates only the current account', async () => {
  let resolve!: (value: unknown) => void
  api.list.mockReturnValueOnce(new Promise(done => { resolve = done }))
    .mockResolvedValueOnce(page([row('b', 'GOLD')], 'next'))
    .mockResolvedValueOnce(page([row('b', 'GOLD'), row('b', 'SILVER'), row('a', 'WRONG')]))
  const wrapper = mount(AccountExecutionHistory, { props: { accountId: 'a' } })
  await wrapper.setProps({ accountId: 'b' })
  await flushPromises()
  resolve(page([row('a', 'STALE')]))
  await flushPromises()
  expect(wrapper.text()).toContain('GOLD')
  expect(wrapper.text()).not.toContain('STALE')
  await wrapper.findAll('button').find(button => button.text() === '加载更早记录')!.trigger('click')
  await flushPromises()
  expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'b', cursor: 'next' }))
  expect(wrapper.findAll('li')).toHaveLength(2)
  expect(wrapper.text()).not.toContain('WRONG')
  await wrapper.setProps({ readOnly: true })
  expect(wrapper.text()).not.toContain('GOLD')
  expect(api.list).toHaveBeenCalledTimes(3)
  wrapper.unmount()
})
it('does not expose unknown internal error codes', () => {
  expect(executionExplanation('internal_sql_failure', 'failed')).not.toContain('internal_sql_failure')
  expect(executionExplanation(null, 'uncertain')).toContain('尚待核实')
})

import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import type { TraderDecisionDetail } from '@aurum/contracts'
import Detail from '../components/TraderDecisionDetail.vue'

it('keeps accepted advice distinct from execution and opens account records', async () => {
  const detail = { summary: { decisionId: '1', status: 'accepted', action: 'market_order', confidence: 70, summary: '等待执行核对', createdAt: '2026-09-15T00:00:00Z' }, actions: [], reasoning: '判断依据', input_snapshot_hash: 'internal-hash' } as unknown as TraderDecisionDetail
  const wrapper = mount(Detail, { props: { detail }, global: { stubs: { RouterLink: true } } })
  expect(wrapper.text()).toContain('建议受理不代表成交')
  expect(wrapper.text()).not.toContain('internal-hash')
  await wrapper.findAll('button').find(button => button.text().includes('本次处理过程'))!.trigger('click')
  expect(wrapper.emitted('navigate')).toEqual([['operations']])
  await wrapper.findAll('button').find(button => button.text().includes('持仓挂单'))!.trigger('click')
  expect(wrapper.emitted('navigate')?.[1]).toEqual(['inventory'])
  wrapper.unmount()
})

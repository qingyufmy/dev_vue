import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import type { MarketAnalysisDetail } from '@aurum/contracts'
import Panel from '../components/AnalysisDetailPanel.vue'
it('normalizes direction scores independently from confidence and does not invent missing scores', async () => {
  const detail = { summary: { symbol: 'XAUUSD', summary: '观察行情', marketBias: 'bullish', opportunity: 'none', confidence: 72, analyzedAt: '2026-09-15T00:00:00Z', validUntil: '2026-09-15T01:00:00Z' }, bullish_score: 11, bearish_score: 9, market_regime: '', supporting_evidence: [], counter_evidence: [], key_levels: {}, invalidation: {}, data_gaps: [], analysis_body: '' } as unknown as MarketAnalysisDetail
  const wrapper = mount(Panel, { props: { detail, strategies: [] } })
  expect(wrapper.text()).toContain('偏多 55.0%')
  expect(wrapper.text()).toContain('偏空 45.0%')
  expect(wrapper.text()).toContain('72%')
  await wrapper.setProps({ detail: { ...detail, bullish_score: null, bearish_score: null } })
  expect(wrapper.text()).toContain('未提供多空比例')
  expect(wrapper.find('[aria-label="多空倾向比例"]').exists()).toBe(false)
  wrapper.unmount()
})

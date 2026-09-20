import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
vi.mock('@aurum/api-client', () => ({ createApiClient: () => ({ request: async () => ({ data: { items: [] } }) }) }))
import StrategyEditorSheet from '../components/StrategyEditorSheet.vue'
import type { StrategyDraft, StrategyVersionView } from '../model/strategy-presentation'
it('includes edited metadata and runtime settings in one draft', async () => {
  const wrapper = mount(StrategyEditorSheet, { props: { open: true, mode: 'version', kind: 'trader', strategyName: '原策略', strategyDescription: '原说明', strategyStatus: 'active', baseVersion: { id: '1', versionNumber: 1, promptText: '请根据真实行情和账户风险判断是否执行交易。', config: { entry_methods: ['market'] }, promptSha256: '', inputContractVersion: 'v1', outputContractVersion: 'v1', createdAt: '' } }, global: { stubs: { DialogTitle: { template: '<h2><slot /></h2>' }, DialogDescription: { template: '<p><slot /></p>' }, Dialog: { name: 'Dialog', template: '<div><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' } } } })
  await flushPromises()
  expect((wrapper.find('#strategy-description').element as HTMLTextAreaElement).value).toBe('原说明')
  await wrapper.find('#strategy-name').setValue('修改后的策略')
  await wrapper.find('#strategy-description').setValue('修改后的说明')
  await wrapper.find('#strategy-symbols').setValue('xauusd,EURUSD')
  await wrapper.findAll('button').find(item => item.text().includes('保存策略'))!.trigger('click')
  expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ name: '修改后的策略', description: '修改后的说明', status: 'active', config: { symbols: ['XAUUSD', 'EURUSD'], entry_methods: ['market'] } })
  wrapper.unmount()
})
it.each([
  { timeframes: ['M5'], candle_limit: 200, indicators: { enabled: true } },
  { market_data_plan: { primary_timeframe: 'H1', timeframes: [{ timeframe: 'H1', kline_count: 180 }] }, indicators: { enabled: true } },
])('preserves existing configuration while editing a prompt', async config => {
  const version: StrategyVersionView = { id: 'v1', versionNumber: 1, promptText: '请根据行情结构、趋势和风险分析当前市场方向，输出证据。', config, promptSha256: 'test-sha', inputContractVersion: 'v1', outputContractVersion: 'v1', createdAt: '2026-09-14T00:00:00Z' }
  const wrapper = mount(StrategyEditorSheet, { props: { open: true, mode: 'version', kind: 'analysis', strategyName: '测试策略', baseVersion: version }, global: { stubs: { DialogTitle: { template: '<h2><slot /></h2>' }, DialogDescription: { template: '<p><slot /></p>' }, Dialog: { name: 'Dialog', template: '<div><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' } } } })
  await flushPromises()
  const button = wrapper.findAll('button').find(item => item.text().includes('保存策略'))!
  await button.trigger('click')
  const draft = wrapper.emitted('submit')?.[0]?.[0] as StrategyDraft
  expect(draft.config).toEqual(config)
  expect(draft.config).not.toBe(config)
  wrapper.unmount()
})

it('submits changed market settings without discarding other configuration', async () => {
  const config = { market_data_plan: { version: 1, primary_timeframe: 'M5', timeframes: [{ timeframe: 'M5', kline_count: 100 }] }, macro_evidence: { enabled: false } }
  const wrapper = mount(StrategyEditorSheet, { props: { open: true, mode: 'version', kind: 'analysis', strategyName: 'Test', baseVersion: { id: '1', versionNumber: 1, promptText: '请根据真实行情数据分析趋势并返回结构化结果。', config, promptSha256: '', inputContractVersion: 'v1', outputContractVersion: 'v1', createdAt: '' } }, global: { stubs: { DialogTitle: { template: '<h2><slot /></h2>' }, DialogDescription: { template: '<p><slot /></p>' }, Dialog: { name: 'Dialog', template: '<div><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' } } } })
  await flushPromises()
  await wrapper.find('input[aria-label="运行间隔（分钟）"]').setValue('10')
  await wrapper.find('input[aria-label="M5 K线数量"]').setValue('250')
  await wrapper.findAll('button').find(item => item.text().includes('保存策略'))!.trigger('click')
  const draft = wrapper.emitted('submit')?.[0]?.[0] as StrategyDraft
  expect(draft.config).toMatchObject({ interval_minutes: 10, market_data_plan: { primary_timeframe: 'M5', timeframes: [{ timeframe: 'M5', kline_count: 250 }] }, macro_evidence: { enabled: false } })
  expect(config.market_data_plan.timeframes[0]?.kline_count).toBe(100)
  wrapper.unmount()
})

it('preserves edits on dismiss and blocks closing while saving', async () => {
  const wrapper = mount(StrategyEditorSheet, { props: { open: true, mode: 'create', kind: 'analysis' }, global: { stubs: { DialogTitle: { template: '<h2><slot /></h2>' }, DialogDescription: { template: '<p><slot /></p>' }, Dialog: { name: 'Dialog', template: '<div><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' } } } })
  await flushPromises()
  await wrapper.get('#strategy-name').setValue('未保存策略')
  await wrapper.findAll('button').find(item => item.text() === '取消')!.trigger('click')
  await flushPromises()
  expect(wrapper.emitted('update:open')).toBeUndefined()
  expect(document.body.textContent).toContain('放弃未保存的修改')
  const keep = [...document.body.querySelectorAll('button')].find(item => item.textContent?.trim() === '继续编辑')!
  keep.click()
  await flushPromises()
  expect((wrapper.get('#strategy-name').element as HTMLInputElement).value).toBe('未保存策略')
  await wrapper.setProps({ submitting: true })
  await wrapper.findComponent({ name: 'Dialog' }).vm.$emit('update:open', false)
  expect(wrapper.emitted('update:open')).toBeUndefined()
  wrapper.unmount()
})

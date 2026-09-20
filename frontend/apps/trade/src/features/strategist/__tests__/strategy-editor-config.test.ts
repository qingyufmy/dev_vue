import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
vi.mock('@aurum/api-client', () => ({ createApiClient: () => ({ request: async () => ({ data: { items: [] } }) }) }))
import StrategyEditorSheet from '../components/StrategyEditorSheet.vue'
import type { StrategyCombinationDraft, StrategyVersionView } from '../model/strategy-presentation'

const dialogStubs = { DialogTitle: { template: '<h2><slot /></h2>' }, DialogDescription: { template: '<p><slot /></p>' }, Dialog: { name: 'Dialog', template: '<div><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' } }
const analysis: StrategyVersionView = { id: 'a1', versionNumber: 1, promptText: '请根据真实行情结构和趋势证据分析当前市场方向，证据不足时观望。', config: { timeframes: ['M5'], candle_limit: 200, trader_strategy_id: 't1' }, promptSha256: '', inputContractVersion: 'v1', outputContractVersion: 'v1', createdAt: '' }
const trader: StrategyVersionView = { id: 't1', versionNumber: 1, promptText: '请根据分析结论和真实账户风险判断交易动作，条件不足时保持当前状态。', config: { entry_methods: ['market'] }, promptSha256: '', inputContractVersion: 'v1', outputContractVersion: 'v1', createdAt: '' }

it('submits both prompts and keeps their independent configuration', async () => {
  const wrapper = mount(StrategyEditorSheet, { props: { open: true, mode: 'version', strategyName: '原组合', strategyDescription: '原说明', strategyStatus: 'active', baseVersion: analysis, traderBaseVersion: trader }, global: { stubs: dialogStubs } })
  await flushPromises()
  await wrapper.get('#strategy-name').setValue('修改后的组合')
  await wrapper.get('#analysis-prompt').setValue('请结合多周期行情与结构证据分析方向和机会，证据不足时必须保持观望。')
  await wrapper.get('#trader-prompt').setValue('请结合分析结论、账户余额与持仓风险提出动作，所有条件不足时必须保持。')
  await wrapper.findAll('button').find(item => item.text().includes('保存两个新版本'))!.trigger('click')
  const draft = wrapper.emitted('submit')?.[0]?.[0] as StrategyCombinationDraft
  expect(draft).toMatchObject({ name: '修改后的组合', status: 'active', analysisConfig: { timeframes: ['M5'], candle_limit: 200 }, traderConfig: { entry_methods: ['market'] } })
  expect(draft.analysisConfig).not.toHaveProperty('trader_strategy_id')
  expect(draft.analysisPromptText).toContain('多周期行情')
  expect(draft.traderPromptText).toContain('账户余额')
  wrapper.unmount()
})

it('requires both role prompts before emitting one combination save', async () => {
  const wrapper = mount(StrategyEditorSheet, { props: { open: true, mode: 'create' }, global: { stubs: dialogStubs } })
  await flushPromises()
  await wrapper.get('#strategy-name').setValue('新组合')
  await wrapper.get('#analysis-prompt').setValue('请根据真实行情结构和趋势证据分析当前市场方向，证据不足时观望。')
  await wrapper.findAll('button').find(item => item.text().includes('保存策略组合'))!.trigger('click')
  expect(wrapper.emitted('submit')).toBeUndefined()
  expect(wrapper.text()).toContain('交易策略提示词至少需要 20 个字符')
  wrapper.unmount()
})

it('preserves both prompt edits when dismiss is cancelled', async () => {
  const wrapper = mount(StrategyEditorSheet, { attachTo: document.body, props: { open: true, mode: 'create' }, global: { stubs: dialogStubs } })
  await flushPromises()
  await wrapper.get('#analysis-prompt').setValue('分析提示词仍需保留，因为用户选择继续编辑而不是放弃本次修改。')
  await wrapper.findAll('button').find(item => item.text() === '取消')!.trigger('click')
  await flushPromises()
  expect(wrapper.emitted('update:open')).toBeUndefined()
  expect(document.body.textContent).toContain('分析与交易提示词的本次修改都会丢失')
  wrapper.unmount()
})

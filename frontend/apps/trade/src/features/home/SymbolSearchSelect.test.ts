import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SymbolSearchSelect from './SymbolSearchSelect.vue'

describe('SymbolSearchSelect', () => {
  it('filters without case sensitivity, prioritizes prefixes and selects a match', async () => {
    const wrapper = mount(SymbolSearchSelect, { props: { symbols: ['XAUUSD', 'ETHUSD', 'BTCUSD', 'BTCUST'], modelValue: 'XAUUSD' } })
    await wrapper.get('button[aria-label="选择行情品种"]').trigger('click')
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="搜索行情品种"]')!
    input.value = 'bt'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    expect(options.map(option => option.textContent?.trim())).toEqual(['BTCUSD', 'BTCUST'])
    options[1]!.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['BTCUST'])
    wrapper.unmount()
  })

  it('limits a broad result set and keeps the search input labelled', async () => {
    const symbols = Array.from({ length: 150 }, (_, index) => `PAIR${String(index).padStart(3, '0')}`)
    const wrapper = mount(SymbolSearchSelect, { props: { symbols, modelValue: symbols[0]! } })
    await wrapper.get('button[aria-label="选择行情品种"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(100)
    expect(document.body.textContent).toContain('当前显示前 100 个')
    wrapper.unmount()
  })
})

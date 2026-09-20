import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ReasoningText from './ReasoningText.vue'

it('renders report structure while preserving values and escaping model HTML', () => {
  const wrapper = mount(ReasoningText, { props: { text: '### 风险\n- **止损** 4261.37\nentryEvidence=unavailable\n<img src=x onerror=alert(1)>' } })
  expect(wrapper.find('h3').text()).toBe('风险')
  expect(wrapper.find('strong').text()).toBe('止损')
  expect(wrapper.text()).toContain('4261.37')
  expect(wrapper.text()).toContain('入场依据=不可用')
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
})

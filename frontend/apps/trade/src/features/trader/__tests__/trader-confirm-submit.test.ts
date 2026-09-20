import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { expect, it } from 'vitest'
import TraderDangerConfirm from '../components/TraderDangerConfirm.vue'

it.each(['market_order', 'modify_position'])('keeps %s available while confirming and exposes a failed submission', async command => {
  const pending = ref(true), submitting = ref(false), error = ref('')
  let calls = 0
  const wrapper = mount(defineComponent({
    components: { TraderDangerConfirm },
    setup: () => ({ pending, submitting, error, command, confirm: () => {
      if (!pending.value) return
      calls++; submitting.value = true
    } }),
    template: `<TraderDangerConfirm :open="pending" :command="command" :submitting="submitting" :error="error" @update:open="pending=$event" @confirm="confirm" />`,
  }), { attachTo: document.body })
  await nextTick()
  const confirm = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === '确认提交')!
  confirm.click(); await nextTick()
  expect(calls).toBe(1)
  expect(pending.value).toBe(true)
  expect(confirm.disabled).toBe(true)
  error.value = '提交失败，请检查交易参数'; submitting.value = false; await nextTick()
  expect([...document.body.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(' ')).toContain(error.value)
  wrapper.unmount()
  document.body.innerHTML = ''
})

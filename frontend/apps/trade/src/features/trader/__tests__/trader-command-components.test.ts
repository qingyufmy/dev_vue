import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import TraderCommandSheet from '../components/TraderCommandSheet.vue'

function componentSource(name: string) {
  return readFileSync(resolve(process.cwd(), 'src/features/trader/components', name), 'utf8')
}

describe('trader command components', () => {
  it('keeps the command sheet as a controlled shadcn form with both order modes', () => {
    const source = componentSource('TraderCommandSheet.vue')
    expect(source).toContain('<Sheet :open="open"')
    expect(source).toContain('<SheetTitle>')
    expect(source).toContain('<FieldGroup>')
    expect(source).toContain('<Input')
    expect(source).toContain('<Select')
    expect(source).toContain('<Checkbox')
    expect(source).toContain("'market_order'")
    expect(source).toContain("'pending_order'")
    expect(source).toContain('stop_limit_price')
    expect(source).toContain('expiration_utc_msc')
    expect(source).toContain('目标范围将在确认时冻结')
    expect(source).toContain('distributionPreview')
    expect(source).toContain("'preview-distribution': [strategyId: string, symbol: string]")
    expect(source).toContain('刷新预览')
    expect(source).toContain('submit: [draft: CommandDraft]')
    expect(source).toMatch(/class="[^"]*min-h-11/)
  })

  it('requires a dangerous-action confirmation and explains asynchronous execution', () => {
    const source = componentSource('TraderDangerConfirm.vue')
    expect(source).toContain('<AlertDialog :open="open"')
    expect(source).toContain('<AlertDialogTitle>')
    expect(source).toContain('<AlertDialogDescription>')
    expect(source).toContain('<AlertDialogCancel')
    expect(source).toContain('<Button type="button"')
    expect(source).toContain('提交后会在当前页面提示受理结果')
    expect(source).toContain('影响范围')
    expect(source).toContain('close_position')
    expect(source).toContain('cancel_order')
    expect(source).toContain('distribution_close')
    expect(source).toMatch(/Button[^>]*min-h-11/)
  })

  it('keeps the user on the current workspace and reports submission through Sonner', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/trader/views/TraderView.vue'), 'utf8')
    const sonner = readFileSync(resolve(process.cwd(), '../../packages/ui/src/components/ui/sonner/Sonner.vue'), 'utf8')
    expect(source).toContain("import { toast } from '@aurum/ui/sonner'")
    expect(sonner).toContain("import 'vue-sonner/style.css'")
    expect(source).toContain("toast.success('交易操作已完成'")
    expect(source).toContain("toast.info('交易指令已受理'")
    expect(source).toContain("toast.warning('交易结果需要核实'")
    expect(source).toContain("toast.error('交易指令未完成'")
    expect(source).toContain("toast.error('交易指令提交失败'")
    expect(source).not.toContain("activeTab.value = 'operations'\n  await workspace.refresh()")
    expect(source).toContain("action: { label: '查看执行记录'")
    expect(source).toContain('pendingOperationFeedback.set(operation.operationId')
    expect(source).toContain('watch(commands.operations')
    expect(source).toContain('terminalOperationStatuses.has(operation.status)')
    expect(source).toContain('workspace.reconcileInventory')
    expect(source).toContain("payload: { strategy_id: draft.strategy_id, command: buildDistributionEntryCommand(draft) }")
    expect(source).toContain("payload: buildAccountEntryCommand(draft, context)")
    expect(source).not.toContain('const command = buildDistributionEntryCommand(draft)')
  })

  it('renders every operation state and calls uncertain out as no-replay', () => {
    const source = componentSource('TraderOperationCenter.vue')
    for (const status of ['accepted', 'queued', 'running', 'succeeded', 'partially_succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'expired']) {
      expect(source).toContain(`${status}:`)
    }
    expect(source).toContain('不要重复提交')
    expect(source).toContain('结果尚未确认')
    expect(source).toContain('<Empty')
    expect(source).toContain('<Table')
    expect(source).toContain('md:hidden')
  })

  it('exposes resource actions while keeping read-only mode disabled', () => {
    const source = componentSource('InventoryDetailSheet.vue')
    expect(source).toContain("'modify-position'")
    expect(source).toContain("'close-position'")
    expect(source).toContain("'modify-order'")
    expect(source).toContain("'cancel-order'")
    expect(source).toContain('修改止盈止损')
    expect(source).toContain('修改挂单')
    expect(source).toContain('当前仅可查看')
    expect(source).toMatch(/variant="destructive"[^>]*min-h-11/)

    const workspace = componentSource('InventoryWorkspace.vue')
    expect(workspace).toContain('readOnly?: boolean')
    expect(workspace).toContain('只读模式')
  })

  it('emits a local market-order draft only after required fields are filled', async () => {
    const wrapper = mount(TraderCommandSheet, {
      attachTo: document.body,
      props: {
        open: true,
        account: {
          id: 'account-1', platform: 'mt5', login: '8950701', server: 'Demo', currency: 'USD',
          terminalProfileId: 'profile-1', terminalInstanceId: null, bridgeState: 'online', tradePermission: true, lastSeenAt: null,
        },
        symbols: ['XAUUSD'],
        quote: { bid: '2300.10', ask: '2300.30', observedAt: '2026-09-04T08:00:00.000Z' },
      },
    })
    await nextTick()
    const setInput = async (id: string, value: string) => {
      const input = document.body.querySelector<HTMLInputElement>(`#${id}`)
      expect(input).not.toBeNull()
      if (!input) return
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    }
    await setInput('command-volume', '0.10')
    await setInput('command-stop-loss', '2290.00')
    const form = document.body.querySelector('form')
    expect(form).not.toBeNull()
    const submitButton = form?.querySelector<HTMLButtonElement>('button[data-slot="button"]:last-child')
    expect(submitButton?.textContent).toContain('核对并继续')
    submitButton?.click()
    await Promise.resolve()

    const events = wrapper.emitted('submit')
    expect(events).toHaveLength(1)
    expect(events?.[0]?.[0]).toMatchObject({
      command_type: 'market_order', symbol: 'XAUUSD', side: 'buy', volume: '0.10',
      stop_loss: '2290.00', reference_price: '2300.30',
    })
    wrapper.unmount()
  })
})

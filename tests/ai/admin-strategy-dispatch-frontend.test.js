import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const strategyDispatchSignalSourceLabel = new Function(`${app.slice(app.indexOf('function strategyDispatchSignalSourceLabel'), app.indexOf('function strategyMarketPlan'))}\nreturn strategyDispatchSignalSourceLabel;`)()

describe('admin strategy dispatch frontend contract', () => {
  it('keeps the entry point inside manual order and gates it by admin capability', () => {
    expect(html).toContain('id="adminStrategyDispatchPanel"')
    expect(html).toContain('id="adminStrategyDispatchEnabled"')
    expect(html).toContain('按平台策略分发')
    expect(html).toContain('管理员策略指令')
    expect(app).toContain('state.user?.role === "admin"')
    expect(app).toContain('/api/admin/strategy-trades/capabilities')
    expect(app).toContain('state.adminStrategyDispatchCapabilities?.enabled')
    expect(app).toContain('panel.hidden = !canUse')
    expect(app).not.toContain('volumeInput.disabled = true')
    expect(app).not.toContain('tradeVolumeDispatchHelp')
    expect(html).not.toContain('id="tradeVolumeDispatchHelp"')
    expect(html).not.toContain('id="adminStrategyDispatchTier"')
    expect(app).not.toContain('function openAdminStrategyDispatchPage')
  })

  it('uses only active platform strategies and validates the admin source order fields', () => {
    expect(app).toContain('item?.scope === "platform"')
    expect(app).toContain('item?.visibility_status === "active"')
    expect(app).toContain('entry_method:"market"')
    for (const key of ['strategy_id', 'trading_account_id', 'symbol', 'direction', 'stop_loss', 'take_profit', 'volume', 'valid_minutes', 'valid_until_utc_msc', 'reason', 'client_request_id']) {
      expect(app).toContain(`${key}:`)
    }
    expect(app).toContain('const volume = Number($("tradeVolume")?.value)')
    expect(app).toContain('交易手数')
    expect(app).toContain('escapeHtml(String(order.meta.volume))} 手')
    expect(app).not.toContain('volumeText(order.meta.volume)')
    expect(String(0.001)).toBe('0.001')
    expect(app).not.toContain('ADMIN_STRATEGY_DISPATCH_TIER_LABELS')
    expect(app).not.toContain('adminStrategyDispatchTier')
    expect(app).not.toContain('position_size_tier:String($("adminStrategyDispatchTier")')
    expect(app).not.toContain('source_volume')
    expect(app).toContain('stopLoss == null')
    expect(app).toContain('takeProfit == null')
    expect(app).toContain('if (reason && reason.length < 2)')
    expect(app).toContain('order.meta.reason || "未填写"')
    expect(app).toContain('reason, client_request_id')
    expect(html).toContain('id="adminStrategyDispatchReason"')
    expect(html).toContain('maxlength="500"')
    expect(html).toContain('中文原因（选填）')
    expect(html).toContain('可填写本次分发指令的中文原因')
    expect(html).toContain('选填；填写时 2–500 字')
    expect(html).not.toContain('id="adminStrategyDispatchReason" rows="2" maxlength="500" required')
  })

  it('previews before creation, shows target outcomes, refreshes, and retries failed targets', () => {
    expect(app).toContain('/api/admin/strategy-trades/preview')
    expect(app).toContain('/api/admin/strategy-trades"')
    expect(app).toContain('/api/admin/strategy-trades/${encodeURIComponent(id)}')
    expect(app).toContain('/retry`')
    expect(app).toContain('state.adminStrategyDispatchPending')
    expect(app).toContain('adminStrategyDispatchPreviewRoot')
    expect(app).toContain('const body = { ...order.payload, preview_hash:order.payload.preview_hash || preview?.preview_hash, confirm:true }')
    expect(app).toContain('成功')
    expect(app).toContain('拒绝')
    expect(app).toContain('跳过')
    expect(app).toContain('结果待确认')
    for (const id of ['adminStrategyDispatchModal', 'adminStrategyDispatchPreviewBody', 'adminStrategyDispatchProgress', 'adminStrategyDispatchRetry']) {
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('does not route ordinary users or ordinary order types through dispatch', () => {
    expect(app).toContain('adminStrategyDispatchModeEnabled() ? openAdminStrategyDispatch("buy") : openManual("buy")')
    expect(app).toContain('adminStrategyDispatchModeEnabled() ? openAdminStrategyDispatch("sell") : openManual("sell")')
    expect(app).toContain('if (!isAdminStrategyDispatchUser() || !state.adminStrategyDispatchCapabilities?.enabled)')
    expect(app).toContain('state.selectedOrderType = "market"')
    expect(app).toContain('type !== "market"')
    expect(css).toContain('.admin-strategy-dispatch-panel')
    expect(css).toContain('.admin-strategy-dispatch-target-row')
  })

  it('keeps admin dispatch labels and omits the redundant auto-shared source label', () => {
    expect(app).toContain('admin_strategy_dispatch')
    expect(app).toContain('管理员策略指令')
    expect(strategyDispatchSignalSourceLabel({ source: 'admin_strategy_dispatch' })).toBe('管理员策略指令')
    expect(strategyDispatchSignalSourceLabel({ source: 'admin_strategy_trade' })).toBe('管理员策略指令')
    expect(strategyDispatchSignalSourceLabel({ admin_strategy_dispatch_id: 42 })).toBe('管理员策略指令')
    expect(strategyDispatchSignalSourceLabel({ source: 'auto_shared' })).toBe('')
    expect(strategyDispatchSignalSourceLabel({ source_type: 'auto_shared' })).toBe('')
    expect(html).toContain('admin-strategy-dispatch1')
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const strategyDispatchSignalSourceLabel = new Function(`${app.slice(app.indexOf('function strategyDispatchSignalSourceLabel'), app.indexOf('function strategyMarketPlan'))}\nreturn strategyDispatchSignalSourceLabel;`)()
const adminStrategyDispatchTargetLabel = new Function(`${app.slice(app.indexOf('function adminStrategyDispatchTargetLabel'), app.indexOf('function renderAdminStrategyDispatchProgress'))}\nreturn adminStrategyDispatchTargetLabel;`)()
const adminStrategyDispatchPreviewTargetHelpers = new Function(`${app.slice(app.indexOf('function adminStrategyDispatchPreviewTargetRows'), app.indexOf('function adminStrategyDispatchPreviewTargetRow(target'))}\nreturn { eligible:adminStrategyDispatchPreviewEligibleTargets, excluded:adminStrategyDispatchPreviewExcludedTargets };`)()

describe('admin strategy dispatch frontend contract', () => {
  it('keeps the entry point inside manual order and gates it by admin capability', () => {
    expect(html).toContain('id="adminStrategyDispatchPanel"')
    expect(html).toContain('id="adminStrategyDispatchEnabled"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('admin-strategy-dispatch-switch-thumb')
    expect(html).toContain('按平台策略分发')
    expect(html).toContain('关闭即恢复普通下单')
    expect(html).not.toContain('<span class="status-chip warning">管理员策略指令</span>')
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
    expect(app).not.toContain('策略分发必须填写止损价格')
    expect(app).not.toContain('策略分发至少填写一个止盈价格')
    expect(app).toContain('function adminStrategyDispatchProtectionDisplay(value)')
    expect(app).toContain('value == null ? "未设置" : priceDisplay(value)')
    expect(app).toContain('admin_account_excluded: "与管理员源账户相同，已作为源账户单独执行"')
    expect(html).toContain('止损止盈均可留空')
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
    expect(html).toContain('admin-dispatch-user-label1')
  })

  it('shows deterministic user account and nickname labels for dispatch targets', () => {
    expect(adminStrategyDispatchTargetLabel({ user_account: '18192234189', user_nickname: '测试用户' })).toBe('18192234189 · 测试用户')
    expect(adminStrategyDispatchTargetLabel({ user_account: 'same', user_nickname: 'same' })).toBe('same')
    expect(adminStrategyDispatchTargetLabel({ user_account: '18192234189' })).toBe('18192234189')
    expect(adminStrategyDispatchTargetLabel({ user_nickname: '测试用户' })).toBe('测试用户')
    expect(adminStrategyDispatchTargetLabel({ user_id: 28 })).toBe('订阅目标')
    expect(app).toContain('const label = adminStrategyDispatchTargetLabel(target)')
    expect(app).not.toContain('target?.user_id ? `用户 #${target.user_id}`')
  })

  it('keeps account details collapsed by default and expands an accessible target list on demand', () => {
    expect(app).toContain('<details class="admin-strategy-dispatch-target-details">')
    expect(app).toContain('<summary><span>查看账号明细</span>')
    expect(app).not.toContain('<details class="admin-strategy-dispatch-target-details" open>')
    expect(app).toContain('adminStrategyDispatchPreviewEligibleTargets(preview)')
    expect(app).toContain('adminStrategyDispatchPreviewExcludedTargets(preview)')
    expect(app).toContain('adminStrategyDispatchTargetLabel(target)')
    expect(app).toContain('adminStrategyDispatchTargetReason(target) || "未满足执行条件"')
    expect(app).toContain('<strong>可执行账号</strong>')
    expect(app).toContain('<strong>排除账号</strong>')
    expect(css).toContain('.admin-strategy-dispatch-target-details summary:focus-visible')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(html).toContain('admin-dispatch-details1')
  })

  it('keeps source and subscription identities distinct while deduplicating compatibility aliases', () => {
    const source = { target_role:'source', trading_account_id:2, valid:true }
    const subscriber = { target_role:'subscriber', subscription_id:5, trading_account_id:3, valid:true }
    expect(adminStrategyDispatchPreviewTargetHelpers.eligible({
      source, source_account:source, targets:[subscriber], eligible_targets:[subscriber],
    })).toEqual([source, subscriber])

    const sourceExclusion = { target_role:'source', trading_account_id:2, exclusion_reason:'source_bridge_offline' }
    const duplicateSubscription = { target_role:'subscriber', subscription_id:4, trading_account_id:2, exclusion_reason:'admin_account_excluded' }
    expect(adminStrategyDispatchPreviewTargetHelpers.excluded({ exclusions:[sourceExclusion, duplicateSubscription] })).toEqual([
      sourceExclusion, duplicateSubscription,
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`)
  const end = source.indexOf('\nfunction ', start + 10)
  return source.slice(start, end < 0 ? source.length : end)
}

describe('PivotGuard position management frontend contract', () => {
  it('places the account guard after automatic analysis and before trade status', () => {
    expect(html).toContain('id="autoAnalyzeMode"')
    expect(html).toContain('id="positionGuardMode"')
    expect(html).toContain('自动盯盘 关闭')
    expect(html.indexOf('id="autoAnalyzeMode"')).toBeLessThan(html.indexOf('id="positionGuardMode"'))
    expect(html.indexOf('id="positionGuardMode"')).toBeLessThan(html.indexOf('id="tradeMode"'))
    expect(app).toContain('positionGuardStatusPresentation')
    expect(app).toContain('自动盯盘 运行中')
    expect(app).toContain('自动盯盘 已暂停')
    expect(app).toContain('自动盯盘 不可用')
    expect(css).toContain('.position-guard-control[hidden] { display:none !important; }')
    expect(html).toContain('position-guard-visibility2')
  })

  it('keeps the ordinary-user renderer free of parameter values and config JSON', () => {
    const userRenderer = functionBody(app, 'renderPositionGuardUserSettings')
    expect(userRenderer).toContain('账号开关')
    expect(userRenderer).toContain('参数由平台管理员统一维护')
    expect(userRenderer).not.toContain('POSITION_GUARD_DEFAULT_CONFIG')
    expect(userRenderer).not.toContain('positionGuardProfile')
    expect(userRenderer).not.toContain('config_json')
    expect(app).toContain('state.user?.role === "admin"')
    expect(app).toContain('positionGuardAdminPanel')
  })

  it('binds the user setting to the active account and uses the declared API contracts', () => {
    expect(app).toContain('/api/ai/position-guard/settings?${query.toString()}')
    expect(app).toContain('body:{ trading_account_id:accountId, enabled }')
    for (const path of [
      '/api/ai/admin/position-guard/profiles',
      '/api/ai/admin/position-guard/profiles/${encodeURIComponent(symbol)}',
      '/api/ai/admin/position-guard/profiles/${encodeURIComponent(current.standard_symbol)}',
      '/api/ai/admin/position-guard/control',
    ]) expect(app).toContain(path)
    expect(app).toContain('trading_account_id:String(accountId)')
    expect(app).toContain('默认关闭')
  })

  it('renders every retained admin parameter and omits the removed protections', () => {
    for (const path of [
      'pivot_method',
      'break_stop.enabled', 'break_stop.distance_price', 'break_stop.open_near_price',
      'pivot_cross_stop.enabled', 'pivot_cross_stop.distance_price', 'pivot_cross_stop.min_duration_seconds',
      'retrace_stop.enabled', 'retrace_stop.distance_price',
      'pivot_take_profit.enabled', 'pivot_take_profit.tolerance_price', 'pivot_take_profit.close_percent', 'pivot_take_profit.move_break_even',
      'first_target_take_profit.enabled', 'first_target_take_profit.tolerance_price', 'first_target_take_profit.close_percent', 'first_target_take_profit.move_break_even', 'first_target_take_profit.break_even_offset_price',
    ]) expect(app).toContain(`path:"${path}"`)
    expect(app).not.toContain('max_loss')
    expect(app).not.toContain('drawdown_percent')
    expect(app).not.toContain('maxProfit')
    expect(app).toContain('保存原因（必填）')
    expect(app).toContain('确认创建 PivotGuard 新版本？')
    expect(app).toContain('只影响之后新纳入监控的持仓')
  })

  it('disables the matching break-even option when a rule closes 100 percent', () => {
    expect(app).toContain('const disabled = value === 100')
    expect(app).toContain('breakEven.disabled = disabled')
    expect(app).toContain('if (disabled) breakEven.checked = false')
    expect(app).toContain('data-position-guard-close-percent')
    expect(app).toContain('data-position-guard-break-even')
  })

  it('keeps administrator-facing labels in Chinese while preserving API values', () => {
    expect(html).toContain('position-guard-admin-layout3')
    expect(app).toContain('positionGuardStatusLabel')
    expect(app).toContain('return version > 0 ? `第 ${version} 版` : "尚未创建版本"')
    expect(app).toContain('fibonacci:"斐波那契法"')
    expect(app).toContain('standard:"标准枢轴点法"')
    expect(app).not.toContain('optionLabels:{ fibonacci:"Fibonacci"')
    expect(app).not.toContain('optionLabels:{ fibonacci:"Fibonacci", standard:"Standard" }')
    expect(app).toContain('function positionGuardSymbolLabel(symbol)')
    expect(app).toContain('return value || "未指定品种"')
    expect(app).toContain('positionGuardSymbolLabel(symbol)')
    expect(app).not.toMatch(/>(?:Fibonacci|Standard|active|inactive)</)
    expect(app).toContain('<h3 id="positionGuardAdminTitle">自动盯盘参数</h3>')
    expect(app).toContain('<span>${escapeHtml(positionGuardStatusLabel(current.status))}</span>')
  })

  it('renders the admin form as a control, basics, rules, and release flow', () => {
    expect(app).toContain('平台总闸')
    expect(app).toContain('position-guard-platform-control-section')
    expect(app).toContain('position-guard-basic-config')
    expect(app).toContain('positionGuardRuleGroupMarkup(group, config)')
    expect(app).toContain('positionGuardRuleBlocks(group)')
    expect(app).toContain('position-guard-rule-fields')
    expect(app).toContain('全部平仓时无需移保本')
    expect(app).toContain('positionGuardStatusLabel(nextStatus)')
    expect(app).toContain('position-guard-release-section')
    expect(app).toContain('保存参数版本')
  })

  it('keeps the parameter form usable at desktop and mobile widths', () => {
    expect(css).toContain('.position-guard-parameter-grid {')
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(css).toContain('.position-guard-rule-fields {')
    expect(css).toContain('min-height: 44px;')
    expect(css).toContain('@media (max-width: 1180px)')
    expect(css).toContain('@media (max-width: 760px)')
    expect(css).toContain('.position-guard-switch input:focus-visible')
  })

  it('keeps observer mode read-only and refreshes state on lifecycle events', () => {
    expect(app).toContain('if (isObserverMode()) { toast(observerMessage(), "warning"); return; }')
    expect(app).toContain('renderPositionGuardBadge(state.positionGuardSettings)')
    expect(app).toContain('refreshPositionGuardState({ quiet:true, includeAdmin:true })')
    expect(app).toContain("msg.type === 'position_guard_settings_updated'")
    expect(app).toContain('streams.has(\'account\') || streams.has(\'positions\')')
    expect(css).toContain('.position-guard-user-settings')
    expect(css).toContain('.position-guard-switch input:focus-visible')
    expect(css).toContain('.position-guard-parameter-grid')
    expect(css).toContain('@media (max-width: 760px)')
  })
})

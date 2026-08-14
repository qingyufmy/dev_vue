import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../../public/ai/responsive.css', import.meta.url), 'utf8')

describe('manual order ticket frontend contract', () => {
  it('keeps the existing order IDs and preserves the transaction sequence', () => {
    for (const id of [
      'adminStrategyDispatchPanel', 'adminStrategyDispatchEnabled', 'adminStrategyDispatchFields',
      'adminStrategyDispatchStrategy', 'adminStrategyDispatchValidMinutes', 'adminStrategyDispatchReason',
      'tradeSymbolSelect', 'tradeBidPrice', 'tradeSpread', 'tradeAskPrice', 'tradeVolume',
      'pendingPriceRow', 'pendingPrice', 'stopLimitPriceWrap', 'stopLimitPrice', 'pendingValidMinutes',
      'takeProfitPoints', 'stopLossPoints', 'buyBtn', 'buyBtnPrice', 'sellBtn', 'sellBtnPrice',
      'adminStrategyDispatchProgress', 'adminStrategyDispatchProgressSummary',
      'adminStrategyDispatchProgressTargets', 'adminStrategyDispatchRetry',
    ]) expect(html).toContain(`id="${id}"`)

    for (const section of [
      'trade-ticket-head', 'trade-ticket-market', 'trade-ticket-order', 'trade-ticket-risk',
      'trade-ticket-actions', 'admin-strategy-dispatch-progress',
    ]) expect(html).toContain(section)

    expect(html.indexOf('trade-ticket-head')).toBeLessThan(html.indexOf('trade-ticket-market'))
    expect(html.indexOf('trade-ticket-market')).toBeLessThan(html.indexOf('trade-ticket-order'))
    expect(html.indexOf('trade-ticket-order')).toBeLessThan(html.indexOf('trade-ticket-risk'))
    expect(html.indexOf('trade-ticket-risk')).toBeLessThan(html.indexOf('trade-ticket-actions'))
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="当前买卖报价"')
    expect(html).toContain('aria-label="刷新交易报价"')
  })

  it('fails closed for dispatch visibility and keeps optional reason compact', () => {
    expect(html).toContain('id="adminStrategyDispatchPanel" class="admin-strategy-dispatch-panel admin-only" hidden')
    expect(html).toContain('aria-controls="adminStrategyDispatchFields" aria-expanded="false"')
    expect(html).toContain('id="adminStrategyDispatchFields" class="admin-strategy-dispatch-fields" hidden')
    expect(html).toContain('id="adminStrategyDispatchProgress" class="admin-strategy-dispatch-progress" hidden')
    expect(css).toContain('.admin-strategy-dispatch-panel[hidden]')
    expect(css).toContain('.admin-strategy-dispatch-fields[hidden]')
    expect(css).toContain('.admin-strategy-dispatch-progress[hidden]')
    expect(app).toContain('!state.adminStrategyDispatchCapabilities?.enabled || !dispatch')
    expect(app).toContain('panel.hidden = !canUse')
    expect(app).toContain('fields.hidden = !canUse || !checkbox.checked')
    expect(html).toContain('id="adminStrategyDispatchReason" rows="2" maxlength="500"')
    expect(html).toContain('选填；填写时 2–500 字')
  })

  it('keeps touch targets, responsive single-column mobile flow, and reduced motion', () => {
    expect(css).toContain('min-height: 44px')
    expect(css).toContain('.trade-ticket-form-grid')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(responsiveCss).toContain('@media (max-width: 375px)')
    expect(responsiveCss).toContain('.trade-ticket-form-grid {\n    grid-template-columns: minmax(0, 1fr);')
    expect(responsiveCss).toContain('@media (max-width: 767px) and (orientation: landscape)')
    expect(responsiveCss).toContain('overflow-x: hidden')
  })

  it('cache-busts each changed manual-order resource without changing the base version contract', () => {
    expect(html).toContain('styles.css?v=20260814ema34toggle1&rev=')
    expect(html).toContain('responsive.css?v=20260814ema34toggle1&rev=')
    expect(html).toContain('app.js?v=20260814ema34toggle1&build=')
    expect(html).toContain('manual-order-ticket1')
  })
})

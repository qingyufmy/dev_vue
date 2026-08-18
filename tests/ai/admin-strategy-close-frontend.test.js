import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

describe('admin strategy linked close frontend contract', () => {
  it('keeps the dangerous action inside the existing protection modal', () => {
    expect(html).toContain('id="positionProtectionModal"')
    expect(html).toContain('id="adminStrategyCloseSection"')
    expect(html).toContain('平仓本次策略指令关联持仓')
    expect(html).toContain('完整平仓不可撤销')
    expect(html).toContain('订阅用户先关，观摩源仓最后')
    expect(html).toContain('Bridge ACK 待对账')
    expect(html).toContain('maxlength="500"')
    expect(html).toContain('id="adminStrategyCloseCapabilityButton"')
    expect(html).toContain('id="adminStrategyCloseCapabilityStatus"')
  })

  it('fails closed unless the preview confirms a unique platform strategy attribution', () => {
    expect(app).toContain('adminStrategyCloseAttribution')
    expect(app).toContain('admin_strategy_dispatch')
    expect(app).toContain('auto_shared')
    expect(app).toContain('unique_attribution')
    expect(app).toContain('if (!adminStrategyCloseAttribution(root)) return false')
    expect(app).toContain('loadAdminStrategyClosePreview(ticket)')
    expect(app).toContain('renderAdminStrategyCloseCapability("unavailable", error)')
    expect(app).toContain('admin_dispatch_attribution_unavailable')
    expect(app).toContain('当前持仓未能唯一关联到平台策略信号')
    expect(app).toContain('adminStrategyCloseAttributionUnavailable')
    expect(app).not.toContain('暂不可完整平仓')
  })

  it('uses the close-preview, job, polling and failed-only retry API contracts', () => {
    for (const endpoint of [
      '/api/admin/ai/positions/${encodeURIComponent(ticketValue)}/close-preview',
      '/api/admin/ai/position-close-jobs',
      '/api/admin/ai/position-close-jobs/${encodeURIComponent(jobId)}',
      '/api/admin/ai/position-close-jobs/${encodeURIComponent(jobId)}/retry-failed',
    ]) expect(app).toContain(endpoint)
    expect(app).toContain('source_ticket:sourceTicket')
    expect(app).toContain('preview_hash:formState.hash')
    expect(app).toContain('reason:formState.reason')
    expect(app).toContain('body:{ preview_hash:previewHash }')
    expect(app).toContain('const freshPreview = await fetchAdminStrategyClosePreview(sourceTicket)')
    expect(app).toContain('if (!adminStrategyCloseEligible(freshPreview))')
    expect(app).toContain('adminStrategyCloseTargetStatus')
    expect(app).toContain('订阅用户先关，观摩源仓最后')
    expect(app).toContain('Bridge ACK 待对账')
  })

  it('requires a reason, checkbox and second dangerous confirmation', () => {
    expect(app).toContain('reason.length < 2')
    expect(app).toContain('reason.length > 500')
    expect(app).toContain('adminStrategyCloseConfirm')
    expect(app).toContain('showConfirm(\n    "确认完整平仓"')
    expect(app).toContain('requireText:"确认平仓"')
    expect(css).toContain('.admin-strategy-close-section')
    expect(css).toContain('.position-protection-target-status.uncertain')
    expect(html).toContain('admin-strategy-close1')
  })

  it('renders the second dangerous confirmation above the position editor modal', () => {
    const formModalZ = Number(css.match(/\.form-modal\s*\{[^}]*z-index:\s*(\d+)/s)?.[1])
    const confirmModalZ = Number(css.match(/#genericConfirmModal\s*\{[^}]*z-index:\s*(\d+)/s)?.[1])
    expect(formModalZ).toBeGreaterThan(0)
    expect(confirmModalZ).toBeGreaterThan(formModalZ)
    expect(html).toContain('admin-strategy-close-confirm1')
  })
})

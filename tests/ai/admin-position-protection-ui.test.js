import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const server = readFileSync(new URL('../../server/routes/admin-position-protection.js', import.meta.url), 'utf8')
const bridgeAdapter = readFileSync(new URL('../../server/bridge-v3/business-adapter.js', import.meta.url), 'utf8')
const mt5Trade = readFileSync(new URL('../../bridge/native/workers/mt5/trade.py', import.meta.url), 'utf8')

describe('admin position protection UI contract', () => {
  it('shows the edit action only to administrators for system-owned positions', () => {
    expect(app).toContain('state.user?.role === "admin" && Number(position.magic) === 234000')
    expect(app).toContain('data-edit-protection-ticket=')
    expect(app).toContain('编辑保护')
  })

  it('provides preview, real progress, per-target results and failed-item retry', () => {
    for (const id of [
      'positionProtectionModal', 'positionProtectionImpact', 'positionProtectionProgress',
      'positionProtectionResultBody', 'positionProtectionRetry',
    ]) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('同步同一信号下的系统持仓')
    expect(app).toContain("msg.type === 'position_protection_job_updated'")
    expect(app).toContain('/retry-failed')
    expect(css).toContain('.position-protection-target-status.failed')
    expect(app).not.toContain('if (sourcePreview.sync_available) await loadPositionProtectionPreview(ticket, "signal")')
    expect(app).toContain('Math.abs(stopLossValue - currentStopLoss) > 1e-8')
    expect(app).toContain('body:{ preview_hash:preview.preview_hash }')
  })

  it('presents a clear, accessible edit flow with inline change feedback', () => {
    for (const id of [
      'positionProtectionDescription', 'positionProtectionStopLossError',
      'positionProtectionTakeProfitError', 'positionProtectionChangeSummary',
      'positionProtectionScopeBadge', 'positionProtectionReasonCount',
      'positionProtectionReasonError', 'positionProtectionCancel',
      'positionProtectionSubmitHint', 'positionProtectionSubmitLabel',
      'positionProtectionScopeDetailsToggle', 'positionProtectionScopeDetails',
      'positionProtectionCloseCurrent', 'positionProtectionCloseCurrentHelp',
    ]) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('aria-describedby="positionProtectionStopLossHelp positionProtectionStopLossError"')
    expect(html).toContain('aria-describedby="positionProtectionTakeProfitHelp positionProtectionTakeProfitError"')
    expect(html).toContain('调整当前系统持仓的保护价，或单独平仓当前持仓；关联账户操作会另行确认。')
    expect(html).toContain('class="position-protection-reason-head"')
    expect(app).toContain('renderPositionProtectionChangeState({ showErrors:true })')
    expect(app).toContain('positionProtectionPriceLabel(currentStopLoss)')
    expect(app).toContain('positionProtectionSubmitLabel").textContent = "正在保存…"')
    expect(css).toContain('.position-protection-field input[aria-invalid="true"]')
    expect(css).toContain('.position-protection-sync-option { position:relative; display:flex;')
    expect(css).toContain('.position-protection-switch { position:relative; flex:0 0 42px;')
    expect(css).toContain('.position-protection-sync-option:has(input:checked)')
    expect(css).toContain('.position-protection-scope-details')
    expect(app).toContain('renderPositionProtectionScopeDetails')
    expect(app).toContain('positionProtectionPreviewRequestVersion')
    expect(app).toContain('closeCurrentPositionFromProtectionModal')
    expect(app).toContain('closeProtectionModalOnSuccess:true')
    expect(app).toContain('closeCurrent.title = "只平仓当前账户这一笔持仓，不影响其他账户"')
    expect(app).toContain('expected_state: managementExpectedState(position, ticket, "position")')
    expect(css).toContain('.position-protection-impact > div')
    expect(css).toContain('.position-protection-impact > button { appearance:none;')
    expect(css).not.toContain('grid-template-columns:1px 42px minmax(0,1fr)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('keeps batch execution on the server and verifies every MT5 write', () => {
    expect(server).toContain("sendBridgeCommand(target.user_id, 'modify_system_position_protection'")
    expect(server).toContain("if (Number(target.is_source))")
    expect(server).toContain("'source_position_update_failed'")
    expect(bridgeAdapter).toContain("modify_system_position_protection:'modify_position'")
    expect(mt5Trade).toContain('current = self.mt5.positions_get(ticket=ticket)')
    expect(mt5Trade).toContain('position_protection_not_applied')
    expect(mt5Trade).toContain('"position": ticket, "stop_loss": next_sl, "take_profit": next_tp')
    expect(server).toContain('stop_loss:expectedStopLoss')
    expect(server).toContain('(position_id = ? OR entry_order_ticket = ?)')
  })
})

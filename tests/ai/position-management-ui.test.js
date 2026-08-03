import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')

describe('AI position management workspace', () => {
  it('publishes the automatic-exit UI with a fresh asset cache key', () => {
    expect(html).toContain('/ai/styles.css?v=20260803utcdisplay1')
    expect(html).toContain('/ai/app.js?v=20260803utcdisplay1')
  })

  it('keeps position management inside AI trader instead of adding another top-level module', () => {
    expect(html).toContain('data-workspace-target="management"')
    expect(html).toContain('AI持仓管理')
    expect(html).toContain('自动平仓、AI 挂单和 AI 取消挂单使用三项独立的平台能力控制')
    expect(html).not.toContain('data-tab="position-management"')
  })

  it('shows the concrete MT5 target and consecutive inference progress without manual execution controls', () => {
    expect(html).toContain('持仓 / 品种')
    expect(html).toContain('确认进度')
    expect(html).toContain('最近判断')
    expect(html).toContain('positionManagementDetail')
    expect(app).toContain('model_evaluation_json')
    expect(app).toContain('evidence_validation_json')
    expect(app).toContain('连续自动推理确认')
    expect(app).toContain('const targetKind = pendingCancelTask ? `${bridgePlatformLabel()} 挂单`')
    expect(app).toContain('snapshot.sl ?? snapshot.stop_loss ?? task.target_actual_stop_loss')
    expect(app).toContain('snapshot.tp ?? snapshot.take_profit ?? task.target_actual_take_profit')
    expect(app).toContain('当前止损 / 当前止盈')
    expect(app).not.toContain('target_original_take_profits_json')
    expect(app).toContain('一轮有效判断明确建议撤单后，立即进入挂单身份与状态校验。')
    expect(app).toContain('撤单判断已确认')
    expect(app).toContain('${bridgePlatformLabel()} 挂单')
    expect(app).toContain('不会创建 ${bridgePlatformLabel()} 平仓命令')
    expect(html).not.toContain('data-action="execute-position-management"')
  })

  it('refreshes the active workspace from WSS task events', () => {
    expect(app).toContain("msg.type === 'position_management_task_updated'")
    expect(app).toContain('loadPositionManagement({ quiet:true, preserveSelection:true })')
    expect(app).toContain('刚刚实时更新')
  })

  it('provides user-scoped list, detail and settings endpoints', () => {
    expect(routes).toContain("router.get('/ai/position-management/settings'")
    expect(routes).toContain("router.get('/ai/position-management'")
    expect(routes).toContain("router.get('/ai/position-management/:taskId'")
    expect(routes).toContain("router.get('/ai/admin/position-management-settings'")
    expect(routes).toContain("router.put('/ai/admin/position-management-control'")
    expect(routes).not.toContain("router.put('/ai/admin/position-management-rollouts/:accountId'")
  })

  it('lets the user enable automatic close without account-level admin authorization', () => {
    expect(html).toContain('positionManagementSettingsPanel')
    expect(app).toContain('positionManagementSettingsForm')
    expect(app).not.toContain('自动反手（尚未开放）')
    expect(app).toContain('AI 挂单和 AI 取消挂单使用独立的平台开关')
    expect(app).toContain('自动平仓')
    expect(app).not.toContain('>影子运行</option>')
    expect(app).not.toContain('>影子模式</option>')
    expect(app).not.toContain('账户执行授权')
    expect(app).not.toContain('account_rollouts')
    expect(app).not.toContain('positionManagementDailyLimit')
    expect(app).not.toContain('positionManagementCooldown')
    expect(app).toContain('AI 挂单和 AI 取消挂单由平台独立控制')
    expect(app).toContain('你的个人选择不会被平台总闸改写')
  })

  it('explains the stricter exclusive-position check for netting account exits', () => {
    expect(app).toContain('净持仓账户仍须通过同品种独占仓位与唯一归属校验')
    expect(app).not.toContain('auto_cancel')
  })

  it('uses responsive, keyboard-visible and reduced-motion styles', () => {
    expect(css).toContain('.management-detail-btn:focus-visible')
    expect(css).toContain('.management-confirmation-meter')
    expect(css).toContain('.management-confirmation-row')
    expect(css).toContain('@media (max-width: 760px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('patches only live price and profit cells while the position structure is stable', () => {
    expect(app).toContain('data-position-live="price"')
    expect(app).toContain('data-position-live="profit"')
    expect(app).toContain('function positionStructureMatches')
    expect(app).toContain('function patchPositionLiveCells')
    expect(app).toContain("renderPositionTables(positions, { liveOnly })")
    expect(app).toContain("loadPositions({ refreshSignalTickets:false, liveOnly:true })")
    expect(app).toContain("if (patched) return 'live'")
  })

  it('shows timeline timestamps in MT5 time and explains rejected preconditions', () => {
    expect(app).toContain('function positionManagementEventTime(event)')
    expect(app).toContain('positionManagementEventTime(event)')
    expect(app).toContain('`${bridgePlatformLabel()} 服务器时间`')
    expect(app).toContain('position_attribution_incomplete:"成交归属尚未完成，系统无法确认完整开仓手数"')
    expect(app).toContain('positionManagementEventSummary(event)')
    expect(css).toContain('.management-timeline time > span')
  })
})

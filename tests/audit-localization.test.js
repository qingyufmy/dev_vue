import { describe, expect, it } from 'vitest'
import {
  formatRiskReason,
  buildSafeExecutionOutcome,
  buildSafeExecutionEvent,
  localizeAuditRow,
  localizeAdminAuditEvent,
  prepareAuditRecord,
  shouldSkipHoldAudit,
} from '../server/audit-localization.js'

describe('audit localization', () => {
  it('keeps preparation, risk, broker and uncertain outcomes structurally distinct', () => {
    const preparation = buildSafeExecutionOutcome({
      status:'rejected', reason:'quote_snapshot_failed', stage:'quote_snapshot', field:'quote',
    })
    expect(preparation).toMatchObject({
      status:'failed', classification:'preparation_failure', reason:'quote_snapshot_failed',
      stage:'quote_snapshot', field:'quote',
    })
    expect(preparation.message).toContain('MT5 报价快照')

    const risk = buildSafeExecutionOutcome({
      status:'rejected', classification:'risk_rejection', reason:'R1.5_RR_TOO_LOW',
      details:{ rules:[{ code:'R1.5_RR_TOO_LOW', outcome:'reject', details:{ rr:1.03, minimum:1.2 } }] },
    })
    expect(risk).toMatchObject({ status:'rejected', classification:'risk_rejection' })
    expect(risk.message).toContain('1.03')
    expect(risk.message).toContain('1.2')

    const broker = buildSafeExecutionOutcome({
      status:'rejected', classification:'broker_rejection', reason:'Invalid price', retcode:10015,
    })
    expect(buildSafeExecutionEvent(broker, { signal_id:9500 })).toMatchObject({
      signal_id:9500, status:'rejected', classification:'broker_rejection',
      reason:'MT5 挂单价格无效', reason_code:'Invalid price', retcode:10015,
    })
  })
  it('writes action, status and known result values in Chinese', () => {
    expect(prepareAuditRecord(
      'weekly_position_closed',
      { stage: 'verification' },
      { status: 'success', reason: 'deadline_reached' },
      'success'
    )).toMatchObject({
      action: '周末系统持仓已平仓',
      status: '成功',
      request: { stage: '执行结果复核' },
      result: { status: '成功', reason: '任务已到达结束时间' },
    })
  })

  it('localizes historical code-based rows and keeps filter codes', () => {
    expect(localizeAuditRow({
      action: 'ai_auto_execute_rejected',
      status: 'rejected',
      request: {},
      result: { reason: 'volume_exceeds_config_limit' },
    })).toMatchObject({
      action: 'AI 自动执行拒绝',
      action_code: 'ai_auto_execute_rejected',
      status: '已拒绝',
      status_code: 'rejected',
      result: { reason: '手数超过配置上限' },
    })
  })

  it('only skips explicitly marked skipped_hold audits', () => {
    expect(shouldSkipHoldAudit({}, { signal_type: 'hold', status: 'skipped_hold' }, 'success')).toBe(true)
    expect(shouldSkipHoldAudit({ signal_type: 'hold' }, { status: 'rejected' }, 'rejected')).toBe(false)
    expect(shouldSkipHoldAudit({}, { signal_type: 'buy', status: 'success' }, 'success')).toBe(false)
    expect(shouldSkipHoldAudit({}, { status: 'error', reason: 'ai_failed' }, 'error')).toBe(false)
  })

  it('does not expose unknown English errors in user-facing audit payloads', () => {
    expect(prepareAuditRecord('manual_open', {}, {
      status: 'error', message: 'Bridge command timeout',
    }, 'error').result.message).toBe('系统执行异常，详细原因请查看服务器运行日志')
  })

  it('keeps known risk rejections specific instead of replacing them with a generic error', () => {
    expect(prepareAuditRecord('ai_auto_execute_rejected', {}, {
      status:'rejected', message:'R1.5_RR_TOO_LOW',
      details:{ rules:[{ code:'R1.5_RR_TOO_LOW', outcome:'reject', details:{ rr:1.03, minimum:1.2 } }] },
    }, 'warning').result.message).toBe('盈亏比低于最低要求')
  })

  it('localizes deterministic MT5 price rejections', () => {
    expect(prepareAuditRecord('ai_auto_execute_rejected', {}, {
      status:'rejected', message:'Invalid price', retcode:10015,
    }, 'rejected').result.message).toBe('MT5 挂单价格无效')
  })

  it('localizes lifecycle states that appear in historical audit payloads', () => {
    expect(prepareAuditRecord('weekly_flatten_started', {}, { status:'started' }, 'started'))
      .toMatchObject({ status:'已开始', result:{ status:'已开始' } })
    expect(prepareAuditRecord('pending_superseded', {}, { status:'superseded' }, 'success').result.status)
      .toBe('已被替换')
  })

  it('returns stable codes and a Chinese management change summary', () => {
    expect(localizeAdminAuditEvent({
      action:'admin_user_subscription_updated',
      target_type:'strategy_subscription',
      detail:JSON.stringify({ target_user_id:7, changes:{ execution_enabled:true, scope:'platform' } }),
    })).toMatchObject({
      raw_action:'admin_user_subscription_updated',
      action_code:'admin_user_subscription_updated',
      action_label:'用户策略订阅已更新',
      target_type_code:'strategy_subscription',
      target_type_label:'策略订阅',
      status_code:'info',
      target_label:'策略订阅',
      sensitive_fields_redacted:false,
      change_summary:[
        { field_code:'target_user_id', field_label:'目标用户编号', value:'7' },
        { field_code:'changes.execution_enabled', field_label:'允许执行', value:'是' },
        { field_code:'changes.scope', field_label:'范围', value:'平台' },
      ],
    })
  })

  it('marks unknown management vocabulary without hiding its stable code', () => {
    expect(localizeAdminAuditEvent({
      action:'future_admin_action', target_type:'future_target', detail:{ future_key:'future_value' },
    })).toMatchObject({
      action_code:'future_admin_action',
      action_label:'未登记的管理动作',
      target_type_code:'future_target',
      target_type_label:'未登记的管理对象',
      change_summary:[{ field_code:'future_key', field_label:'未登记字段', value:'future_value' }],
    })
  })

  it('redacts sensitive management details before they reach the browser', () => {
    const event = localizeAdminAuditEvent({
      action:'system_config_updated', target_type:'system_config',
      detail:{ api_key:'secret-value', password_reset:true },
    })
    expect(event.sensitive_fields_redacted).toBe(true)
    expect(event.detail).toBeUndefined()
    expect(event.details).toEqual([
      { field_code:'api_key', field_label:'未登记字段', value:'已隐藏' },
      { field_code:'password_reset', field_label:'重置密码', value:'是' },
    ])
  })

  it('keeps delivery recovery summaries specific and user-readable', () => {
    expect(prepareAuditRecord('ai_delivery_recovery_summary', {
      reason:'delivery_recovery_expired', count:50,
    }, {
      status:'skipped', reason:'delivery_recovery_expired', count:50,
    }, 'info')).toMatchObject({
      action:'历史信号恢复汇总',
      status:'信息',
      request:{ reason:'历史信号已超过安全恢复时限', count:50 },
      result:{ status:'已跳过', reason:'历史信号已超过安全恢复时限', count:50 },
    })
  })

  it('formats portfolio alignment outcomes with concrete counts', () => {
    expect(formatRiskReason('opposite_position_exists', { count:3 }))
      .toBe('当前账户已有反向持仓，本次不新增仓位：检测到 3 个反向持仓')
    expect(prepareAuditRecord('ai_auto_execute_skipped', { stage:'portfolio_alignment' }, {
      status:'skipped', reason:'opposite_position_exists', details:{ count:3 },
    }, 'info')).toMatchObject({
      action:'AI 自动执行跳过',
      request:{ stage:'持仓与挂单对齐' },
      result:{ status:'已跳过', reason:'当前账户已有反向持仓，本次不新增仓位', details:{ count:3 } },
    })
  })

  it('explains the full minimum-lot risk calculation in account currency', () => {
    expect(formatRiskReason('R1.9_BELOW_MINIMUM_AFTER_RISK', {
      theoretical_volume:0.00822, volume:0, minimum:0.01, step:0.01,
      rounded_volume_candidate:0.01, approved_volume:0,
      rounding_step:0.01, rounding_guard_applied:true,
      risk_cap:24.67, minimum_lot_risk:30,
    })).toBe('风险调整后手数低于最小可交易手数：理论手数 0.0082，按 0.01 手步进四舍五入候选为 0.01 手，向上舍入超过风险预算后已安全回退；最终 0 手，本次风险预算 24.67，最小 0.01 手预计止损亏损 30（均为账户货币），因此未执行')
    expect(formatRiskReason('R1_INSTRUMENT_DATA_INCONSISTENT', {
      tick_size:0.0001, tick_value:1, tick_size_source:'unavailable',
    })).toBe('交易平台返回的品种风险参数不一致：tick size 0.0001，tick value 1，来源 unavailable；已为安全起见阻止下单')
  })
})

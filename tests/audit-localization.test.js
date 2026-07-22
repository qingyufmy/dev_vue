import { describe, expect, it } from 'vitest'
import {
  formatRiskReason,
  localizeAuditRow,
  prepareAuditRecord,
  shouldSkipHoldAudit,
} from '../server/audit-localization.js'

describe('audit localization', () => {
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
})

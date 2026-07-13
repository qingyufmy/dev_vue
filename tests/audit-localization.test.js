import { describe, expect, it } from 'vitest'
import {
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

  it('skips normal hold audits but keeps inference failure audits', () => {
    expect(shouldSkipHoldAudit({}, { signal_type: 'hold', status: 'skipped_hold' }, 'success')).toBe(true)
    expect(shouldSkipHoldAudit({ signal_type: 'hold' }, { status: 'rejected' }, 'rejected')).toBe(true)
    expect(shouldSkipHoldAudit({}, { status: 'error', reason: 'ai_failed' }, 'error')).toBe(false)
  })

  it('does not expose unknown English errors in user-facing audit payloads', () => {
    expect(prepareAuditRecord('manual_open', {}, {
      status: 'error', message: 'Bridge command timeout',
    }, 'error').result.message).toBe('系统执行异常，详细原因请查看服务器运行日志')
  })
})

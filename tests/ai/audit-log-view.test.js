import { describe, expect, it } from 'vitest'
import {
  collapseRecoveryAuditRows,
  isRecoveryCleanupAudit,
} from '../../server/routes/ai/audit-log-view.js'

function legacyRecoveryRow(id, createdAtUtcMsc, overrides = {}) {
  return {
    id,
    action:'系统审计操作',
    action_code:'unknown',
    symbol:'XAUUSD',
    status:'信息',
    status_code:'info',
    created_at_utc_msc:createdAtUtcMsc,
    request:{ signal_id:1000 + id, delivery_id:2000 + id, reason:'系统执行条件未满足' },
    result:{ status:'已跳过', reason:'系统执行条件未满足' },
    ...overrides,
  }
}

describe('audit log recovery-noise view', () => {
  it('recognizes only the legacy delivery recovery shape', () => {
    expect(isRecoveryCleanupAudit(legacyRecoveryRow(1, 10_000))).toBe(true)
    expect(isRecoveryCleanupAudit({
      ...legacyRecoveryRow(2, 9_000),
      request:{ signal_id:1002, reason:'系统执行条件未满足' },
    })).toBe(false)
    expect(isRecoveryCleanupAudit({
      ...legacyRecoveryRow(3, 8_000),
      action:'AI 自动执行拒绝', action_code:'ai_auto_execute_rejected',
    })).toBe(false)
  })

  it('collapses consecutive legacy recovery rows within five minutes', () => {
    const rows = [
      legacyRecoveryRow(3, 300_000),
      legacyRecoveryRow(2, 240_000),
      legacyRecoveryRow(1, 180_000),
    ]

    const collapsed = collapseRecoveryAuditRows(rows)

    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]).toMatchObject({
      id:3,
      action:'历史信号恢复跳过',
      action_code:'ai_delivery_recovery_skipped',
      repeat_count:3,
      repeat_grouped_rows:3,
      repeat_from_utc_msc:180_000,
      repeat_to_utc_msc:300_000,
      result:{ reason:'历史信号恢复条件未满足（旧记录未保留具体原因）' },
    })
  })

  it('does not collapse normal audit rows or bridge across a normal event', () => {
    const normal = {
      id:9, action:'AI 自动执行拒绝', action_code:'ai_auto_execute_rejected',
      symbol:'XAUUSD', status:'已拒绝', status_code:'rejected', created_at_utc_msc:250_000,
      request:{ signal_id:9 }, result:{ reason:'当前品种已有持仓' },
    }
    const rows = [legacyRecoveryRow(3, 300_000), normal, legacyRecoveryRow(2, 240_000)]

    const collapsed = collapseRecoveryAuditRows(rows)

    expect(collapsed).toHaveLength(3)
    expect(collapsed[1]).toBe(normal)
    expect(collapsed[0].repeat_count).toBe(1)
    expect(collapsed[2].repeat_count).toBe(1)
  })

  it('adds the delivery counts carried by summary audit rows', () => {
    const rows = [
      {
        id:2, action:'历史信号恢复汇总', action_code:'ai_delivery_recovery_summary',
        symbol:'XAUUSD', status:'信息', status_code:'info', created_at_utc_msc:300_000,
        request:{ reason:'历史信号已超过安全恢复时限', count:7 },
        result:{ reason:'历史信号已超过安全恢复时限', count:7 },
      },
      {
        id:1, action:'历史信号恢复汇总', action_code:'ai_delivery_recovery_summary',
        symbol:'XAUUSD', status:'信息', status_code:'info', created_at_utc_msc:240_000,
        request:{ reason:'历史信号已超过安全恢复时限', count:5 },
        result:{ reason:'历史信号已超过安全恢复时限', count:5 },
      },
    ]

    expect(collapseRecoveryAuditRows(rows)).toEqual([
      expect.objectContaining({ id:2, repeat_count:12, repeat_grouped_rows:2 }),
    ])
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyModelDrivenPendingSchema } from '../../server/migrations.js'

const legacyRule = '。挂单管理：同品种同方向最多保留1笔挂单，如果market_data_json.pending_orders中已有同品种同方向挂单且价格合理则返回hold不挂新单，仅在现有挂单价格明显不合理时才用cancel_pending取消旧单挂新单'

describe('model-driven pending inventory migration', () => {
  it('replaces the persisted one-order rule and remains idempotent', () => {
    const migrated = applyModelDrivenPendingSchema({
      signal_type:`buy | sell | hold${legacyRule}`,
      reasoning:'逐笔检查挂单。',
    })

    expect(migrated.signal_type).not.toContain('最多保留1笔挂单')
    expect(migrated.signal_type).toContain('系统不按同品种或同方向的挂单数量限制新增挂单')
    expect(migrated.pending_action).toContain('保留现有挂单并新增时使用 none')
    expect(migrated.pending_action).toContain('仅保留现有挂单且不新增时返回 hold 并使用 keep')
    expect(applyModelDrivenPendingSchema(migrated)).toEqual(migrated)
  })

  it('keeps the user guide aligned with model-driven pending decisions', () => {
    const guide = readFileSync(new URL('../../public/ai/guide.html', import.meta.url), 'utf8')
    expect(guide).toContain('AI 会逐笔结合当前全部持仓与挂单决定保留或取消，新信号是否新增由独立的行情计划决定')
    expect(guide).not.toContain('决定新增、保留、取消或替换')
    expect(guide).not.toContain('自动撤销后再处理新信号')
  })

  it('uses the code contract as the only active output schema', () => {
    const llm = readFileSync(new URL('../../server/routes/ai/llm.js', import.meta.url), 'utf8')
    const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    expect(llm).not.toContain('ai_signal_schema')
    expect(llm).not.toContain('cancel_replace')
    expect(migrations).toContain("id: '172_expand_position_management_bridge_command_id'")
    expect(migrations).toContain('bridge_command_id VARCHAR(128)')
    expect(migrations).toContain("id: '173_remove_database_ai_signal_schema'")
    expect(migrations).toContain('DROP TABLE IF EXISTS ai_signal_schema')
  })
})

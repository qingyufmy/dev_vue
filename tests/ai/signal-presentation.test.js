import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { attachSignalPresentation, buildExecutionAdvice, normalizeDecisionFields, restrictSignalExperienceUsage } from '../../server/routes/ai/signal-presentation.js'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

describe('signal presentation', () => {
  it('shows platform usage only to admins and personal usage only to its owner', () => {
    const platform = { user_id:0, experience_usage:{ source:'platform', considered_ids:[3], used_ids:[3], influence:'采用平台经验' } }
    expect(restrictSignalExperienceUsage(platform, { requesterUserId:7, requesterRole:'user' }).experience_usage).toBeUndefined()
    expect(restrictSignalExperienceUsage(platform, { requesterUserId:1, requesterRole:'admin' }).experience_usage.used_ids).toEqual([3])

    const personal = { user_id:7, decision_json:JSON.stringify({ experience_usage:{ source:'personal', considered_ids:[9], used_ids:[9] } }) }
    expect(JSON.parse(restrictSignalExperienceUsage(personal, { requesterUserId:8, requesterRole:'user' }).decision_json)).not.toHaveProperty('experience_usage')
    expect(JSON.parse(restrictSignalExperienceUsage(personal, { requesterUserId:7, requesterRole:'user' }).decision_json).experience_usage.used_ids).toEqual([9])
    expect(JSON.parse(restrictSignalExperienceUsage(personal, { requesterUserId:1, requesterRole:'admin' }).decision_json)).not.toHaveProperty('experience_usage')
    expect(restrictSignalExperienceUsage({ user_id:7, experience_usage:{ considered_ids:[99] } }, { requesterUserId:7, requesterRole:'user' }).experience_usage).toBeUndefined()
  })
  it('does not present an unavailable confidence sentinel as a measured zero percent', () => {
    expect(app).toContain('if (rounded === 0) return { value: 0, label: "不可用" }')
  })
  it('normalizes model fields and limits untrusted arrays', () => {
    const result = normalizeDecisionFields({ signal_type: 'buy', decision_summary: '  顺势做多  ', bullish_score: 63, bearish_score: 37, key_reasons: ['趋势向上', '', '回踩支撑', '量能改善', '结构完整', 'ignored'] })
    expect(result.schema_version).toBe(2)
    expect(result.decision_summary).toBe('顺势做多')
    expect(result.key_reasons).toHaveLength(4)
    expect(result).toMatchObject({ bullish_score: 63, bearish_score: 37 })
  })

  it('persists only model usage ids that were actually considered', () => {
    const result = normalizeDecisionFields({ experience_usage:{ source:'platform', considered_ids:[3, 4], used_ids:[4, 99], rejected_ids:[3, 99], influence:'等待确认' } })
    expect(result.experience_usage).toEqual({ source:'platform', considered_ids:[3, 4], used_ids:[4], rejected_ids:[3], influence:'等待确认' })
  })

  it('normalizes direction inclination without presenting it as confidence', () => {
    expect(normalizeDecisionFields({ bullish_score: 2, bearish_score: 1 })).toMatchObject({ bullish_score: 66.7, bearish_score: 33.3 })
    expect(normalizeDecisionFields({ bullish_score: 'bad', bearish_score: 50 })).toMatchObject({ bullish_score: null, bearish_score: null })
  })

  it('never marks a hold signal executable', () => {
    expect(buildExecutionAdvice({ signal_type: 'hold' })).toMatchObject({ state: 'observe', executable: false })
  })

  it('presents a successful pending delivery as submitted and never executable', () => {
    const advice = buildExecutionAdvice({
      signal_type: 'sell_limit',
      entry_method: 'limit',
      pending_ticket: '663220141',
      pending_state: 'pending',
      execution_result: { status: 'success' },
    })
    expect(advice).toMatchObject({ state: 'pending', executable: false })
  })

  it('uses persisted rejection as the primary execution state', () => {
    const advice = buildExecutionAdvice({ signal_type: 'buy', execution_result: JSON.stringify({ status: 'rejected', message: '超过风险上限' }) })
    expect(advice).toMatchObject({ state: 'rejected', title: '风控未放行', executable: false })
    expect(advice.description).toContain('风险上限')
  })

  it('shows a Chinese risk reason instead of exposing an internal rule code', () => {
    const advice = buildExecutionAdvice({ signal_type: 'sell_stop', execution_result: JSON.stringify({ status: 'rejected', message: 'R1.7_PENDING_DEVIATION' }) })
    expect(advice).toMatchObject({ state: 'rejected', description: '挂单价格偏离当前报价过大' })
    expect(advice.description).not.toContain('R1.7')
  })

  it('shows the concrete rejected values instead of only a generic risk label', () => {
    const advice = buildExecutionAdvice({ signal_type:'buy', execution_result:{ status:'rejected', details:{ rules:[{
      code:'R1.9_AI_VOLUME_OUT_OF_RANGE', outcome:'reject', details:{ volume:0.3, minimum:0.01, maximum:0.05, step:0.01 },
    }] } } })
    expect(advice.description).toBe('AI 建议手数超出平台允许范围：AI 建议 0.3 手，允许范围 0.01～0.05 手，步进 0.01 手')
    expect(advice.description).not.toContain('R1.9')
  })

  it('does not expose a raw English broker error in user-facing advice', () => {
    const advice = buildExecutionAdvice({ signal_type:'sell_limit', execution_result:{ status:'failed', error:'Unknown broker transport failure' } })
    expect(advice.description).toBe('系统执行条件未满足，详细信息已记录')
  })

  it('restores a persisted rejection even when an old execution payload has no status field', () => {
    const advice = buildExecutionAdvice({
      signal_type:'sell', execution_status:'rejected',
      execution_result:{ reason:'invalid_stop_loss_direction', details:{ stop_loss:3990, entry_price:4000 } },
    })
    expect(advice).toMatchObject({ state:'rejected', executable:false })
    expect(advice.description).toBe('止损价格方向与订单方向不一致：止损 3990，入场参考价 4000')
  })

  it('hides unknown internal risk codes behind a safe Chinese fallback', () => {
    const advice = buildExecutionAdvice({ signal_type: 'buy', execution_result: { status: 'rejected', message: 'R9_UNKNOWN_PRIVATE_RULE' } })
    expect(advice.description).toBe('风控条件未满足')
  })

  it('adapts legacy rows without a decision payload', () => {
    const result = attachSignalPresentation({ id: 1, signal_type: 'sell', entry_method: 'market' })
    expect(result.decision.schema_version).toBe(2)
    expect(result.execution_advice.executable).toBe(true)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const prompt = readFileSync(new URL('../../docs/行情分析Agent-v1.7.6-完整提示词.md', import.meta.url), 'utf8')

describe('行情分析 Agent v1.7.6 prompt contract', () => {
  it('keeps the original multi-timeframe workflow and restores six M15 candidates', () => {
    expect(prompt).toContain('1H趋势主判')
    expect(prompt).toContain('4H降级备判')
    expect(prompt).toContain('M15-1 缠论背驰')
    expect(prompt).toContain('M15-2 谐波PRZ触达')
    expect(prompt).toContain('M15-3 第一、第二或第三类买卖点')
    expect(prompt).toContain('M15-4 关键裸K')
    expect(prompt).toContain('M15-5 假突破')
    expect(prompt).toContain('M15-6 支撑阻力K线反应')
    expect(prompt).toContain('M15独立通过数量 >= 2')
    expect(prompt).toContain('分母固定为六项')
    expect(prompt).not.toContain('至少2个相互独立的证据组')
    expect(prompt).not.toContain('独立确认数量：[X / 3]')
  })

  it('adds a separate confirmed trend-continuation path without weakening path A', () => {
    expect(prompt).toContain('M15有两条互斥的合格路径')
    expect(prompt).toContain('路径A——六项结构确认')
    expect(prompt).toContain('路径B——顺势延续确认')
    expect(prompt).toContain('首次突破与二次确认必须是两根不同的M15 K线')
    expect(prompt).toContain('summary.support_resistance.two_closed_bar_breakout')
    expect(prompt).toContain('对象缺失或未准备完成时路径B不可用')
    expect(prompt).toContain('不得改用本轮动态R1/S1或自行重算关键位')
    expect(prompt).toContain('M15总路径判定：路径A满足至少2/6，或路径B全部通过')
    expect(prompt).toContain('AND（M15路径A六项中至少两个独立通过 OR M15路径B全部通过）')
    expect(prompt).toContain('不能计入M15-1、M15-3、M5系统Chan触发或顺势延续路径')
    expect(prompt).not.toContain('M15六项中至少两个独立通过\nAND M5')
  })

  it('uses system Chan as the only authority and does not provide a model-side Chan fallback', () => {
    expect(prompt).toContain('系统Chan是唯一缠论权威')
    expect(prompt).toContain('不得根据原始K线重新计算、补算、修正或覆盖分型、笔、线段、中枢、背驰和买卖点')
    expect(prompt).toContain('divergence_usable')
    expect(prompt).toContain('entry_structure_usable')
    expect(prompt).toContain('current_segment` 表示最新已确认线段，不等于当前价格正在运行的摆动')
    expect(prompt).toContain('candidate_segment.confirmed=false')
    expect(prompt).toContain('entry_structure_usable=true` 但 `entry_candidates=[]` 时，M15-3是“未通过”而不是“不可用”')
    expect(prompt).toContain('divergence_usable=true` 但 `divergence.confirmed!=true` 时，M15-1是“未通过”而不是“不可用”')
    expect(prompt).not.toMatch(/顶分型[：:]\s*\n\s*-/)
    expect(prompt).not.toContain('成笔条件')
    expect(prompt).not.toContain('线段至少由3笔构成')
    expect(prompt).not.toContain('连续三笔存在有效价格重叠')
    expect(prompt).not.toContain('MACD面积法')
  })

  it('does not duplicate objective indicator formulas already supplied by the system', () => {
    expect(prompt).toContain('strategy_context.indicators.entry_ema34')
    expect(prompt).not.toContain('strategy_context.indicators.ema34')
    expect(prompt).toContain('reason=indicator_source_stale')
    expect(prompt).toContain('summary.atr_14_closed')
    expect(prompt).not.toMatch(/EMA\d*\s*\(t\)\s*=/i)
    expect(prompt).not.toMatch(/TR\s*\(t\)\s*=/i)
    expect(prompt).not.toMatch(/DIF\s*\(t\)\s*=/i)
    expect(prompt).not.toMatch(/DEA\s*\(t\)\s*=/i)
    expect(prompt).not.toMatch(/Pivot\s*=/i)
    expect(prompt).not.toContain('系统提供客观数据时不要复算')
  })

  it('keeps PRZ optional, preserves M5 and EMA gates, and enforces net reward-to-risk', () => {
    expect(prompt).toContain('PRZ不是必要条件')
    expect(prompt).toContain('M5至少一项已收盘触发')
    expect(prompt).toContain('M1 EMA34证据可用且方向通过')
    expect(prompt).toContain('推荐执行档位净风险收益至少1:1.5')
    expect(prompt).toContain('不建仓`、`试探仓`、`轻仓`、`标准仓')
    expect(prompt).not.toMatch(/\b0\.0[1-9]\s*手/)
  })

  it('does not let lifecycle labels or momentum warnings veto a confirmed H1 trend', () => {
    expect(prompt).toContain('current_segment.broken=true')
    expect(prompt).toContain('不表示趋势已经被破坏')
    expect(prompt).toContain('反向未确认候选')
    expect(prompt).toContain('不能单独否定')
    expect(prompt).toContain('超买/超卖')
    expect(prompt).toContain('不同周期最后已收盘时间不同也不等于数据陈旧')
    expect(prompt).toContain('H1硬仲裁')
    expect(prompt).toContain('不得再以该候选、`broken=true`、MACD、RSI或4H为理由')
  })

  it('requires the auditable reasoning prefix and evidence-level deduplication', () => {
    for (const marker of [
      'H1=[通过/不明确/不可用]',
      'M15-1背驰=[通过/未通过/不可用/未检查]',
      'M15-2PRZ=[通过/未通过/不可用/未检查]',
      'M15-3买卖点=[通过/未通过/不可用/未检查]',
      'M15-4裸K=[通过/未通过/不可用/未检查]',
      'M15-5假突破=[通过/未通过/不可用/未检查]',
      'M15-6关键位反应=[通过/未通过/不可用/未检查]',
      'M15路径A独立通过数=[0-6]',
      'M15路径B=[通过/未通过/不可用/未检查]',
      'M15采用路径=[路径A/路径B/无]',
    ]) expect(prompt).toContain(marker)
    expect(prompt).toContain('同一底层证据不得换名称重复计票')
  })

  it('maps the objective two-bar completion boolean without model discretion', () => {
    expect(prompt).toContain('先执行布尔直映射，不允许主观解释')
    expect(prompt).toContain('`up.complete` 不是严格布尔值 `true`，路径B必须为“未通过”')
    expect(prompt).toContain('`down.complete` 不是严格布尔值 `true`，路径B必须为“未通过”')
  })

  it('maps pullback prices to legal limit orders instead of stop-limit orders', () => {
    expect(prompt).toContain('计划做多且入场价低于当前Ask时只能使用 `buy_limit/limit`')
    expect(prompt).toContain('计划做空且入场价高于当前Bid时只能使用 `sell_limit/limit`')
    expect(prompt).toContain('把低于现价的回踩买入称为“突破限价”不能改变订单类型')
  })

  it('requires a final field-consistency self-check without turning it into platform-wide risk policy', () => {
    expect(prompt).toContain('新入场硬门槛=[通过/未通过]')
    expect(prompt).toContain('`hard_gate_status=pass`、`hard_gate_failures=[]`')
    expect(prompt).toContain('`minimum_reward_to_risk` 固定填写 `1.5`')
    expect(prompt).toContain('`recommended_reward_to_risk` 必须对应 `recommended_take_profit_tier`')
    expect(prompt).toContain('不得在reasoning中写“应当观望”却仍返回买卖信号')
    expect(prompt).toContain('不得把本策略的1.5门槛解释为平台其他策略的统一风控规则')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const prompt = readFileSync(new URL('../../docs/行情分析Agent-v1.7.7-完整提示词.md', import.meta.url), 'utf8')

describe('行情分析 Agent v1.7.7 prompt contract', () => {
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
    expect(prompt).toContain('recent_confirmed.up/down')
    expect(prompt).toContain('`age_closed_bars` 为0至3的整数')
    expect(prompt).toContain('近期事件超过3根M15已收盘K线')
    expect(prompt).toContain('近期M5突破事件必须仍有效且年龄不超过3根M5已收盘K线')
    expect(prompt).toContain('M5近期突破事件只延续M5触发生命周期，不能替代M15门槛')
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

  it('uses supplied objective H1 fields when Chan direction evidence is unavailable', () => {
    expect(prompt).toContain('H1系统Chan `segment_direction_usable=false`')
    expect(prompt).toContain('`last_closed_bar.close > sma_20`')
    expect(prompt).toContain('`momentum_3_pct > 0`')
    expect(prompt).toContain('`momentum_10_pct > 0`')
    expect(prompt).toContain('`macd.trend=bullish`')
    expect(prompt).toContain('不得根据K线重新计算均线、动量或MACD')
    expect(prompt).toContain('单个阻力/支撑只影响入场空间和净风险收益')
    expect(prompt).toContain('必须在趋势依据中原样引用本轮H1 summary的实际')
    expect(prompt).toContain('禁止引用其他周期数值、EMA数值或自行推导值冒充H1字段')
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
    expect(prompt).toContain('最终做多时 `up.complete=true`，最终做空时 `down.complete=true`')
    expect(prompt).toContain('两种证据均不满足时路径B必须为“未通过”')
    expect(prompt).toContain('不得跨方向选取事件')
  })

  it('maps pullback prices to legal limit orders instead of stop-limit orders', () => {
    expect(prompt).toContain('计划做多且入场价低于当前Ask时只能使用 `buy_limit/limit`')
    expect(prompt).toContain('计划做空且入场价高于当前Bid时只能使用 `sell_limit/limit`')
    expect(prompt).toContain('把低于现价的回踩买入称为“突破限价”不能改变订单类型')
  })

  it('uses path-specific stop evidence and audits a pullback order before holding', () => {
    expect(prompt).toContain('路径A止损波动校验读取M15')
    expect(prompt).toContain('路径B采用M5触发入场时读取M5')
    expect(prompt).toContain('不允许自行调换优先级')
    expect(prompt).toContain('`first_bar.low` 与 `second_bar.low` 较低者一侧')
    expect(prompt).toContain('`first_bar.high` 与 `second_bar.high` 较高者一侧')
    expect(prompt).toContain('不得把同一对象用于描述区间下边界的远端 `reference_low` 当作第一保护价锚点')
    expect(prompt).toContain('市价追入的净风险收益不合格时，必须继续检查一次合法的系统回踩位挂单')
    expect(prompt).toContain('不得只写“市价风险收益不足”就直接观望')
    expect(prompt).toContain('回踩方案必须执行方向单调性自检')
    expect(prompt).toContain('做多候选入场价降低只会缩小风险并扩大目标空间')
    expect(prompt).toContain('做空候选入场价升高同样只会缩小风险并扩大目标空间')
    expect(prompt).toContain('最终归约必须按以下顺序执行')
    expect(prompt).toContain('不得把“回踩方案未通过M1方向过滤”列为失败原因')
    expect(prompt).toContain('不能保留已被通过证据排除的失败项')
    expect(prompt).toContain('禁止把未采用路径的状态写入 `hard_gate_failures`')
    expect(prompt).toContain('先从 `hard_gate_failures` 删除所有“路径A不足2/6')
    expect(prompt).toContain('“没有更远的历史阻力或支撑”本身不是强制观望理由')
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

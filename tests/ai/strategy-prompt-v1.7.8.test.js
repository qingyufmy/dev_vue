import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const prompt = readFileSync(new URL('../../docs/行情分析Agent-v1.7.8-完整提示词.md', import.meta.url), 'utf8')

describe('行情分析 Agent v1.7.8 prompt contract', () => {
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
    expect(prompt).toContain('M15常规路径判定：路径A满足至少2/6，或路径B全部通过')
    expect(prompt).toContain('AND（（M15路径A六项中至少两个独立通过 OR M15路径B全部通过）AND M5至少一项已收盘触发')
    expect(prompt).toContain('不能计入M15-1、M15-3、M5系统Chan触发或顺势延续路径')
    expect(prompt).not.toContain('M15六项中至少两个独立通过\nAND M5')
  })

  it('uses system Chan as the only authority and does not provide a model-side Chan fallback', () => {
    expect(prompt).toContain('系统Chan是唯一缠论权威')
    expect(prompt).toContain('不得根据原始K线重新计算、补算、修正或覆盖分型、笔、线段、中枢、背驰和买卖点')
    expect(prompt).toContain('divergence_usable')
    expect(prompt).toContain('entry_structure_usable')
    expect(prompt).toContain('local_structure_usable')
    expect(prompt).toContain('`latest_structure` 是系统对本轮最后已收盘行情的当前结构摘要')
    expect(prompt).toContain('`background_bias` 只表示已经退役的旧线段、旧中枢或旧突破背景')
    expect(prompt).toContain('不得从原始K线重建')
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
    expect(prompt).toContain('entry_ema34.source.timeframe')
    expect(prompt).toContain('`raw_policy.prompt_rules`')
    expect(prompt).toContain('该文字视为过期说明')
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

  it('checks EMA34 only after a prior path has established one candidate direction', () => {
    expect(prompt).toContain('只有前序流程已经通过“路径A或路径B＋M5触发”，或路径C完整通过')
    expect(prompt).toContain('候选方向必须为“无”、比较结果必须为“无法比较”、过滤结论必须为“未检查”')
    expect(prompt).toContain('不得提前使用EMA34选择方向')
    expect(prompt).toContain('不得把“未检查”写成“未通过”')
    expect(prompt).toContain('不得将其列入 `hard_gate_failures`')
    expect(prompt.match(/过滤结论：\[通过 \/ 未通过 \/ 不可用 \/ 未检查\]/g)).toHaveLength(2)
    expect(prompt).not.toContain('过滤结论：[通过 / 未通过 / 不可用]')
  })

  it('keeps unchecked downstream gates out of hard gate failures', () => {
    expect(prompt).toContain('`hard_gate_failures` 只列出已经实际检查并阻断流程的最早门槛')
    expect(prompt).toContain('任何状态为“未检查”的下游步骤都不得写入 `hard_gate_failures`')
    expect(prompt).toContain('H1/H4不明确时，M15、常规M5和M1均为未检查且不得列为失败')
    expect(prompt).toContain('M15路径未通过时，尚未进入的常规M5和M1不得列为失败')
    expect(prompt).toContain('失败清单只保留本轮实际检查过的最早阻断事实')
  })

  it('uses the current system trend state instead of forcing direction from an old confirmed segment', () => {
    expect(prompt).toContain('current_segment.broken=true')
    expect(prompt).toContain('不表示趋势已经被破坏')
    expect(prompt).toContain('反向未确认候选')
    expect(prompt).toContain('summary.chan.trend_state')
    expect(prompt).toContain('current_segment` 仅是历史确认结构')
    expect(prompt).toContain('trend_state.direction=neutral')
    expect(prompt).toContain('不得把旧线段端点距离作为趋势硬仲裁条件')
    expect(prompt).toContain('`local_bias` 是当前机会方向')
    expect(prompt).toContain('旧趋势不得覆盖它')
    expect(prompt).toContain('超买/超卖')
    expect(prompt).toContain('不同周期最后已收盘时间不同也不等于数据陈旧')
    expect(prompt).not.toContain('H1硬仲裁：')
    expect(prompt).not.toContain('不得再以该候选、`broken=true`、MACD、RSI或4H为理由')
  })

  it('lets a system-confirmed latest reversal watch enter path A or complete path C only', () => {
    expect(prompt).toContain('`latest_structure.local_state=reversal_watch`')
    expect(prompt).toContain('`local_structure_usable=true`')
    expect(prompt).toContain('`local_bias` 唯一为 `up` 或 `down`')
    expect(prompt).toContain('同一 `local_bias` 也可作为1H反转观察方向送入M15路径A继续确认')
    expect(prompt).toContain('不得直接下单')
    expect(prompt).toContain('不得直接下单或使用路径B')
    expect(prompt).toContain('不能使用路径B或直接下单')
    expect(prompt).toContain('M15路径A至少2/6、M5已收盘触发、M1 EMA34、止损、净风险收益和通用执行门槛')
    expect(prompt).toContain('采用路径C时必须满足路径C的全部生命周期、M1 EMA34、保护价、净风险收益和通用执行门槛')
    expect(prompt).toContain('路径C交易方向固定等于该 `local_bias`')
    expect(prompt).toContain('原始 `candidate_segment`、`developing_bi` 不能作为路径C入口或方向依据')
    expect(prompt).toContain('H1系统最新 `reversal_watch` 且 `local_structure_usable=true`、`local_bias` 唯一为 `up/down` 且采用路径A或路径C')
    expect(prompt).toContain('对路径C的H1反转观察入口只执行客观布尔直映射')
    expect(prompt).toContain('H1入口判定为“通过”')
    expect(prompt).toContain('路径C交易方向固定等于该 `local_bias`')
    expect(prompt).toContain('不得再因 `trend_state.direction`、`background_direction`、`background_bias`、`confirmed_direction`、`developing_bi` 未确认、H4旧背景或“M15未共振”否决这个H1入口')
    expect(prompt).toContain('回到该 `local_bias` 方向')
    expect(prompt).not.toContain('reversal_watch只能路径A')
    expect(prompt).not.toContain('reversal_watch时不能使用路径C')
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
      '采用路径=[路径A/路径B/路径C/无]',
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
    expect(prompt).toContain('市价信号的实际成交价由平台执行前的新鲜Bid/Ask确定')
    expect(prompt).toContain('模型输出 `market` 时必须保持 `limit_price=null`、`stop_limit_price=null`')
    expect(prompt).toContain('输入没有Bid/Ask时，只禁止生成需要本轮报价校验的 `limit`、`stop`、`stop_limit` 挂单')
    expect(prompt).toContain('不得因此否决已通过路径、止损和净风险收益的 `market` 信号')
    expect(prompt).toContain('平台校验失败时再阻止执行，不能把该执行前校验缺失改写为策略路径失败')
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

  it('adds a bounded H1-aligned failed-breakout reclaim path without weakening normal M15 paths', () => {
    for (const marker of [
      '路径C：H1同向或H1反转观察方向同向的M5反向突破回收',
      '路径C短线回收观察',
      '路径C不是一般逆势反转',
      '路径C必须先满足以下两类H1入口之一',
      '明确H1趋势入口',
      'H1反转观察入口',
      '路径C交易方向必须与H1趋势完全一致',
      '路径C交易方向必须与该 `local_bias` 完全一致',
      '原始 `developing_bi`、`candidate_segment`、旧线段方向或模型推导方向均不可用',
      '路径C本身不是直接订单信号',
      '只读取M5 `summary.support_resistance.two_closed_bar_breakout.recent_confirmed`',
      '`reclaim.bars_after_confirmation` 必须是1至3的整数',
      '第一根收回K线只能生成候选，不能入场',
      '`reclaim.reclaim_close_beyond_breakout_bars` 必须严格为 `true`',
      '`reclaim.confirmed=true`',
      '`reclaim.confirmation_close_beyond_reclaim_extreme=true`',
      '不得由模型自行重算这两个布尔值',
      '`reclaim.age_closed_bars` 必须按H1入口分别判断',
      '明确H1趋势入口仍必须是1至3的整数',
      'H1 `reversal_watch` 入口必须严格为1，表示独立确认完成后的唯一首次候选周期',
      '年龄为2或3时该入口已过期，不得交易',
      '`reclaim.still_valid=true`',
      'M15不得存在仍有效、年龄不超过3根M15已收盘K线',
      '同一个反向突破事件只能生成一次路径C交易候选',
      '路径C已经包含M5反向突破、收回和独立确认的完整触发生命周期',
      '路径C只读取M5 `reclaim.sweep_extreme`',
      '路径C随后仍必须通过M1 EMA34方向过滤、保护价、净风险收益、订单合法性、重复订单和平台风险控制',
      '路径C必须按以下唯一顺序归约，不允许跨周期、跨方向或定性改写系统布尔值',
      '做多只选 `recent_confirmed.down`，做空只选 `recent_confirmed.up`',
      '不得读取H1或M15同名事件冒充M5事件',
      '所有必需布尔值、方向、年龄和有效性均通过时，M5回收生命周期必须判为“通过”',
      '做多只检查M15 `down.complete` 与 `recent_confirmed.down`',
      '做空只检查M15 `up.complete` 与 `recent_confirmed.up`',
      '必须在 `reasoning` 引用实际失败字段的完整周期、方向、字段路径和值',
      '当前 `recent_confirmed` 或 `reclaim` 对象存在本身不等于以前已经生成过候选',
      '只有输入中存在显式 `prior event usage`、已交付信号或同事件订单记录时，才可判定该事件已被使用',
      '缺少这些显式记录时不得臆测重复',
      'OR 路径C全部通过',
    ]) expect(prompt).toContain(marker)
    expect(prompt).toContain('路径A满足至少2/6，或路径B全部通过')
    expect(prompt).toContain('路径A少于两个独立通过时，采用路径A的本轮不得新入场')
    expect(prompt).toContain('路径C只能按其完整客观生命周期独立通过，不能给路径A/B补票')
    expect(prompt).not.toContain('路径C第一根收回K线可以直接入场')
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

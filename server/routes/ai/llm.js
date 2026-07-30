// ai/llm.js — AI 推理 + 信号标准化

import { queryOne } from '../../db.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { DEFAULT_PROMPT, stripTimeframeTags, round2, parseJsonObject, aiFailureHold } from './utils.js'
import { DEFAULT_MAX_POSITION_SIZE } from './config.js'
import { beginModelUsage, finishModelUsage } from './model-profiles.js'
import { KIMI_CODE_CLIENT_IDENTITY, MODEL_PROVIDER_DEFAULTS, isKimiCodeRequest, modelProviderProtocol } from './model-providers.js'
import { assertSafeModelEndpoint } from './model-endpoint-security.js'
import { buildSharedMarketSnapshot, sha256 } from './inference-snapshots.js'
import { normalizeEntryMethods, signalTypesForEntryMethods } from './strategy-policy.js'
import { normalizePositionSizeTier, positionSizeFactor, resolvePositionSizeTier } from './position-sizing.js'
import { buildPositionManagementOutputFormat, hasActivePositionManagementGroups,
  validatePositionManagementResponse } from './position-management.js'
import { assertModelQuotaAvailable, buildModelQuotaCircuitContext, deferModelQuotaProbe,
  recordModelQuotaExhausted, recordModelQuotaRecovered } from './model-quota-circuit.js'

const DEBUG_LLM_PAYLOAD = process.env.DEBUG_LLM_PAYLOAD === '1'
const DEBUG_LLM = process.env.DEBUG_LLM === '1' || DEBUG_LLM_PAYLOAD
const TP_FROM_SL = { tp1: 1.5, tp2: 2.5, tp3: 4.0 }
export const AUTO_INFERENCE_MAX_OUTPUT_TOKENS = 12_000
export const AUTO_INFERENCE_MAX_PROMPT_CHARS = 120_000
export const INFERENCE_KLINE_FIELDS = Object.freeze(['time', 'open', 'high', 'low', 'close', 'tick_volume'])
const COMPACT_MARKET_INPUT_RULE = `## 市场数据紧凑编码
strategy_context.input_encoding 说明模型输入的无损编码。各周期 klines 中每个数组元素依次对应 kline_fields 的 time、open、high、low、close、tick_volume，数组元素数量就是 K 线根数。对象 {"$ref":"#/..."} 是 JSON Pointer，表示与所指对象完全相同；分析时必须按原对象展开理解，不得视为数据缺失。`

export function automaticInferenceMaxTokens(config = {}) {
  const requested = Math.max(1_000, Number.parseInt(config.max_tokens || 2_000) || 2_000)
  return String(config._usage || '').startsWith('auto')
    ? Math.min(requested, AUTO_INFERENCE_MAX_OUTPUT_TOKENS)
    : requested
}

function jsonPointerToken(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1')
}

function dedupeChanObjects(value, path, seen, state) {
  if (Array.isArray(value)) {
    return value.map((item, index) => dedupeChanObjects(item, `${path}/${index}`, seen, state))
  }
  if (!value || typeof value !== 'object') return value
  const signature = JSON.stringify(value)
  if (signature.length >= 120 && seen.has(signature)) {
    state.references++
    return { $ref:seen.get(signature) }
  }
  if (signature.length >= 120) seen.set(signature, path)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    dedupeChanObjects(item, `${path}/${jsonPointerToken(key)}`, seen, state),
  ]))
}

/**
 * Losslessly compact only the model-bound copy of market data. Stored market
 * snapshots and chart K-lines retain their normal object representation.
 */
export function compactInferenceMarketPayload(payload) {
  const compacted = structuredClone(payload || {})
  const timeframes = compacted?.strategy_context?.timeframes
  if (!timeframes || typeof timeframes !== 'object') return compacted
  const state = { klineFrames:0, references:0 }
  const knownFields = new Set(INFERENCE_KLINE_FIELDS)
  for (const [timeframe, frame] of Object.entries(timeframes)) {
    const bars = frame?.klines
    if (Array.isArray(bars) && bars.length && bars.every(bar => {
      if (!bar || Array.isArray(bar) || typeof bar !== 'object') return false
      return Object.keys(bar).every(key => knownFields.has(key))
    })) {
      frame.klines = bars.map(bar => INFERENCE_KLINE_FIELDS.map(field => bar[field] ?? null))
      state.klineFrames++
    }
    if (frame?.summary?.chan && typeof frame.summary.chan === 'object') {
      const path = `#/strategy_context/timeframes/${jsonPointerToken(timeframe)}/summary/chan`
      frame.summary.chan = dedupeChanObjects(frame.summary.chan, path, new Map(), state)
    }
  }
  if (state.klineFrames || state.references) {
    compacted.strategy_context.input_encoding = {
      version:'compact-v1',
      ...(state.klineFrames ? { kline_fields:[...INFERENCE_KLINE_FIELDS] } : {}),
      ...(state.references ? { object_refs:'JSON Pointer; exact duplicate object' } : {}),
    }
  }
  return compacted
}

export function formatPendingValidUntilUtc(validMinutes, nowMs = Date.now()) {
  const minutes = Math.min(Math.max(parseInt(validMinutes) || 240, 1), 1440)
  return new Date(nowMs + minutes * 60000).toISOString().replace('T', ' ').substring(0, 19)
}
const PENDING_LIFECYCLE_RULE = `
## 挂单生命周期硬性规则
挂单有效期、过期识别和到期取消由 MT5 与后端协调器负责。禁止比较任何时间字符串来判断挂单是否过期；禁止在 analysis 或 reasoning 中声称某挂单“已过期”“超时失效”“已自动取消”；禁止仅以时间、有效期或过期为理由输出 cancel_pending。cancel_pending 只能用于价格条件已明显失效、市场结构已破坏或方向逻辑已反转等非时间原因。是否存在挂单只能依据 pending_orders 当前数组；数组中不存在时只能表述“当前输入未包含该挂单”，不得推断其已过期或已取消。`

const CHAN_DIVERGENCE_RULE = `
## 缠论背驰使用规则
必须区分“结构拓扑可靠”和“绝对时间定位精度”：当 chan.structure_topology_reliable=true 且 segment_count、center_count 为正时，已经输出的确认线段与中枢拓扑可用于结构分析；不得仅因 time_location_reliable=false、mt4_historical_offset_unverified 或 MT4 历史时区为近似值，就声称“缺乏确认线段或中枢”“线段结构不可靠”。这些 MT4 时钟字段只表示历史 K 线的绝对 UTC 时间可能存在偏差，不否定同一数据源内按时间顺序计算出的线段、中枢和背驰结构。只有 structure_topology_reliable=false 或对应计数确实为零时，才能说相关结构尚未可靠形成。
当前服务端输出的是线段级中枢：只有连续三条已确认线段的完整价格区间存在正宽度重叠，并且同一组三线段形成核心在所有可观察历史窗口中获得严格多数，才构成跨窗口确认中枢；候选线段、单笔重叠和未确认结构不得称为中枢。chan.bi_center_count 与 chan.latest_bi_center 仅是只读的笔级低层结构证据，不能替代线段级中枢参与自动执行。center_cross_window_unstable 表示窗口之间没有对同一中枢形成核心达成多数；center_entry_unconfirmed 表示中枢本身已确认，但进入段未进入跨窗口公共结构，此时只禁用依赖进入段的背驰与买卖点，不得误写成“没有中枢”。structure_anchor_bootstrap_pending 表示系统正在以最长完整历史和连续三根已收盘K线确认中枢相位，不等于市场没有结构，也不得把尚未稳定的进入段用于背驰或买卖点。chan.divergence 仅表示最新确认线段的背驰判断；只有 type 为 top 或 bottom、state 为 confirmed 且 confirmed=true 时，才能称为“已确认背驰段”。divergence_evidence_unavailable 表示可比较的有效力度证据不足，不等于“确认无背驰”；chan.forming_divergence 仅表示候选线段背驰，不得当作已确认反转或单独作为执行依据。chan.recent_divergences 是当前稳定历史结构内最近的已确认背驰段，entry_segment 与 departure_segment 给出进入段、离开段的 UTC 时间、经纪商时间和价格。area_ratio 与 peak_ratio 越小表示力度衰减越明显。chan.trend_state 区分趋势、盘整、突破候选、确认突破和衰竭；upward_breakout_pending/downward_breakout_pending 只表示价格已经离开尚未闭合的旧中枢，方向仍未由新确认线段证实，不得描述为已确认突破；衰竭也只表示反转风险上升。chan.entry_candidates 中的一二三类买卖点均为候选证据，只有 usable_for_entry=true 才可参与入场论证，也不得单独构成执行指令。strategy_context.chan_timeframe_alignment 用于检查大小周期方向是否一致；agreement=mixed、alignment_with_higher=conflict、status=partial 时必须降低结论强度或选择观望。必须先检查 strategy_context.context_status、missing_timeframes，以及 chan.status、reliability、window_stable、time_location_reliable 和 warnings；segment_history_unresolved 表示已识别笔，但不同历史窗口的线段边界尚未收敛，应说明“正在使用更长历史确认”，不能笼统写成“市场没有结构”；出现 confirmed_structure_stale 表示最近确认结构距当前行情过远，不得把旧中枢描述为当前盘整区。结构或时间定位不可靠时应降低该证据权重。所有缠论结果都是行情证据，不等同于交易已经确认，也不直接构成交易指令。
`

const USER_VISIBLE_CHINESE_RULE = `
## 用户可见语言规则
所有用户可见文本必须使用简体中文，包括一句话结论、触发条件、失效条件、关键依据、风险因素、行情分析、分析依据、经验影响和取消原因。禁止输出内部错误码、英文状态值或整句英文。品种代码、周期、价格以及 AI、MT5、MACD、RSI、ATR、KDJ、EMA、SMA 等通用技术缩写可以保留。
不得写 agreement=insufficient、reliability=low、unreliable_segments、segment_history_unresolved、partial 等内部字段或枚举，也不得用“系统内部状态”代替解释。必须直接说明用户能理解的中文含义，例如：agreement=insufficient 写成“多周期方向证据不足”；unreliable_segments 写成“线段结构尚不可靠”；segment_history_unresolved 写成“历史窗口尚未收敛，正在使用更长历史确认线段”；reliability=low 写成“结构可靠性较低”。当某周期结构不可用时，应说明原因和影响，例如“H1 尚未形成可靠的确认线段，当前方向证据不足”或“H4 结构可靠性较低，暂不能作为多头依据”。`

const INFERENCE_NARRATIVE_REPLACEMENTS = [
  [/\bstructure_topology_reliable\s*=\s*true\b/gi, '线段与中枢结构拓扑已确认'],
  [/\bstructure_topology_reliable\s*=\s*false\b/gi, '线段与中枢结构拓扑尚未确认'],
  [/\bwindow_stable\s*=\s*false\b/gi, '结构窗口不稳定'],
  [/\btime_location_reliable\s*=\s*false\b/gi, '结构时间定位不可靠'],
  [/\balignment_with_higher\s*=\s*conflict\b/gi, '与高周期方向冲突'],
  [/\bcontext_status\s*=\s*partial\b/gi, '多周期行情证据不完整'],
  [/\bstatus\s*=\s*segment_history_unresolved\b/gi, '历史窗口尚未收敛，暂不确认线段'],
  [/\bstatus\s*=\s*unreliable_segments\b/gi, '线段结构尚不可靠'],
  [/\bagreement\s*=\s*aligned_up\b/gi, '多周期方向一致偏多'],
  [/\bagreement\s*=\s*aligned_down\b/gi, '多周期方向一致偏空'],
  [/\bagreement\s*=\s*mixed\b/gi, '多周期方向存在分歧'],
  [/\bagreement\s*=\s*insufficient\b/gi, '多周期方向证据不足'],
  [/\breliability\s*=\s*low\b/gi, '结构可靠性较低'],
  [/\breliability\s*=\s*(?:medium|normal)\b/gi, '结构可靠性一般'],
  [/\breliability\s*=\s*high\b/gi, '结构可靠性较高'],
  [/\bunreliable_segments\b/gi, '线段结构尚不可靠'],
  [/\bsegment_history_unresolved\b/gi, '历史窗口尚未收敛，暂不确认线段'],
  [/\bsegment_cross_window_unstable\b/gi, '不同历史窗口的线段边界尚未收敛'],
  [/\bcenter_cross_window_unstable\b/gi, '不同历史窗口对中枢形成核心尚未达成共识'],
  [/\bcenter_entry_unconfirmed\b/gi, '中枢已确认，但进入段缺少跨窗口共识，仅背驰暂不可判'],
  [/\bstructure_anchor_bootstrap_pending\b/gi, '结构锚点正在用连续三根已收盘K线确认，暂不使用依赖进入段的背驰与买卖点'],
  [/\bmt4_historical_offset_unverified\b/gi, 'MT4 历史K线的绝对UTC时间为近似定位，不影响同源结构顺序'],
  [/\bdivergence_evidence_unavailable\b/gi, '背驰所需的有效力度证据不足'],
  [/\bdivergence_cross_window_unstable\b/gi, '不同历史窗口的背驰证据尚未收敛'],
  [/\bforming_evidence_unavailable\b/gi, '候选背驰所需的有效证据不足'],
  [/\bforming_cross_window_unstable\b/gi, '不同历史窗口的候选背驰证据尚未收敛'],
  [/\bno_cross_window_center\b/gi, '尚无跨窗口确认的中枢'],
  [/\binsufficient_confirmed_bis\b/gi, '已确认笔数量不足'],
  [/\binsufficient_bis\b/gi, '确认笔数量不足'],
  [/\binsufficient_klines\b/gi, 'K线数据不足'],
  [/\bsegments_not_confirmed\b/gi, '线段尚未确认'],
  [/\bno_valid_center\b/gi, '尚未形成有效中枢'],
  [/\bupward_breakout_pending\b/gi, '向上突破仍待结构确认'],
  [/\bdownward_breakout_pending\b/gi, '向下突破仍待结构确认'],
  [/\baligned_up\b/gi, '方向一致偏多'],
  [/\baligned_down\b/gi, '方向一致偏空'],
  [/\bmixed\b/gi, '方向存在分歧'],
  [/\bpartial\b/gi, '结构证据不完整'],
  [/\binsufficient\b/gi, '证据不足'],
  [/\bsystem internal status\b/gi, '当前结构尚未确认'],
]

export function localizeInferenceNarrative(value) {
  let text = typeof value === 'string' ? value.trim() : ''
  for (const [pattern, replacement] of INFERENCE_NARRATIVE_REPLACEMENTS) text = text.replace(pattern, replacement)
  return text.replace(/\b((?:M|H|D)\d+|\d+H)\s*缠论趋势?为[“"]线段结构尚不可靠[”"]/gi, '$1 尚未形成可靠的确认线段')
    .replace(/\b((?:M|H|D)\d+|\d+H)\s*缠论为[“"]线段结构尚不可靠[”"]/gi, '$1 尚未形成可靠的确认线段')
    .replace(/可靠性低/g, '结构可靠性较低')
    .replace(/\bagreement\s*=\s*[a-z_]+\b/gi, '多周期方向状态尚未确认')
    .replace(/\breliability\s*=\s*[a-z_]+\b/gi, '结构可靠性尚未确认')
    .replace(/\b(?:status|trend_state|context_status|alignment_with_higher|window_stable|time_location_reliable)\s*=\s*[a-z_]+\b/gi, '相关结构状态尚未确认')
}

function localizeAiSignalUserVisibleFields(signal) {
  for (const key of ['decision_summary', 'trigger_condition', 'invalidation_condition', 'position_size_reason', 'pending_action_reason', 'analysis', 'reasoning']) {
    if (typeof signal?.[key] === 'string') signal[key] = localizeInferenceNarrative(signal[key])
  }
  for (const key of ['key_reasons', 'risk_factors']) {
    if (Array.isArray(signal?.[key])) signal[key] = signal[key].map(localizeInferenceNarrative).filter(Boolean)
  }
  if (signal?.experience_usage && typeof signal.experience_usage === 'object' && typeof signal.experience_usage.influence === 'string') {
    signal.experience_usage.influence = localizeInferenceNarrative(signal.experience_usage.influence)
  }
  if (Array.isArray(signal?.cancel_pending)) {
    signal.cancel_pending = signal.cancel_pending.map(item => item && typeof item === 'object'
      ? { ...item, reason:localizeInferenceNarrative(item.reason) }
      : item)
  }
  const management = signal?._position_management
  if (management && typeof management === 'object') {
    for (const key of ['pending_evaluations', 'position_evaluations']) {
      if (!Array.isArray(management[key])) continue
      management[key] = management[key].map(item => item && typeof item === 'object'
        ? { ...item, reason:localizeInferenceNarrative(item.reason) }
        : item)
    }
  }
  return signal
}

let _schemaCache = null
let _schemaCacheTs = 0
const SCHEMA_CACHE_TTL = 300_000 // 5 minutes

const DEFAULT_OUTPUT_FORMAT = JSON.stringify({
  signal_type: "buy | sell | hold | buy_limit | sell_limit | buy_stop | sell_stop | buy_stop_limit | sell_stop_limit。禁止其他值。buy/sell=市价立即执行; buy_limit/sell_limit=挂限价单; buy_stop/sell_stop=突破追单; buy_stop_limit/sell_stop_limit=突破后限价。方向优势不清晰、关键位距离过近、短线波动过大、已有持仓风险不合适时必须返回hold。挂单管理：同品种同方向最多保留1笔挂单，如果market_data_json.pending_orders中已有同品种同方向挂单且价格合理则返回hold不挂新单，仅在现有挂单价格明显不合理时才用cancel_pending取消旧单挂新单",
  entry_method: "必须字段。仅允许 market | limit | stop | stop_limit | observe，并且必须与signal_type一致：buy/sell=market，*_limit=limit，*_stop=stop，*_stop_limit=stop_limit，hold=observe",
  confidence: "0.00-1.00，动态估算，禁止固定值。按趋势强度、位置结构、波动噪音、风险状态综合评估。BUY/SELL弱优势0.52-0.62，中等0.63-0.74，强共振>0.75。HOLD时0.55-0.68，明确回避风险可>0.70。hold时也不得为0",
  bullish_score: "0-100，市场偏多倾向分。必须与bearish_score合计为100；表示当前行情方向倾向，不代表胜率或执行概率",
  bearish_score: "0-100，市场偏空倾向分。必须与bullish_score合计为100；表示当前行情方向倾向，不代表胜率或执行概率",
  position_size_tier: "必须字段。hold 返回 observe；交易信号仅允许 probe | light | standard，分别表示试探仓、轻仓、标准仓。不得返回具体手数或自定义系数",
  position_size_reason: "必须字段。使用简体中文说明为什么选择该仓位档位，不得猜测用户账户余额或手数",
  position_action: "必须字段。仅允许 open | hold_no_add | allow_add | observe。参考组合已有同向持仓且不建议加仓时必须返回 hold_no_add，同时 signal_type 必须为 hold、entry_method 必须为 observe；候选入场价只能写入分析正文或触发条件，不得伪装成可执行信号。只有明确延续信号才可 allow_add；不得建议自动平仓",
  pending_action: "必须字段。仅允许 none | keep | cancel | cancel_replace。参考组合无挂单时返回 none；旧挂单仍符合当前逻辑时返回 keep，禁止无条件替换",
  pending_action_reason: "中文说明挂单处理依据。pending_action 为 cancel 或 cancel_replace 时必须具体说明原挂单在哪个价格、市场结构或方向依据上已经失效，不得只写‘逻辑失效’，不得使用过期或超时作为原因；其他动作可返回空字符串",
  management_direction: "必须字段。仅允许 buy | sell | none。需要取消或替换挂单时填写被管理挂单方向；其他情况填 none",
  limit_price: "挂单价。buy_limit/sell_limit:入场价,订单直接挂在此价; buy_stop/sell_stop:触发价,价格到达后以市价成交; buy_stop_limit/sell_stop_limit:触发价,到达后按stop_limit_price挂限价单。方向：限价买单须低于当前价,限价卖单须高于当前价;突破单相反,买单触发价须高于当前价,卖单触发价须低于当前价。距离参考：M15一般0.5-2 ATR,H1一般1-3 ATR",
  stop_limit_price: "Stop Limit 触发后挂出的限价，仅buy_stop_limit/sell_stop_limit时必填。limit_price始终是突破触发价：buy_stop_limit 的触发价高于当前价，stop_limit_price不得高于触发价；sell_stop_limit 的触发价低于当前价，stop_limit_price不得低于触发价",
  pending_valid_minutes: "挂单有效期(分钟)，1-1440，默认240",
  stop_loss_price: "数字，buy/sell/挂单必须给出，hold可为null。买单止损须低于入场价，卖单止损须高于入场价。最小距离由风险等级决定：low=2倍ATR(14), medium=1.5倍, high=1倍，过近会被系统自动修正。止损位必须参考M15 K线的关键支撑/阻力位（support_resistance.s1/s2/r1/r2），设在M15级别关键位外侧，给足波动空间",
  take_profit_1_price: "止盈-保守(第一目标位)，数字，buy/sell/挂单必须给出，hold可为null。买单止盈须高于入场价，卖单止盈须低于入场价。建议设在最近的支撑/阻力位，R:R至少1:1",
  take_profit_2_price: "止盈-标准(第二目标位)，数字，buy/sell/挂单必须给出，hold可为null。距离应大于tp1，R:R建议1:1.5-1:2",
  take_profit_3_price: "止盈-激进(第三目标位)，数字，可选。距离应大于tp2，R:R建议1:2-1:3。仅在趋势明确且有延续依据时提供",
  recommended_take_profit_tier: "必须字段。非hold仅允许1、2、3，表示AI综合行情后建议实际执行的止盈目标档位，并且对应目标价格必须存在；hold返回null。reasoning中必须说明选择该档位的行情依据",
  cancel_pending: "必须字段（条件触发）。挂单有效期、过期识别和到期取消由MT5与后端负责，禁止比较时间字符串判断过期，禁止以过期、超时或有效期为理由取消挂单。仅当价格条件明显失效、市场结构破坏或方向逻辑反转时，才输出取消条件；否则返回空数组[]。每个元素：symbol(必填), pending_type(可选), max_price(可选), min_price(可选), cancel_all(可选bool), reason(必填且必须是非时间原因)",
  decision_summary: "必填，中文，一句话给出用户最关心的结论；不超过80字。观望时明确说明为什么暂不执行",
  trigger_condition: "中文，说明该建议成立或挂单触发需要满足的市场条件；没有额外条件时返回空字符串",
  invalidation_condition: "中文，说明什么市场变化会使当前建议失效；hold时可说明重新评估条件",
  key_reasons: ["2至4条关键行情依据，每条不超过60字，不包含账户、持仓或风控结论"],
  risk_factors: ["0至4条市场层面的不利因素，每条不超过60字，不包含账户或仓位信息"],
  analysis: "中文，按以下顺序：1.当前趋势方向和强度 2.关键支撑/阻力位 3.当前价与均线关系 4.波动率状态 5.潜在催化剂或风险事件",
  reasoning: "中文，按以下结构：1.信号方向依据（哪些指标/形态支持） 2.入场方式选择理由（为什么用市价/限价/挂单） 3.风险评估（潜在不利因素） 4.执行建议（为什么可以执行或为什么观望） 5.挂单管理：检查现有挂单状态，是否需要取消、是否已有同方向挂单"
}, null, 2)

export function buildStrategyOutputFormat(baseFormat, allowedEntryMethods, experienceSelection = null) {
  const methods = normalizeEntryMethods(allowedEntryMethods)
  let schema
  try { schema = JSON.parse(baseFormat || DEFAULT_OUTPUT_FORMAT) } catch { schema = JSON.parse(DEFAULT_OUTPUT_FORMAT) }
  if (!schema || Array.isArray(schema) || typeof schema !== 'object') schema = JSON.parse(DEFAULT_OUTPUT_FORMAT)
  const signalTypes = signalTypesForEntryMethods(methods)
  const labels = { market: '市价', limit: '限价挂单', stop: '突破挂单', stop_limit: '突破限价挂单' }
  schema.signal_type = `仅允许 ${signalTypes.join(' | ')}。hold 表示观望；本策略支持的入场方式：${methods.map(item => labels[item]).join('、')}。禁止输出未列出的信号类型。`
  schema.entry_method = `必须字段。仅允许 observe | ${methods.join(' | ')}；hold 必须对应 observe，其他信号必须与 signal_type 一致。`
  delete schema.recommended_volume
  schema.position_size_tier = '必须字段。hold 返回 observe；交易信号仅允许 probe | light | standard，分别表示试探仓、轻仓和标准仓。不得返回具体手数或自定义系数。'
  schema.position_size_reason = '必须字段。使用简体中文说明仓位档位的行情依据；不得猜测用户账户余额或手数。'
  schema.position_action = '必须字段。仅允许 open | hold_no_add | allow_add | observe。平台参考组合已有同向持仓且不建议加仓时必须返回 hold_no_add，同时 signal_type 必须为 hold、entry_method 必须为 observe；候选入场价只能写入分析正文或触发条件，不得伪装成可执行信号。只有明确延续信号才可 allow_add；暂不支持自动平仓。'
  schema.pending_action = '必须字段。仅允许 none | keep | cancel | cancel_replace。旧挂单仍符合当前行情逻辑时必须 keep，只有逻辑失效或方向反转时才能 cancel 或 cancel_replace。'
  schema.pending_action_reason = '中文字符串。pending_action 为 cancel 或 cancel_replace 时必须说明可核验的具体依据，例如关键位被突破、原结构被破坏、方向逻辑反转或挂单价格已不符合当前结构；必须包含对应的价格、结构或方向变化，不得只写“逻辑失效”，不得以过期、超时或有效期为理由。其他动作返回空字符串。'
  schema.management_direction = '必须字段。仅允许 buy | sell | none。pending_action 为 cancel 或 cancel_replace 时填写被管理挂单方向；其他情况填 none。'
  const experienceIds = [...new Set((experienceSelection?.selectedItemIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  const experienceRefs = [...new Set((experienceSelection?.selectedRefs || experienceIds.map(id => `item:${id}`))
    .map(value => String(value || '').trim()).filter(Boolean))]
  schema.experience_usage = experienceRefs.length
    ? { considered_refs:experienceRefs, used_refs:`只能填写实际采用的记忆引用，且必须来自 ${experienceRefs.join('、')}`,
      rejected_refs:'已评估但不适用于当前行情的记忆引用', considered_ids:experienceIds,
      used_ids:`兼容字段；平台记忆填写实际采用的编号，且只能来自 ${experienceIds.join('、') || '空集合'}`,
      rejected_ids:'兼容字段；平台记忆未采用的编号', influence:'中文说明记忆对方向、入场方式或观望结论的具体影响；used_refs 为空时不得声称采用了任何记忆' }
    : { considered_refs:[], used_refs:[], rejected_refs:[], considered_ids:[], used_ids:[], rejected_ids:[], influence:'本次没有提供记忆，必须返回空字符串' }
  const hasPending = methods.some(item => item !== 'market')
  if (!hasPending) {
    delete schema.limit_price
    delete schema.stop_limit_price
    delete schema.pending_valid_minutes
    delete schema.cancel_pending
  } else if (!methods.includes('stop_limit')) {
    delete schema.stop_limit_price
  }
  schema.reasoning = `中文，说明信号方向依据、为何从本策略允许的入场方式（${methods.map(item => labels[item]).join('、')}）中选择当前方式、风险评估与执行建议。${hasPending ? '如涉及挂单，再说明挂单管理。' : '本策略不支持挂单，不得提出挂单或取消挂单。'}`
  return { outputFormat: JSON.stringify(schema, null, 2), hasPending }
}

function usesNativeJsonMode(provider, protocol) {
  return (provider === 'deepseek' && protocol !== 'responses')
    || (provider === 'volcengine_agent_plan' && protocol === 'responses')
}

function buildLlmRequestBody({ protocol, provider, model, temperature, maxTokens, messages, thinkingEnabled, reasoningEffort }) {
  if (protocol === 'responses') {
    const instructions = messages
      .filter(message => message.role === 'system')
      .map(message => String(message.content || ''))
      .filter(Boolean)
      .join('\n\n')
    const input = messages
      .filter(message => message.role !== 'system')
      .map(message => ({ role: message.role, content: String(message.content || '') }))
    const body = { model, input, max_output_tokens: maxTokens }
    if (instructions) body.instructions = instructions
    // Ark Agent Plan follows the Responses API structured-output contract.
    // Keep this provider-scoped: other Responses-compatible gateways may
    // reject the field instead of silently ignoring it.
    if (provider === 'volcengine_agent_plan') {
      body.text = { format:{ type:'json_object' } }
    }
    if (thinkingEnabled) {
      body.reasoning = { effort: reasoningEffort === 'max' ? 'high' : (reasoningEffort || 'high') }
    } else {
      body.temperature = temperature
    }
    return body
  }

  const body = { model, messages }
  // DeepSeek's JSON Output contract guarantees syntactically valid JSON when
  // the prompt also explicitly requests JSON (our inference prompt does).
  if (provider === 'deepseek') {
    body.response_format = { type:'json_object' }
  }
  // Thinking providers have different wire contracts. Kimi Code accepts
  // enabled or disabled inside the thinking object.
  if (thinkingEnabled) {
    body.thinking = provider === 'kimi_code'
      ? (model === 'k3' ? { type: 'enabled', effort: 'max' } : { type: 'enabled' })
      : { type: 'enabled' }
    if (provider === 'kimi_code') body.max_tokens = maxTokens
    else body.reasoning_effort = reasoningEffort || 'max'
  } else if (provider === 'kimi_code') {
    body.thinking = { type: 'disabled' }
    body.max_tokens = maxTokens
  } else {
    body.temperature = temperature
    body.max_tokens = maxTokens
  }
  return body
}

function extractLlmContent(data, protocol, expectJson = false) {
  if (protocol === 'responses') {
    if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text
    const chunks = []
    for (const item of data?.output || []) {
      for (const part of item?.content || []) {
        if ((part?.type === 'output_text' || typeof part?.text === 'string') && part.text) chunks.push(part.text)
      }
    }
    return chunks.join('\n')
  }

  const msg = data?.choices?.[0]?.message
  return msg?.content || (expectJson ? '' : msg?.reasoning_content) || ''
}

function extractTokenCount(data) {
  const usage = data?.usage || data?.response?.usage || {}
  const total = usage.total_tokens ?? usage.totalTokens
  if (Number.isFinite(Number(total))) return Math.max(0, Math.trunc(Number(total)))
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0
  return Math.max(0, Math.trunc(Number(input) + Number(output)))
}

function providerHttpError(url, provider, status) {
  if (!isKimiCodeRequest(url, provider)) return `LLM HTTP ${status}`
  if (status === 401 || status === 404) return 'kimi_code_subscription_or_model_permission_denied'
  if (status === 429) return 'kimi_code_rate_limited'
  if (status === 403) return 'kimi_code_request_rejected'
  if (status === 400) return 'kimi_code_request_invalid'
  if (status >= 500) return 'kimi_code_service_unavailable'
  return `kimi_code_http_${status}`
}

async function emitProviderTelemetry(callback, payload) {
  if (typeof callback !== 'function') return
  try { await callback(payload) } catch (error) {
    console.error('[LLM] Provider telemetry callback failed:', error.message)
  }
}

function formatByteSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KiB`
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`
}

function logAutomaticModelRequest({ usageContext, phase, body, requestBytes }) {
  const usage = String(usageContext?.usage || '')
  if (usage !== 'auto_platform' && usage !== 'auto_private') return

  const userId = Number(usageContext?.userId || 0) || '-'
  const strategyId = Number(usageContext?.strategyId || 0) || '-'
  const model = String(body?.model || 'unknown').replace(/\s+/g, '_')
  const messageCount = Array.isArray(body?.messages) ? body.messages.length : 0
  console.log(
    `[AI Auto] Model request usage=${usage} phase=${phase || 'request'} user=${userId} `
    + `strategy=${strategyId} model=${model} messages=${messageCount} `
    + `request_bytes=${requestBytes} request_size=${formatByteSize(requestBytes)}`,
  )
}

async function trackedModelRequest({
  url, apiKey, body, timeout, usageContext, estimatedTokens, phase, provider, signal,
  onProviderRequest, onProviderUsage,
}) {
  let usageLogId = null
  let providerRequestStarted = false
  const startedAt = Date.now()
  const requestBody = JSON.stringify(body)
  const requestBytes = Buffer.byteLength(requestBody, 'utf8')
  let responseBytes = 0
  const quotaCircuitContext = buildModelQuotaCircuitContext({
    usageContext, provider, model:body?.model, url,
  })
  let quotaCircuitState = { probe:false }
  try {
    quotaCircuitState = await assertModelQuotaAvailable(quotaCircuitContext)
    if (usageContext) {
      const reservation = await beginModelUsage({ ...usageContext, estimatedTokens })
      usageLogId = reservation.logId
    }
    await assertSafeModelEndpoint(url)
    const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    if (isKimiCodeRequest(url, provider)) headers['User-Agent'] = KIMI_CODE_CLIENT_IDENTITY
    const timeoutSignal = AbortSignal.timeout(timeout)
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal
    signal?.throwIfAborted()
    await emitProviderTelemetry(onProviderRequest, { phase })
    providerRequestStarted = true
    logAutomaticModelRequest({ usageContext, phase, body, requestBytes })
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: requestSignal,
      redirect: 'error',
    })
    if (!response.ok) {
      const code = providerHttpError(url, provider, response.status)
      const stableCode = response.status === 429 ? 'model_quota_exhausted' : code
      const error = new Error(phase === 'repair' && !stableCode.startsWith('kimi_code_')
        ? stableCode.replace(/^LLM/, 'LLM repair')
        : stableCode)
      error.providerStatus = response.status
      error.code = stableCode
      error.providerCode = code
      throw error
    }
    const data = await response.json()
    responseBytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
    const reportedTokens = extractTokenCount(data)
    const fallbackTokens = Math.ceil((JSON.stringify(body).length + JSON.stringify(data).length) / 4)
    const tokenCount = reportedTokens || fallbackTokens
    if (usageLogId) {
      try {
        await finishModelUsage(usageLogId, { tokenCount, status: 'success', requestBytes, responseBytes, durationMs: Date.now() - startedAt })
      } catch (logError) {
        // The reservation remains at its conservative estimate. Do not repeat a
        // provider call merely because post-call accounting could not finalize.
        console.error('[LLM] Failed to finalize successful usage log:', logError.message)
      }
      usageLogId = null
    }
    await emitProviderTelemetry(onProviderUsage, { phase, status: 'success', tokenCount, requestBytes, responseBytes, durationMs: Date.now() - startedAt })
    if (quotaCircuitState.probe) await recordModelQuotaRecovered(quotaCircuitContext)
    return { response, data }
  } catch (error) {
    if (usageLogId) {
      try {
        await finishModelUsage(usageLogId, { tokenCount: 0, status: 'error', errorCode: error.message,
          requestBytes, responseBytes, durationMs: Date.now() - startedAt })
      } catch (logError) {
        console.error('[LLM] Failed to finalize usage log:', logError.message)
      }
    }
    if (providerRequestStarted) {
      await emitProviderTelemetry(onProviderUsage, {
        phase, status: 'error', tokenCount: 0, errorCode: error.message,
        requestBytes, responseBytes, durationMs: Date.now() - startedAt,
      })
    }
    try {
      if (Number(error?.providerStatus) === 429) {
        await recordModelQuotaExhausted(quotaCircuitContext, error.providerCode || error.code || error.message)
      } else if (quotaCircuitState.probe) {
        await deferModelQuotaProbe(quotaCircuitContext)
      }
    } catch (circuitError) {
      console.error('[LLM] Failed to update model quota circuit:', circuitError.message)
    }
    throw error
  }
}

async function emitModelProgress(onProgress, stage) {
  if (typeof onProgress !== 'function') return
  try { await onProgress(stage) } catch (error) { console.error('[LLM] Progress callback failed:', error.message) }
}

export async function requestJsonObject({
  url, apiKey, provider, model, temperature, maxTokens, messages, thinkingEnabled,
  reasoningEffort, protocol = 'chat_completions', timeout = 120000, usageContext = null,
  onProgress = null, validateObject = null, signal = null,
  onProviderRequest = null, onProviderUsage = null,
}) {
  if (apiKey && /[^ -~]/.test(apiKey)) {
    throw new Error('API key contains non-ASCII characters, please check your configuration')
  }
  signal?.throwIfAborted()
  const body = buildLlmRequestBody({ protocol, provider, model, temperature, maxTokens, messages, thinkingEnabled, reasoningEffort })
  const estimatedTokens = Math.ceil(JSON.stringify(messages).length / 4) + Math.max(0, Number(maxTokens) || 0)
  await emitModelProgress(onProgress, 'model_request')
  const { response, data } = await trackedModelRequest({
    url, apiKey, body, timeout, usageContext, estimatedTokens, phase: 'request', provider, signal,
    onProviderRequest, onProviderUsage,
  })
  const nativeJsonMode = usesNativeJsonMode(provider, protocol)
  let content = extractLlmContent(data, protocol, nativeJsonMode)
  if (!content && nativeJsonMode) {
    signal?.throwIfAborted()
    await emitModelProgress(onProgress, 'repairing')
    const emptyRetryMessages = [
      ...messages,
      { role:'user', content:'上一次响应正文为空。请重新完成原任务，只返回一个完整、合法的 JSON 对象，不要 Markdown 或解释。' },
    ]
    const emptyRetryBody = buildLlmRequestBody({
      protocol, provider, model, temperature:0, maxTokens, messages:emptyRetryMessages,
      thinkingEnabled, reasoningEffort,
    })
    const emptyRetryEstimate = Math.ceil(JSON.stringify(emptyRetryMessages).length / 4) + Math.max(0, Number(maxTokens) || 0)
    const { data: emptyRetryData } = await trackedModelRequest({
      url, apiKey, body:emptyRetryBody, timeout, usageContext, estimatedTokens:emptyRetryEstimate,
      phase:'repair', provider, signal, onProviderRequest, onProviderUsage,
    })
    content = extractLlmContent(emptyRetryData, protocol, true)
  }
  if (!content) throw new Error(`LLM response content is empty, protocol=${protocol}, status=${response.status}, body=${JSON.stringify(data).substring(0, 300)}`)
  await emitModelProgress(onProgress, 'validating')
  try {
    const parsed = parseJsonObject(content)
    return typeof validateObject === 'function' ? validateObject(parsed) : parsed
  } catch (exc) {
    signal?.throwIfAborted()
    await emitModelProgress(onProgress, 'repairing')
    const repairMessages = [
      ...messages,
      { role: 'assistant', content: content.substring(0, 6000) },
      { role: 'user', content: `上一次输出未通过系统校验，错误代码为：${exc.message}。请严格按照最初要求的字段名、数据类型、枚举值和完整覆盖范围修正。必须补齐所有必填字段，只返回修正后的一个 JSON 对象，不要 Markdown，不要解释，不要增加外层包装字段。` },
    ]
    const repairBody = buildLlmRequestBody({
      protocol, provider, model, temperature: 0, maxTokens, messages: repairMessages,
      thinkingEnabled, reasoningEffort,
    })
    const repairEstimate = Math.ceil(JSON.stringify(repairMessages).length / 4) + Math.max(0, Number(maxTokens) || 0)
    const { data: repairedData } = await trackedModelRequest({
      url, apiKey, body: repairBody, timeout, usageContext, estimatedTokens: repairEstimate,
      phase: 'repair', provider, signal, onProviderRequest, onProviderUsage,
    })
    const repaired = extractLlmContent(repairedData, protocol, nativeJsonMode)
    if (!repaired) throw new Error('LLM repair response content is empty')
    await emitModelProgress(onProgress, 'validating')
    const repairedObject = parseJsonObject(repaired)
    return typeof validateObject === 'function' ? validateObject(repairedObject) : repairedObject
  }
}

function adaptLegacyPositionSizing(value) {
  if (!value || typeof value !== 'object') return value
  const signalType = String(value.signal_type || 'hold').toLowerCase()
  const isHold = signalType === 'hold'
  if (!value.position_size_tier) value.position_size_tier = isHold ? 'observe' : 'light'
  if (!String(value.position_size_reason || '').trim()) {
    value.position_size_reason = isHold
      ? '当前不满足建仓条件'
      : '旧版结果未提供仓位档位，系统按中性档位交由风控精算'
  }
  if (!value.position_action) value.position_action = isHold ? 'observe' : 'open'
  if (!value.pending_action) value.pending_action = 'none'
  if (value.pending_action_reason === undefined) value.pending_action_reason = ''
  if (!value.management_direction) value.management_direction = 'none'
  return value
}

export function validateAiSignalResponse(value, allowedEntryMethods) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('ai_response_not_object')
  adaptLegacyPositionSizing(value)
  const required = ['signal_type', 'entry_method', 'confidence', 'position_size_tier', 'position_size_reason', 'position_action', 'pending_action', 'management_direction', 'analysis', 'reasoning']
  const missing = required.filter(key => !(key in value))
  if (missing.length) throw new Error(`ai_response_missing_required_fields:${missing.join(',')}`)

  const methods = normalizeEntryMethods(allowedEntryMethods)
  const allowedSignals = new Set(signalTypesForEntryMethods(methods))
  const signalType = String(value.signal_type || '').trim().toLowerCase()
  const entryMethod = String(value.entry_method || '').trim().toLowerCase()
  if (!allowedSignals.has(signalType)) throw new Error(`ai_response_invalid_signal_type:${signalType || 'empty'}`)
  const expectedMethod = signalType === 'hold' ? 'observe'
    : signalType === 'buy' || signalType === 'sell' ? 'market'
      : signalType.endsWith('_stop_limit') ? 'stop_limit'
        : signalType.endsWith('_limit') ? 'limit' : 'stop'
  if (entryMethod !== expectedMethod) throw new Error(`ai_response_entry_method_mismatch:${entryMethod || 'empty'}:${expectedMethod}`)
  if (entryMethod !== 'observe' && !methods.includes(entryMethod)) throw new Error(`ai_response_entry_method_not_allowed:${entryMethod}`)

  const confidence = Number(value.confidence)
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) throw new Error('ai_response_invalid_confidence')
  const positionTier = normalizePositionSizeTier(value.position_size_tier, signalType)
  if (!positionTier) throw new Error('ai_response_invalid_position_size_tier')
  if (signalType === 'hold' && String(value.position_size_tier).toLowerCase() !== 'observe') throw new Error('ai_response_hold_position_tier_must_be_observe')
  if (typeof value.position_size_reason !== 'string' || !value.position_size_reason.trim()) throw new Error('ai_response_position_size_reason_required')
  const positionAction = String(value.position_action || '').toLowerCase()
  const pendingAction = String(value.pending_action || '').toLowerCase()
  if (!['open', 'hold_no_add', 'allow_add', 'observe'].includes(positionAction)) throw new Error('ai_response_invalid_position_action')
  if (signalType === 'hold' && !['observe', 'hold_no_add'].includes(positionAction)) throw new Error('ai_response_hold_position_action_invalid')
  if (signalType !== 'hold' && !['open', 'hold_no_add', 'allow_add'].includes(positionAction)) throw new Error('ai_response_trade_position_action_invalid')
  if (!['none', 'keep', 'cancel', 'cancel_replace'].includes(pendingAction)) throw new Error('ai_response_invalid_pending_action')
  if (signalType === 'hold' && pendingAction === 'cancel_replace') throw new Error('ai_response_hold_cancel_replace_invalid')
  const managementDirection = String(value.management_direction || '').toLowerCase()
  if (!['buy', 'sell', 'none'].includes(managementDirection)) throw new Error('ai_response_invalid_management_direction')
  if (['cancel', 'cancel_replace'].includes(pendingAction) && managementDirection === 'none') {
    throw new Error('ai_response_management_direction_required')
  }
  if (['cancel', 'cancel_replace'].includes(pendingAction) && (typeof value.pending_action_reason !== 'string' || !value.pending_action_reason.trim())) {
    const legacyReason = Array.isArray(value.cancel_pending)
      ? value.cancel_pending.find(item => item && typeof item === 'object' && String(item.reason || '').trim())?.reason
      : ''
    if (legacyReason) value.pending_action_reason = legacyReason
    else throw new Error('ai_response_pending_action_reason_required')
  }
  if (typeof value.analysis !== 'string' || !value.analysis.trim()) throw new Error('ai_response_analysis_required')
  if (typeof value.reasoning !== 'string' || !value.reasoning.trim()) throw new Error('ai_response_reasoning_required')
  return value
}

export async function maybeAiSignal(db, config, market, promptOverride) {
  if (!config || !config.api_key_encrypted) return aiFailureHold(market, 'missing_ai_configuration_or_key')
  const apiKey = config.api_key_encrypted
  const provider = config.api_provider || 'deepseek'
  const baseUrl = config.api_base_url
  if (!apiKey) return aiFailureHold(market, 'empty_ai_key')

  const compatibleProviders = new Set(Object.keys(MODEL_PROVIDER_DEFAULTS))
  if (!compatibleProviders.has(provider)) return aiFailureHold(market, `unsupported_ai_provider:${provider}`)
  const normalizedBaseUrl = String(baseUrl || MODEL_PROVIDER_DEFAULTS[provider]).replace(/\/+$/, '')
  const protocol = modelProviderProtocol(provider)
  const url = `${normalizedBaseUrl}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`

  try {
    const effectivePrompt = typeof promptOverride === 'string' ? promptOverride : (config.system_prompt || DEFAULT_PROMPT)
    const prompt = stripTimeframeTags(effectivePrompt)

    // Load output schema from DB (cached 5 min)
    let outputFormat = ''
    let schemaSource = 'default'
    try {
      if (_schemaCache && Date.now() - _schemaCacheTs < SCHEMA_CACHE_TTL) {
        outputFormat = _schemaCache; schemaSource = 'cache'
      } else {
        const schema = await queryOne('SELECT schema_json FROM ai_signal_schema WHERE is_active = 1 LIMIT 1')
        if (schema?.schema_json) { outputFormat = schema.schema_json; schemaSource = 'database'; _schemaCache = outputFormat; _schemaCacheTs = Date.now() }
      }
    } catch (e) { console.warn('[LLM] Failed to load output schema from DB, using default:', e.message) }
    if (!outputFormat) outputFormat = DEFAULT_OUTPUT_FORMAT
    const strategySchema = buildStrategyOutputFormat(outputFormat, config._allowed_entry_methods, config._experienceSelection)
    outputFormat = strategySchema.outputFormat
    const positionManagementContext = config._positionManagementContext
    const positionManagementEnabled = hasActivePositionManagementGroups(positionManagementContext)
    if (positionManagementEnabled) {
      outputFormat = buildPositionManagementOutputFormat(outputFormat, positionManagementContext)
    }
    if (DEBUG_LLM) console.log(`[LLM] Output schema loaded: ${schemaSource} (${outputFormat.length} chars)`)

    const marketOnlyRule = config._market_only
      ? '\n\n## 共享市场推理边界\n你只能分析输入中的市场行情、K线、技术指标和 platform_strategy_reference_portfolio。该参考组合仅表示本平台策略已经产生的持仓与挂单，不代表任何订阅用户的真实账户。禁止推测订阅用户的账户、余额、权益、持仓、挂单或个人风控信息。你只能选择不建仓、试探仓、轻仓或标准仓，不得返回绝对手数；用户实际手数由独立风控根据净值、真实止损亏损和 MT5 合约规格计算。参考组合已有同向持仓时，除非行情形成明确的延续加仓机会，否则 position_action 必须为 hold_no_add；即使允许加仓，系统也会限制为试探仓。参考挂单仍符合当前逻辑时必须 keep，只有原逻辑失效时才能 cancel，方向反转且新挂单成立时才能 cancel_replace。'
      : ''
    const privatePortfolioRule = !config._market_only && config._include_portfolio_context
      ? '\n\n## 私有策略账户上下文\n输入中的 positions 与 pending_orders 是当前用户账户的实时数据。请结合它们判断 position_action 与 pending_action，但不得把余额或现有手数直接复制成新订单手数；新订单仍只返回固定仓位档位，实际手数由风控精算。'
      : ''
    // Personal memory is untrusted data, never a higher-priority instruction.
    // Shared platform inference is market-only and is structurally barred from it.
    const personalMemory = !config._market_only && typeof config._memoryContext === 'string'
      ? config._memoryContext : ''
    // Platform experience is a separately reviewed market/strategy corpus. It
    // may be used by shared market-only inference but can never carry account
    // state or override the system/output/risk boundaries above.
    const platformExperience = config._market_only && typeof config._platformExperienceContext === 'string'
      ? config._platformExperienceContext : ''
    const pendingRule = strategySchema.hasPending ? `\n\n${PENDING_LIFECYCLE_RULE}` : ''
    const positionManagementRule = positionManagementEnabled ? `

## 持仓管理 v1.1 强制边界
输入中的 position_management_context 由服务端生成。你必须完整返回其中每一个挂单管理组和持仓管理组，且只能原样引用给出的 management_group_id、thesis_id、condition_id 和 evidence_refs。挂单动作只允许 keep 或 cancel；持仓动作只允许 hold 或 exit。禁止输出 replace、reverse、ticket、手数或任何账户身份。不得修改冻结条件、失效价格、条件类型、周期和确认次数。reversal_candidate 只表示解释性判断，不是执行命令。新建仓、挂单评估、持仓评估彼此独立；新建仓字段无效时也必须继续完成其他评估。` : ''
    const fullPrompt = prompt + marketOnlyRule + privatePortfolioRule + positionManagementRule + platformExperience + personalMemory + `\n\n${USER_VISIBLE_CHINESE_RULE}` + '\n\n## 输出格式\n你必须返回以下 JSON 结构：\n' + outputFormat + (positionManagementEnabled ? '' : pendingRule)

    // Check if prompt wants Chan theory data
    const useChan = config._use_chan_analysis === undefined
      ? /\{\{USE_CHAN\}\}/.test(effectivePrompt)
      : Boolean(config._use_chan_analysis)
    const promptWithChanRules = useChan ? `${fullPrompt}\n\n${CHAN_DIVERGENCE_RULE}` : fullPrompt
    const replaySystemPrompt = typeof config._comparison_replay_system_prompt === 'string'
      ? config._comparison_replay_system_prompt.trim()
      : ''
    let cleanPrompt = replaySystemPrompt || promptWithChanRules.replace(/\{\{USE_CHAN\}\}/g, '').replace(/\n{3,}/g, '\n\n').trim()
    if (DEBUG_LLM) console.log(`[LLM] Chan analysis: ${useChan ? 'enabled' : 'disabled'}`)

    let aiPayload = config._market_only ? buildSharedMarketSnapshot(market, {
      standardSymbol:market.standard_symbol || market.symbol,
      marketSource:market.market_source,
    }) : {
      symbol: market.symbol, timeframe: market.timeframe, timestamp: market.timestamp,
      latest_price: market.latest_price, price_change: market.price_change,
      price_change_pct: market.price_change_pct, account: market.account,
      positions: market.positions, pending_orders: market.pending_orders || [],
      kline_count: market.kline_count,
      atr_anchor: market.atr_anchor,
      atr_anchor_tf: market.atr_anchor_tf,
    }
    if (market.strategy_context) {
      const ctx = { ...market.strategy_context }
      // Full Chan history is retained only for the auditable chart snapshot;
      // the model still receives the strategy-configured visible K-line window.
      delete ctx.visualization_klines
      // Strip Chan data when the strategy capability is disabled.
      if (!useChan && ctx.timeframes) {
        let stripped = 0
        for (const tf of Object.keys(ctx.timeframes)) {
          if (ctx.timeframes[tf]?.summary?.chan) {
            const s = { ...ctx.timeframes[tf].summary }
            delete s.chan
            ctx.timeframes[tf] = { ...ctx.timeframes[tf], summary: s }
            stripped++
          }
        }
        if (stripped > 0) console.log(`[LLM] Stripped Chan data from ${stripped} timeframe(s) (strategy disabled)`)
      }
      aiPayload.strategy_context = ctx
    }
    if (positionManagementEnabled) {
      aiPayload.position_management_context = {
        contract_version:positionManagementContext.contract_version,
        as_of:positionManagementContext.as_of,
        pending_groups:positionManagementContext.pending_groups,
        position_groups:positionManagementContext.position_groups,
      }
    }
    if (!config._comparison_replay_user_prompt) {
      aiPayload = compactInferenceMarketPayload(aiPayload)
      if (aiPayload?.strategy_context?.input_encoding) cleanPrompt = `${cleanPrompt}\n\n${COMPACT_MARKET_INPUT_RULE}`
    }
    if (DEBUG_LLM) console.log(`[LLM] Payload to model (${JSON.stringify(aiPayload).length} chars)`)
    if (DEBUG_LLM_PAYLOAD) console.log(JSON.stringify(aiPayload, null, 2).substring(0, 3000))
    // DeepSeek and Agent Plan use different reasoning contracts.
    const thinkingEnabled = (provider === 'kimi_code' || provider === 'deepseek' || provider === 'volcengine_agent_plan')
      && config.thinking_enabled !== 0 && config.thinking_enabled !== false
    if (DEBUG_LLM) console.log(`[LLM] Request params: model=${config.model_name}, thinking=${thinkingEnabled}, effort=${config.reasoning_effort || 'max'}, temp=${thinkingEnabled ? 'ignored' : config.temperature}`)
    const usageContext = config._model_profile_id ? {
      userId: config._userId || 0,
      profileId: config._model_profile_id,
      credentialSource: config._credential_source || (config._model_shared ? 'platform_shared' : 'user'),
      usage: config._usage || 'manual',
      strategyId: config._strategyId || null,
    } : null
    const renderedUserPrompt = typeof config._comparison_replay_user_prompt === 'string'
      ? config._comparison_replay_user_prompt
      : '市场数据 JSON：\n' + JSON.stringify(aiPayload)
    const promptChars = cleanPrompt.length + renderedUserPrompt.length
    if (String(config._usage || '').startsWith('auto') && promptChars > AUTO_INFERENCE_MAX_PROMPT_CHARS) {
      throw new Error(`auto_inference_prompt_budget_exceeded:${promptChars}`)
    }
    if (typeof config._onInferencePrepared === 'function') {
      config._onInferencePrepared({
        systemPrompt: cleanPrompt,
        userPrompt: renderedUserPrompt,
        outputSchemaVersion: config._comparison_replay_output_schema_version || sha256(outputFormat),
        aiPayload,
      })
    }
    const parsed = await requestJsonObject({
      url, apiKey, provider,
      model: config.model_name || 'deepseek-chat',
      temperature: parseFloat(config.temperature ?? 0.3),
      maxTokens: automaticInferenceMaxTokens(config),
      thinkingEnabled,
      reasoningEffort: config.reasoning_effort || 'max',
      protocol,
      timeout: config.request_timeout_ms || 120000,
      messages: [
        { role: 'system', content: cleanPrompt },
        { role: 'user', content: renderedUserPrompt },
      ],
      usageContext,
      signal: config._abortSignal || null,
      onProviderRequest:config._onProviderRequest || null,
      onProviderUsage:config._onProviderUsage || null,
      validateObject: value => positionManagementEnabled
        ? validatePositionManagementResponse(value, positionManagementContext,
          marketPlan => validateAiSignalResponse(marketPlan, config._allowed_entry_methods))
        : validateAiSignalResponse(value, config._allowed_entry_methods),
    })
    parsed._inference_source = 'ai'
    localizeAiSignalUserVisibleFields(parsed)
    const comparisonRaw = config?._comparison_mode ? structuredClone(parsed) : null
    const normalized = normalizeAiSignal(parsed, config, market)
    return comparisonRaw
      ? buildModelComparisonSignal(comparisonRaw, normalized, config, market)
      : normalized
  } catch (exc) {
    if (config?._abortSignal?.aborted) throw exc
    return aiFailureHold(market, exc.message)
  }
}

const COMPARISON_LIVE_RISK_REASONS = new Set([
  'atr_anchor_unavailable_hold',
  'confidence_below_risk_threshold',
  'sl_widened',
  'sl_widen_min_lot_hold',
  'sl_too_far_hold',
])

/**
 * Preserve the model's original decision for offline comparison. The normal
 * live path is still evaluated so its diagnostics remain available, but live
 * risk policy is not allowed to rewrite BUY/SELL into HOLD. Contract and
 * order-structure errors only make the suggestion ineligible for replay.
 */
export function buildModelComparisonSignal(raw, normalized, config = {}, market = {}) {
  const signalType = String(raw?.signal_type || 'hold').toLowerCase()
  const typeEntryMap = {
    buy_limit:'limit', sell_limit:'limit', buy_stop:'stop', sell_stop:'stop',
    buy_stop_limit:'stop_limit', sell_stop_limit:'stop_limit', buy:'market', sell:'market', hold:'observe',
  }
  const entryMethod = String(raw?.entry_method || typeEntryMap[signalType] || '').toLowerCase()
  const isTrade = signalType.startsWith('buy') || signalType.startsWith('sell')
  const isBuySide = signalType.startsWith('buy')
  const numberOrNull = value => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  const limitPrice = numberOrNull(raw?.limit_price)
  const stopLimitPrice = entryMethod === 'stop_limit' ? numberOrNull(raw?.stop_limit_price) : null
  const stopLoss = numberOrNull(raw?.stop_loss_price)
  const takeProfits = [1, 2, 3].map(tier => numberOrNull(raw?.[`take_profit_${tier}_price`]))
  const referencePrice = Number(market?.latest_price)
  const anchorPrice = entryMethod !== 'market' && entryMethod !== 'observe' ? limitPrice : referencePrice
  const errors = new Set()
  const warnings = new Set()
  const normalizationReason = normalized?.normalization_info?.reason || normalized?.normalization_info?.type || null
  if (normalizationReason) {
    if (COMPARISON_LIVE_RISK_REASONS.has(normalizationReason)) warnings.add(normalizationReason)
    else errors.add(normalizationReason)
  }

  const validTypes = new Set(['buy', 'sell', 'hold', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'])
  if (!validTypes.has(signalType)) errors.add('invalid_signal_type')
  if (!['market', 'limit', 'stop', 'stop_limit', 'observe'].includes(entryMethod)) errors.add('invalid_entry_method')
  if (isTrade && entryMethod !== typeEntryMap[signalType]) errors.add('signal_entry_mismatch')
  if (isTrade && !new Set(normalizeEntryMethods(config?._allowed_entry_methods)).has(entryMethod)) {
    errors.add('entry_method_not_allowed_by_strategy')
  }
  if (isTrade && entryMethod !== 'market' && !limitPrice) errors.add('pending_price_required')
  if (isTrade && entryMethod === 'stop_limit' && !stopLimitPrice) errors.add('stop_limit_price_required')
  if (isTrade && anchorPrice > 0) {
    if (entryMethod !== 'market') {
      const directionInvalid = entryMethod === 'limit'
        ? (isBuySide ? limitPrice >= referencePrice : limitPrice <= referencePrice)
        : (isBuySide ? limitPrice <= referencePrice : limitPrice >= referencePrice)
      if (directionInvalid) errors.add('pending_price_direction_invalid')
    }
    if (entryMethod === 'stop_limit') {
      const relationInvalid = isBuySide ? stopLimitPrice > limitPrice : stopLimitPrice < limitPrice
      if (relationInvalid) errors.add('stop_limit_price_relation_invalid')
    }
    if (!stopLoss || (isBuySide ? stopLoss >= anchorPrice : stopLoss <= anchorPrice)) errors.add('invalid_stop_loss_direction')
    if (!takeProfits[0] || (isBuySide ? takeProfits[0] <= anchorPrice : takeProfits[0] >= anchorPrice)) {
      errors.add('invalid_take_profit_direction')
    }
  }
  const recommendedTier = Number(raw?.recommended_take_profit_tier)
  if (isTrade && (![1, 2, 3].includes(recommendedTier) || !takeProfits[recommendedTier - 1])) {
    errors.add('invalid_recommended_take_profit_tier')
  }

  let confidence = Number(normalized?.confidence)
  if (!(confidence > 0)) {
    confidence = Number(raw?.confidence)
    if (confidence > 1) confidence /= 100
    confidence = round2(Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0)))
  }
  const pendingValidMinutes = Math.min(Math.max(parseInt(raw?.pending_valid_minutes) || 240, 1), 1440)
  const validationErrors = [...errors]
  const validationWarnings = [...warnings]
  return {
    ...normalized,
    signal_type:signalType,
    entry_method:isTrade ? entryMethod : 'observe',
    confidence,
    recommended_volume:isTrade ? (numberOrNull(raw?.recommended_volume) || 0) : 0,
    position_size_tier:isTrade ? (normalizePositionSizeTier(raw?.position_size_tier, signalType) || 'light') : 'observe',
    position_size_factor:isTrade ? positionSizeFactor(normalizePositionSizeTier(raw?.position_size_tier, signalType) || 'light') : 0,
    position_size_reason:localizeInferenceNarrative(String(raw?.position_size_reason || normalized?.position_size_reason || '')).slice(0, 240),
    position_action:String(raw?.position_action || (isTrade ? 'open' : 'observe')).toLowerCase(),
    pending_action:String(raw?.pending_action || 'none').toLowerCase(),
    management_direction:String(raw?.management_direction || 'none').toLowerCase(),
    limit_price:isTrade ? limitPrice : null,
    stop_limit_price:isTrade ? stopLimitPrice : null,
    pending_valid_minutes:pendingValidMinutes,
    // Historical replay must derive expiry from the historical decision time,
    // never from the wall clock at which the comparison happened to run.
    pending_valid_until:null,
    stop_loss_price:isTrade ? stopLoss : null,
    take_profit_1_price:isTrade ? takeProfits[0] : null,
    take_profit_2_price:isTrade ? takeProfits[1] : null,
    take_profit_3_price:isTrade ? takeProfits[2] : null,
    recommended_take_profit_tier:isTrade && [1, 2, 3].includes(recommendedTier) ? recommendedTier : null,
    normalization_info:null,
    comparison_validation:{
      status:validationErrors.length ? 'invalid' : 'valid',
      execution_eligible:isTrade && validationErrors.length === 0,
      errors:validationErrors,
      warnings:validationWarnings,
      live_risk_bypassed:true,
    },
  }
}

export function normalizeAiSignal(parsed, config, market) {
  const strictInference = parsed?._inference_source === 'ai'
  adaptLegacyPositionSizing(parsed)
  localizeAiSignalUserVisibleFields(parsed)
  const cleanText = (value, maxLength) => typeof value === 'string' ? localizeInferenceNarrative(value).slice(0, maxLength) : ''
  const cleanList = value => Array.isArray(value)
    ? value.map(item => cleanText(item, 160)).filter(Boolean).slice(0, 4)
    : []
  parsed.decision_summary = cleanText(parsed.decision_summary, 200)
  parsed.trigger_condition = cleanText(parsed.trigger_condition, 240)
  parsed.invalidation_condition = cleanText(parsed.invalidation_condition, 240)
  parsed.position_size_reason = cleanText(parsed.position_size_reason, 240)
  const legacyPendingReason = Array.isArray(parsed.cancel_pending)
    ? parsed.cancel_pending.find(item => item && typeof item === 'object' && String(item.reason || '').trim())?.reason
    : ''
  parsed.pending_action_reason = cleanText(parsed.pending_action_reason || legacyPendingReason, 320)
  parsed.position_action = String(parsed.position_action || '').trim().toLowerCase()
  parsed.pending_action = String(parsed.pending_action || '').trim().toLowerCase()
  parsed.management_direction = String(parsed.management_direction || 'none').trim().toLowerCase()
  parsed.key_reasons = cleanList(parsed.key_reasons)
  parsed.risk_factors = cleanList(parsed.risk_factors)
  parsed.analysis = cleanText(parsed.analysis, 4000)
  parsed.reasoning = cleanText(parsed.reasoning, 4000)
  const availableExperienceIds = [...new Set((config?._experienceSelection?.selectedItemIds || [])
    .map(Number).filter(id => Number.isInteger(id) && id > 0))]
  const availableExperienceRefs = [...new Set((config?._experienceSelection?.selectedRefs || availableExperienceIds.map(id => `item:${id}`))
    .map(value => String(value || '').trim()).filter(Boolean))]
  const allowedExperienceIds = new Set(availableExperienceIds)
  const usage = parsed.experience_usage && typeof parsed.experience_usage === 'object' ? parsed.experience_usage : {}
  const validUsageIds = value => [...new Set((Array.isArray(value) ? value : []).map(Number)
    .filter(id => allowedExperienceIds.has(id)))]
  const usedExperienceIds = validUsageIds(usage.used_ids)
  const allowedExperienceRefs = new Set(availableExperienceRefs)
  const validUsageRefs = value => [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim())
    .filter(item => allowedExperienceRefs.has(item)))]
  let usedExperienceRefs = validUsageRefs(usage.used_refs)
  let usedIds = usedExperienceIds
  if (!usedExperienceRefs.length && !usedIds.length && availableExperienceRefs.length && /采用|使用|参考了/.test(String(usage.influence || ''))) {
    const influenceText = String(usage.influence || '')
    const directRefs = availableExperienceRefs.filter(ref => influenceText.includes(ref))
    const mentionedIds = [...influenceText.matchAll(/#\s*(\d+)/g)].map(match => Number(match[1]))
    const unambiguousRefs = mentionedIds.flatMap(id => {
      const matches = availableExperienceRefs.filter(ref => Number(ref.split(':').at(-1)) === id)
      return matches.length === 1 ? matches : []
    })
    usedExperienceRefs = [...new Set([...directRefs, ...unambiguousRefs])]
    usedIds = [...new Set(mentionedIds.filter(id => allowedExperienceIds.has(id)))]
  }
  const influence = cleanText(usage.influence, 400)
  parsed.experience_usage = {
    source:config?._experienceSelection?.source || null,
    considered_ids:availableExperienceIds,
    used_ids:usedIds,
    rejected_ids:validUsageIds(usage.rejected_ids).filter(id => !usedIds.includes(id)),
    considered_refs:availableExperienceRefs,
    used_refs:usedExperienceRefs,
    rejected_refs:validUsageRefs(usage.rejected_refs).filter(ref => !usedExperienceRefs.includes(ref)),
    influence:availableExperienceRefs.length ? influence : '',
  }
  const bullishRaw = Number(parsed.bullish_score)
  const bearishRaw = Number(parsed.bearish_score)
  if (Number.isFinite(bullishRaw) && Number.isFinite(bearishRaw) && bullishRaw >= 0 && bearishRaw >= 0 && bullishRaw + bearishRaw > 0) {
    const total = bullishRaw + bearishRaw
    parsed.bullish_score = Math.round(bullishRaw / total * 1000) / 10
    parsed.bearish_score = Math.round((100 - parsed.bullish_score) * 10) / 10
  } else {
    parsed.bullish_score = null
    parsed.bearish_score = null
  }
  const schemaHold = reason => ({
    ...parsed, signal_type: 'hold', confidence: 0, entry_method: 'observe',
    recommended_volume: 0, limit_price: null, stop_limit_price: null,
    position_size_tier: 'observe', position_size_factor: 0,
    position_action:'observe', pending_action:'none', pending_action_reason:'',
    management_direction:'none',
    recommended_take_profit_tier: null,
    pending_valid_minutes: 0, pending_valid_until: null,
    normalization_info: {
      type: 'l5_schema_hold', reason,
      original_signal_type:String(parsed.signal_type || 'unknown').toLowerCase(),
      original_entry_method:String(parsed.entry_method || '').toLowerCase() || null,
    },
  })
  const pendingSchemaHold = (reason, details = {}) => {
    const reasonLabels = {
      stop_limit_price_required: '缺少 Stop Limit 触发后的限价',
      pending_reference_price_unavailable: '当前行情参考价不可用',
      pending_price_direction_invalid: '挂单触发价与当前价格的方向关系错误',
      stop_limit_price_relation_invalid: 'Stop Limit 触发价与触发后限价的关系错误',
    }
    return {
      ...schemaHold(reason),
      decision_summary: '挂单价格结构不符合当前行情规则，本次暂不执行。',
      trigger_condition: '',
      invalidation_condition: '等待下一轮行情更新后重新评估入场方式和价格。',
      reasoning: `系统校验未通过：${reasonLabels[reason] || '挂单价格结构无效'}。AI 原始入场建议未进入执行链路。`,
      normalization_info: {
        type:'l5_schema_hold', reason,
        original_signal_type:String(parsed.signal_type || 'unknown').toLowerCase(),
        original_entry_method:String(parsed.entry_method || '').toLowerCase() || null,
        ...details,
      },
    }
  }
  let signalType = String(parsed.signal_type || 'hold').toLowerCase()
  const validTypes = ['buy', 'sell', 'hold', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit']
  if (!validTypes.includes(signalType)) {
    if (strictInference) return schemaHold('invalid_signal_type')
    signalType = 'hold'
  }
  if (strictInference) {
    const strictRequired = ['signal_type', 'entry_method', 'position_size_tier', 'position_size_reason', 'position_action', 'pending_action', 'management_direction']
    if (signalType !== 'hold') strictRequired.push('stop_loss_price', 'take_profit_1_price')
    const missing = strictRequired.filter(key => parsed[key] === undefined || parsed[key] === null || parsed[key] === '')
    if (missing.length) return schemaHold(`missing:${missing.join(',')}`)
  }

  // signal_type → entry_method + order_type auto mapping
  const typeEntryMap = {
    buy_limit: 'limit', sell_limit: 'limit',
    buy_stop: 'stop', sell_stop: 'stop',
    buy_stop_limit: 'stop_limit', sell_stop_limit: 'stop_limit',
    buy: 'market', sell: 'market',
  }
  let entryMethod = String(parsed.entry_method || typeEntryMap[signalType] || 'market').toLowerCase()
  if (!['market', 'limit', 'stop', 'stop_limit', 'observe'].includes(entryMethod)) {
    if (strictInference) return schemaHold('invalid_entry_method')
    entryMethod = 'market'
  }
  if (strictInference && signalType !== 'hold' && entryMethod !== typeEntryMap[signalType]) return schemaHold('signal_entry_mismatch')
  const allowedEntryMethods = new Set(normalizeEntryMethods(config?._allowed_entry_methods))
  if (strictInference && signalType !== 'hold' && !allowedEntryMethods.has(entryMethod)) return schemaHold('entry_method_not_allowed_by_strategy')
  if (signalType === 'hold') entryMethod = 'observe'
  if (entryMethod === 'observe') { signalType = 'hold'; }
  const requestedPositionTier = normalizePositionSizeTier(parsed.position_size_tier, signalType)
  if (!requestedPositionTier) return schemaHold('invalid_position_size_tier')
  if (!['open', 'hold_no_add', 'allow_add', 'observe'].includes(parsed.position_action)) return schemaHold('invalid_position_action')
  if (signalType === 'hold' && !['observe', 'hold_no_add'].includes(parsed.position_action)) return schemaHold('invalid_hold_position_action')
  if (signalType !== 'hold' && !['open', 'hold_no_add', 'allow_add'].includes(parsed.position_action)) return schemaHold('invalid_trade_position_action')
  if (!['none', 'keep', 'cancel', 'cancel_replace'].includes(parsed.pending_action)) return schemaHold('invalid_pending_action')
  if (signalType === 'hold' && parsed.pending_action === 'cancel_replace') return schemaHold('invalid_hold_cancel_replace')
  if (!['buy', 'sell', 'none'].includes(parsed.management_direction)) return schemaHold('invalid_management_direction')
  if (['cancel', 'cancel_replace'].includes(parsed.pending_action) && parsed.management_direction === 'none') return schemaHold('management_direction_required')
  if (['cancel', 'cancel_replace'].includes(parsed.pending_action) && !parsed.pending_action_reason) return schemaHold('pending_action_reason_required')
  if (!['cancel', 'cancel_replace'].includes(parsed.pending_action)) parsed.pending_action_reason = ''

  // Limit price validation — reject signal if pending order has no valid price
  let limitPrice = parsed.limit_price ? parseFloat(parsed.limit_price) : null
  if (entryMethod === 'limit' || entryMethod === 'stop' || entryMethod === 'stop_limit') {
    if (!limitPrice || !Number.isFinite(limitPrice) || limitPrice <= 0) {
      console.log(`[LLM] Missing/invalid limit_price for ${entryMethod}, rejecting signal (not falling back to market)`)
      return schemaHold('pending_price_required')
    }
  }

  // Stop-limit price (the actual limit price for stop_limit orders)
  let stopLimitPrice = parsed.stop_limit_price ? parseFloat(parsed.stop_limit_price) : null
  if (entryMethod === 'stop_limit') {
    if (!stopLimitPrice || !Number.isFinite(stopLimitPrice) || stopLimitPrice <= 0) {
      if (strictInference) return pendingSchemaHold('stop_limit_price_required')
      stopLimitPrice = null
    }
  } else {
    stopLimitPrice = null
  }

  if (strictInference && entryMethod !== 'market' && entryMethod !== 'observe') {
    const referencePrice = Number(market.latest_price)
    if (!(referencePrice > 0)) return pendingSchemaHold('pending_reference_price_unavailable')
    const isBuySide = signalType.startsWith('buy')
    const directionInvalid = entryMethod === 'limit'
      ? (isBuySide ? limitPrice >= referencePrice : limitPrice <= referencePrice)
      : (isBuySide ? limitPrice <= referencePrice : limitPrice >= referencePrice)
    if (directionInvalid) {
      return pendingSchemaHold('pending_price_direction_invalid', {
        entry_method: entryMethod, trigger_price: limitPrice, reference_price: referencePrice,
      })
    }
    if (entryMethod === 'stop_limit') {
      const relationInvalid = isBuySide ? stopLimitPrice > limitPrice : stopLimitPrice < limitPrice
      if (relationInvalid) {
        return pendingSchemaHold('stop_limit_price_relation_invalid', {
          trigger_price: limitPrice, stop_limit_price: stopLimitPrice,
        })
      }
    }
  }

  // Persist UTC as a timezone-less DATETIME string. Consumers must parse it as UTC.
  let pendingValidMinutes = Math.min(Math.max(parseInt(parsed.pending_valid_minutes) || 240, 1), 1440)
  const pendingValidUntil = entryMethod !== 'market' && entryMethod !== 'observe'
    ? formatPendingValidUntilUtc(pendingValidMinutes)
    : null

  const riskLevel = (config || {}).risk_level || 'medium'
  const RISK_TABLE = {
    low:    { minConfidence: 0.60, slAtrMult: 2.0 },
    medium: { minConfidence: 0.40, slAtrMult: 1.5 },
    high:   { minConfidence: 0.25, slAtrMult: 1.2 },
  }
  const risk = RISK_TABLE[riskLevel] || RISK_TABLE.medium

  const configuredMinPosition = Number(config?._ai_volume_min ?? market?.ai_volume_range?.min ?? 0.01)
  const configuredMaxPosition = Number(config?._ai_volume_max ?? market?.ai_volume_range?.max ?? config?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE)
  const minPosition = Number.isFinite(configuredMinPosition) && configuredMinPosition > 0 ? configuredMinPosition : 0.01
  const maxPosition = Number.isFinite(configuredMaxPosition) && configuredMaxPosition >= minPosition ? configuredMaxPosition : minPosition
  // New signals do not accept an absolute lot recommendation from the model.
  // Keep this legacy database field as an internal execution ceiling; the
  // deterministic risk gate derives the real lot size from stop-loss risk.
  let recommendedVolume = signalType === 'hold' ? 0 : maxPosition

  let rawConfidence = parseFloat(parsed.confidence)
  if (!Number.isFinite(rawConfidence)) rawConfidence = 0
  if (rawConfidence > 1) rawConfidence /= 100

  const score = market.strategy_score || {}
  const dataConfidence = parseFloat(score.data_confidence || 0.55)
  const trendStrength = parseFloat(score.trend_strength || 0)
  const volatilityPct = parseFloat(market.volatility_pct || 0)

  let calibrated
  if (signalType === 'hold') {
    const holdCertainty = 0.50 + (1 - trendStrength) * 0.22 + Math.min(volatilityPct / 0.5, 0.12)
    calibrated = rawConfidence * 0.55 + holdCertainty * 0.45
  } else {
    calibrated = rawConfidence * 0.85 + dataConfidence * 0.15
  }

  parsed.confidence = round2(Math.max(0.05, Math.min(0.95, calibrated)))

  // `hold_no_add` is a non-executable portfolio-management conclusion. Some
  // models still pair it with a BUY/SELL order type, which creates a
  // contradictory user-facing signal even though delivery correctly skips it.
  // Normalize that combination to HOLD while retaining the proposed levels as
  // explicitly non-executable market evidence.
  if (signalType !== 'hold' && parsed.position_action === 'hold_no_add') {
    const originalSignalType = signalType
    const candidateEntryPrice = entryMethod === 'market' ? Number(market.latest_price) : limitPrice
    parsed.candidate_entry = {
      signal_type:originalSignalType,
      direction:originalSignalType.startsWith('buy') ? 'buy' : 'sell',
      entry_method:entryMethod,
      entry_price:Number.isFinite(Number(candidateEntryPrice)) && Number(candidateEntryPrice) > 0 ? Number(candidateEntryPrice) : null,
      stop_limit_price:Number.isFinite(Number(stopLimitPrice)) && Number(stopLimitPrice) > 0 ? Number(stopLimitPrice) : null,
      stop_loss_price:Number.isFinite(Number(parsed.stop_loss_price)) && Number(parsed.stop_loss_price) > 0 ? Number(parsed.stop_loss_price) : null,
      take_profit_1_price:Number.isFinite(Number(parsed.take_profit_1_price)) && Number(parsed.take_profit_1_price) > 0 ? Number(parsed.take_profit_1_price) : null,
      take_profit_2_price:Number.isFinite(Number(parsed.take_profit_2_price)) && Number(parsed.take_profit_2_price) > 0 ? Number(parsed.take_profit_2_price) : null,
      take_profit_3_price:Number.isFinite(Number(parsed.take_profit_3_price)) && Number(parsed.take_profit_3_price) > 0 ? Number(parsed.take_profit_3_price) : null,
    }
    parsed.signal_type = 'hold'
    parsed.entry_method = 'observe'
    parsed.recommended_volume = 0
    parsed.position_size_tier = 'observe'
    parsed.position_size_factor = 0
    parsed.position_size_reason = '当前已有同向持仓，本次不新增仓位。'
    parsed.pending_action = parsed.pending_action === 'cancel_replace' ? 'cancel' : parsed.pending_action
    parsed.management_direction = ['cancel'].includes(parsed.pending_action) ? parsed.management_direction : 'none'
    parsed.limit_price = null
    parsed.stop_limit_price = null
    parsed.stop_loss_price = null
    parsed.take_profit_1_price = null
    parsed.take_profit_2_price = null
    parsed.take_profit_3_price = null
    parsed.recommended_take_profit_tier = null
    parsed.pending_valid_minutes = 0
    parsed.pending_valid_until = null
    parsed.decision_summary = '当前已有同向持仓，策略建议继续持有，暂不加仓。'
    parsed.normalization_info = {
      type:'existing_position_hold_no_add',
      reason:'existing_position_hold_no_add',
      original_signal_type:originalSignalType,
      original_entry_method:entryMethod,
    }
    return parsed
  }

  if (signalType !== 'hold' && parsed.confidence < risk.minConfidence) {
    const originalSignalType = signalType
    const originalConfidence = parsed.confidence
    signalType = 'hold'
    parsed.signal_type = 'hold'
    parsed.recommended_volume = 0
    parsed.entry_method = 'observe'
    parsed.position_size_tier = 'observe'
    parsed.position_size_factor = 0
    parsed.position_action = 'observe'
    parsed.pending_action = 'none'
    parsed.pending_action_reason = ''
    parsed.management_direction = 'none'
    parsed.limit_price = null
    parsed.stop_limit_price = null
    parsed.pending_valid_until = null
    parsed.normalization_info = {
      type:'confidence_below_risk_threshold',
      reason:'confidence_below_risk_threshold',
      original_signal_type:originalSignalType,
      original_confidence:originalConfidence,
      minimum_confidence:risk.minConfidence,
    }
    return parsed
  }

  const context = market?.strategy_context || {}
  const alignment = context?.chan_timeframe_alignment || {}
  const missingFrames = Array.isArray(context.missing_timeframes) ? context.missing_timeframes.length
    : Array.isArray(market?.missing_timeframes) ? market.missing_timeframes.length : 0
  let evidenceCap = parsed.confidence >= 0.75 ? 'standard' : parsed.confidence >= 0.62 ? 'light' : 'probe'
  if (missingFrames > 0 || context.context_status === 'partial') evidenceCap = 'probe'
  if (['mixed', 'insufficient'].includes(String(alignment.agreement || '').toLowerCase())) evidenceCap = 'probe'
  const positionSizing = resolvePositionSizeTier({ requestedTier:requestedPositionTier, signalType, evidenceCap })
  if (!positionSizing) return schemaHold('invalid_position_size_tier')
  parsed.position_size_tier = positionSizing.tier
  parsed.position_size_factor = positionSizing.factor
  if (positionSizing.downgraded) {
    parsed.normalization_info = {
      ...(parsed.normalization_info || {}),
      position_size_tier_requested:requestedPositionTier,
      position_size_tier_used:positionSizing.tier,
      position_size_tier_downgraded:true,
    }
  }

  parsed.signal_type = signalType
  parsed.recommended_volume = recommendedVolume

  if (signalType !== 'hold') {
    const isBuySide = signalType.startsWith('buy')
    const anchorPrice = (entryMethod !== 'market' && entryMethod !== 'observe' && limitPrice) ? limitPrice : (market.latest_price || 0)
    const atr = Number(market.atr_anchor) || 0
    if (!(atr > 0)) {
      console.log(`[LLM] Closed hourly ATR unavailable for ${signalType}, holding`)
      return { ...parsed, signal_type: 'hold', confidence: 0, entry_method: 'observe', recommended_volume: 0, limit_price: null, stop_limit_price: null, pending_valid_until: null, normalization_info: { type:'atr_anchor_unavailable_hold', reason:'atr_anchor_unavailable_hold', original_signal_type:signalType, original_entry_method:entryMethod } }
    }
    if (atr > 0 && anchorPrice > 0) {
      const fallbackSlDistance = atr * risk.slAtrMult
      if (!parsed.stop_loss_price) {
        parsed.stop_loss_price = isBuySide
          ? round2(anchorPrice - fallbackSlDistance) : round2(anchorPrice + fallbackSlDistance)
      }

      // Preserve a model-provided stop loss. The versioned risk gate validates
      // the maximum distance and sizes the order from the actual loss amount;
      // normalization must not silently create a different trade thesis.
      const finalSlDistance = Math.abs(Number(parsed.stop_loss_price) - anchorPrice)
      if (!parsed.take_profit_1_price) {
        parsed.take_profit_1_price = isBuySide
          ? round2(anchorPrice + finalSlDistance * TP_FROM_SL.tp1) : round2(anchorPrice - finalSlDistance * TP_FROM_SL.tp1)
      }
      if (!parsed.take_profit_2_price) {
        parsed.take_profit_2_price = isBuySide
          ? round2(anchorPrice + finalSlDistance * TP_FROM_SL.tp2) : round2(anchorPrice - finalSlDistance * TP_FROM_SL.tp2)
      }
      if (!parsed.take_profit_3_price) {
        parsed.take_profit_3_price = isBuySide
          ? round2(anchorPrice + finalSlDistance * TP_FROM_SL.tp3) : round2(anchorPrice - finalSlDistance * TP_FROM_SL.tp3)
      }
    }
    // Direction validation: always runs when anchorPrice is valid (ATR-independent)
    if (anchorPrice > 0) {
      // SL direction: buy SL must be below entry, sell SL must be above entry
      if (parsed.stop_loss_price != null) {
        const sl = parseFloat(parsed.stop_loss_price)
        const slOk = isBuySide ? sl < anchorPrice : sl > anchorPrice
        if (!slOk || !Number.isFinite(sl) || sl <= 0) {
          console.log(`[LLM] SL direction wrong: ${parsed.stop_loss_price} for ${signalType} at ${anchorPrice}, rejecting`)
          parsed.stop_loss_price = null
        }
      }
      // TP direction: buy TP must be above entry, sell TP must be below entry
      for (const tpKey of ['take_profit_1_price', 'take_profit_2_price', 'take_profit_3_price']) {
        if (parsed[tpKey] != null) {
          const tp = parseFloat(parsed[tpKey])
          const tpOk = isBuySide ? tp > anchorPrice : tp < anchorPrice
          if (!tpOk || !Number.isFinite(tp) || tp <= 0) {
            console.log(`[LLM] ${tpKey} direction wrong: ${parsed[tpKey]} for ${signalType} at ${anchorPrice}, clearing`)
            parsed[tpKey] = null
          }
        }
      }
      // TP ordering: for buy, TP1 < TP2 < TP3; for sell, TP1 > TP2 > TP3
      if (parsed.take_profit_1_price && parsed.take_profit_2_price) {
        if (isBuySide ? parsed.take_profit_2_price <= parsed.take_profit_1_price : parsed.take_profit_2_price >= parsed.take_profit_1_price) {
          console.log(`[LLM] TP2 not beyond TP1 for ${signalType}, clearing TP2/TP3`)
          parsed.take_profit_2_price = null
          parsed.take_profit_3_price = null
        }
      }
      if (parsed.take_profit_2_price && parsed.take_profit_3_price) {
        if (isBuySide ? parsed.take_profit_3_price <= parsed.take_profit_2_price : parsed.take_profit_3_price >= parsed.take_profit_2_price) {
          console.log(`[LLM] TP3 not beyond TP2 for ${signalType}, clearing TP3`)
          parsed.take_profit_3_price = null
        }
      }
    }
    // Reject if SL or TP1 are missing
    if (!parsed.stop_loss_price || !parsed.take_profit_1_price) {
      console.log(`[LLM] Missing SL/TP for ${signalType} (atr=${atr}), rejecting`)
      return schemaHold('missing_valid_sl_or_tp')
    }
    const recommendedTier = Number(parsed.recommended_take_profit_tier || (strictInference ? 0 : 1))
    if (![1, 2, 3].includes(recommendedTier) || !parsed[`take_profit_${recommendedTier}_price`]) {
      console.log(`[LLM] Invalid recommended TP tier ${parsed.recommended_take_profit_tier} for ${signalType}, rejecting`)
      return schemaHold('invalid_recommended_take_profit_tier')
    }
    parsed.recommended_take_profit_tier = recommendedTier
  } else {
    parsed.recommended_take_profit_tier = null
  }

  // Attach pending order fields
  parsed.entry_method = entryMethod
  parsed.recommended_volume = recommendedVolume
  parsed.position_size_tier = signalType === 'hold' ? 'observe' : parsed.position_size_tier
  parsed.position_size_factor = signalType === 'hold' ? 0 : positionSizeFactor(parsed.position_size_tier)
  parsed.limit_price = limitPrice
  parsed.stop_limit_price = stopLimitPrice
  parsed.pending_valid_until = pendingValidUntil

  return parsed
}

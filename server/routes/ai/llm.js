// ai/llm.js — AI 推理 + 信号标准化

import { queryOne } from '../../db.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { DEFAULT_PROMPT, stripTimeframeTags, round2, parseJsonObject, aiFailureHold } from './utils.js'
import { DEFAULT_MAX_POSITION_SIZE } from './config.js'

const DEBUG_LLM_PAYLOAD = process.env.DEBUG_LLM_PAYLOAD === '1'

let _schemaCache = null
let _schemaCacheTs = 0
const SCHEMA_CACHE_TTL = 300_000 // 5 minutes

const DEFAULT_OUTPUT_FORMAT = JSON.stringify({
  signal_type: "buy | sell | hold | buy_limit | sell_limit | buy_stop | sell_stop | buy_stop_limit | sell_stop_limit。禁止其他值。buy/sell=市价立即执行; buy_limit/sell_limit=挂限价单; buy_stop/sell_stop=突破追单; buy_stop_limit/sell_stop_limit=突破后限价。方向优势不清晰、关键位距离过近、短线波动过大、已有持仓风险不合适时必须返回hold。挂单管理：同品种同方向最多保留1笔挂单，如果market_data_json.pending_orders中已有同品种同方向挂单且价格合理则返回hold不挂新单，仅在现有挂单价格明显不合理时才用cancel_pending取消旧单挂新单",
  confidence: "0.00-1.00，动态估算，禁止固定值。按趋势强度、位置结构、波动噪音、风险状态综合评估。BUY/SELL弱优势0.52-0.62，中等0.63-0.74，强共振>0.75。HOLD时0.55-0.68，明确回避风险可>0.70。hold时也不得为0",
  recommended_volume: "0.01-0.05手，不得超过0.05。根据风险等级调整：low=0.01-0.02, medium=0.02-0.03, high=0.03-0.05。hold时返回0",
  limit_price: "挂单价。buy_limit/sell_limit:入场价,订单直接挂在此价; buy_stop/sell_stop:触发价,价格到达后以市价成交; buy_stop_limit/sell_stop_limit:触发价,到达后按stop_limit_price挂限价单。方向：限价买单须低于当前价,限价卖单须高于当前价;突破单相反,买单触发价须高于当前价,卖单触发价须低于当前价。距离参考：M15一般0.5-2 ATR,H1一般1-3 ATR",
  stop_limit_price: "止损触发价，仅buy_stop_limit/sell_stop_limit时需要。触发后按limit_price成交。通常设在关键支撑/阻力突破位，limit_price设在突破后合理入场位",
  pending_valid_minutes: "挂单有效期(分钟)，1-1440，默认240",
  stop_loss_price: "数字，buy/sell/挂单必须给出，hold可为null。买单止损须低于入场价，卖单止损须高于入场价。最小距离由风险等级决定：low=2倍ATR(14), medium=1.5倍, high=1倍，过近会被系统自动修正。止损位必须参考M15 K线的关键支撑/阻力位（support_resistance.s1/s2/r1/r2），设在M15级别关键位外侧，给足波动空间",
  take_profit_1_price: "止盈-保守(第一目标位)，数字，buy/sell/挂单必须给出，hold可为null。买单止盈须高于入场价，卖单止盈须低于入场价。建议设在最近的支撑/阻力位，R:R至少1:1",
  take_profit_2_price: "止盈-标准(第二目标位)，数字，buy/sell/挂单必须给出，hold可为null。距离应大于tp1，R:R建议1:1.5-1:2",
  take_profit_3_price: "止盈-激进(第三目标位)，数字，可选。距离应大于tp2，R:R建议1:2-1:3。仅在趋势明确且有延续依据时提供",
  cancel_pending: "必须字段（条件触发）。需要取消现有挂单时，此字段必须输出对应的取消条件数组，不能为空。不需要取消时返回空数组 []。每个元素：symbol(必填)品种, pending_type(可选)挂单类型如buy_limit/sell_limit/buy_stop/sell_stop, max_price(可选)取消此价格以下的挂单(限买单), min_price(可选)取消此价格以上的挂单(限卖单), cancel_all(可选bool)取消该品种所有挂单, reason(必填)取消原因。示例：需要取消XAUUSD上价格不合理的买单时：[{\"symbol\":\"XAUUSD\",\"pending_type\":\"buy_limit\",\"max_price\":4110,\"reason\":\"价格偏离过远，成交概率极低\"}]；不需要取消时：[]",
  analysis: "中文，按以下顺序：1.当前趋势方向和强度 2.关键支撑/阻力位 3.当前价与均线关系 4.波动率状态 5.潜在催化剂或风险事件",
  reasoning: "中文，按以下结构：1.信号方向依据（哪些指标/形态支持） 2.入场方式选择理由（为什么用市价/限价/挂单） 3.风险评估（潜在不利因素） 4.执行建议（为什么可以执行或为什么观望） 5.挂单管理：检查现有挂单状态，是否需要取消、是否已有同方向挂单"
}, null, 2)

export async function requestJsonObject({ url, apiKey, model, temperature, maxTokens, messages, thinkingEnabled, reasoningEffort, timeout = 120000 }) {
  if (apiKey && /[^ -~]/.test(apiKey)) {
    throw new Error('API key contains non-ASCII characters, please check your configuration')
  }
  const body = { model, messages }
  // DeepSeek thinking mode: temperature/top_p ignored when enabled
  if (thinkingEnabled) {
    body.thinking = { type: 'enabled' }
    body.reasoning_effort = reasoningEffort || 'max'
  } else {
    body.temperature = temperature
    body.max_tokens = maxTokens
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}`)
  const data = await response.json()
  const msg = data.choices?.[0]?.message
  if (!msg) throw new Error(`LLM response missing choices[0].message, status=${response.status}, body=${JSON.stringify(data).substring(0, 300)}`)
  const content = msg.content || msg.reasoning_content || ''
  if (!content) throw new Error('LLM response content is empty')
  try {
    return parseJsonObject(content)
  } catch (exc) {
    const repairMessages = [
      ...messages,
      { role: 'assistant', content: content.substring(0, 6000) },
      { role: 'user', content: `上一次输出不是合法 JSON，解析错误为：${exc.message}。请只返回修正后的一个 JSON 对象，不要 Markdown，不要解释。` },
    ]
    const repairBody = { model, messages: repairMessages }
    if (thinkingEnabled) {
      repairBody.thinking = { type: 'enabled' }
      repairBody.reasoning_effort = reasoningEffort || 'max'
    } else {
      repairBody.temperature = 0
      repairBody.max_tokens = maxTokens
    }
    const repairResp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(repairBody),
      signal: AbortSignal.timeout(timeout),
    })
    if (!repairResp.ok) throw new Error(`LLM repair HTTP ${repairResp.status}`)
    const repairedData = await repairResp.json()
    const repairedMsg = repairedData.choices?.[0]?.message
    if (!repairedMsg) throw new Error(`LLM repair response missing choices[0].message`)
    const repaired = repairedMsg.content || repairedMsg.reasoning_content || ''
    if (!repaired) throw new Error('LLM repair response content is empty')
    return parseJsonObject(repaired)
  }
}

export async function maybeAiSignal(db, config, market) {
  if (!config || !config.api_key_encrypted) return aiFailureHold(market, 'missing_ai_configuration_or_key')
  const apiKey = config.api_key_encrypted
  const provider = config.api_provider || 'deepseek'
  const baseUrl = config.api_base_url
  if (!apiKey) return aiFailureHold(market, 'empty_ai_key')

  const compatibleProviders = new Set(['deepseek', 'gpt', 'kimi', 'qwen', 'zhipu', 'doubao'])
  if (!compatibleProviders.has(provider)) return aiFailureHold(market, `unsupported_ai_provider:${provider}`)
  const providerDefaults = {
    deepseek: DEFAULT_API_BASE_URL,
    gpt: 'https://api.openai.com/v1',
    kimi: 'https://api.moonshot.cn/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  }
  const normalizedBaseUrl = String(baseUrl || providerDefaults[provider]).replace(/\/+$/, '')
  const url = `${normalizedBaseUrl}/chat/completions`

  try {
    const prompt = stripTimeframeTags(config.system_prompt || DEFAULT_PROMPT)

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
    console.log(`[LLM] Output schema loaded: ${schemaSource} (${outputFormat.length} chars)`)

    const fullPrompt = prompt + '\n\n## 输出格式\n你必须返回以下 JSON 结构：\n' + outputFormat

    // Check if prompt wants Chan theory data
    const useChan = /\{\{USE_CHAN\}\}/.test(config.system_prompt || '')
    const cleanPrompt = fullPrompt.replace(/\{\{USE_CHAN\}\}/g, '').replace(/\n{3,}/g, '\n\n').trim()
    console.log(`[LLM] USE_CHAN tag: ${useChan ? 'detected' : 'not found'}`)

    const aiPayload = {
      symbol: market.symbol, timeframe: market.timeframe, timestamp: market.timestamp,
      latest_price: market.latest_price, price_change: market.price_change,
      price_change_pct: market.price_change_pct, account: market.account,
      positions: market.positions, pending_orders: market.pending_orders || [],
      kline_count: market.kline_count,
      risk_level: (config || {}).risk_level || 'medium',
      max_position_size: parseFloat((config || {}).max_position_size || DEFAULT_MAX_POSITION_SIZE),
    }
    if (market.strategy_context) {
      const ctx = { ...market.strategy_context }
      // Strip chan data if prompt doesn't have {{USE_CHAN}}
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
        if (stripped > 0) console.log(`[LLM] Stripped chan from ${stripped} timeframe(s) (no {{USE_CHAN}} tag)`)
      }
      aiPayload.strategy_context = ctx
    }
    console.log(`[LLM] Payload to model (${JSON.stringify(aiPayload).length} chars)`)
    if (DEBUG_LLM_PAYLOAD) console.log(JSON.stringify(aiPayload, null, 2).substring(0, 3000))
    const thinkingEnabled = config.thinking_enabled !== false
    console.log(`[LLM] Request params: model=${config.model_name}, thinking=${thinkingEnabled}, effort=${config.reasoning_effort || 'max'}, temp=${thinkingEnabled ? 'ignored' : config.temperature}`)
    const parsed = await requestJsonObject({
      url, apiKey,
      model: config.model_name || 'deepseek-chat',
      temperature: parseFloat(config.temperature || 0.7),
      maxTokens: parseInt(config.max_tokens || 2000),
      thinkingEnabled: config.thinking_enabled !== false,
      reasoningEffort: config.reasoning_effort || 'max',
      messages: [
        { role: 'system', content: cleanPrompt },
        { role: 'user', content: '市场数据 JSON：\n' + JSON.stringify(aiPayload) },
      ],
    })
    const required = ['signal_type', 'confidence', 'recommended_volume', 'analysis', 'reasoning']
    if (!required.every(k => k in parsed)) {
      const missing = required.filter(k => !(k in parsed))
      throw new Error(`ai_response_missing_required_fields:${missing.join(',')}`)
    }
    parsed._inference_source = 'ai'
    return normalizeAiSignal(parsed, config, market)
  } catch (exc) {
    return aiFailureHold(market, exc.message)
  }
}

export function normalizeAiSignal(parsed, config, market) {
  let signalType = String(parsed.signal_type || 'hold').toLowerCase()
  const validTypes = ['buy', 'sell', 'hold', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit']
  if (!validTypes.includes(signalType)) signalType = 'hold'

  // signal_type → entry_method + order_type auto mapping
  const typeEntryMap = {
    buy_limit: 'limit', sell_limit: 'limit',
    buy_stop: 'stop', sell_stop: 'stop',
    buy_stop_limit: 'stop_limit', sell_stop_limit: 'stop_limit',
    buy: 'market', sell: 'market',
  }
  let entryMethod = String(parsed.entry_method || typeEntryMap[signalType] || 'market').toLowerCase()
  if (!['market', 'limit', 'stop', 'stop_limit', 'observe'].includes(entryMethod)) entryMethod = 'market'
  if (signalType === 'hold') entryMethod = 'observe'
  if (entryMethod === 'observe') { signalType = 'hold'; }

  // Limit price validation — reject signal if pending order has no valid price
  let limitPrice = parsed.limit_price ? parseFloat(parsed.limit_price) : null
  if (entryMethod === 'limit' || entryMethod === 'stop' || entryMethod === 'stop_limit') {
    if (!limitPrice || !Number.isFinite(limitPrice) || limitPrice <= 0) {
      console.log(`[LLM] Missing/invalid limit_price for ${entryMethod}, rejecting signal (not falling back to market)`)
      return { ...parsed, signal_type: 'hold', confidence: 0, entry_method: 'observe', limit_price: null, stop_limit_price: null, pending_valid_minutes: 0, pending_valid_until: null, recommended_volume: 0 }
    }
  }

  // Stop-limit price (the actual limit price for stop_limit orders)
  let stopLimitPrice = parsed.stop_limit_price ? parseFloat(parsed.stop_limit_price) : null
  if (entryMethod === 'stop_limit') {
    if (!stopLimitPrice || !Number.isFinite(stopLimitPrice) || stopLimitPrice <= 0) {
      stopLimitPrice = null // optional, fallback to limit_price
    }
  } else {
    stopLimitPrice = null
  }

  // Pending validity — UTC time string (no timezone suffix), consistent with reconcilePendingOrders parsing
  let pendingValidMinutes = Math.min(Math.max(parseInt(parsed.pending_valid_minutes) || 240, 1), 1440)
  const pendingValidUntil = entryMethod !== 'market' && entryMethod !== 'observe'
    ? new Date(Date.now() + pendingValidMinutes * 60000).toISOString().replace('T', ' ').substring(0, 19)
    : null

  const riskLevel = (config || {}).risk_level || 'medium'
  const RISK_TABLE = {
    low:    { minConfidence: 0.60, volumeMultiplier: 0.5, slAtrMult: 2.0, tp1AtrMult: 1.5, tp2AtrMult: 2.5, tp3AtrMult: 4.0 },
    medium: { minConfidence: 0.40, volumeMultiplier: 1.0, slAtrMult: 1.5, tp1AtrMult: 1.5, tp2AtrMult: 2.5, tp3AtrMult: 4.0 },
    high:   { minConfidence: 0.25, volumeMultiplier: 1.5, slAtrMult: 1.0, tp1AtrMult: 1.0, tp2AtrMult: 2.0, tp3AtrMult: 3.0 },
  }
  const risk = RISK_TABLE[riskLevel] || RISK_TABLE.medium

  const maxPosition = parseFloat((config || {}).max_position_size || DEFAULT_MAX_POSITION_SIZE) * risk.volumeMultiplier
  const rawVolume = parseFloat(parsed.recommended_volume || 0)
  const recommendedVolume = signalType === 'hold' ? 0 : round2(Math.max(0.01, Math.min(rawVolume, maxPosition)))

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

  if (signalType !== 'hold' && parsed.confidence < risk.minConfidence) {
    signalType = 'hold'
    parsed.signal_type = 'hold'
    parsed.recommended_volume = 0
    parsed.entry_method = 'observe'
    parsed.limit_price = null
    parsed.stop_limit_price = null
    parsed.pending_valid_until = null
    return parsed
  }

  parsed.signal_type = signalType
  parsed.recommended_volume = recommendedVolume

  if (signalType !== 'hold') {
    const isBuySide = signalType.startsWith('buy')
    const anchorPrice = (entryMethod !== 'market' && entryMethod !== 'observe' && limitPrice) ? limitPrice : (market.latest_price || 0)
    const atr = market.atr_14_m15 || market.atr_14 || 0
    if (atr > 0 && anchorPrice > 0) {
      const atrSlDistance = atr * risk.slAtrMult
      // SL minimum distance: enforce at least slAtrMult * ATR
      if (parsed.stop_loss_price) {
        const aiSlDist = Math.abs(parsed.stop_loss_price - anchorPrice)
        if (aiSlDist < atrSlDistance) {
          console.log(`[LLM] AI SL too tight: ${aiSlDist.toFixed(2)} < ${atrSlDistance.toFixed(2)} (${risk.slAtrMult}x ATR), overriding`)
          parsed.stop_loss_price = isBuySide
            ? round2(anchorPrice - atrSlDistance) : round2(anchorPrice + atrSlDistance)
        }
        // SL direction check: buy SL must be below entry, sell SL must be above entry
        const slOk = isBuySide ? parsed.stop_loss_price < anchorPrice : parsed.stop_loss_price > anchorPrice
        if (!slOk) {
          console.log(`[LLM] SL direction wrong: ${parsed.stop_loss_price} for ${signalType} at ${anchorPrice}, overriding`)
          parsed.stop_loss_price = isBuySide
            ? round2(anchorPrice - atrSlDistance) : round2(anchorPrice + atrSlDistance)
        }
      } else {
        parsed.stop_loss_price = isBuySide
          ? round2(anchorPrice - atrSlDistance) : round2(anchorPrice + atrSlDistance)
      }
      if (!parsed.take_profit_1_price) {
        parsed.take_profit_1_price = isBuySide
          ? round2(anchorPrice + atr * risk.tp1AtrMult) : round2(anchorPrice - atr * risk.tp1AtrMult)
      }
      if (!parsed.take_profit_2_price) {
        parsed.take_profit_2_price = isBuySide
          ? round2(anchorPrice + atr * risk.tp2AtrMult) : round2(anchorPrice - atr * risk.tp2AtrMult)
      }
      if (!parsed.take_profit_3_price) {
        parsed.take_profit_3_price = isBuySide
          ? round2(anchorPrice + atr * risk.tp3AtrMult) : round2(anchorPrice - atr * risk.tp3AtrMult)
      }
      // TP direction check: buy TP must be above entry, sell TP must be below entry
      for (const tpKey of ['take_profit_1_price', 'take_profit_2_price', 'take_profit_3_price']) {
        if (parsed[tpKey]) {
          const tpOk = isBuySide ? parsed[tpKey] > anchorPrice : parsed[tpKey] < anchorPrice
          if (!tpOk) {
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
    // Reject if SL or TP1 are missing (ATR unavailable and LLM didn't provide them)
    if (!parsed.stop_loss_price || !parsed.take_profit_1_price) {
      console.log(`[LLM] Missing SL/TP for ${signalType} (atr=${atr}), rejecting`)
      return { ...parsed, signal_type: 'hold', confidence: 0, entry_method: 'observe', limit_price: null, stop_limit_price: null, pending_valid_until: null, recommended_volume: 0 }
    }
  }

  // Attach pending order fields
  parsed.entry_method = entryMethod
  parsed.limit_price = limitPrice
  parsed.stop_limit_price = stopLimitPrice
  parsed.pending_valid_until = pendingValidUntil

  return parsed
}

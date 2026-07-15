// ai/llm.js — AI 推理 + 信号标准化

import { queryOne } from '../../db.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { DEFAULT_PROMPT, stripTimeframeTags, round2, parseJsonObject, aiFailureHold } from './utils.js'
import { DEFAULT_MAX_POSITION_SIZE } from './config.js'
import { beginModelUsage, finishModelUsage } from './model-profiles.js'
import { sha256 } from './inference-snapshots.js'

const DEBUG_LLM_PAYLOAD = process.env.DEBUG_LLM_PAYLOAD === '1'
const SL_CLAMP = { K_MIN: 1.0, K_MAX: 3.0 }
const TP_FROM_SL = { tp1: 1.5, tp2: 2.5, tp3: 4.0 }
const PENDING_LIFECYCLE_RULE = `
## 挂单生命周期硬性规则
挂单有效期、过期识别和到期取消由 MT5 与后端协调器负责。禁止比较任何时间字符串来判断挂单是否过期；禁止在 analysis 或 reasoning 中声称某挂单“已过期”“超时失效”“已自动取消”；禁止仅以时间、有效期或过期为理由输出 cancel_pending。cancel_pending 只能用于价格条件已明显失效、市场结构已破坏或方向逻辑已反转等非时间原因。是否存在挂单只能依据 pending_orders 当前数组；数组中不存在时只能表述“当前输入未包含该挂单”，不得推断其已过期或已取消。`

let _schemaCache = null
let _schemaCacheTs = 0
const SCHEMA_CACHE_TTL = 300_000 // 5 minutes

const DEFAULT_OUTPUT_FORMAT = JSON.stringify({
  signal_type: "buy | sell | hold | buy_limit | sell_limit | buy_stop | sell_stop | buy_stop_limit | sell_stop_limit。禁止其他值。buy/sell=市价立即执行; buy_limit/sell_limit=挂限价单; buy_stop/sell_stop=突破追单; buy_stop_limit/sell_stop_limit=突破后限价。方向优势不清晰、关键位距离过近、短线波动过大、已有持仓风险不合适时必须返回hold。挂单管理：同品种同方向最多保留1笔挂单，如果market_data_json.pending_orders中已有同品种同方向挂单且价格合理则返回hold不挂新单，仅在现有挂单价格明显不合理时才用cancel_pending取消旧单挂新单",
  entry_method: "必须字段。仅允许 market | limit | stop | stop_limit | observe，并且必须与signal_type一致：buy/sell=market，*_limit=limit，*_stop=stop，*_stop_limit=stop_limit，hold=observe",
  confidence: "0.00-1.00，动态估算，禁止固定值。按趋势强度、位置结构、波动噪音、风险状态综合评估。BUY/SELL弱优势0.52-0.62，中等0.63-0.74，强共振>0.75。HOLD时0.55-0.68，明确回避风险可>0.70。hold时也不得为0",
  recommended_volume: "0.01至输入市场数据中的max_position_size手，不得超过max_position_size。应根据当前风险与止损距离合理建议；hold时返回0",
  limit_price: "挂单价。buy_limit/sell_limit:入场价,订单直接挂在此价; buy_stop/sell_stop:触发价,价格到达后以市价成交; buy_stop_limit/sell_stop_limit:触发价,到达后按stop_limit_price挂限价单。方向：限价买单须低于当前价,限价卖单须高于当前价;突破单相反,买单触发价须高于当前价,卖单触发价须低于当前价。距离参考：M15一般0.5-2 ATR,H1一般1-3 ATR",
  stop_limit_price: "止损触发价，仅buy_stop_limit/sell_stop_limit时需要。触发后按limit_price成交。通常设在关键支撑/阻力突破位，limit_price设在突破后合理入场位",
  pending_valid_minutes: "挂单有效期(分钟)，1-1440，默认240",
  stop_loss_price: "数字，buy/sell/挂单必须给出，hold可为null。买单止损须低于入场价，卖单止损须高于入场价。最小距离由风险等级决定：low=2倍ATR(14), medium=1.5倍, high=1倍，过近会被系统自动修正。止损位必须参考M15 K线的关键支撑/阻力位（support_resistance.s1/s2/r1/r2），设在M15级别关键位外侧，给足波动空间",
  take_profit_1_price: "止盈-保守(第一目标位)，数字，buy/sell/挂单必须给出，hold可为null。买单止盈须高于入场价，卖单止盈须低于入场价。建议设在最近的支撑/阻力位，R:R至少1:1",
  take_profit_2_price: "止盈-标准(第二目标位)，数字，buy/sell/挂单必须给出，hold可为null。距离应大于tp1，R:R建议1:1.5-1:2",
  take_profit_3_price: "止盈-激进(第三目标位)，数字，可选。距离应大于tp2，R:R建议1:2-1:3。仅在趋势明确且有延续依据时提供",
  cancel_pending: "必须字段（条件触发）。挂单有效期、过期识别和到期取消由MT5与后端负责，禁止比较时间字符串判断过期，禁止以过期、超时或有效期为理由取消挂单。仅当价格条件明显失效、市场结构破坏或方向逻辑反转时，才输出取消条件；否则返回空数组[]。每个元素：symbol(必填), pending_type(可选), max_price(可选), min_price(可选), cancel_all(可选bool), reason(必填且必须是非时间原因)",
  analysis: "中文，按以下顺序：1.当前趋势方向和强度 2.关键支撑/阻力位 3.当前价与均线关系 4.波动率状态 5.潜在催化剂或风险事件",
  reasoning: "中文，按以下结构：1.信号方向依据（哪些指标/形态支持） 2.入场方式选择理由（为什么用市价/限价/挂单） 3.风险评估（潜在不利因素） 4.执行建议（为什么可以执行或为什么观望） 5.挂单管理：检查现有挂单状态，是否需要取消、是否已有同方向挂单"
}, null, 2)

function buildLlmRequestBody({ protocol, model, temperature, maxTokens, messages, thinkingEnabled, reasoningEffort }) {
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
    if (thinkingEnabled) {
      body.reasoning = { effort: reasoningEffort === 'max' ? 'high' : (reasoningEffort || 'high') }
    } else {
      body.temperature = temperature
    }
    return body
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
  return body
}

function extractLlmContent(data, protocol) {
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
  return msg?.content || msg?.reasoning_content || ''
}

function extractTokenCount(data) {
  const usage = data?.usage || data?.response?.usage || {}
  const total = usage.total_tokens ?? usage.totalTokens
  if (Number.isFinite(Number(total))) return Math.max(0, Math.trunc(Number(total)))
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0
  return Math.max(0, Math.trunc(Number(input) + Number(output)))
}

async function trackedModelRequest({ url, apiKey, body, timeout, usageContext, estimatedTokens, phase }) {
  let usageLogId = null
  try {
    if (usageContext) {
      const reservation = await beginModelUsage({ ...usageContext, estimatedTokens })
      usageLogId = reservation.logId
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) throw new Error(`${phase === 'repair' ? 'LLM repair' : 'LLM'} HTTP ${response.status}`)
    const data = await response.json()
    if (usageLogId) {
      const reportedTokens = extractTokenCount(data)
      const fallbackTokens = Math.ceil((JSON.stringify(body).length + JSON.stringify(data).length) / 4)
      try {
        await finishModelUsage(usageLogId, { tokenCount: reportedTokens || fallbackTokens, status: 'success' })
      } catch (logError) {
        // The reservation remains at its conservative estimate. Do not repeat a
        // provider call merely because post-call accounting could not finalize.
        console.error('[LLM] Failed to finalize successful usage log:', logError.message)
      }
      usageLogId = null
    }
    return { response, data }
  } catch (error) {
    if (usageLogId) {
      try {
        await finishModelUsage(usageLogId, { tokenCount: 0, status: 'error', errorCode: error.message })
      } catch (logError) {
        console.error('[LLM] Failed to finalize usage log:', logError.message)
      }
    }
    throw error
  }
}

export async function requestJsonObject({ url, apiKey, model, temperature, maxTokens, messages, thinkingEnabled, reasoningEffort, protocol = 'chat_completions', timeout = 120000, usageContext = null }) {
  if (apiKey && /[^ -~]/.test(apiKey)) {
    throw new Error('API key contains non-ASCII characters, please check your configuration')
  }
  const body = buildLlmRequestBody({ protocol, model, temperature, maxTokens, messages, thinkingEnabled, reasoningEffort })
  const estimatedTokens = Math.ceil(JSON.stringify(messages).length / 4) + Math.max(0, Number(maxTokens) || 0)
  const { response, data } = await trackedModelRequest({
    url, apiKey, body, timeout, usageContext, estimatedTokens, phase: 'request',
  })
  const content = extractLlmContent(data, protocol)
  if (!content) throw new Error(`LLM response content is empty, protocol=${protocol}, status=${response.status}, body=${JSON.stringify(data).substring(0, 300)}`)
  try {
    return parseJsonObject(content)
  } catch (exc) {
    const repairMessages = [
      ...messages,
      { role: 'assistant', content: content.substring(0, 6000) },
      { role: 'user', content: `上一次输出不是合法 JSON，解析错误为：${exc.message}。请只返回修正后的一个 JSON 对象，不要 Markdown，不要解释。` },
    ]
    const repairBody = buildLlmRequestBody({
      protocol, model, temperature: 0, maxTokens, messages: repairMessages,
      thinkingEnabled, reasoningEffort,
    })
    const repairEstimate = Math.ceil(JSON.stringify(repairMessages).length / 4) + Math.max(0, Number(maxTokens) || 0)
    const { data: repairedData } = await trackedModelRequest({
      url, apiKey, body: repairBody, timeout, usageContext, estimatedTokens: repairEstimate, phase: 'repair',
    })
    const repaired = extractLlmContent(repairedData, protocol)
    if (!repaired) throw new Error('LLM repair response content is empty')
    return parseJsonObject(repaired)
  }
}

export async function maybeAiSignal(db, config, market, promptOverride) {
  if (!config || !config.api_key_encrypted) return aiFailureHold(market, 'missing_ai_configuration_or_key')
  const apiKey = config.api_key_encrypted
  const provider = config.api_provider || 'deepseek'
  const baseUrl = config.api_base_url
  if (!apiKey) return aiFailureHold(market, 'empty_ai_key')

  const compatibleProviders = new Set(['deepseek', 'gpt', 'kimi', 'qwen', 'zhipu', 'doubao', 'volcengine_agent_plan'])
  if (!compatibleProviders.has(provider)) return aiFailureHold(market, `unsupported_ai_provider:${provider}`)
  const providerDefaults = {
    deepseek: DEFAULT_API_BASE_URL,
    gpt: 'https://api.openai.com/v1',
    kimi: 'https://api.moonshot.cn/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    volcengine_agent_plan: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  }
  const normalizedBaseUrl = String(baseUrl || providerDefaults[provider]).replace(/\/+$/, '')
  const protocol = provider === 'volcengine_agent_plan' ? 'responses' : 'chat_completions'
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
    console.log(`[LLM] Output schema loaded: ${schemaSource} (${outputFormat.length} chars)`)

    const marketOnlyRule = config._market_only
      ? '\n\n## 共享市场推理边界\n你只能分析输入中的市场行情、K线和技术指标。输入不包含任何账户、余额、权益、持仓、挂单或个人风控信息；禁止推测这些信息。手数建议只能处于 ai_volume_range 的上下限内，账户相关调整由独立风控完成。'
      : ''
    const fullPrompt = prompt + marketOnlyRule + '\n\n## 输出格式\n你必须返回以下 JSON 结构：\n' + outputFormat + '\n\n' + PENDING_LIFECYCLE_RULE

    // Check if prompt wants Chan theory data
    const useChan = /\{\{USE_CHAN\}\}/.test(effectivePrompt)
    const cleanPrompt = fullPrompt.replace(/\{\{USE_CHAN\}\}/g, '').replace(/\n{3,}/g, '\n\n').trim()
    console.log(`[LLM] USE_CHAN tag: ${useChan ? 'detected' : 'not found'}`)

    const aiPayload = config._market_only ? { ...market } : {
      symbol: market.symbol, timeframe: market.timeframe, timestamp: market.timestamp,
      latest_price: market.latest_price, price_change: market.price_change,
      price_change_pct: market.price_change_pct, account: market.account,
      positions: market.positions, pending_orders: market.pending_orders || [],
      kline_count: market.kline_count,
      atr_anchor: market.atr_anchor,
      atr_anchor_tf: market.atr_anchor_tf,
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
    // DeepSeek and Agent Plan use different reasoning contracts.
    const thinkingEnabled = (provider === 'deepseek' || provider === 'volcengine_agent_plan')
      && config.thinking_enabled !== 0 && config.thinking_enabled !== false
    console.log(`[LLM] Request params: model=${config.model_name}, thinking=${thinkingEnabled}, effort=${config.reasoning_effort || 'max'}, temp=${thinkingEnabled ? 'ignored' : config.temperature}`)
    const usageContext = config._model_profile_id ? {
      userId: config._userId || 0,
      profileId: config._model_profile_id,
      credentialSource: config._credential_source || (config._model_shared ? 'platform_shared' : 'user'),
      usage: config._usage || 'manual',
      strategyId: config._strategyId || null,
    } : null
    const renderedUserPrompt = '市场数据 JSON：\n' + JSON.stringify(aiPayload)
    if (typeof config._onInferencePrepared === 'function') {
      config._onInferencePrepared({
        systemPrompt: cleanPrompt,
        userPrompt: renderedUserPrompt,
        outputSchemaVersion: sha256(outputFormat),
        aiPayload,
      })
    }
    const parsed = await requestJsonObject({
      url, apiKey,
      model: config.model_name || 'deepseek-chat',
      temperature: parseFloat(config.temperature ?? 0.3),
      maxTokens: parseInt(config.max_tokens || 2000),
      thinkingEnabled,
      reasoningEffort: config.reasoning_effort || 'max',
      protocol,
      messages: [
        { role: 'system', content: cleanPrompt },
        { role: 'user', content: renderedUserPrompt },
      ],
      usageContext,
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
  const strictInference = parsed?._inference_source === 'ai'
  const schemaHold = reason => ({
    ...parsed, signal_type: 'hold', confidence: 0, entry_method: 'observe',
    recommended_volume: 0, limit_price: null, stop_limit_price: null,
    pending_valid_minutes: 0, pending_valid_until: null,
    normalization_info: { type: 'l5_schema_hold', reason },
  })
  if (strictInference) {
    const strictRequired = ['signal_type', 'entry_method', 'recommended_volume', 'stop_loss_price', 'take_profit_1_price']
    const missing = strictRequired.filter(key => parsed[key] === undefined || parsed[key] === null || parsed[key] === '')
    if (missing.length) return schemaHold(`missing:${missing.join(',')}`)
  }
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
  if (!['market', 'limit', 'stop', 'stop_limit', 'observe'].includes(entryMethod)) {
    if (strictInference) return schemaHold('invalid_entry_method')
    entryMethod = 'market'
  }
  if (strictInference && signalType !== 'hold' && entryMethod !== typeEntryMap[signalType]) return schemaHold('signal_entry_mismatch')
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
    low:    { minConfidence: 0.60, slAtrMult: 2.0 },
    medium: { minConfidence: 0.40, slAtrMult: 1.5 },
    high:   { minConfidence: 0.25, slAtrMult: 1.2 },
  }
  const risk = RISK_TABLE[riskLevel] || RISK_TABLE.medium

  const configuredMaxPosition = parseFloat((config || {}).max_position_size || DEFAULT_MAX_POSITION_SIZE)
  const maxPosition = configuredMaxPosition
  const rawVolume = parseFloat(parsed.recommended_volume || 0)
  if (strictInference && signalType !== 'hold' && (!Number.isFinite(rawVolume) || rawVolume < 0.01 || rawVolume > 0.05 || Math.abs(rawVolume * 100 - Math.round(rawVolume * 100)) > 1e-7)) {
    return schemaHold('ai_volume_out_of_platform_range')
  }
  const boundedVolume = Math.max(0.01, Math.min(Number.isFinite(rawVolume) ? rawVolume : 0.01, maxPosition))
  let recommendedVolume = signalType === 'hold' ? 0 : Math.floor(boundedVolume * 100 + 1e-9) / 100

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
    const atr = Number(market.atr_anchor) || 0
    if (!(atr > 0)) {
      console.log(`[LLM] Closed hourly ATR unavailable for ${signalType}, holding`)
      return { ...parsed, signal_type: 'hold', confidence: 0, entry_method: 'observe', recommended_volume: 0, limit_price: null, stop_limit_price: null, pending_valid_until: null, normalization_info: { type: 'atr_anchor_unavailable_hold' } }
    }
    if (atr > 0 && anchorPrice > 0) {
      const fallbackSlDistance = atr * risk.slAtrMult
      if (!parsed.stop_loss_price) {
        parsed.stop_loss_price = isBuySide
          ? round2(anchorPrice - fallbackSlDistance) : round2(anchorPrice + fallbackSlDistance)
      }

      const originalSlDistance = Math.abs(Number(parsed.stop_loss_price) - anchorPrice)
      const minSlDistance = atr * SL_CLAMP.K_MIN
      const maxSlDistance = atr * SL_CLAMP.K_MAX
      if (Number.isFinite(originalSlDistance) && originalSlDistance < minSlDistance) {
        const adjustedVolume = Math.floor((recommendedVolume * originalSlDistance / minSlDistance) * 100 + 1e-9) / 100
        if (adjustedVolume < 0.01) {
          console.log(`[LLM] SL widening would require volume below 0.01: dist=${originalSlDistance.toFixed(2)} min=${minSlDistance.toFixed(2)}, holding`)
          return { ...parsed, signal_type: 'hold', entry_method: 'observe', recommended_volume: 0, limit_price: null, stop_limit_price: null, pending_valid_until: null, normalization_info: { type: 'sl_widen_min_lot_hold', from: round2(originalSlDistance), to: round2(minSlDistance) } }
        }
        parsed.stop_loss_price = isBuySide
          ? round2(anchorPrice - minSlDistance) : round2(anchorPrice + minSlDistance)
        recommendedVolume = adjustedVolume
        parsed.normalization_info = { type: 'sl_widened', from: round2(originalSlDistance), to: round2(minSlDistance), volume: recommendedVolume }
        console.log(`[LLM] SL widened: ${originalSlDistance.toFixed(2)} -> ${minSlDistance.toFixed(2)}, volume=${recommendedVolume}`)
      } else if (Number.isFinite(originalSlDistance) && originalSlDistance > maxSlDistance) {
        console.log(`[LLM] SL too far: ${originalSlDistance.toFixed(2)} > ${maxSlDistance.toFixed(2)}, holding`)
        return { ...parsed, signal_type: 'hold', entry_method: 'observe', recommended_volume: 0, limit_price: null, stop_limit_price: null, pending_valid_until: null, normalization_info: { type: 'sl_too_far_hold', distance: round2(originalSlDistance), max: round2(maxSlDistance) } }
      }

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
      return { ...parsed, signal_type: 'hold', confidence: 0, entry_method: 'observe', limit_price: null, stop_limit_price: null, pending_valid_until: null, recommended_volume: 0 }
    }
  }

  // Attach pending order fields
  parsed.entry_method = entryMethod
  parsed.recommended_volume = recommendedVolume
  parsed.limit_price = limitPrice
  parsed.stop_limit_price = stopLimitPrice
  parsed.pending_valid_until = pendingValidUntil

  return parsed
}

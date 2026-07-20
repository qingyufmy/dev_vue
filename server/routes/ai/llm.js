// ai/llm.js — AI 推理 + 信号标准化

import { queryOne } from '../../db.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { DEFAULT_PROMPT, stripTimeframeTags, round2, parseJsonObject, aiFailureHold } from './utils.js'
import { DEFAULT_MAX_POSITION_SIZE } from './config.js'
import { beginModelUsage, finishModelUsage } from './model-profiles.js'
import { KIMI_CODE_CLIENT_IDENTITY, MODEL_PROVIDER_DEFAULTS, isKimiCodeRequest, modelProviderProtocol } from './model-providers.js'
import { assertSafeModelEndpoint } from './model-endpoint-security.js'
import { sha256 } from './inference-snapshots.js'
import { normalizeEntryMethods, signalTypesForEntryMethods } from './strategy-policy.js'

const DEBUG_LLM_PAYLOAD = process.env.DEBUG_LLM_PAYLOAD === '1'
const SL_CLAMP = { K_MIN: 1.0, K_MAX: 3.0 }
const TP_FROM_SL = { tp1: 1.5, tp2: 2.5, tp3: 4.0 }

export function formatPendingValidUntilUtc(validMinutes, nowMs = Date.now()) {
  const minutes = Math.min(Math.max(parseInt(validMinutes) || 240, 1), 1440)
  return new Date(nowMs + minutes * 60000).toISOString().replace('T', ' ').substring(0, 19)
}
const PENDING_LIFECYCLE_RULE = `
## 挂单生命周期硬性规则
挂单有效期、过期识别和到期取消由 MT5 与后端协调器负责。禁止比较任何时间字符串来判断挂单是否过期；禁止在 analysis 或 reasoning 中声称某挂单“已过期”“超时失效”“已自动取消”；禁止仅以时间、有效期或过期为理由输出 cancel_pending。cancel_pending 只能用于价格条件已明显失效、市场结构已破坏或方向逻辑已反转等非时间原因。是否存在挂单只能依据 pending_orders 当前数组；数组中不存在时只能表述“当前输入未包含该挂单”，不得推断其已过期或已取消。`

const CHAN_DIVERGENCE_RULE = `
## 缠论背驰使用规则
chan.divergence 仅表示最新确认线段的背驰判断；只有 type 为 top 或 bottom、state 为 confirmed 且 confirmed=true 时，才能称为“已确认背驰段”。chan.forming_divergence 仅表示候选线段背驰，不得当作已确认反转或单独作为执行依据。chan.recent_divergences 是当前稳定历史结构内最近的已确认背驰段，entry_segment 与 departure_segment 给出进入段、离开段的 UTC 时间、经纪商时间和价格。area_ratio 与 peak_ratio 越小表示力度衰减越明显。chan.trend_state 区分趋势、盘整、突破候选、确认突破和衰竭；upward_breakout_pending/downward_breakout_pending 只表示价格已经离开尚未闭合的旧中枢，方向仍未由新确认线段证实，不得描述为已确认突破；衰竭也只表示反转风险上升。chan.entry_candidates 中的一二三类买卖点均为候选证据，只有 usable_for_entry=true 才可参与入场论证，也不得单独构成执行指令。strategy_context.chan_timeframe_alignment 用于检查大小周期方向是否一致；agreement=mixed、alignment_with_higher=conflict、status=partial 时必须降低结论强度或选择观望。必须先检查 strategy_context.context_status、missing_timeframes，以及 chan.status、reliability、window_stable、time_location_reliable 和 warnings；出现 confirmed_structure_stale 表示最近确认结构距当前行情过远，不得把旧中枢描述为当前盘整区。结构或时间定位不可靠时应降低该证据权重。所有缠论结果都是行情证据，不等同于交易已经确认，也不直接构成交易指令。
`

let _schemaCache = null
let _schemaCacheTs = 0
const SCHEMA_CACHE_TTL = 300_000 // 5 minutes

const DEFAULT_OUTPUT_FORMAT = JSON.stringify({
  signal_type: "buy | sell | hold | buy_limit | sell_limit | buy_stop | sell_stop | buy_stop_limit | sell_stop_limit。禁止其他值。buy/sell=市价立即执行; buy_limit/sell_limit=挂限价单; buy_stop/sell_stop=突破追单; buy_stop_limit/sell_stop_limit=突破后限价。方向优势不清晰、关键位距离过近、短线波动过大、已有持仓风险不合适时必须返回hold。挂单管理：同品种同方向最多保留1笔挂单，如果market_data_json.pending_orders中已有同品种同方向挂单且价格合理则返回hold不挂新单，仅在现有挂单价格明显不合理时才用cancel_pending取消旧单挂新单",
  entry_method: "必须字段。仅允许 market | limit | stop | stop_limit | observe，并且必须与signal_type一致：buy/sell=market，*_limit=limit，*_stop=stop，*_stop_limit=stop_limit，hold=observe",
  confidence: "0.00-1.00，动态估算，禁止固定值。按趋势强度、位置结构、波动噪音、风险状态综合评估。BUY/SELL弱优势0.52-0.62，中等0.63-0.74，强共振>0.75。HOLD时0.55-0.68，明确回避风险可>0.70。hold时也不得为0",
  bullish_score: "0-100，市场偏多倾向分。必须与bearish_score合计为100；表示当前行情方向倾向，不代表胜率或执行概率",
  bearish_score: "0-100，市场偏空倾向分。必须与bullish_score合计为100；表示当前行情方向倾向，不代表胜率或执行概率",
  recommended_volume: "0.01至输入市场数据中的max_position_size手，不得超过max_position_size。应根据当前风险与止损距离合理建议；hold时返回0",
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
  const experienceIds = [...new Set((experienceSelection?.selectedItemIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  schema.experience_usage = experienceIds.length
    ? { considered_ids:experienceIds, used_ids:`只能填写实际采用的经验编号，且必须来自 ${experienceIds.join('、')}`,
      rejected_ids:'已评估但不适用于当前行情的经验编号', influence:'中文说明经验对方向、入场方式或观望结论的具体影响；没有影响时说明原因' }
    : { considered_ids:[], used_ids:[], rejected_ids:[], influence:'本次没有提供经验，必须返回空字符串' }
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
    if (thinkingEnabled) {
      body.reasoning = { effort: reasoningEffort === 'max' ? 'high' : (reasoningEffort || 'high') }
    } else {
      body.temperature = temperature
    }
    return body
  }

  const body = { model, messages }
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

async function trackedModelRequest({
  url, apiKey, body, timeout, usageContext, estimatedTokens, phase, provider, signal,
  onProviderRequest, onProviderUsage,
}) {
  let usageLogId = null
  let providerRequestStarted = false
  try {
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
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: requestSignal,
      redirect: 'error',
    })
    if (!response.ok) {
      const code = providerHttpError(url, provider, response.status)
      throw new Error(phase === 'repair' && !code.startsWith('kimi_code_') ? code.replace(/^LLM/, 'LLM repair') : code)
    }
    const data = await response.json()
    const reportedTokens = extractTokenCount(data)
    const fallbackTokens = Math.ceil((JSON.stringify(body).length + JSON.stringify(data).length) / 4)
    const tokenCount = reportedTokens || fallbackTokens
    if (usageLogId) {
      try {
        await finishModelUsage(usageLogId, { tokenCount, status: 'success' })
      } catch (logError) {
        // The reservation remains at its conservative estimate. Do not repeat a
        // provider call merely because post-call accounting could not finalize.
        console.error('[LLM] Failed to finalize successful usage log:', logError.message)
      }
      usageLogId = null
    }
    await emitProviderTelemetry(onProviderUsage, { phase, status: 'success', tokenCount })
    return { response, data }
  } catch (error) {
    if (usageLogId) {
      try {
        await finishModelUsage(usageLogId, { tokenCount: 0, status: 'error', errorCode: error.message })
      } catch (logError) {
        console.error('[LLM] Failed to finalize usage log:', logError.message)
      }
    }
    if (providerRequestStarted) {
      await emitProviderTelemetry(onProviderUsage, {
        phase, status: 'error', tokenCount: 0, errorCode: error.message,
      })
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
  const content = extractLlmContent(data, protocol)
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
    const repaired = extractLlmContent(repairedData, protocol)
    if (!repaired) throw new Error('LLM repair response content is empty')
    await emitModelProgress(onProgress, 'validating')
    const repairedObject = parseJsonObject(repaired)
    return typeof validateObject === 'function' ? validateObject(repairedObject) : repairedObject
  }
}

export function validateAiSignalResponse(value, allowedEntryMethods) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('ai_response_not_object')
  const required = ['signal_type', 'entry_method', 'confidence', 'recommended_volume', 'analysis', 'reasoning']
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
  const volume = Number(value.recommended_volume)
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) throw new Error('ai_response_invalid_confidence')
  if (!Number.isFinite(volume) || volume < 0) throw new Error('ai_response_invalid_recommended_volume')
  if (signalType === 'hold' && volume !== 0) throw new Error('ai_response_hold_volume_must_be_zero')
  if (signalType !== 'hold' && volume <= 0) throw new Error('ai_response_trade_volume_required')
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
    console.log(`[LLM] Output schema loaded: ${schemaSource} (${outputFormat.length} chars)`)

    const marketOnlyRule = config._market_only
      ? '\n\n## 共享市场推理边界\n你只能分析输入中的市场行情、K线和技术指标。输入不包含任何账户、余额、权益、持仓、挂单或个人风控信息；禁止推测这些信息。手数建议只能处于 ai_volume_range 的上下限内，账户相关调整由独立风控完成。'
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
    const fullPrompt = prompt + marketOnlyRule + platformExperience + personalMemory + '\n\n## 输出格式\n你必须返回以下 JSON 结构：\n' + outputFormat + pendingRule

    // Check if prompt wants Chan theory data
    const useChan = config._use_chan_analysis === undefined
      ? /\{\{USE_CHAN\}\}/.test(effectivePrompt)
      : Boolean(config._use_chan_analysis)
    const promptWithChanRules = useChan ? `${fullPrompt}\n\n${CHAN_DIVERGENCE_RULE}` : fullPrompt
    const cleanPrompt = promptWithChanRules.replace(/\{\{USE_CHAN\}\}/g, '').replace(/\n{3,}/g, '\n\n').trim()
    console.log(`[LLM] Chan analysis: ${useChan ? 'enabled' : 'disabled'}`)

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
      ai_volume_range: {
        min: Number(config?._ai_volume_min ?? market?.ai_volume_range?.min ?? 0.01),
        max: Number(config?._ai_volume_max ?? market?.ai_volume_range?.max ?? config?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE),
      },
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
    console.log(`[LLM] Payload to model (${JSON.stringify(aiPayload).length} chars)`)
    if (DEBUG_LLM_PAYLOAD) console.log(JSON.stringify(aiPayload, null, 2).substring(0, 3000))
    // DeepSeek and Agent Plan use different reasoning contracts.
    const thinkingEnabled = (provider === 'kimi_code' || provider === 'deepseek' || provider === 'volcengine_agent_plan')
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
      url, apiKey, provider,
      model: config.model_name || 'deepseek-chat',
      temperature: parseFloat(config.temperature ?? 0.3),
      maxTokens: parseInt(config.max_tokens || 2000),
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
      validateObject: value => validateAiSignalResponse(value, config._allowed_entry_methods),
    })
    parsed._inference_source = 'ai'
    return normalizeAiSignal(parsed, config, market)
  } catch (exc) {
    if (config?._abortSignal?.aborted) throw exc
    return aiFailureHold(market, exc.message)
  }
}

export function normalizeAiSignal(parsed, config, market) {
  const strictInference = parsed?._inference_source === 'ai'
  const cleanText = (value, maxLength) => typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
  const cleanList = value => Array.isArray(value)
    ? value.map(item => cleanText(item, 160)).filter(Boolean).slice(0, 4)
    : []
  parsed.decision_summary = cleanText(parsed.decision_summary, 200)
  parsed.trigger_condition = cleanText(parsed.trigger_condition, 240)
  parsed.invalidation_condition = cleanText(parsed.invalidation_condition, 240)
  parsed.key_reasons = cleanList(parsed.key_reasons)
  parsed.risk_factors = cleanList(parsed.risk_factors)
  const availableExperienceIds = [...new Set((config?._experienceSelection?.selectedItemIds || [])
    .map(Number).filter(id => Number.isInteger(id) && id > 0))]
  const allowedExperienceIds = new Set(availableExperienceIds)
  const usage = parsed.experience_usage && typeof parsed.experience_usage === 'object' ? parsed.experience_usage : {}
  const validUsageIds = value => [...new Set((Array.isArray(value) ? value : []).map(Number)
    .filter(id => allowedExperienceIds.has(id)))]
  const usedExperienceIds = validUsageIds(usage.used_ids)
  parsed.experience_usage = {
    source:config?._experienceSelection?.source || null,
    considered_ids:availableExperienceIds,
    used_ids:usedExperienceIds,
    rejected_ids:validUsageIds(usage.rejected_ids).filter(id => !usedExperienceIds.includes(id)),
    influence:cleanText(usage.influence, 400),
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
    recommended_take_profit_tier: null,
    pending_valid_minutes: 0, pending_valid_until: null,
    normalization_info: { type: 'l5_schema_hold', reason },
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
      normalization_info: { type: 'l5_schema_hold', reason, ...details },
    }
  }
  let signalType = String(parsed.signal_type || 'hold').toLowerCase()
  const validTypes = ['buy', 'sell', 'hold', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit']
  if (!validTypes.includes(signalType)) {
    if (strictInference) return schemaHold('invalid_signal_type')
    signalType = 'hold'
  }
  if (strictInference) {
    const strictRequired = ['signal_type', 'entry_method', 'recommended_volume']
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
  const configuredVolumeStep = Number(config?._ai_volume_step ?? 0.01)
  const minPosition = Number.isFinite(configuredMinPosition) && configuredMinPosition > 0 ? configuredMinPosition : 0.01
  const maxPosition = Number.isFinite(configuredMaxPosition) && configuredMaxPosition >= minPosition ? configuredMaxPosition : minPosition
  const volumeStep = Number.isFinite(configuredVolumeStep) && configuredVolumeStep > 0 ? configuredVolumeStep : 0.01
  const rawVolume = parseFloat(parsed.recommended_volume || 0)
  const volumeSteps = (rawVolume - minPosition) / volumeStep
  if (strictInference && signalType !== 'hold' && (!Number.isFinite(rawVolume) || rawVolume < minPosition || rawVolume > maxPosition || Math.abs(volumeSteps - Math.round(volumeSteps)) > 1e-7)) {
    return schemaHold('ai_volume_out_of_platform_range')
  }
  const boundedVolume = Math.max(minPosition, Math.min(Number.isFinite(rawVolume) ? rawVolume : minPosition, maxPosition))
  let recommendedVolume = signalType === 'hold' ? 0 : Math.floor((boundedVolume - minPosition + 1e-9) / volumeStep) * volumeStep + minPosition
  recommendedVolume = Number(recommendedVolume.toFixed(8))

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
  parsed.limit_price = limitPrice
  parsed.stop_limit_price = stopLimitPrice
  parsed.pending_valid_until = pendingValidUntil

  return parsed
}
